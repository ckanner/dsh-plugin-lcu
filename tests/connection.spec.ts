/**
 * Contract tests for the connection, against the real computer-use runtime.
 *
 * The connection is built from this plugin's own launch plan — the runtime inside
 * the ChatGPT application is started directly, with no wrapper in between — so
 * these verify the wire behaviour *and* the launch path the plugin actually
 * ships: protocol negotiation, tool visibility, real JavaScript, and fail-closed
 * approvals. Skipped when the application is not installed.
 *
 * Run: npm test      (or: node --test tests/connection.spec.ts)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { planLaunch, type LaunchPlan } from '../src/app.ts'
import {
  HOST_ONLY_TOOL_NAMES, LcuConnection, MODEL_TOOL_NAMES, TURN_CLEANUP_TIMEOUT_CODE,
  classifyTurnEndFailure, resolveElicitation, turnMetadataFor,
} from '../src/connection.ts'

/** The state of the machine, decided once for the whole file. */
const launch: { plan?: LaunchPlan; skip: string | false } = { skip: false }
try {
  launch.plan = planLaunch({ chrome: false, audio: false, identity: 'dsh-test-connection' })
} catch (error: unknown) {
  launch.skip = `the computer-use runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`
}
const skip = launch.skip

/** A connection built the way the plugin builds it. */
function openConnection(): LcuConnection {
  const plan = launch.plan
  if (plan === undefined) throw new Error('no launch plan')
  return new LcuConnection({ command: plan.command, args: plan.args, env: plan.env })
}

test('connects, negotiates a protocol revision, and carries server instructions', { skip }, async () => {
  const connection = openConnection()
  try {
    await connection.connect()
    assert.equal(connection.serverInfo.name, 'rmcp')
    assert.ok(connection.instructions.length > 0, 'expected non-empty instructions')
  } finally {
    await connection.close()
  }
})

test('exposes exactly js/js_reset to the model and keeps host-only tools out', { skip }, async () => {
  const connection = openConnection()
  try {
    await connection.connect()
    const modelNames = connection.modelTools().map((tool) => tool.name)
    assert.deepEqual(modelNames, [...MODEL_TOOL_NAMES])

    const allNames = connection.allTools.map((tool) => tool.name)
    for (const hostOnly of HOST_ONLY_TOOL_NAMES) {
      assert.ok(allNames.includes(hostOnly), `server should still advertise ${hostOnly}`)
      assert.ok(!modelNames.includes(hostOnly), `${hostOnly} must not reach the model`)
    }

    // The js description is the API manual: losing it would blind the model.
    const js = connection.modelTools().find((tool) => tool.name === 'js')
    assert.ok((js?.description.length ?? 0) > 500, 'js must keep its full description')
    assert.ok('code' in (js?.inputSchema.properties ?? {}), 'js must declare a code parameter')
  } finally {
    await connection.close()
  }
})

test('runs real JavaScript through the CUA runtime', { skip }, async () => {
  const connection = openConnection()
  try {
    await connection.connect()
    const result = await connection.callTool('js', { code: 'await cua.getState();' }, { timeoutMs: 180_000 })
    assert.equal(result.isError, false)
    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    // The first call returns the API documentation for the enabled surfaces.
    assert.match(text, /Computer Use/)
    assert.match(text, /cua\.getApp/)
  } finally {
    await connection.close()
  }
})

test('fails closed on every unexpected elicitation answer', async () => {
  const request = { mode: 'form', message: 'Allow Computer Use to use "Zed"?' }

  // No presenter at all.
  assert.deepEqual(await resolveElicitation(undefined, request), { action: 'cancel' })

  // A presenter that throws.
  assert.deepEqual(
    await resolveElicitation(async () => { throw new Error('no UI available') }, request),
    { action: 'cancel' },
  )

  // A malformed answer must not be forwarded.
  assert.deepEqual(
    await resolveElicitation(async () => ({ action: 'allow' }) as never, request),
    { action: 'cancel' },
  )

  // A real choice passes through untouched, including a persistence scope.
  assert.deepEqual(
    await resolveElicitation(async () => ({ action: 'accept', content: {}, _meta: { persist: 'always' } }), request),
    { action: 'accept', content: {}, _meta: { persist: 'always' } },
  )

  // An already-aborted in-flight call cancels instead of waiting for the human.
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(
    await resolveElicitation(async () => await new Promise(() => {}), request, new Set([controller.signal])),
    { action: 'cancel' },
  )
})

test('every call carries the real turn the runtime keys its state by', () => {
  // The runtime reads these; without them a Stop or a missed cleanup would look
  // like it applied to every later turn on the connection.
  assert.deepEqual(turnMetadataFor('session-1', '3'), {
    'x-codex-turn-metadata': { session_id: 'session-1', turn_id: '3' },
  })
  assert.deepEqual(turnMetadataFor('session-1', '3', 'call-9'), {
    'x-codex-turn-metadata': { session_id: 'session-1', turn_id: '3', call_id: 'call-9' },
  })

  // Never fabricate an identity: a lie is worse than omitting it.
  assert.equal(turnMetadataFor(undefined, '3'), undefined)
  assert.equal(turnMetadataFor('session-1', undefined), undefined)
  assert.equal(turnMetadataFor('', '3'), undefined)
  assert.equal(turnMetadataFor('session-1', ''), undefined)
  // An absent call id is simply not a field.
  assert.deepEqual(turnMetadataFor('s', '1', ''), { 'x-codex-turn-metadata': { session_id: 's', turn_id: '1' } })
})

test('classifies a failed turn cleanup instead of ignoring it', () => {
  // A healthy call classifies as nothing.
  assert.equal(classifyTurnEndFailure({ content: [], isError: false }), undefined)

  // The runtime's own cleanup timeout is a warning with a stable code, because
  // the cleanup keeps running and is retried before the next action.
  const timedOut = classifyTurnEndFailure({
    content: [{ type: 'text', text: 'turn-ended handlers timed out' }],
    isError: true,
  })
  assert.equal(timedOut?.code, TURN_CLEANUP_TIMEOUT_CODE)
  assert.equal(timedOut?.stage, 'turn_ended')

  // Any other failure is a plain error, and never silently dropped.
  const other = classifyTurnEndFailure({ content: [{ type: 'text', text: 'boom' }], isError: true })
  assert.equal(other?.code, undefined)
  assert.match(other?.message ?? '', /boom/)

  const silent = classifyTurnEndFailure({ content: [], isError: true })
  assert.match(silent?.message ?? '', /unknown error/)
})

test('the macOS control channel is advertised only when it is served', { skip }, async () => {
  const connection = openConnection()
  try {
    await connection.connect()
    if (process.platform !== 'darwin') {
      assert.equal(connection.hasHostControl, false)
      return
    }
    // The connection serves the socket, but the runtime's Sky service is what has
    // to connect to it, and nothing here guarantees that: this probe answers
    // elicitations with a refusal and touches no application, so no turn context
    // is ever reported. The honest answer is therefore "not reachable yet", and it
    // is what keeps `computer_use_stop` from promising something it cannot do.
    //
    // A bare `false` is the point. The path existing is not the answer — a
    // configuration that installs no wrapper never connects to it at all, and
    // reporting a channel nobody serves turns "not supported here" into a
    // connection error the caller has to interpret.
    assert.equal(typeof connection.hasHostControl, 'boolean')
    assert.equal(connection.hasHostControl, false)

    // Nothing is held, and asking about a turn this runtime never saw is not an
    // error: it means there is nothing to release.
    assert.deepEqual(await connection.controlStatus('never-seen', 'never-seen'), [])
    // A Stop for an application nothing is holding is refused rather than obeyed.
    await assert.rejects(() => connection.controlStop('never-seen', 'never-seen', 'com.apple.finder'), /./)
  } finally {
    await connection.close()
  }
})

test('turn_ended refuses synthetic identifiers', { skip }, async () => {
  const connection = openConnection()
  try {
    await connection.connect()
    await assert.rejects(() => connection.turnEnded('', 'turn-1'), /real session id and turn id/)
  } finally {
    await connection.close()
  }
})
