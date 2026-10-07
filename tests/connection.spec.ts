/**
 * Contract tests for the LCU connection.
 *
 * These run against the real installed `lcu` server, because the whole point of
 * this module is the wire behaviour: protocol negotiation, tool visibility, and
 * fail-closed approvals. Skipped automatically when `lcu` is not installed.
 *
 * Run: npm test      (or: node --test tests/connection.spec.ts)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  HOST_ONLY_TOOL_NAMES, LcuConnection, MODEL_TOOL_NAMES, TURN_CLEANUP_TIMEOUT_CODE,
  classifyTurnEndFailure, resolveElicitation,
} from '../src/connection.ts'

const LCU = join(homedir(), '.local/share/lcu/current/bin/lcu')
const installed = existsSync(LCU)
const skip = installed ? false : 'lcu is not installed at ~/.local/share/lcu'

test('connects, negotiates a protocol revision, and carries server instructions', { skip }, async () => {
  const connection = new LcuConnection({ command: LCU })
  try {
    await connection.connect()
    assert.equal(connection.serverInfo.name, 'rmcp')
    assert.ok(connection.instructions.length > 0, 'expected non-empty instructions')
  } finally {
    await connection.close()
  }
})

test('exposes exactly js/js_reset to the model and keeps host-only tools out', { skip }, async () => {
  const connection = new LcuConnection({ command: LCU })
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
  const connection = new LcuConnection({ command: LCU })
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

test('turn_ended refuses synthetic identifiers', { skip }, async () => {
  const connection = new LcuConnection({ command: LCU })
  try {
    await connection.connect()
    await assert.rejects(() => connection.turnEnded('', 'turn-1'), /real session id and turn id/)
  } finally {
    await connection.close()
  }
})
