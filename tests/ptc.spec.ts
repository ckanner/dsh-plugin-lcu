/**
 * The PTC bridge is split in two halves that have to agree on a very small
 * protocol: the program-side proxy (`bridge.ts`) and the host-side `cua` tool
 * (`ptc.ts`). These tests pin both halves without launching the ChatGPT app.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { connectCua, type CuaBridgeRequest } from '../src/bridge.ts'
import {
  CUA_RESULT_MARKER, createCuaTool, ptcBridgeInstructions, readCuaRequest,
} from '../src/ptc.ts'
import type { RuntimeConnection } from '../src/session.ts'

const ctx = {} as Context
const exec = {
  signal: new AbortController().signal,
  callId: 'call-1',
} as unknown as ToolRunContext

test('readCuaRequest normalizes the generic method call', () => {
  assert.deepEqual(readCuaRequest({ method: 'getState' }), { method: 'getState', args: [] })
  assert.deepEqual(
    readCuaRequest({ target: 'h1', method: 'activate', args: [] }),
    { target: 'h1', method: 'activate', args: [] },
  )
  assert.throws(() => readCuaRequest({}), /method/)
  assert.throws(() => readCuaRequest({ method: 'x', args: 'nope' }), /array/)
  assert.throws(() => readCuaRequest({ method: '__proto__' }), /invalid method/)
})

test('the program-side proxy turns handles into routable method calls', async () => {
  const calls: CuaBridgeRequest[] = []
  const cua = connectCua(async (request) => {
    calls.push(request)
    if (request.method === 'getApp') return { __handle: 'h1' }
    if (request.target === 'h1' && request.method === 'activate') return { activated: true }
    return null
  })

  const app = await cua.getApp('Finder')
  assert.deepEqual(await app.activate(), { activated: true })
  assert.deepEqual(calls, [
    { method: 'getApp', args: ['Finder'] },
    { target: 'h1', method: 'activate' },
  ])

  const state = await cua.getState()
  assert.equal(typeof state, 'object')
})

test('nested handle objects are decoded, not left as raw __handle values', async () => {
  const calls: CuaBridgeRequest[] = []
  const cua = connectCua(async (request) => {
    calls.push(request)
    if (request.method === 'getState') {
      return { apps: [], browsers: [{ metadata: { __handle: 'b1', browserId: '1' }, tabs: [{ __handle: 't1', id: 'tab-1', title: 'Example' }] }] }
    }
    if (request.target === 't1' && request.method === 'getTitle') return 'Example'
    return null
  })

  const state = await cua.getState()
  const tab = state.browsers[0].tabs[0]
  assert.equal(tab.id, 'tab-1')
  assert.equal(tab.title, 'Example')
  assert.equal(state.browsers[0].metadata.browserId, '1')
  assert.equal(typeof tab.getTitle, 'function')
  assert.equal(await tab.getTitle(), 'Example')
})

test('the host tool sends a bridge program and returns its JSON value', async () => {
  const calls: { name: string, args: Readonly<Record<string, unknown>> }[] = []
  const values = [{ state: 'ready' }, { __handle: 'h1' }]
  let callNumber = 0
  const connection = {
    sessionId: 'session-1',
    hasHostControl: true,
    modelTools: () => [],
    callTool: async (name: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ name, args })
      callNumber += 1
      // The bridge stores the method result in the REPL and fetches it with a
      // second tiny call; only that second call carries the marker.
      if (callNumber % 2 === 1) return { content: [{ type: 'text', text: 'docs' }], isError: false }
      const value = values.shift()
      return {
        content: [{ type: 'text', text: `${CUA_RESULT_MARKER}${JSON.stringify({ ok: true, value })}` }],
        isError: false,
      }
    },
    turnEnded: async () => {},
    controlStatus: async () => [],
    controlStop: async () => {},
    close: async () => {},
  } as unknown as RuntimeConnection

  const tool = createCuaTool(connection, ctx)
  assert.deepEqual(await tool.execute({ method: 'getState' }, exec), { state: 'ready' })
  assert.deepEqual(await tool.execute({ method: 'getApp', args: ['Finder'] }, exec), { __handle: 'h1' })
  assert.equal(calls[0]?.name, 'js')
  assert.match(String(calls[0]?.args.code), /__dshLcu/)
  assert.match(String(calls[0]?.args.code), /"getState"/)
})

test('the PTC instructions embed the bridge file URL', () => {
  const text = ptcBridgeInstructions('file:///profile/lib/bridge.js')
  assert.match(text, /connectCua/)
  assert.match(text, /file:\/\/\/profile\/lib\/bridge\.js/)
  assert.match(text, /Do not call `js`/)
})
