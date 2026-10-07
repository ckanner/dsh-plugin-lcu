/**
 * The LCU MCP client.
 *
 * Why not `@modelcontextprotocol/sdk` or the host's `@modelcontextprotocol/client`:
 * the harness's own MCP bridge declares `capabilities: {}` and therefore cannot
 * answer elicitation, which is how LCU asks for per-app approval; and pulling a
 * second SDK into a profile plugin would pin a version the host does not own.
 * MCP over stdio is newline-delimited JSON-RPC, so the wire is small enough to
 * own here and keeps this plugin dependency-free at runtime.
 *
 * Contract kept from `amontlabs/lcu`:
 * - declare `capabilities.elicitation` and answer `elicitation/create`
 * - expose only `js` and `js_reset` to the model; `turn_ended` and
 *   `js_add_node_module_dir` are host-only
 * - inject the server's `initialize.instructions` into model context
 * - fail closed: an elicitation with no handler, or any unknown shape, cancels
 * - approvals never time out; a pending approval freezes the call deadline
 *
 * @module dsh-plugin-lcu/connection
 */

/** One tool as the server describes it. */
export interface LcuTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** A single MCP content block, text or image. */
export type LcuContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: string; readonly [key: string]: unknown }

/** The result of one `tools/call`. */
export interface LcuCallResult {
  readonly content: readonly LcuContentBlock[]
  readonly isError: boolean
  readonly structuredContent?: unknown
}

/** An `elicitation/create` request as the server sends it. */
export interface LcuElicitationRequest {
  readonly message?: string
  readonly mode?: string
  readonly requestedSchema?: unknown
  readonly _meta?: Record<string, unknown>
  readonly [key: string]: unknown
}

/** What a host may answer. Anything else is normalized to `cancel`. */
export type LcuElicitationResponse =
  | { readonly action: 'accept'; readonly content?: Record<string, unknown>; readonly _meta?: Record<string, unknown> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' }

/** Tools the model may see. Everything else is host-only. */
export const MODEL_TOOL_NAMES: readonly string[] = ['js', 'js_reset']

/** Host-only tools, named so a mistake is loud rather than silent. */
export const HOST_ONLY_TOOL_NAMES: readonly string[] = ['turn_ended', 'js_add_node_module_dir']

/** Lifecycle events the server accepts for `turn_ended`. */
export type LcuTurnEndEvent = 'Stop' | 'Interrupt' | 'SubagentStop'

/** MCP protocol revision this client asks for; the server negotiates. */
const PROTOCOL_VERSION = '2025-06-18'

/** LCU's own approval timeout: effectively "never expire a pending approval". */
const NO_APPROVAL_TIMEOUT_MS = 2 ** 31 - 1

const DEFAULT_CALL_TIMEOUT_MS = 120_000
/** The original host's control channel is bounded; 45 s matches LCU's own client. */
const CONTROL_TIMEOUT_MS = 45_000
const CONTROL_RESPONSE_LIMIT = 1024 * 1024
const DEFAULT_TURN_END_TIMEOUT_MS = 120_000
const CONNECT_TIMEOUT_MS = 120_000

/** Connection options. */
export interface LcuConnectionOptions {
  /** Executable to spawn; defaults to the installed `lcu` launcher. */
  readonly command: string
  /** Extra arguments, e.g. `['--chrome']` to enable the browser surface. */
  readonly args?: readonly string[]
  /** Extra environment layered over the current process environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory for the child process. */
  readonly cwd?: string
  /**
   * Answer one elicitation. Omit to fail closed: every approval then cancels,
   * which is what LCU expects from a host that cannot present the request.
   */
  readonly onElicitation?: (request: LcuElicitationRequest, signal: AbortSignal) => Promise<LcuElicitationResponse>
  /** Called whenever the server's tool list changes. */
  readonly onToolsChanged?: (tools: readonly LcuTool[]) => void
  /** Receives child-process stderr lines; never model-visible. */
  readonly onStderr?: (line: string) => void
}

/** One JSON-RPC message on the wire. */
interface WireMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code?: number; readonly message?: string }
}

/** Where a request is in its lifecycle, for a diagnostic that names the stage. */
export type LcuStage = 'spawn' | 'initialize' | 'tools/list' | 'tools/call' | 'turn_ended'

/**
 * Code for the turn-cleanup timeout: the original host stopped waiting for its
 * per-turn cleanup. The cleanup keeps running in the worker and the runtime
 * retries it before the next action, so this is a warning the caller should
 * surface rather than a reason to abort the session.
 */
export const TURN_CLEANUP_TIMEOUT_CODE = 'LCU_TURN_CLEANUP_TIMEOUT'

/** A failure that names the protocol stage it happened at. */
export class LcuError extends Error {
  readonly stage: LcuStage
  /** Stable machine-readable classification, when one applies. */
  readonly code?: string

  constructor(stage: LcuStage, message: string, cause?: unknown, code?: string) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LcuError'
    this.stage = stage
    if (code !== undefined) this.code = code
  }
}

/**
 * Classify a failed `turn_ended` call.
 *
 * The runtime reports its own cleanup timeout as an ordinary error result with a
 * recognizable detail. Missing it would let a stalled cleanup look like a
 * healthy turn, which is exactly what LCU's contract asks a host not to do.
 *
 * @param result - the failed call's result.
 * @returns the classified error, or `undefined` when the call succeeded.
 */
export function classifyTurnEndFailure(result: LcuCallResult): LcuError | undefined {
  if (!result.isError) return undefined
  const detail = result.content
    .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n')
  if (/turn-ended handlers timed out/i.test(detail)) {
    return new LcuError(
      'turn_ended',
      "the CUA turn cleanup did not finish within the host's wait; it may still be finishing in the background "
      + 'and the runtime retries it before the next action',
      undefined,
      TURN_CLEANUP_TIMEOUT_CODE,
    )
  }
  return new LcuError('turn_ended', `turn cleanup failed: ${detail === '' ? 'unknown error' : detail}`)
}

/**
 * Answer one elicitation, failing closed on every unexpected shape.
 *
 * LCU requires this exact discipline: a host that cannot present the request,
 * a handler that throws, or an answer that is not one of the three actions must
 * all end as `cancel`, because anything else would silently grant desktop access.
 *
 * @param handler - the host's presenter, or `undefined` when there is none.
 * @param request - the server's elicitation params.
 * @param activeCalls - signals of in-flight tool calls; aborting one cancels.
 * @returns an answer the server accepts; never rejects.
 */
export async function resolveElicitation(
  handler: LcuConnectionOptions['onElicitation'],
  request: LcuElicitationRequest,
  activeCalls: ReadonlySet<AbortSignal> = new Set(),
): Promise<LcuElicitationResponse> {
  if (handler === undefined) return { action: 'cancel' }
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, ...activeCalls])
  const dismissed = new Promise<LcuElicitationResponse>((resolve) => {
    if (signal.aborted) resolve({ action: 'cancel' })
    else signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true })
  })
  let answer: LcuElicitationResponse
  try {
    answer = await Promise.race([handler(request, signal), dismissed])
  } catch {
    return { action: 'cancel' }
  }
  if (answer?.action === 'accept' || answer?.action === 'decline' || answer?.action === 'cancel') return answer
  return { action: 'cancel' }
}

/**
 * One long-lived connection to the `lcu` MCP server.
 *
 * The connection is per Agent/Session: LCU carries a persistent JavaScript
 * session on its side, and its approvals are scoped to a real host session and
 * turn, so sharing one connection across agents would interleave both.
 */
export class LcuConnection {
  readonly #options: LcuConnectionOptions
  #child: import('node:child_process').ChildProcess | undefined
  #nextId = 1
  #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; cleanup: () => void }>()
  #tools: LcuTool[] = []
  #instructions = ''
  #serverInfo: { name?: string; version?: string } = {}
  #closed = false
  #stderrBuffer = ''
  #activeCalls = new Set<AbortSignal>()
  #controlDirectory: string | undefined
  #controlSocketPath: string | undefined

  constructor(options: LcuConnectionOptions) {
    this.#options = options
  }

  /** The server's `initialize.instructions`, injected into model context. */
  get instructions(): string {
    return this.#instructions
  }

  /** The host session this connection serves, once bound. */
  sessionId: string | undefined

  /** Server identity, for diagnostics. */
  get serverInfo(): { name?: string; version?: string } {
    return this.#serverInfo
  }

  /** Everything the server advertised, including host-only tools. */
  get allTools(): readonly LcuTool[] {
    return this.#tools
  }

  /** The tools the model may see, in server order. */
  modelTools(): LcuTool[] {
    return this.#tools.filter((tool) => MODEL_TOOL_NAMES.includes(tool.name))
  }

  /**
   * Spawn `lcu`, complete the MCP handshake, and discover tools.
   *
   * @throws {LcuError} when the process cannot start or the handshake fails.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    const { spawn } = await import('node:child_process')
    // macOS only: the wrapper inside the runtime exposes an explicit per-app
    // Stop over a private socket, which the host owns and passes down. Without
    // it the only way to release an app is to end the whole connection.
    this.#controlDirectory = undefined
    this.#controlSocketPath = undefined
    if (process.platform === 'darwin') {
      try {
        const { mkdtempSync, chmodSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const directory = mkdtempSync(join(tmpdir(), 'dsh-lcu-'))
        chmodSync(directory, 0o700)
        this.#controlDirectory = directory
        this.#controlSocketPath = join(directory, 'c.sock')
      } catch {
        this.#controlDirectory = undefined
        this.#controlSocketPath = undefined
      }
    }
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.#options.env }
    if (this.#controlSocketPath === undefined) delete childEnv.LCU_MAC_CONTROL_SOCKET
    else childEnv.LCU_MAC_CONTROL_SOCKET = this.#controlSocketPath
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn(this.#options.command, [...this.#options.args ?? []], {
        cwd: this.#options.cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      throw new LcuError('spawn', `could not start ${this.#options.command}`, error)
    }
    this.#child = child
    child.stderr?.on('data', (chunk: Buffer) => this.#consumeStderr(chunk.toString()))
    child.on('exit', (code, signalName) => {
      const detail = signalName === null ? `exit ${String(code)}` : `signal ${signalName}`
      this.#failAll(new LcuError('spawn', `lcu ${detail}`))
      this.#closed = true
    })
    const { createInterface } = await import('node:readline')
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line: string) => {
      this.#onLine(line)
    })

    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: { name: 'dsh-plugin-lcu', version: '0.0.1' },
    }, CONNECT_TIMEOUT_MS, 'initialize', signal)

    this.#instructions = typeof result.instructions === 'string' ? result.instructions : ''
    const info = result.serverInfo
    this.#serverInfo = info !== null && typeof info === 'object' && !Array.isArray(info)
      ? info as { name?: string; version?: string }
      : {}
    this.#notify('notifications/initialized')
    await this.#refreshTools(signal)
  }

  /**
   * Call one tool. `js_reset` and `js` are the model-facing ones; the host-only
   * tools are reachable here too because the lifecycle needs `turn_ended`.
   *
   * Requests carry no client-side deadline by default: a pause for a human
   * approval must not look like a hung call.
   */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<LcuCallResult> {
    const result = await this.#request('tools/call', { name, arguments: args }, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, 'tools/call', options.signal)
    const content = Array.isArray(result.content) ? result.content as LcuContentBlock[] : []
    return {
      content,
      isError: result.isError === true,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    }
  }

  /**
   * Tell the server a host turn ended, so its per-turn cleanup runs.
   *
   * @param sessionId - the real host session id, and nothing synthetic.
   * @param turnId - the real host turn id.
   * @param event - `Stop`, `Interrupt`, or `SubagentStop`.
   */
  async turnEnded(
    sessionId: string,
    turnId: string,
    event: LcuTurnEndEvent = 'Stop',
  ): Promise<void> {
    this.sessionId = sessionId
    if (sessionId === '' || turnId === '') {
      throw new LcuError('turn_ended', 'turn_ended requires a real session id and turn id')
    }
    const result = await this.callTool('turn_ended', {
      hook_event_name: event,
      session_id: sessionId,
      turn_id: turnId,
    }, { timeoutMs: DEFAULT_TURN_END_TIMEOUT_MS })
    const failure = classifyTurnEndFailure(result)
    if (failure !== undefined) throw failure
  }

  /**
   * Close the connection and let the runtime tear itself down.
   *
   * Order matters: the server owns a process tree (the CUA kernel, its trusted
   * worker, the macOS supervisor and the Sky helper), and LCU's supervisor exits
   * when its lifetime socket closes. Closing stdin gives the server that
   * orderly path; signalling first would orphan the tree on a machine that then
   * keeps reporting computer use as active.
   */
  /** Whether this platform and connection expose the explicit per-app Stop. */
  get hasHostControl(): boolean {
    return this.#controlSocketPath !== undefined && !this.#closed
  }

  /**
   * List the applications the runtime currently holds for one turn.
   *
   * @param sessionId - the real host session id.
   * @param turnId - the real host turn id.
   * @returns the active applications, with the names and bundle ids to stop by.
   */
  async controlStatus(
    sessionId: string,
    turnId: string,
  ): Promise<readonly { name: string; bundleIdentifier: string }[]> {
    const result = await this.#controlRequest({ type: 'status', session_id: sessionId, turn_id: turnId })
    const applications = (result as { computerUse?: { activeApplications?: unknown } }).computerUse?.activeApplications
    if (!Array.isArray(applications)) {
      throw new LcuError('turn_ended', 'the original host returned an invalid Computer Use status')
    }
    return applications.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const { name, bundleIdentifier } = entry as { name?: unknown; bundleIdentifier?: unknown }
      if (typeof name !== 'string' || typeof bundleIdentifier !== 'string' || bundleIdentifier === '') return []
      return [{ name, bundleIdentifier }]
    })
  }

  /**
   * Ask the original host to stop using one application for this turn.
   *
   * This is the documented way to release an app without ending the connection;
   * the runtime then rejects further use of it until a later turn.
   *
   * @param sessionId - the real host session id.
   * @param turnId - the real host turn id.
   * @param app - the bundle identifier to stop.
   */
  async controlStop(sessionId: string, turnId: string, app: string): Promise<void> {
    const result = await this.#controlRequest({ type: 'stop', session_id: sessionId, turn_id: turnId, app }) as {
      accepted?: unknown
      applicationId?: unknown
    }
    if (result.accepted !== true || result.applicationId !== app) {
      throw new LcuError('turn_ended', `the original host did not confirm Stop for ${app}`)
    }
  }

  /** Open the control socket, send one newline-delimited request, await its answer. */
  async #controlRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socketPath = this.#controlSocketPath
    if (socketPath === undefined || this.#closed) {
      throw new LcuError('turn_ended', 'the macOS Computer Use control endpoint is unavailable')
    }
    const { createConnection } = await import('node:net')
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = ''
      let settled = false
      const finish = (error: Error | undefined, value?: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error !== undefined) reject(error)
        else resolve(value ?? {})
      }
      const timer = setTimeout(
        () => { finish(new LcuError('turn_ended', 'the Computer Use control request timed out')) },
        CONTROL_TIMEOUT_MS,
      )
      const socket = createConnection(socketPath)
      socket.on('error', (error: Error) => { finish(new LcuError('turn_ended', `control connection failed: ${error.message}`)) })
      socket.on('connect', () => { socket.write(`${JSON.stringify(request)}\n`) })
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer, 'utf8') > CONTROL_RESPONSE_LIMIT) {
          finish(new LcuError('turn_ended', 'the Computer Use control response exceeded its size limit'))
          return
        }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as { ok?: unknown; error?: unknown; result?: unknown }
          if (typeof response !== 'object' || response === null || typeof response.ok !== 'boolean') {
            throw new Error('invalid response shape')
          }
          if (response.ok !== true) {
            finish(new LcuError('turn_ended', typeof response.error === 'string' ? response.error : 'the host refused the control request'))
            return
          }
          const value = typeof response.result === 'object' && response.result !== null
            ? response.result as Record<string, unknown>
            : {}
          finish(undefined, value)
        } catch (error: unknown) {
          finish(new LcuError('turn_ended', `invalid Computer Use control response: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      socket.on('end', () => { finish(new LcuError('turn_ended', 'the Computer Use control connection ended before a response')) })
    })
  }

  /** Release the private control directory once the child is gone. */
  #removeControlDirectory(): void {
    const directory = this.#controlDirectory
    this.#controlDirectory = undefined
    this.#controlSocketPath = undefined
    if (directory === undefined) return
    void import('node:fs').then(({ rmSync }) => { rmSync(directory, { recursive: true, force: true }) }).catch(() => {})
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#failAll(new LcuError('spawn', 'connection closed'))
    const child = this.#child
    this.#child = undefined
    if (child === undefined || child.exitCode !== null) {
      this.#removeControlDirectory()
      return
    }
    try {
      child.stdin?.end()
    } catch {
      // A already-broken stdin just means we fall through to signalling.
    }
    if (await this.#exited(child, 5_000)) return
    child.kill('SIGTERM')
    if (await this.#exited(child, 3_000)) return
    child.kill('SIGKILL')
    await this.#exited(child, 2_000)
  }

  /** Resolve `true` once the child has exited, or `false` after `timeoutMs`. */
  #exited(child: import('node:child_process').ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit)
        resolve(false)
      }, timeoutMs)
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      child.once('exit', onExit)
    })
  }

  // -------------------------------------------------------------------------
  // Wire
  // -------------------------------------------------------------------------

  #consumeStderr(text: string): void {
    this.#stderrBuffer += text
    const lines = this.#stderrBuffer.split('\n')
    this.#stderrBuffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') this.#options.onStderr?.(line)
  }

  #onLine(line: string): void {
    if (line.trim() === '') return
    let message: WireMessage
    try {
      message = JSON.parse(line) as WireMessage
    } catch {
      return // non-protocol chatter on stdout is not ours to interpret
    }
    if (message.method !== undefined) {
      void this.#onServerMessage(message)
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.#pending.get(message.id)
    if (entry === undefined) return
    this.#pending.delete(message.id)
    entry.cleanup()
    if (message.error !== undefined) {
      entry.reject(new LcuError('tools/call', message.error.message ?? 'server error'))
      return
    }
    entry.resolve(message.result ?? {})
  }

  async #onServerMessage(message: WireMessage): Promise<void> {
    const id = message.id
    if (message.method === 'notifications/tools/list_changed') {
      try {
        await this.#refreshTools()
      } catch {
        // A failed refresh keeps the previous tool set, matching the host bridge.
      }
      return
    }
    // Requests from the server are the elicitation surface; answer or cancel.
    if (id === undefined) return
    if (message.method === 'elicitation/create') {
      const request = (message.params ?? {}) as LcuElicitationRequest
      const response = await this.#answerElicitation(request)
      this.#respond(id, response as unknown as Record<string, unknown>)
      return
    }
    // Unknown server requests fail closed rather than hanging the child.
    this.#respondError(id, -32601, `unsupported server request: ${message.method}`)
  }

  async #answerElicitation(request: LcuElicitationRequest): Promise<LcuElicitationResponse> {
    return await resolveElicitation(this.#options.onElicitation, request, this.#activeCalls)
  }

  async #refreshTools(signal?: AbortSignal): Promise<void> {
    const result = await this.#request('tools/list', {}, CONNECT_TIMEOUT_MS, 'tools/list', signal)
    const listed = Array.isArray(result.tools) ? result.tools as LcuTool[] : []
    const missing = MODEL_TOOL_NAMES.filter((name) => !listed.some((tool) => tool.name === name))
    if (missing.length > 0) {
      throw new LcuError('tools/list', `server does not expose ${missing.join(', ')}`)
    }
    this.#tools = listed
    this.#options.onToolsChanged?.(listed)
  }

  #write(message: WireMessage): void {
    const child = this.#child
    if (child === undefined || child.stdin === null || this.#closed) {
      throw new LcuError('spawn', 'lcu is not connected')
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  #notify(method: string, params?: Record<string, unknown>): void {
    this.#write(params === undefined ? { method } : { method, params })
  }

  #respond(id: number | string, result: Record<string, unknown>): void {
    this.#write({ id, result })
  }

  #respondError(id: number | string, code: number, message: string): void {
    this.#write({ id, error: { code, message } })
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    stage: LcuStage,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal !== undefined) this.#activeCalls.add(signal)
    const id = this.#nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id)
        reject(new LcuError(stage, `${method} was aborted`))
      }
      const timer = timeoutMs >= NO_APPROVAL_TIMEOUT_MS
        ? undefined
        : setTimeout(() => {
          this.#pending.delete(id)
          signal?.removeEventListener('abort', onAbort)
          reject(new LcuError(stage, `${method} timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (signal !== undefined) this.#activeCalls.delete(signal)
      }
      if (signal?.aborted === true) {
        cleanup()
        reject(new LcuError(stage, `${method} was aborted`))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
        cleanup,
      })
      try {
        this.#write({ id, method, params })
      } catch (error: unknown) {
        cleanup()
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new LcuError(stage, String(error)))
      }
    })
  }

  #failAll(error: Error): void {
    for (const entry of this.#pending.values()) entry.reject(error)
    this.#pending.clear()
  }
}
