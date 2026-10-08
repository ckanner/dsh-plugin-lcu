/**
 * The connection an Agent's tools talk to.
 *
 * The runtime is executed from files inside the ChatGPT application, and the
 * application replaces those files when it updates. A session that stays
 * connected across an update therefore runs a mix of two generations — the
 * runtime it started with and the modules a later `import` resolves from the new
 * bundle — and the failure that follows is not obvious from the outside.
 *
 * This is a thin facade rather than a fix inside the connection: the tools close
 * over one object for the life of the Agent, so that object has to be able to
 * become a different connection. Before every call it compares the application's
 * fingerprint, and when it changed it opens a new connection and retires the old
 * one, so all later calls come from a single generation.
 *
 * @module dsh-plugin-lcu/session
 */

import type { LcuConnection } from './connection.ts'

/**
 * What the tools need from a connection.
 *
 * Written as indexed access types rather than restated signatures, so a change to
 * the connection cannot leave this out of date.
 */
export interface RuntimeConnection {
  sessionId: string | undefined
  modelTools: LcuConnection['modelTools']
  readonly hasHostControl: boolean
  callTool: LcuConnection['callTool']
  turnEnded: LcuConnection['turnEnded']
  controlStatus: LcuConnection['controlStatus']
  controlStop: LcuConnection['controlStop']
  close: LcuConnection['close']
}

/** How the session opens a connection, and how it notices the application moved. */
export interface ManagedSessionOptions {
  /**
   * Open a fresh connection.
   *
   * @param reason - whether this is the first connection or a replacement.
   */
  connect: (reason: 'initial' | 'regenerated') => Promise<LcuConnection>
  /**
   * The application's current fingerprint.
   *
   * Called before every call, so it must stay cheap: it reads two file
   * timestamps. It may throw, which is treated as "the application moved" and
   * lets the reconnect report the real error.
   */
  generation: () => string
  /** Called after a successful replacement, for the diagnostic log. */
  onRegenerated?: (transition: { readonly from: string; readonly to: string }) => void
  /** Called when a replacement fails. The previous connection stays in use. */
  onRegenerateFailed?: (error: unknown) => void
  /**
   * Called when the fingerprint cannot be read at all.
   *
   * A fingerprint that cannot be read is **not** evidence that anything changed,
   * and opening a second runtime because of a transient read failure is worse
   * than waiting: the next call checks again.
   */
  onGenerationUnreadable?: (error: unknown) => void
}

/** A connection that follows the application across an update. */
export class ManagedSession implements RuntimeConnection {
  #connection: LcuConnection
  #generation: string
  /**
   * The session identity, kept here rather than only on the connection.
   *
   * The runtime keys its per-turn state by this, so a replacement connection
   * that had not been told the identity would send calls the runtime cannot
   * attribute to a turn — which is the difference between "a new turn" and "the
   * same stopped turn".
   */
  #sessionId: string | undefined
  #closed = false
  #rebuilding: Promise<void> | undefined
  readonly #options: ManagedSessionOptions

  private constructor(connection: LcuConnection, generation: string, options: ManagedSessionOptions) {
    this.#connection = connection
    this.#generation = generation
    this.#options = options
  }

  /**
   * Open the first connection.
   *
   * @param options - how to connect and how to notice a change.
   * @returns the session, already connected.
   */
  static async open(options: ManagedSessionOptions): Promise<ManagedSession> {
    const connection = await options.connect('initial')
    // Recorded after connecting, not before: an update during the handshake is
    // then caught by the first call rather than missed.
    let generation: string
    try {
      generation = options.generation()
    } catch (error: unknown) {
      options.onGenerationUnreadable?.(error)
      generation = ''
    }
    return new ManagedSession(connection, generation, options)
  }

  get sessionId(): string | undefined {
    return this.#connection.sessionId ?? this.#sessionId
  }

  set sessionId(value: string | undefined) {
    this.#sessionId = value
    this.#connection.sessionId = value
  }

  get hasHostControl(): boolean {
    return this.#connection.hasHostControl
  }

  modelTools(): ReturnType<LcuConnection['modelTools']> {
    return this.#connection.modelTools()
  }

  /** Replace the connection when the application underneath it changed. */
  async #ensureCurrent(): Promise<void> {
    if (this.#closed) throw new Error('the session is closed')
    let current: string
    try {
      current = this.#options.generation()
    } catch (error: unknown) {
      // Reported, then ignored: see `onGenerationUnreadable`.
      this.#options.onGenerationUnreadable?.(error)
      return
    }
    if (current === this.#generation) return
    // One replacement at a time: concurrent calls must not each open a runtime.
    if (this.#rebuilding === undefined) {
      this.#rebuilding = this.#rebuild(current).finally(() => { this.#rebuilding = undefined })
    }
    await this.#rebuilding
  }

  async #rebuild(current: string): Promise<void> {
    const previous = this.#connection
    const from = this.#generation
    let next: LcuConnection
    try {
      next = await this.#options.connect('regenerated')
    } catch (error: unknown) {
      // The old connection is stale but alive, which is better than nothing: the
      // next call tries again, and the caller sees why the replacement failed.
      this.#options.onRegenerateFailed?.(error)
      return
    }
    // The identity travels with the session, not with the connection.
    next.sessionId = this.#sessionId
    this.#connection = next
    this.#generation = current
    this.#options.onRegenerated?.({ from, to: current })
    await previous.close()
  }

  async callTool(...args: Parameters<LcuConnection['callTool']>): ReturnType<LcuConnection['callTool']> {
    await this.#ensureCurrent()
    return await this.#connection.callTool(...args)
  }

  async turnEnded(...args: Parameters<LcuConnection['turnEnded']>): ReturnType<LcuConnection['turnEnded']> {
    await this.#ensureCurrent()
    return await this.#connection.turnEnded(...args)
  }

  async controlStatus(...args: Parameters<LcuConnection['controlStatus']>): ReturnType<LcuConnection['controlStatus']> {
    await this.#ensureCurrent()
    return await this.#connection.controlStatus(...args)
  }

  async controlStop(...args: Parameters<LcuConnection['controlStop']>): ReturnType<LcuConnection['controlStop']> {
    await this.#ensureCurrent()
    return await this.#connection.controlStop(...args)
  }

  /** Retire the connection. Later calls fail rather than opening a new runtime. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#connection.close()
  }
}
