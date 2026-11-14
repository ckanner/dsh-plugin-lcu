/**
 * The program-facing side of the LCU PTC bridge.
 *
 * PTC programs run in the harness's own Node runtime, so they cannot reach the
 * objects that live inside the ChatGPT application's CUA REPL directly. This
 * module exposes those objects as a small proxy tree: every method call becomes
 * one `tools.cua` binding call, and every object returned by the runtime becomes
 * an opaque handle whose methods are routed back through the same binding.
 *
 * The file is imported from generated `run_code` programs, so it must stay
 * dependency-free and run in any of the PTC execution modes.
 *
 * @module dsh-plugin-lcu/bridge
 */

/** One method call routed to the LCU runtime. */
export interface CuaBridgeRequest {
  /** Opaque handle returned by a previous call; absent for top-level `cua` methods. */
  readonly target?: string
  /** Method name on the runtime object. */
  readonly method: string
  /** Positional arguments, exactly as the program passed them. */
  readonly args?: readonly unknown[]
}

/** The binding supplied by the PTC program. */
export type CuaBridgeCall = (request: CuaBridgeRequest) => Promise<unknown>

/** A callable object exposed to the program. */
export type CuaBridgeObject = Record<string, (...args: unknown[]) => Promise<unknown>>

const METHOD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Reserved names a model-controlled method string must never reach. */
const RESERVED_METHODS = new Set(['__proto__', 'prototype', 'constructor'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Build the `cua` object used by PTC programs.
 *
 * @param call - the `tools.cua` binding supplied by the generated SDK.
 * @param log - optional sink for runtime text; currently unused but kept so a
 *   caller can pass the same logger as the generic CUA bridge.
 * @returns a proxy whose top-level and returned-object methods all route through
 *   `call`.
 */
export function connectCua(call: CuaBridgeCall, log?: (text: string) => void): CuaBridgeObject {
  void log

  const invoke = async (target: string | undefined, method: string, args: readonly unknown[]): Promise<unknown> => {
    if (!METHOD_NAME.test(method) || RESERVED_METHODS.has(method)) {
      throw new Error(`cua: invalid method name "${method}"`)
    }
    const request: CuaBridgeRequest = {
      method,
      ...(target === undefined ? {} : { target }),
      ...(args.length === 0 ? {} : { args }),
    }
    const result = await call(request)
    return decode(result)
  }

  const makeHandle = (id: string): CuaBridgeObject => new Proxy({} as CuaBridgeObject, {
    get(_target, property) {
      // A Proxy is otherwise awaitable if it exposes `then`; a handle must not
      // be mistaken for a promise by `await cua.getApp(...)`.
      if (property === 'then') return undefined
      if (typeof property !== 'string' || !METHOD_NAME.test(property) || RESERVED_METHODS.has(property)) {
        return undefined
      }
      return (...args: unknown[]) => invoke(id, property, args)
    },
  })

  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode)
    if (isRecord(value) && typeof value.__handle === 'string') return makeHandle(value.__handle)
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) out[key] = decode(child)
      return out
    }
    return value
  }

  return new Proxy({} as CuaBridgeObject, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (typeof property !== 'string' || !METHOD_NAME.test(property) || RESERVED_METHODS.has(property)) {
        return undefined
      }
      return (...args: unknown[]) => invoke(undefined, property, args)
    },
  })
}
