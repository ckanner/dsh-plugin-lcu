/**
 * The Sky service wrapper.
 *
 * This module runs inside the runtime's own process, where the runtime's
 * JavaScript sandbox denies file writes and captures console output — so the
 * assertions here are on behaviour rather than on logs. A fake `nodeRepl` stands
 * in for the runtime, and fixture modules stand in for the application's service
 * and its signed client, which is what lets the hook be driven directly.
 *
 * The hook is the point of the module: the runtime has no turn-ended handler of
 * its own, and a turn that never ends is a turn whose per-application Stop is
 * never released.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WRAPPER = new URL('../helper/sky-service.mjs', import.meta.url).href

/** A fresh copy of the module, so one test's state cannot leak into the next. */
let generation = 0
async function loadWrapper(): Promise<{ handleRpc: (request: unknown) => Promise<unknown> }> {
  generation += 1
  return await import(`${WRAPPER}?v=${String(generation)}`) as { handleRpc: (request: unknown) => Promise<unknown> }
}

interface Harness {
  /** The requests the application's own service received. */
  readonly forwarded: unknown[]
  /** The hooks the wrapper installed, as the runtime would have kept them. */
  readonly hooks: { timeoutMs?: number; run: (event: { session_id: string; turn_id: string }) => Promise<void> }[]
  /** Set the identity the runtime would report for the next request. */
  setIdentity(value: unknown): void
  /** The cleanup calls the signed client received. */
  readonly cleanups: { method: string; args: unknown; options: { codexMetadata?: unknown } }[]
}

/** Build the runtime the wrapper believes it is running inside. */
function harness(options: { readonly cleanupFails?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sky-'))
  const forwarded: unknown[] = []
  const cleanups: Harness['cleanups'] = []

  const service = join(dir, 'service.mjs')
  writeFileSync(service, `export async function handleRpc(request) {
    globalThis.__dshForwarded.push(request)
    return { forwarded: true }
  }\n`)

  const client = join(dir, 'client.mjs')
  writeFileSync(client, `export class MacComputerUseClient {
    async request(method, args, opts) {
      globalThis.__dshCleanups.push({ method, args, options: opts })
      ${options.cleanupFails === true ? "throw new Error('the application refused the cleanup')" : 'return { ok: true }'}
    }
  }\n`)

  const state = {
    requestMeta: undefined as unknown,
    env: {
      DSH_SKY_SERVICE_PATH: service,
      DSH_SKY_CLIENT_PATH: client,
    } as Record<string, string>,
  }

  const hooks: Harness['hooks'] = []
  const runtime = {
    get requestMeta() { return state.requestMeta },
    get env() { return state.env },
    addTurnEndedHandler(hook: Harness['hooks'][number]) { hooks.push(hook) },
  }
  ;(globalThis as Record<string, unknown>).nodeRepl = runtime
  ;(globalThis as Record<string, unknown>).__dshForwarded = forwarded
  ;(globalThis as Record<string, unknown>).__dshCleanups = cleanups

  return {
    forwarded,
    hooks,
    cleanups,
    setIdentity(value: unknown) { state.requestMeta = value },
  }
}

const identity = (session: string, turn: string): unknown => ({ 'x-codex-turn-metadata': { session_id: session, turn_id: turn } })

test('a request is forwarded to the application unchanged', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  h.setIdentity(identity('s1', 't1'))
  const request = { method: 'get_app_state', args: [{ app: 'com.apple.finder' }] }
  assert.deepEqual(await wrapper.handleRpc(request), { forwarded: true })
  assert.deepEqual(h.forwarded, [request], 'the request must arrive intact')
  assert.equal(h.hooks.length, 1, 'the hook is installed on the first request')
  assert.ok((h.hooks[0]?.timeoutMs ?? 0) > 0, 'the hook declares the runtime a deadline')
})

test('a finished turn is cleaned up through the application’s own client', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  h.setIdentity(identity('session-a', 'turn-a'))
  await wrapper.handleRpc({ method: 'get_app_state' })
  assert.equal(h.cleanups.length, 0, 'nothing is cleaned up before the turn ends')

  await h.hooks[0]?.run({ session_id: 'session-a', turn_id: 'turn-a' })
  assert.equal(h.cleanups.length, 1)
  const call = h.cleanups[0]
  // The application's own IPC, which needs no Apple Events — unlike shelling out
  // to the signed client binary, which is the step this module deliberately omits.
  assert.equal(call?.method, 'ComputerUseIPCCodexTurnEndedRequest')
  assert.deepEqual(call?.args, { threadID: 'session-a', turnID: 'turn-a' })
  assert.deepEqual(call?.options.codexMetadata, { session_id: 'session-a', turn_id: 'turn-a' })
})

test('a turn with no identity has nothing to clean up', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  await wrapper.handleRpc({ method: 'get_app_state' })
  assert.equal(h.cleanups.length, 0)
  // Still resolves: an unknown turn is not a reason to fail the runtime's hook.
  await h.hooks[0]?.run({ session_id: 'never-seen', turn_id: 'never-seen' })
  assert.equal(h.cleanups.length, 0)
})

test('a malformed identity is ignored rather than fatal', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  for (const bad of [undefined, null, 'a string', 42, { 'x-codex-turn-metadata': {} }, { 'x-codex-turn-metadata': { session_id: 's' } }, { 'x-codex-turn-metadata': { session_id: 's', turn_id: '  ' } }]) {
    h.setIdentity(bad)
    assert.deepEqual(await wrapper.handleRpc({ method: 'get_app_state' }), { forwarded: true })
  }
  assert.equal(h.cleanups.length, 0)
  // A request with no usable identity still reaches the application.
  assert.equal(h.forwarded.length, 7)
})

test('a failing cleanup is retried and then given up on', async () => {
  const h = harness({ cleanupFails: true })
  const wrapper = await loadWrapper()
  h.setIdentity(identity('session-b', 'turn-b'))
  await wrapper.handleRpc({ method: 'get_app_state' })
  // The hook itself must not throw: the runtime fails the turn when it does, and
  // a cleanup that cannot settle would then break every turn.
  await h.hooks[0]?.run({ session_id: 'session-b', turn_id: 'turn-b' })
  assert.equal(h.cleanups.length, 1, 'the first attempt happens at turn end')
  // Later requests retry, which is what keeps a slow application from losing it.
  await wrapper.handleRpc({ method: 'get_app_state' })
  await wrapper.handleRpc({ method: 'get_app_state' })
  assert.equal(h.cleanups.length, 3, 'a failure is retried before the next request')
  // And then it stops, so a permanent failure cannot wedge the session forever.
  await wrapper.handleRpc({ method: 'get_app_state' })
  await wrapper.handleRpc({ method: 'get_app_state' })
  assert.equal(h.cleanups.length, 3, 'retries are bounded')
})

test('the hook reports an unusable identity instead of failing the turn', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  await wrapper.handleRpc({ method: 'get_app_state' })
  const hook = h.hooks[0]
  await assert.rejects(() => hook!.run({ session_id: '', turn_id: 't' }), /without a session/)
  await assert.rejects(() => hook!.run({ session_id: 's', turn_id: '' }), /without a turn/)
})

test('a missing environment is refused with the variable that is missing', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  delete globalThis.nodeRepl.env.DSH_SKY_SERVICE_PATH
  await assert.rejects(() => wrapper.handleRpc({ method: 'get_app_state' }), /DSH_SKY_SERVICE_PATH/)
  h.setIdentity(identity('s', 't'))
})

test('a runtime with no hook to install is refused', async () => {
  const h = harness()
  const wrapper = await loadWrapper()
  const runtime = globalThis.nodeRepl as Record<string, unknown>
  delete runtime.addTurnEndedHandler
  await assert.rejects(() => wrapper.handleRpc({ method: 'get_app_state' }), /no turn-ended hook/)
  assert.equal(h.forwarded.length, 0)
})
