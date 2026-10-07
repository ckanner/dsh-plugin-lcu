/**
 * The approval contract.
 *
 * These are the rules that decide whether the model may touch the user's
 * desktop, so they are tested exhaustively rather than by example: every way a
 * request can be malformed, and every answer that must not be forwarded.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  approvalValueForLabel,
  isPreApprovedOrigin,
  nativeAppApproval,
  nativeAppApprovalResponse,
  normalizeOrigins,
  originApprovalOrigin,
} from '../src/approval.ts'
import type { LcuElicitationRequest } from '../src/connection.ts'

/** A well-formed native-app approval, as the runtime sends it. */
function request(overrides: Partial<LcuElicitationRequest> = {}, meta: Record<string, unknown> = {}): LcuElicitationRequest {
  return {
    mode: 'form',
    message: 'Allow Computer Use to use "Zed"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'computer-use',
      tool_params: { app: 'Zed' },
      ...meta,
    },
    ...overrides,
  }
}

test('recognizes a native-app approval and offers only the requested scopes', () => {
  const base = nativeAppApproval(request())
  assert.ok(base)
  assert.equal(base.resource, 'Zed')
  assert.deepEqual(base.choices.map((choice) => choice.value), ['once', 'decline'])

  const session = nativeAppApproval(request({}, { persist: ['session'] }))
  assert.deepEqual(session?.choices.map((choice) => choice.value), ['once', 'session', 'decline'])

  const both = nativeAppApproval(request({}, { persist: ['session', 'always'] }))
  assert.deepEqual(both?.choices.map((choice) => choice.value), ['once', 'session', 'always', 'decline'])

  // An unknown persistence scope must never become a choice.
  const bogus = nativeAppApproval(request({}, { persist: ['forever'] }))
  assert.deepEqual(bogus?.choices.map((choice) => choice.value), ['once', 'decline'])
})

test('rejects every request that is not exactly this shape', () => {
  const rejects: [string, LcuElicitationRequest][] = [
    ['wrong mode', request({ mode: 'url' })],
    ['empty message', request({ message: '' })],
    ['missing message', request({ message: undefined })],
    ['non-object schema', request({ requestedSchema: { type: 'array' } })],
    ['missing properties', request({ requestedSchema: { type: 'object' } })],
    ['non-empty properties', request({ requestedSchema: { type: 'object', properties: { choice: {} } } })],
    ['required present', request({ requestedSchema: { type: 'object', properties: {}, required: ['choice'] } })],
    ['wrong approval kind', request({}, { codex_approval_kind: 'something_else' })],
    ['wrong connector', request({}, { connector_id: 'other' })],
    ['missing app', request({}, { tool_params: {} })],
    ['empty app', request({}, { tool_params: { app: '' } })],
    ['no meta at all', { mode: 'form', message: 'x', requestedSchema: { type: 'object', properties: {} } }],
    ['plain form', { mode: 'form', message: 'Pick one', requestedSchema: { type: 'object', properties: { a: {} }, required: ['a'] } }],
  ]
  for (const [label, value] of rejects) {
    assert.equal(nativeAppApproval(value), undefined, `should reject: ${label}`)
    assert.deepEqual(nativeAppApprovalResponse(value, 'once'), { action: 'cancel' }, `must cancel: ${label}`)
  }
})

test('maps a chosen value back to exactly the response the runtime offered', () => {
  const withScopes = request({}, { persist: ['session', 'always'] })
  assert.deepEqual(nativeAppApprovalResponse(withScopes, 'once'), { action: 'accept', content: {} })
  assert.deepEqual(nativeAppApprovalResponse(withScopes, 'session'), { action: 'accept', content: {}, _meta: { persist: 'session' } })
  assert.deepEqual(nativeAppApprovalResponse(withScopes, 'always'), { action: 'accept', content: {}, _meta: { persist: 'always' } })
  assert.deepEqual(nativeAppApprovalResponse(withScopes, 'decline'), { action: 'decline' })
  assert.deepEqual(nativeAppApprovalResponse(withScopes, 'cancel'), { action: 'cancel' })

  // A value that was never offered must not be granted.
  const once = request()
  assert.deepEqual(nativeAppApprovalResponse(once, 'always'), { action: 'cancel' })
  assert.deepEqual(nativeAppApprovalResponse(once, 'session'), { action: 'cancel' })
  assert.deepEqual(nativeAppApprovalResponse(once, 'allow'), { action: 'cancel' })
})

test('maps a presented LABEL back to the value the runtime accepts', () => {
  // The question surface answers with labels; the response needs values. Getting
  // this wrong silently cancels a choice the user actually made.
  const approval = nativeAppApproval(request({}, { persist: ['session', 'always'] }))
  assert.ok(approval)

  assert.equal(approvalValueForLabel(approval, 'Allow once'), 'once')
  assert.equal(approvalValueForLabel(approval, 'Allow for this session'), 'session')
  assert.equal(approvalValueForLabel(approval, 'Always allow'), 'always')
  assert.equal(approvalValueForLabel(approval, 'Decline'), 'decline')

  // A dismissal, an unknown label, and a raw value all cancel rather than grant.
  assert.equal(approvalValueForLabel(approval, undefined), 'cancel')
  assert.equal(approvalValueForLabel(approval, 'always'), 'cancel')
  assert.equal(approvalValueForLabel(approval, 'Allow'), 'cancel')

  // End to end: the label the user picks must produce the offered persistence.
  assert.deepEqual(
    nativeAppApprovalResponse(request({}, { persist: ['session', 'always'] }), approvalValueForLabel(approval, 'Always allow')),
    { action: 'accept', content: {}, _meta: { persist: 'always' } },
  )
  assert.deepEqual(
    nativeAppApprovalResponse(request(), approvalValueForLabel(approval, 'Always allow')),
    { action: 'cancel' }, // the un-scoped request never offered `always`
  )
})

test('recognizes only an exact HTTP(S) site origin', () => {
  const origin = (value: string) => ({ _meta: { tool_name: 'access_browser_origin', origin: value } })
  assert.equal(originApprovalOrigin(origin('http://localhost:3000')), 'http://localhost:3000')
  assert.equal(originApprovalOrigin(origin('https://example.com')), 'https://example.com')

  // Anything that is not the exact origin is refused, never widened. Note this
  // is an exactness rule, not a domain allowlist: a different host is simply a
  // different origin, and the user decides it at approval time.
  assert.equal(originApprovalOrigin(origin('http://localhost:3000/')), undefined)
  assert.equal(originApprovalOrigin(origin('http://localhost:3000/path')), undefined)
  assert.equal(originApprovalOrigin(origin('https://EXAMPLE.com')), undefined) // case-normalized, not round-tripped
  assert.equal(originApprovalOrigin(origin('file:///etc/passwd')), undefined)
  assert.equal(originApprovalOrigin(origin('not a url')), undefined)
  assert.equal(originApprovalOrigin({ _meta: { tool_name: 'other', origin: 'https://example.com' } }), undefined)
  assert.equal(originApprovalOrigin(origin('https://other.example')), 'https://other.example')

  const allowed = normalizeOrigins(['https://example.com', 'https://example.com/', 'ftp://x', 'garbage'])
  assert.deepEqual([...allowed], ['https://example.com'])
  assert.equal(isPreApprovedOrigin(origin('https://example.com'), allowed), true)
  assert.equal(isPreApprovedOrigin(origin('https://other.com'), allowed), false)
})
