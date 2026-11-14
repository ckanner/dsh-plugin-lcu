/**
 * The PTC-facing LCU surface.
 *
 * The ChatGPT application's CUA runtime is a JavaScript REPL (`js`). PTC
 * programs cannot call that REPL's `cua` object directly, so this module exposes
 * one namespaced structured RPC tool, `lcu_cua`, whose binding is a small RPC: a program calls a
 * method, the host runs it inside the persistent CUA REPL, and app/tab/window
 * objects come back as opaque handles.
 *
 * The model never sees the `js` tool. It sees the generated SDK's `tools.lcu_cua`
 * binding and the `connectCua` prelude in {@link ptcBridgeInstructions}.
 *
 * @module dsh-plugin-lcu/ptc
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { LcuError, type LcuContentBlock } from './connection.ts'
import type { RuntimeConnection } from './session.ts'
import { extractText, prepareProjection } from './tool.ts'

/** The single model-facing tool of the PTC surface. */
export const CUA_TOOL_NAME = 'lcu_cua'

/** Marker printed by the in-REPL bridge so the host can find structured output. */
export const CUA_RESULT_MARKER = '__DSH_LCU_RESULT__'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Method names the host may route; keeps model input out of the prototype chain. */
const METHOD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const RESERVED_METHODS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * The in-REPL half of the bridge.
 *
 * It is deliberately installed with `??=` so a persistent PTC runtime (or a
 * persistent CUA REPL) can call it many times without replacing live handles.
 * Values that expose methods are remembered and returned as opaque handles;
 * plain JSON is passed through unchanged.
 */
export const CUA_PRELUDE = String.raw`
globalThis.__dshLcu ??= (() => {
  const objects = new Map()
  const results = new Map()
  let next = 1
  const methodName = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  const reserved = new Set(['__proto__', 'prototype', 'constructor'])
  const remember = (value) => {
    const id = 'h' + String(next++)
    objects.set(id, value)
    return { __handle: id }
  }
  const hasMethods = (value) => {
    let current = value
    while (current !== null && current !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (key !== 'constructor' && typeof current[key] === 'function') return true
      }
      current = Object.getPrototypeOf(current)
    }
    return false
  }
  const encode = (value, seen) => {
    if (value === undefined) return null
    if (typeof value === 'bigint') return String(value)
    if (value instanceof String) return String(value)
    if (value instanceof Number) return Number(value)
    if (value instanceof Boolean) return Boolean(value)
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return { __bytes: value.byteLength }
    if (value instanceof Uint8Array) return { __bytes: value.length }
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => encode(item, seen))
    if (value instanceof Date) return value.toISOString()
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (hasMethods(value)) {
      const handle = remember(value)
      const names = new Set()
      let current = value
      while (current !== null && current !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(current)) {
          if (key === 'constructor' || key === '__handle' || names.has(key)) continue
          names.add(key)
          try {
            const child = value[key]
            if (typeof child !== 'function') handle[key] = encode(child, seen)
          } catch {
            // A native getter may require a connection or permissions; it is
            // not a reason to turn the whole object into an opaque handle.
          }
        }
        current = Object.getPrototypeOf(current)
      }
      return handle
    }
    const keys = Object.keys(value)
    const out = {}
    for (const key of keys) out[key] = encode(value[key], seen)
    return out
  }
  return {
    objects,
    results,
    encode,
    async invoke(target, method, args) {
      if (typeof method !== 'string' || !methodName.test(method) || reserved.has(method)) {
        throw new Error('cua: invalid method')
      }
      const receiver = target == null ? cua : objects.get(target)
      if (receiver == null) throw new Error('cua: unknown handle')
      const fn = receiver[method]
      if (typeof fn !== 'function') throw new Error('cua: unknown method ' + method)
      const value = await fn.apply(receiver, Array.isArray(args) ? args : [])
      return encode(value, new WeakSet())
    },
  }
})()
`

/** Host-owned hooks around one bridge call. */
export interface CuaToolOptions {
  /** Awaited before every call; a rejection fails the call. */
  readonly beforeCall?: () => Promise<void>
  /** The Agent's active turn identity, used for runtime approvals and cleanup. */
  readonly currentTurn?: () => string | undefined
  /** The trusted owner may stop an entire turn, independently of the current model call. */
  readonly callSignal?: () => AbortSignal
  /** Host admission surrounds the complete RPC, including its two native calls. */
  readonly aroundCall?: (request: CuaRequest, exec: ToolRunContext, operation: () => Promise<unknown>) => Promise<unknown>
  /** Prepared projection is not proof that downstream policy or the model received it. */
  readonly onMedia?: (observation: CuaMediaObservation, exec: ToolRunContext) => Promise<void>
}

export interface CuaMediaObservation {
  readonly method: string
  readonly target?: string
  readonly observedAt: string
  readonly modelRoute: { readonly provider?: string; readonly model?: string }
  readonly capturedImages: number
  readonly preparedImages: number
  readonly imageDeliveredToModel: 'unverified'
  readonly images: readonly {
    readonly sha256: string
    readonly mimeType: string
    readonly bytes: number
    readonly attachment?: unknown
    readonly hostPath?: string
  }[]
}

/** Bind opaque native handles to the exact connection generation. */
export function scopeCuaValue(value: unknown, epoch?: string): unknown {
  if (epoch === undefined) return value
  if (Array.isArray(value)) return value.map(child => scopeCuaValue(child, epoch))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === '__handle' && typeof child === 'string' ? `${epoch}:${child}` : scopeCuaValue(child, epoch),
  ]))
}

function nativeRequest(request: CuaRequest, epoch?: string): CuaRequest {
  if (epoch === undefined || request.target === undefined) return request
  const prefix = `${epoch}:`
  if (!request.target.startsWith(prefix) || request.target.length === prefix.length) {
    throw new Error('LCU_STALE_HANDLE: acquire a fresh app or tab in the current runtime epoch')
  }
  return { ...request, target: request.target.slice(prefix.length) }
}

/** One validated bridge request. */
export interface CuaRequest {
  readonly target?: string
  readonly method: string
  readonly args: readonly unknown[]
}

/**
 * Validate the model's arguments.
 *
 * The tool is intentionally generic; the method name and positional arguments
 * are checked here so the in-REPL bridge never receives a non-string method or
 * a non-array argument list.
 *
 * @param value - parsed tool arguments.
 * @returns the normalized request.
 * @throws {Error} when the request shape is not usable.
 */
export function readCuaRequest(value: unknown): CuaRequest {
  if (!isRecord(value)) throw new Error('cua: expected an object')
  const method = value.method
  if (typeof method !== 'string' || method.length === 0) {
    throw new Error('cua: method must be a non-empty string')
  }
  if (!METHOD_NAME.test(method) || RESERVED_METHODS.has(method)) {
    throw new Error(`cua: invalid method name "${method}"`)
  }
  const target = typeof value.target === 'string' && value.target !== '' ? value.target : undefined
  const args = value.args === undefined ? [] : value.args
  if (!Array.isArray(args)) throw new Error('cua: args must be an array when present')
  return {
    ...(target === undefined ? {} : { target }),
    method,
    args,
  }
}

/**
 * Execute one method against the persistent CUA REPL.
 *
 * @param connection - the Agent's LCU connection.
 * @param request - the validated method call.
 * @param options - host hooks.
 * @param exec - the current DSH tool execution.
 * @returns the method's structured result.
 */
async function invokeCua(
  connection: RuntimeConnection,
  request: CuaRequest,
  options: CuaToolOptions,
  exec: ToolRunContext,
): Promise<{ readonly value: unknown; readonly content: readonly unknown[] }> {
  const turn = options.currentTurn?.()
  const callSignal = options.callSignal?.()
  const signal = callSignal === undefined ? exec.signal : AbortSignal.any([exec.signal, callSignal])
  const token = `r-${randomUUID()}`
  const epoch = connection.epoch
  const subCall = (suffix: string) => ({
    signal,
    ...(turn === undefined ? {} : { turnId: turn }),
    ...(exec.callId === undefined || exec.callId === '' ? {} : { callId: `${exec.callId}:cua:${suffix}` }),
    ...(epoch === undefined ? {} : { expectedEpoch: epoch }),
  })
  const firstCode = [
    CUA_PRELUDE,
    '{',
    '  try {',
    `    const receiver = ${request.target === undefined ? 'cua' : `globalThis.__dshLcu.objects.get(${JSON.stringify(request.target)})`}`,
    `    if (receiver == null) throw new Error('cua: unknown handle')`,
    `    const fn = receiver[${JSON.stringify(request.method)}]`,
    `    if (typeof fn !== 'function') throw new Error(${JSON.stringify(`cua: unknown method ${request.method}`)})`,
    `    const value = await fn.apply(receiver, ${JSON.stringify(request.args)})`,
    `    globalThis.__dshLcu.results.set(${JSON.stringify(token)}, { ok: true, value: globalThis.__dshLcu.encode(value, new WeakSet()) })`,
    '  } catch (error) {',
    `    globalThis.__dshLcu.results.set(${JSON.stringify(token)}, { ok: false, error: String(error && error.message ? error.message : error) })`,
    '  }',
    '}',
  ].join('\n')
  const first = await connection.callTool('js', { code: firstCode }, subCall('1'))
  const firstText = extractText(first.content, 'js')

  // The runtime's first call also returns its API manual and auto-emits the
  // initial UI state. A large AX/screenshot result can push a trailing marker
  // past that output budget, so the method result is stored in the REPL and
  // fetched by a second, tiny call. The first call's content is retained for its
  // images and attachment projection.
  const secondCode = [
    '{',
    `  const result = globalThis.__dshLcu && globalThis.__dshLcu.results.get(${JSON.stringify(token)})`,
    `  if (globalThis.__dshLcu) globalThis.__dshLcu.results.delete(${JSON.stringify(token)})`,
    `  console.log(${JSON.stringify(CUA_RESULT_MARKER)} + JSON.stringify(result ?? { ok: false, error: 'missing bridge result' }))`,
    '}',
  ].join('\n')
  const second = await connection.callTool('js', { code: secondCode }, subCall('2'))
  const text = extractText(second.content, 'js')

  const at = text.lastIndexOf(CUA_RESULT_MARKER)
  if (at < 0) {
    throw new LcuError(
      'tools/call',
      `cua ${request.method}: the runtime returned no bridge result (${(first.isError ? firstText : text).slice(0, 500)})`,
    )
  }
  const raw = text.slice(at + CUA_RESULT_MARKER.length).trim()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new LcuError('tools/call', `cua ${request.method}: the runtime returned invalid bridge output`)
  }
  if (!isRecord(payload) || payload.ok !== true) {
    const reason = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'unknown runtime error'
    throw new Error(`cua ${request.method}: ${reason}`)
  }
  return { value: payload.value, content: first.isError ? [] : first.content }
}

/**
 * The per-application Stop, exposed as `cua.stopApp(...)`.
 *
 * This is the PTC equivalent of the old `computer_use_stop` tool. The control
 * channel is still the only authority; the PTC surface only changes where the
 * method is called from.
 *
 * @param connection - the Agent's LCU connection.
 * @param options - host hooks, including the active turn.
 * @param args - `[]` to list, or `[bundleIdentifier]` to stop one application.
 * @returns the held applications and, when requested, the stopped identifier.
 */
async function stopApp(
  connection: RuntimeConnection,
  options: CuaToolOptions,
  args: readonly unknown[],
): Promise<unknown> {
  if (!connection.hasHostControl) {
    throw new Error(
      'the per-application Stop is unavailable: nothing in this configuration serves the runtime control channel',
    )
  }
  const turn = options.currentTurn?.()
  if (turn === undefined) throw new Error('no active turn: computer use is released between turns')
  const sessionId = connection.sessionId
  if (sessionId === undefined) throw new Error('this runtime is not bound to a session')
  const requested = typeof args[0] === 'string' && args[0] !== '' ? args[0] : undefined
  const activeApplications = await connection.controlStatus(sessionId, turn)
  if (requested === undefined) return { activeApplications }
  const target = activeApplications.find((app) => app.bundleIdentifier === requested)
    ?? activeApplications.find((app) => app.name === requested)
  if (target === undefined) {
    throw new Error(`computer use is not holding "${requested}"; held: `
      + (activeApplications.map((app) => app.bundleIdentifier).join(', ') || 'nothing'))
  }
  await connection.controlStop(sessionId, turn, target.bundleIdentifier)
  return { activeApplications, stopped: target.bundleIdentifier }
}

/**
 * Build the one model-facing PTC tool.
 *
 * @param connection - the Agent's LCU connection.
 * @param ctx - the plugin context, kept for the screenshot/attachment projection.
 * @param options - host hooks.
 * @returns a registrable tool definition.
 */
export function createCuaTool(
  connection: RuntimeConnection,
  ctx: Context,
  options: CuaToolOptions = {},
): ToolDefinition {
  const projections = new WeakMap<ToolExecution, { readonly value: unknown; readonly content: readonly unknown[] }>()
  return {
    name: CUA_TOOL_NAME,
    description:
      'Call the persistent Computer Use runtime. Use `method` for the runtime method and `args` for its '
      + 'positional arguments; `target` is an opaque handle returned by a previous call. The PTC prelude '
      + 'wraps this binding as `cua`, whose app, browser and tab handles expose the same method tree. '
      + 'Call `cua.getState()` first when the available apps, browsers or tabs are unknown.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Opaque handle from a previous call; omit for top-level cua methods.',
        },
        method: {
          type: 'string',
          description: 'Runtime method name, such as getState, getApp, getTab, or a method on a handle.',
        },
        args: {
          type: 'array',
          items: {},
          description: 'Positional arguments for the runtime method.',
        },
      },
      required: ['method'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render(_args: unknown, value: unknown) {
        let text: string
        if (typeof value === 'string') text = value
        else {
          try {
            text = JSON.stringify(value, null, 2) ?? String(value)
          } catch {
            text = String(value)
          }
        }
        return [{ type: 'text', text }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const outerRequest = readCuaRequest(args)
      const operation = async (): Promise<unknown> => {
      await options.beforeCall?.()
      await connection.prepare?.()
      const epoch = connection.epoch
      const request = nativeRequest(outerRequest, epoch)
      const ownerSignal = options.callSignal?.()
      const signal = ownerSignal === undefined ? exec.signal : AbortSignal.any([exec.signal, ownerSignal])
      if (signal.aborted) throw new Error('LCU operation was canceled before dispatch')
      if (request.method === 'stopApp') return stopApp(connection, options, request.args)
      if (request.method === 'documentation') {
        const turn = options.currentTurn?.()
        const result = await connection.callTool('js', { code: 'await cua.rewriteDocumentation()' }, {
          signal,
          ...(turn === undefined ? {} : { turnId: turn }),
          ...(exec.callId === undefined || exec.callId === '' ? {} : { callId: exec.callId }),
        })
        const text = extractText(result.content, 'js')
        if (result.isError) throw new LcuError('tools/call', text)
        return text
      }
      if (request.method === 'reset') {
        const turn = options.currentTurn?.()
        const result = await connection.callTool('js_reset', {}, {
          signal,
          ...(turn === undefined ? {} : { turnId: turn }),
          ...(exec.callId === undefined || exec.callId === '' ? {} : { callId: exec.callId }),
        })
        if (result.isError) throw new LcuError('tools/call', extractText(result.content, 'js_reset'))
        connection.rotateEpoch?.()
        return { reset: true, ...(connection.epoch === undefined ? {} : { runtimeEpoch: connection.epoch }) }
      }
      const result = await invokeCua(connection, request, options, exec)
      const value = scopeCuaValue(result.value, epoch)
      if (result.content.some((block) => isRecord(block) && block.type === 'image')) {
        const content = await prepareProjection(ctx, { ...exec, signal }, result.content as LcuContentBlock[], CUA_TOOL_NAME)
        projections.set(exec, { value, content })
        const images = result.content.flatMap((block, sourceIndex) =>
          isRecord(block) && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
            ? [{ data: block.data, mimeType: block.mimeType, sourceIndex }] : [])
        const projected = content.filter(block => block.type === 'image')
        const routed = exec.agent?.session.requestHeader()?.config
        const provider = routed?.provider ?? exec.agent?.options.provider
        const model = routed?.model ?? exec.agent?.options.model
        await options.onMedia?.({
          method: outerRequest.method,
          ...(outerRequest.target === undefined ? {} : { target: outerRequest.target }),
          observedAt: new Date().toISOString(),
          modelRoute: { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) },
          capturedImages: images.length, preparedImages: projected.length, imageDeliveredToModel: 'unverified',
          images: images.map((block) => {
            const bytes = Buffer.from(block.data, 'base64')
            const attachment = (content[block.sourceIndex] as { attachment?: unknown } | undefined)?.attachment
            let hostPath: string | undefined
            try { if (attachment !== undefined) hostPath = ctx.get('attachments')?.imageHostPath(attachment as never) } catch { /* store has no host path */ }
            return { sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: block.mimeType, bytes: bytes.length,
              ...(attachment === undefined ? {} : { attachment }), ...(hostPath === undefined ? {} : { hostPath }) }
          }),
        }, exec)
      }
      return value
      }
      return options.aroundCall === undefined ? operation() : options.aroundCall(outerRequest, exec, operation)
    },
    projectContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError === true) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      return projection.content as never
    },
  }
}

/**
 * Register the PTC surface in one Agent's scope.
 *
 * @param agentCtx - the Agent's own context; registrations unwind on disposal.
 * @param connection - the Agent's connected LCU session.
 * @param ctx - the plugin context.
 * @param options - host hooks.
 * @returns a disposer that unregisters the tool.
 */
export function registerCuaTool(
  agentCtx: Context,
  connection: RuntimeConnection,
  ctx: Context,
  options: CuaToolOptions = {},
): () => void {
  return agentCtx.tools.register(createCuaTool(connection, ctx, options))
}

/**
 * Model-facing PTC instructions.
 *
 * The generated SDK already declares `tools.lcu_cua`; this section teaches the model
 * how to turn it into the same `cua` object the native REPL used to expose.
 *
 * @param bridgeUrl - absolute `file:` URL of the compiled `bridge.js`.
 * @returns the prompt section text.
 */
export function ptcBridgeInstructions(bridgeUrl: string): string {
  return [
    'Computer Use is available through the PTC bridge in this program.',
    'Initialize it once, before the first CUA call:',
    '```ts',
    `var { connectCua } = await import(${JSON.stringify(bridgeUrl)});`,
    'var cua = connectCua((request) => tools.lcu_cua(request), text => console.log(text));',
    '```',
    'Then use the runtime API directly:',
    '```ts',
    'const state = await cua.getState();',
    "const app = await cua.getApp('Finder');",
    "const tab = await cua.getTab({ url: 'https://example.com' }, { browser: 'chrome' });",
    '```',
    '`cua.getApp`, `cua.getBrowser`, `cua.getTab` and `cua.createBrowserTab` return handles. '
      + 'Call methods on those handles directly; every call is routed through `tools.lcu_cua`. '
      + '`cua.stopApp(app?)` lists or releases held applications, `cua.documentation()` returns the '
      + 'runtime API manual, and `cua.reset()` clears the runtime.',
    'Call `cua.documentation()` once to load the runtime API manual, and `cua.getState()` when the '
      + 'available applications, browsers or tabs are unknown. '
      + 'Screenshots are delivered through the harness attachment pipeline; browser access still '
      + 'requires the configured Chrome surface and site approvals.',
    'Show selected text with inspect(...) when the runtime declares it, otherwise console.log(...).',
    'The lcu_cua binding preserves structured handles and projects images separately; do not substitute a native cua binding.',
    'Do not call `js` or `js_reset`: those native tools are not part of the PTC surface.',
  ].join('\n')
}
