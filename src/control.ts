/**
 * The control channel between this plugin and the runtime's Sky service.
 *
 * The runtime can hold an application open for a turn — that is what lets a
 * later call act on the same window. Releasing one early needs the runtime's own
 * control API, and that API lives inside the runtime's process, reachable only
 * from the Sky service wrapping it.
 *
 * So this is a relay. The wrapper inside the runtime connects first and becomes
 * the *service*; a request then arrives from the connection's client, is
 * forwarded to the service, and the service's answer is relayed back. No second
 * process is involved: the socket the child was told about is served here.
 *
 * The relay deliberately does not decide anything. Whether a session and turn are
 * real, and whether the application is actually being held, are questions only
 * the wrapper can answer, because only it has the turn metadata the runtime keys
 * that state by. A relay that guessed would turn "not yours to stop" into "done".
 *
 * Wire format, one JSON object per line:
 *   service -> here   {"type":"service"} first, then contexts, then replies
 *   here -> service   {"id":N,"type":"status"|"stop",…}
 *   client -> here    {"type":"status"|"stop",…}
 *   here -> client    {"ok":true,"result":…} or {"ok":false,"error":"…"}
 *
 * @module dsh-plugin-lcu/control
 */

import { createServer, type Server, type Socket } from 'node:net'

/** A line larger than this is not a control message. */
const MAX_LINE_BYTES = 64 * 1024
/** Bound the wait for the service's answer; the client has its own, shorter one. */
const RELAY_TIMEOUT_MS = 45_000

interface Pending {
  resolve(reply: Record<string, unknown>): void
  timer: NodeJS.Timeout
}

/** The relay. */
export class ControlServer {
  #server: Server
  #service: Socket | undefined
  #pending = new Map<number, Pending>()
  #nextId = 1
  #buffers = new WeakMap<Socket, string>()
  #closed = false
  #contexts = new Map<string, Record<string, unknown>>()
  readonly #onDiag: ((message: string) => void) | undefined

  private constructor(server: Server, onDiag?: (message: string) => void) {
    this.#server = server
    this.#onDiag = onDiag
  }

  /**
   * Serve one socket path.
   *
   * @param socketPath - the path the child was told about.
   * @param onDiag - the diagnostic sink.
   * @returns the running relay.
   */
  static async open(socketPath: string, onDiag?: (message: string) => void): Promise<ControlServer> {
    const server = createServer()
    const relay = new ControlServer(server, onDiag)
    server.on('connection', (socket) => { relay.#accept(socket) })
    server.on('error', (error) => { onDiag?.(`control: server error ${error.message}`) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return relay
  }

  /**
   * Whether the runtime's service has connected.
   *
   * This is the honest answer to "is the per-app Stop reachable": the path
   * existing means nothing, because a configuration with no wrapper never
   * connects to it.
   */
  get connected(): boolean {
    return this.#service !== undefined && !this.#service.destroyed
  }

  /** The turn contexts the service last reported, for diagnostics only. */
  get contexts(): readonly Record<string, unknown>[] {
    return [...this.#contexts.values()]
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true)
    this.#buffers.set(socket, '')
    socket.on('data', (chunk: Buffer) => {
      const buffer = (this.#buffers.get(socket) ?? '') + chunk.toString('utf8')
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
        this.#onDiag?.('control: a message exceeded the size limit; dropping the connection')
        socket.destroy()
        return
      }
      const lines = buffer.split('\n')
      this.#buffers.set(socket, lines.pop() ?? '')
      for (const line of lines) {
        if (line.trim() === '') continue
        this.#onLine(socket, line)
      }
    })
    socket.on('error', () => { /* a client that goes away is not an error here */ })
    socket.on('close', () => {
      if (this.#service === socket) {
        this.#service = undefined
        // Every request in flight can no longer be answered.
        for (const [id, pending] of this.#pending) {
          clearTimeout(pending.timer)
          pending.resolve({ ok: false, error: 'the runtime service disconnected' })
          this.#pending.delete(id)
          void id
        }
        this.#onDiag?.('control: the runtime service disconnected')
      }
    })
  }

  #onLine(socket: Socket, line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      message = parsed as Record<string, unknown>
    } catch {
      this.#onDiag?.('control: ignoring a line that is not a JSON object')
      return
    }

    if (message.type === 'service') {
      if (this.#service !== undefined && this.#service !== socket) {
        this.#onDiag?.('control: a second service tried to connect; refusing it')
        socket.destroy()
        return
      }
      this.#service = socket
      this.#onDiag?.('control: the runtime service connected')
      return
    }

    // Unsolicited reports from the service.
    if (socket === this.#service && message.id === undefined) {
      if (message.type === 'context' && typeof message.token === 'string') this.#contexts.set(message.token, message)
      else if (message.type === 'context-ended' && typeof message.token === 'string') this.#contexts.delete(message.token)
      return
    }

    // A reply from the service.
    if (socket === this.#service) {
      if (typeof message.id !== 'number') return
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
      return
    }

    // A request from the plugin's client.
    void this.#forward(socket, message)
  }

  async #forward(socket: Socket, request: Record<string, unknown>): Promise<void> {
    const reply = (value: Record<string, unknown>): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
    }
    const service = this.#service
    if (service === undefined || service.destroyed) {
      // Deliberately the phrase the connection's client recognises as "nothing is
      // held": a configuration with no wrapper attached has nothing to release,
      // which is not an error for a caller asking what is held.
      reply({ ok: false, error: 'Trusted macOS control service is not connected' })
      return
    }
    const id = this.#nextId
    this.#nextId += 1
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({ ok: false, error: 'the runtime service did not answer' })
      }, RELAY_TIMEOUT_MS)
      this.#pending.set(id, { resolve, timer })
      service.write(`${JSON.stringify({ ...request, id })}\n`)
    })
    reply(answer)
  }

  #writeToService(message: Record<string, unknown>): void {
    if (this.#service === undefined || this.#service.destroyed) return
    this.#service.write(`${JSON.stringify(message)}\n`)
  }

  /** Push one message to the service, for a caller that does not expect an answer. */
  notify(message: Record<string, unknown>): void {
    this.#writeToService(message)
  }

  /** Stop serving. Requests already in flight are answered as failures. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: 'the control channel closed' })
    }
    this.#pending.clear()
    this.#service?.destroy()
    this.#service = undefined
    this.#contexts.clear()
    await new Promise<void>((resolve) => {
      this.#server.close(() => { resolve() })
      // A server with no connections closes immediately; anything else has to be
      // allowed to finish rather than blocking the caller.
      setTimeout(resolve, 500).unref?.()
    })
  }
}
