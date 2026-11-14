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

import { randomUUID } from 'node:crypto'
import type { LcuConnection } from './connection.ts'

/**
 * What the tools need from a connection.
 *
 * Written as indexed access types rather than restated signatures, so a change to
 * the connection cannot leave this out of date.
 */
export interface RuntimeConnection {
  sessionId: string | undefined
  readonly epoch?: string
  prepare?(): Promise<void>
  rotateEpoch?(): void
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
  /** Managed invocations pin their admitted runtime; a change requires a new admission. */
  generationPolicy?: 'replace' | 'pin'

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
  #epoch = randomUUID()
  #closing: Promise<void> | undefined
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
    // Sample before spawning as well as after the handshake. Sampling only
    // afterwards can label a runtime started from the old application as the
    // new generation when the application updates during initialize.
    let before = ''
    try { before = options.generation() }
    catch (error: unknown) {
      options.onGenerationUnreadable?.(error)
      if (options.generationPolicy === 'pin') throw error
    }
    const connection = await options.connect('initial')
    let generation: string
    try {
      generation = options.generation()
    } catch (error: unknown) {
      options.onGenerationUnreadable?.(error)
      if (options.generationPolicy === 'pin') { await connection.close(); throw error }
      generation = ''
    }
    if (options.generationPolicy === 'pin' && generation !== before) {
      await connection.close()
      throw new Error('LCU_GENERATION_CHANGED: application changed during runtime initialization')
    }
    // A replaceable desktop session checks again before its first operation.
    // Keep the pre-spawn identity if initialization straddled an update.
    return new ManagedSession(connection, before, options)
  }

  get epoch(): string { return this.#epoch }

  /** Invalidate live proxies after a successful explicit runtime reset. */
  rotateEpoch(): void { this.#epoch = randomUUID() }

  /** Resolve the actual generation before interpreting a handle. */
  async prepare(): Promise<void> { await this.#ensureCurrent() }

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
      if (this.#options.generationPolicy === 'pin') throw new Error('LCU_GENERATION_UNKNOWN: runtime identity cannot be verified', { cause: error })
      return
    }
    if (current === this.#generation) return
    if (this.#options.generationPolicy === 'pin') throw new Error('LCU_GENERATION_CHANGED: close this invocation before admitting a replacement')
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
    if (this.#closed) {
      await next.close()
      throw new Error('the session was closed during runtime replacement')
    }
    // The identity travels with the session, not with the connection.
    next.sessionId = this.#sessionId
    this.#connection = next
    this.#generation = current
    this.rotateEpoch()
    this.#options.onRegenerated?.({ from, to: current })
    await previous.close()
  }

  async callTool(...args: Parameters<LcuConnection['callTool']>): ReturnType<LcuConnection['callTool']> {
    await this.#ensureCurrent()
    const expected = args[2]?.expectedEpoch
    if (expected !== undefined && expected !== this.#epoch) throw new Error('LCU_STALE_HANDLE: runtime changed during the operation')
    return await this.#connection.callTool(...args)
  }

  async turnEnded(...args: Parameters<LcuConnection['turnEnded']>): ReturnType<LcuConnection['turnEnded']> {
    // Cleanup belongs to the runtime that executed the turn. Rebuilding here
    // would acknowledge a fresh runtime while abandoning the original owner.
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
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    const pending = this.#connection.close()
    this.#closing = pending
    try { await pending } catch (error) { this.#closing = undefined; throw error }
  }
}
