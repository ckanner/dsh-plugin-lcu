/**
 * Result projection and the agent-host guard.
 *
 * Both are pure enough to test without a harness: the projection decides what
 * the model finally sees (including whether a screenshot survives), and the
 * guard decides whether an approval would let the agent control its own host.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'

import { decodeImage, extractText, imageDiagnostic } from '../src/tool.ts'
import { STATIC_HOST_BUNDLE_IDS, enclosingAppBundle, isAgentHostApp } from '../src/host-guard.ts'

test('extractText joins text and never returns an empty string', () => {
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'js'), 'a\nb')
  assert.equal(extractText([{ type: 'image', data: 'x', mimeType: 'image/png' }], 'js'), '[1 image]')
  assert.equal(
    extractText([{ type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'image', data: 'y', mimeType: 'image/png' }], 'js'),
    '[2 images]',
  )
  assert.equal(extractText([], 'js'), '[js returned no text content]')
  // Text wins over the image count so the model still reads the result.
  assert.equal(extractText([{ type: 'text', text: 'seen' }, { type: 'image', data: 'x', mimeType: 'image/png' }], 'js'), 'seen')
})

test('decodeImage admits only canonical base64 of an allowed media type', () => {
  const png = Buffer.from('not really a png').toString('base64')
  const decoded = decodeImage({ type: 'image', data: png, mimeType: 'image/png' })
  assert.deepEqual(decoded.mediaType, 'image/png')
  assert.equal(decoded.data.toString(), 'not really a png')

  assert.throws(() => decodeImage({ type: 'image', data: png, mimeType: 'image/bmp' }), /media type/)
  assert.throws(() => decodeImage({ type: 'image', data: 'not base64!!', mimeType: 'image/png' }), /base64/)
  // Whitespace-wrapped base64 is not canonical and must be refused.
  assert.throws(() => decodeImage({ type: 'image', data: 'AA A=', mimeType: 'image/png' }), /base64/)
})

test('imageDiagnostic names the media type and the reason', () => {
  const text = imageDiagnostic({ type: 'image', data: 'x', mimeType: 'image/png' }, 'model has no image input')
  assert.match(text, /image\/png/)
  assert.match(text, /model has no image input/)
  assert.match(imageDiagnostic({ type: 'text', text: 'x' }, 'why'), /unknown media type/)
})

test('enclosingAppBundle walks up to the .app root', () => {
  assert.equal(enclosingAppBundle('/Applications/Zed.app/Contents/MacOS/Zed'), '/Applications/Zed.app')
  assert.equal(enclosingAppBundle('/Applications/Zed.app'), '/Applications/Zed.app')
  assert.equal(enclosingAppBundle('/usr/bin/bash'), undefined)
})

test('the guard refuses known agent hosts by name or bundle id', async () => {
  assert.ok(STATIC_HOST_BUNDLE_IDS.includes('com.deepseek.dsh'))
  assert.ok(STATIC_HOST_BUNDLE_IDS.includes('com.apple.Terminal'))
  assert.equal(await isAgentHostApp('com.deepseek.dsh'), true)
  assert.equal(await isAgentHostApp('com.apple.Terminal'), true)
  assert.equal(await isAgentHostApp(''), false)
  // An ordinary app that is neither a known host nor an ancestor is allowed.
  assert.equal(await isAgentHostApp('Some Unrelated App'), false)
})

test('the guard is disabled only by the documented override', async () => {
  assert.ok(join(dirname('/a/b'), 'b').length > 0) // keeps the import used
  process.env.LCU_ALLOW_AGENT_HOST_APPROVAL = '1'
  try {
    assert.equal(await isAgentHostApp('com.deepseek.dsh'), false)
  } finally {
    delete process.env.LCU_ALLOW_AGENT_HOST_APPROVAL
  }
})
