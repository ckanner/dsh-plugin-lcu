/**
 * The runtime's Sky service, with a turn-ended hook.
 *
 * The runtime loads this module as its `sky` trusted service and calls
 * `handleRpc` for every request. Everything is forwarded to the application's
 * own service unchanged; the only addition is the per-turn cleanup that tells the
 * host application a turn is over.
 *
 * That hook is not optional bookkeeping. Without it the application keeps
 * believing the turn is open, and a per-application Stop it recorded inside that
 * turn is never released: every later turn then fails with "explicitly stopped by
 * the user until the host application is relaunched.
 *
 * The related wrapper this replaces also signalled a separate supervisor process
 * over a lifetime socket, which spawned the signed client binary with a
 * `turn-ended` argument. That step needs Apple Events, which macOS refuses to
 * grant a hardened-runtime harness — and refuses to even prompt for — so it
 * always timed out. It is deliberately absent here: the application's own IPC is
 * the step that performs the cleanup, and it needs no Apple Events at all.
 *
 * Two environment variables come from the launcher:
 * `DSH_SKY_SERVICE_PATH` is the application's real service module, and
 * `DSH_SKY_CLIENT_PATH` is the signed client the cleanup call goes through.
 *
 * @module dsh-plugin-lcu/sky-service
 */

import { pathToFileURL } from 'node:url'

// Neither a file write nor console output can prove this module loaded: the
// runtime's JavaScript sandbox denies file writes, and it captures console
// output. `DSH_SKY_FORCE_ERROR=1` is the observable probe instead — it makes the
// next call fail with a message only this module can produce.

/** How long the runtime waits for a turn-ended handler before failing the turn. */
const HOOK_TIMEOUT_MS = 4_000
/** The application's own budget for one cleanup call. */
const CALL_TIMEOUT_SECONDS = 15
/** Bound the remembered turn identities, so a long session cannot grow without limit. */
const METADATA_LIMIT = 128
/** Give up on a cleanup that will not settle, rather than wedging every later call. */
const CLEANUP_ATTEMPTS = 3

let original
let client
let registered = false
let cleanupInFlight

/** Turn identities seen on requests, keyed by `[session, turn]`. */
const metadata = new Map()
/** Turns whose cleanup has not settled yet. A Map keeps insertion order for retries. */
const pending = new Map()
/**
 * The last thing worth reporting, surfaced by `DSH_SKY_REPORT=1`.
 *
 * This module runs where the obvious channels do not work: the sandbox denies
 * file writes and the runtime captures console output. Failing a later call is
 * the only way to get a fact out of it.
 */
let lastReport

function runtime() {
  return globalThis.nodeRepl
}

/**
 * Whether to trace the hook. `DSH_SKY_DEBUG=1` turns it on.
 *
 * A handler that never fires is indistinguishable from one that fired and found
 * nothing to do, and the difference decides where the bug is.
 */
function trace(message) {
  if (runtime()?.env?.DSH_SKY_DEBUG === '1') console.error(`dsh-plugin-lcu[sky]: ${message}`)
}

function fail(message) {
  return new Error(`dsh-plugin-lcu Sky service: ${message}`)
}

/**
 * The identity a request carries, when it carries a usable one.
 *
 * A malformed identity is not an error: the runtime falls back to whatever its
 * own metadata says, and a call without one simply gets no cleanup hook.
 */
function readMetadata() {
  try {
    const raw = runtime()?.requestMeta?.['x-codex-turn-metadata']
    let value = raw
    if (raw instanceof Uint8Array) value = JSON.parse(Buffer.from(raw).toString('utf8'))
    else if (typeof raw === 'string') value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const session = value.session_id
    const turn = value.turn_id
    if (typeof session !== 'string' || session.trim() === '') return undefined
    if (typeof turn !== 'string' || turn.trim() === '') return undefined
    // Structured clone, so a later mutation of the request cannot alter a record
    // that is about to be sent to the application.
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/**
 * Ask the host application to clean up one finished turn.
 *
 * This is the application's own IPC through its own signed client, which is why
 * it works where a shelled-out client does not.
 */
async function cleanUp(item) {
  const clientPath = runtime()?.env?.DSH_SKY_CLIENT_PATH
  if (typeof clientPath !== 'string' || clientPath === '') {
    throw fail('DSH_SKY_CLIENT_PATH is not set')
  }
  const { MacComputerUseClient } = await import(pathToFileURL(clientPath).href)
  client ??= new MacComputerUseClient()
  return await client.request('ComputerUseIPCCodexTurnEndedRequest', {
    threadID: item.session_id,
    turnID: item.turn_id,
  }, { codexMetadata: item.metadata, timeoutSeconds: CALL_TIMEOUT_SECONDS })
}

/** Settle every pending cleanup, in the order the turns ended. */
async function settlePending() {
  if (cleanupInFlight !== undefined) return await cleanupInFlight
  cleanupInFlight = (async () => {
    for (const [key, item] of pending) {
      if (item.attempts >= CLEANUP_ATTEMPTS) {
        console.error(`dsh-plugin-lcu: giving up on turn cleanup for ${item.turn_id} after ${item.attempts} attempts`)
        pending.delete(key)
        continue
      }
      item.attempts += 1
      const started = Date.now()
      try {
        await cleanUp(item)
        pending.delete(key)
        // Reported because the alternative is silence: a cleanup that never runs
        // looks exactly like one that ran, until an application refuses a later
        // turn for reasons the user cannot see.
        lastReport = `acknowledged turn=${item.turn_id} in ${Date.now() - started}ms`
        console.error(`dsh-plugin-lcu: turn cleanup ${lastReport}`)
      } catch (error) {
        // Leave it pending: the next request retries, which is what keeps a slow
        // application from losing the cleanup entirely. The attempt count above
        // is what stops a permanent failure from wedging the session.
        lastReport = `failed turn=${item.turn_id} attempt=${item.attempts}/${CLEANUP_ATTEMPTS}: ${String(error)}`
        console.error(`dsh-plugin-lcu: turn cleanup ${lastReport}`)
      }
    }
  })().finally(() => { cleanupInFlight = undefined })
  return await cleanupInFlight
}

/** Install the turn-ended hook once. */
function register() {
  if (registered) return
  const rt = runtime()
  if (typeof rt?.addTurnEndedHandler !== 'function') {
    throw fail('the runtime has no turn-ended hook to install on')
  }
  rt.addTurnEndedHandler({
    timeoutMs: HOOK_TIMEOUT_MS,
    run: async ({ session_id: session, turn_id: turn }) => {
      trace(`turn-ended hook fired session=${String(session)} turn=${String(turn)} known=${String(metadata.size)}`)
      if (typeof session !== 'string' || session.trim() === '') throw fail('a turn-ended hook arrived without a session')
      if (typeof turn !== 'string' || turn.trim() === '') throw fail('a turn-ended hook arrived without a turn')
      const key = JSON.stringify([session, turn])
      const carried = metadata.get(key)
      metadata.delete(key)
      trace(`hook lookup ${key} -> ${carried === undefined ? 'no metadata' : 'found'}`)
      // A turn that carried no identity has nothing to send the application, so
      // there is no cleanup to attempt and no reason to fail the turn. Recorded
      // because "the hook fired and had nothing to send" is a different bug from
      // "the hook never fired", and the two look identical from outside.
      if (carried === undefined) {
        lastReport = `no metadata for turn=${turn} (hook fired, known=${metadata.size})`
        return
      }
      pending.set(key, { session_id: session, turn_id: turn, metadata: carried, attempts: 0 })
      endControlTurn(session, turn)
      await settlePending()
    },
  })
  registered = true
}


// --- the control channel ----------------------------------------------------
//
// The runtime can hold an application open for a turn, which is what lets a later
// call act on the same window. Releasing one early needs the runtime's control
// API, and that API lives in *this* process — so the request has to be answered
// here rather than in the plugin. The plugin serves a socket, this connects to it
// as the service, and the plugin relays requests across.

/** Active turn contexts, keyed by [session, turn, app]. */
const activeContexts = new Map()
const CONTEXT_LIMIT = 128
const STATUS_TIMEOUT_SECONDS = 15
const STOP_TIMEOUT_SECONDS = 15
/** Bound the per-context policy lookups so a Stop still has time to be sent. */
const POLICY_BUDGET_MS = 5_000

let controlSocket
let controlConnecting
let controlBuffer = Buffer.alloc(0)

/** The application's signed client, imported once. */
async function appClient() {
  const clientPath = runtime()?.env?.DSH_SKY_CLIENT_PATH
  if (typeof clientPath !== 'string' || clientPath === '') throw fail('DSH_SKY_CLIENT_PATH is not set')
  const { MacComputerUseClient } = await import(pathToFileURL(clientPath).href)
  client ??= new MacComputerUseClient()
  return client
}

/** The application a request is about, when it names one. */
function appFromRequest(request) {
  try {
    if (request?.type === 'execute' && Array.isArray(request.args)) {
      const argument = request.args[0]
      if (typeof argument === 'string' && request.method === 'get_app_state') return argument
      if (argument !== null && typeof argument === 'object' && typeof argument.app === 'string') return argument.app
    }
  } catch {
    // An unreadable request names no application, which only means no context.
  }
  return undefined
}

function sendControl(message) {
  if (controlSocket === undefined || controlSocket.destroyed) return
  try {
    // A Buffer, not a string. The runtime's native pipe does not accept a string
    // write: it is silently dropped, which is indistinguishable from a peer that
    // never answered. The wrapper this replaces writes Buffers for the same reason.
    controlSocket.write(Buffer.from(`${JSON.stringify(message)}\n`))
  } catch {
    // The channel is gone; the next request reconnects.
    controlSocket = undefined
  }
}

/** Connect to the plugin's socket once, and answer whatever it asks. */
function controlChannel() {
  if (controlSocket !== undefined && !controlSocket.destroyed) return Promise.resolve(controlSocket)
  if (controlConnecting !== undefined) return controlConnecting
  const path = runtime()?.env?.LCU_MAC_CONTROL_SOCKET
  if (typeof path !== 'string' || path === '') {
    lastReport = `control: no socket in env (keys with LCU/DSH: ${Object.keys(runtime()?.env ?? {}).filter((k) => k.startsWith('LCU') || k.startsWith('DSH')).join(',') || 'none'})`
    return Promise.resolve(undefined)
  }
  lastReport = `control: connecting to ${path}`

  controlConnecting = (async () => {
    // The runtime's own native-pipe API, not `node:net`. This module runs inside
    // the runtime's JavaScript sandbox, and that sandbox refuses an ordinary
    // socket connection with EPERM — the same boundary that denies its file
    // writes. `nativePipe` is the sanctioned way out, and it is what the wrapper
    // this replaces uses. `node:net` stays as the fallback so the module can be
    // exercised outside a runtime.
    let socket
    try {
      const opening = Promise.resolve().then(() =>
        typeof runtime()?.nativePipe?.createConnection === 'function'
          ? runtime().nativePipe.createConnection(path)
          : import('node:net').then(({ createConnection }) => createConnection(path)))
      // A deadline, because a native-pipe connection can hang rather than fail.
      socket = await Promise.race([
        opening,
        new Promise((_, reject) => { setTimeout(() => { reject(new Error('control connection timed out')) }, 2_000) }),
      ])
      if (socket === undefined || socket === null) throw new Error('the runtime returned no control connection')
    } catch (error) {
      lastReport = `control: connect failed ${String(error?.message ?? error).slice(0, 90)}`
      return undefined
    }
    // Deliberately no `connect` event: the runtime's native pipe does not emit one,
    // and waiting for it meant the channel never came up. The first write is
    // buffered by the fallback and sent immediately by the native pipe.
    socket.setNoDelay?.(true)
    socket.on('data', (chunk) => {
      controlBuffer = Buffer.concat([controlBuffer, Buffer.from(chunk)])
      if (controlBuffer.length > 256 * 1024) {
        controlBuffer = Buffer.alloc(0)
        return
      }
      for (;;) {
        const newline = controlBuffer.indexOf(10)
        if (newline < 0) break
        const line = controlBuffer.subarray(0, newline).toString('utf8')
        controlBuffer = controlBuffer.subarray(newline + 1)
        if (line.trim() !== '') onControlLine(line)
      }
    })
    socket.on('error', (error) => {
      lastReport = `control: channel error ${String(error?.message ?? error).slice(0, 90)}`
      controlSocket = undefined
    })
    socket.on('close', () => { controlSocket = undefined })
    controlSocket = socket
    sendControl({ type: 'service' })
    trace('control: connected to the plugin')
    return socket
  })().finally(() => { controlConnecting = undefined })
  return controlConnecting
}

/**
 * Answer one control request from the plugin.
 *
 * Every question here is one only this process can answer: it holds the turn
 * metadata the runtime keys the held applications by.
 */
async function handleControl(request) {
  const matches = [...activeContexts.values()].filter(
    (item) => item.session_id === request.session_id && item.turn_id === request.turn_id,
  )
  if (matches.length === 0) {
    // The phrase the plugin's client reads as "nothing is held": a turn this
    // runtime never saw has nothing to release, which is not a failure.
    throw fail('The requested session and turn are not active in the trusted runtime')
  }

  const client = await appClient()
  const status = await client.request('ComputerUseIPCCodexStatusItemMenuStateRequest', {}, {
    codexMetadata: matches[0].metadata,
    timeoutSeconds: STATUS_TIMEOUT_SECONDS,
  })
  const active = status?.computerUse?.activeApplications
  if (!Array.isArray(active) || active.some((app) => app === null || typeof app?.bundleIdentifier !== 'string')) {
    throw fail('the runtime returned an invalid active application list')
  }

  // Which of those this session's turns may see: the ones they named, plus the
  // ones the runtime says the turn is allowed to use.
  const targeted = new Map()
  const deadline = Date.now() + POLICY_BUDGET_MS
  for (const item of matches) {
    if (typeof item.app !== 'string' || item.app === '') continue
    if (active.some((app) => app.bundleIdentifier === item.app)) {
      targeted.set(item, item.app)
      continue
    }
    if (Date.now() >= deadline) continue
    try {
      const policy = await client.getAppPolicy(item.app, {
        codexMetadata: item.metadata,
        timeoutSeconds: STATUS_TIMEOUT_SECONDS,
      })
      const bundle = policy?.target?.bundleIdentifier
      if (policy?.decision === 'allowed' && typeof bundle === 'string' && bundle.trim() !== '') {
        targeted.set(item, bundle)
      }
    } catch {
      // An application this turn cannot use is simply not visible to it.
    }
  }
  const visible = active.filter((app) => new Set(targeted.values()).has(app.bundleIdentifier))

  if (request.type === 'status') {
    return { computerUse: { ...status.computerUse, activeApplications: visible }, computerHistory: status.computerHistory }
  }

  if (typeof request.app !== 'string' || !visible.some((app) => app.bundleIdentifier === request.app)) {
    throw fail('the selected application is not targeted by an active computer-use call')
  }
  const selected = visible.find((app) => app.bundleIdentifier === request.app)
  if (typeof selected?.id !== 'string' || selected.id.trim() === '') {
    throw fail('the runtime did not provide the selected application id')
  }
  const context = matches.find((item) => targeted.get(item) === request.app)
  if (context === undefined) throw fail('the turn ended before Stop could be sent')

  await client.request('ComputerUseIPCAppStopRequest', { app: selected.id }, {
    codexMetadata: context.metadata,
    timeoutSeconds: STOP_TIMEOUT_SECONDS,
  })
  // The shape the plugin's client confirms against: a Stop is only done when the
  // runtime accepted it *and* the application it acted on is the one asked for.
  return { accepted: true, applicationId: request.app }
}

function onControlLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object' || typeof message.id !== 'number') return
  const id = message.id
  void (async () => {
    try {
      sendControl({ id, ok: true, result: await handleControl(message) })
    } catch (error) {
      sendControl({ id, ok: false, error: String(error?.message ?? error).slice(0, 400) })
    }
  })()
}

/** Report one turn's context, so a later request can be attributed to it. */
async function registerContext(carried, request) {
  if (carried === undefined) return
  const app = appFromRequest(request)
  if (typeof app !== 'string' || app === '') return
  const token = JSON.stringify([carried.session_id, carried.turn_id, app])
  if (activeContexts.has(token) || activeContexts.size >= CONTEXT_LIMIT) return
  const socket = await controlChannel()
  if (socket === undefined) return
  activeContexts.set(token, { session_id: carried.session_id, turn_id: carried.turn_id, app, metadata: carried })
  sendControl({ type: 'context', token, session_id: carried.session_id, turn_id: carried.turn_id, app })
}

/** Forget a finished turn's contexts. */
function endControlTurn(session, turn) {
  for (const [token, item] of activeContexts) {
    if (item.session_id === session && item.turn_id === turn) {
      activeContexts.delete(token)
      sendControl({ type: 'context-ended', token })
    }
  }
}

/**
 * Handle one Sky request.
 *
 * Exported because this module *is* the trusted service: the runtime calls this
 * for every request, and the application's own service does the work.
 *
 * @param request - the runtime's Sky request.
 * @returns whatever the application's own service returns.
 */
export async function handleRpc(request) {
  if (runtime()?.env?.DSH_SKY_FORCE_ERROR === '1') {
    throw fail('the wrapper is active (DSH_SKY_FORCE_ERROR=1)')
  }
  // Console output and file writes are both unavailable inside this sandbox, so
  // the only trustworthy way to report a cleanup is to fail a later call with it.
  if (runtime()?.env?.DSH_SKY_REPORT === '1' && lastReport !== undefined) {
    const report = lastReport
    lastReport = undefined
    throw fail(`last cleanup ${report}`)
  }
  register()
  // A previous turn's cleanup is retried before the next request, because the
  // application refuses some actions while it still believes that turn is open.
  await settlePending()

  const rt = runtime()
  const servicePath = rt?.env?.DSH_SKY_SERVICE_PATH
  if (typeof servicePath !== 'string' || servicePath === '') {
    throw fail('DSH_SKY_SERVICE_PATH is not set')
  }
  original ??= import(pathToFileURL(servicePath).href)

  if (runtime()?.env?.DSH_SKY_DEBUG === '1' && lastReport === undefined) {
    const first = Array.isArray(request?.args) ? request.args[0] : undefined
    const shape = typeof first === 'string'
      ? first
      : first === null || first === undefined
        ? String(first)
        : `keys=${Object.keys(first).join('+')} app=${typeof first.app}`
    lastReport = `request type=${String(request?.type)} method=${String(request?.method)} arg0=${shape}`
  }
  const carried = readMetadata()
  trace(`handleRpc requestMeta=${String(runtime()?.requestMeta === undefined ? 'absent' : JSON.stringify(Object.keys(runtime()?.requestMeta ?? {})))} identity=${carried === undefined ? 'none' : String(carried.turn_id)}`)
  if (carried !== undefined) {
    const key = JSON.stringify([carried.session_id, carried.turn_id])
    if (!metadata.has(key) && metadata.size >= METADATA_LIMIT) {
      throw fail('too many turn identities are open; refusing a new request until cleanup settles')
    }
    metadata.set(key, carried)
    await registerContext(carried, request)
  }

  const service = await original
  if (typeof service?.handleRpc !== 'function') {
    throw fail(`the application service at ${servicePath} does not export handleRpc`)
  }
  return await service.handleRpc(request)
}
