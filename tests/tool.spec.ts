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

import {
  buildLcuTools, capturePermissionHint, createComputerUseStopTool, decodeImage, extractText, imageDiagnostic,
  storedImageNote, stuckStopHint,
} from '../src/tool.ts'
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

test('every tool the plugin registers declares a JSON-Schema object', () => {
  // The harness rejects a tool whose `parameters` is not `type: "object"`, and it
  // rejects it at request time — the whole turn fails. The server's descriptors
  // are JSON Schemas already; a hand-written tool must match that shape rather
  // than the descriptor *map* LCU uses on the wire.
  // The two tools LCU promises the model; a server missing either is refused.
  const serverTools = ['js', 'js_reset'].map((name) => ({
    name,
    description: 'server-owned',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  }))
  const connection = { modelTools: () => serverTools } as unknown as Parameters<typeof buildLcuTools>[0]
  const ctx = { get: () => undefined } as unknown as Parameters<typeof buildLcuTools>[1]

  const tools = [
    ...buildLcuTools(connection, ctx),
    createComputerUseStopTool(connection, () => 1),
  ]
  assert.equal(tools.length, 3)

  for (const tool of tools) {
    const parameters = tool.parameters as { type?: unknown; properties?: unknown } | undefined
    assert.equal(parameters?.type, 'object', `${tool.name}: parameters must be a JSON Schema object`)
    assert.equal(typeof parameters?.properties, 'object', `${tool.name}: properties must be present`)

    const output = tool.output?.schema as { type?: unknown } | undefined
    assert.equal(output?.type, 'object', `${tool.name}: output schema must be a JSON Schema object`)
  }

  // The hand-written tool keeps `app` optional: no arguments is the listing form.
  const stop = tools[tools.length - 1]
  const schema = stop.parameters as { required?: unknown, properties: Record<string, unknown> }
  assert.equal(schema.required, undefined)
  assert.ok('app' in schema.properties)
})

test('a refused capture becomes an instruction instead of a number', () => {
  // The model cannot act on "-10005"; it retries and the user learns nothing.
  const hint = capturePermissionHint('Computer Use server error -10005: The screen capture failed.')
  // Naming only the grants sent a user whose grants were fine to check them anyway.
  assert.match(hint ?? '', /grants are missing/)
  assert.match(hint ?? '', /not ready yet/)
  assert.match(hint ?? '', /transient/)

  assert.ok(capturePermissionHint('not authorized to capture the display'))
  // An ordinary failure keeps its own meaning and gets no invented advice.
  assert.equal(capturePermissionHint('Illegal return statement'), undefined)
  assert.equal(capturePermissionHint('Computer Use was not approved to use Finder'), undefined)
  assert.equal(capturePermissionHint(''), undefined)
})

test('a latched Stop is answered with what actually clears it', () => {
  const text = 'This application session has been explicitly stopped by the user for this turn. '
    + 'Stop your work and send a final message noting they stopped the session and you\'re ready to '
    + 'continue if they want you to. Computer Use can be used again in the next assistant turn.'
  const hint = stuckStopHint(text)
  // Retrying, js_reset and a new session all fail; only relaunching the app works.
  assert.match(hint ?? '', /relaunch the ChatGPT application/i)
  assert.match(hint ?? '', /will not help/i)

  assert.equal(stuckStopHint('Computer Use was not approved to use Finder'), undefined)
  assert.equal(stuckStopHint('Computer Use server error -10005: The screen capture failed.'), undefined)
  assert.equal(stuckStopHint(''), undefined)

  // The two hints never both claim the same failure.
  assert.equal(capturePermissionHint(text), undefined)
})

test('a stored screenshot comes back with a path the model can act on', () => {
  // Without this the model knows it has an image and nothing else, and the only
  // route it can find is copying the store's internal layout by hash.
  const note = storedImageNote(['/Users/x/.dsh/attachments/v1/objects/de/de9ecfb6'])
  assert.match(note ?? '', /\/Users\/x\/\.dsh\/attachments\/v1\/objects\/de\/de9ecfb6/)
  assert.match(note ?? '', /EPERM/)
  // The store's objects are mode 400, so the note names a copy that sets the mode:
  // a plain `cp` produced an unreadable file and cost the model an extra call.
  assert.match(note ?? '', /install -m 644/)
  assert.match(note ?? '', /mode 400/)
  assert.match(note ?? '', /bash/)

  // Plurals and the empty case.
  assert.match(storedImageNote(['/a', '/b']) ?? '', /these images/)
  assert.match(storedImageNote(['/a']) ?? '', /this image/)
  // A backend that cannot name a path gets no note rather than an empty one.
  assert.equal(storedImageNote([]), undefined)
})
