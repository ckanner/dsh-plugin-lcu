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

  constructor(options: LcuConnectionOptions) {
    this.#options = options
  }

  /** The server's `initialize.instructions`, injected into model context. */
  get instructions(): string {
    return this.#instructions
  }

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
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn(this.#options.command, [...this.#options.args ?? []], {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.env },
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

  /** Close the connection, terminating the child process. */
  async close(): Promise<void> {
    this.#closed = true
    this.#failAll(new LcuError('spawn', 'connection closed'))
    const child = this.#child
    this.#child = undefined
    if (child === undefined || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
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
