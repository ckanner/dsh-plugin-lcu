/**
 * The control relay.
 *
 * The runtime's control API lives inside the runtime's process, so releasing an
 * application early needs a message to travel from this plugin, across a socket,
 * to the Sky wrapper and back. This is the socket half.
 *
 * The wire is one JSON object per line, and the parts worth pinning down are the
 * ones where silence would be ambiguous: what a caller is told when nothing is
 * serving the channel, that a request carries an id the service can answer, and
 * that an answer reaches the caller it belongs to.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ControlServer } from '../src/control.ts'

/** A line-oriented client, so a test reads exactly what the plugin would. */
function client(socketPath: string): {
  readonly ready: Promise<Socket>
  send(message: unknown): void
  next(): Promise<Record<string, unknown>>
  close(): void
} {
  const lines: Record<string, unknown>[] = []
  const waiting: ((value: Record<string, unknown>) => void)[] = []
  let buffer = ''
  const socket = createConnection(socketPath)
  const ready = new Promise<Socket>((resolve, reject) => {
    socket.on('connect', () => { resolve(socket) })
    socket.on('error', reject)
  })
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const parsed = JSON.parse(line) as Record<string, unknown>
      const next = waiting.shift()
      if (next === undefined) lines.push(parsed)
      else next(parsed)
    }
  })
  return {
    ready,
    send: (message) => { socket.write(`${JSON.stringify(message)}\n`) },
    next: async () => lines.shift() ?? await new Promise((resolve) => { waiting.push(resolve) }),
    close: () => { socket.destroy() },
  }
}

/** Wait until a condition holds, so a socket message has time to arrive. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

/** A socket path in a directory this test owns. */
function socketPath(): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-control-'))
  return {
    path: join(directory, 'c.sock'),
    cleanup: () => { rmSync(directory, { recursive: true, force: true }) },
  }
}

test('a caller is told plainly when nothing serves the channel', async () => {
  const { path, cleanup } = socketPath()
  const relay = await ControlServer.open(path)
  const caller = client(path)
  try {
    assert.equal(relay.connected, false, 'no service has connected')
    await caller.ready
    caller.send({ type: 'status', session_id: 's', turn_id: 't' })
    const reply = await caller.next()
    // The phrase the connection's client reads as "nothing is held". A caller
    // asking what is held does not need an error, and one asking to stop does.
    assert.equal(reply.ok, false)
    assert.match(String(reply.error), /Trusted macOS control service is not connected/)
  } finally {
    caller.close()
    await relay.close()
    cleanup()
  }
})

test('a request reaches the service and its answer reaches the caller', async () => {
  const { path, cleanup } = socketPath()
  const relay = await ControlServer.open(path)
  const service = client(path)
  const caller = client(path)
  try {
    await service.ready
    service.send({ type: 'service' })
    await until(() => relay.connected)
    assert.equal(relay.connected, true, 'the service is attached once it says so')

    await caller.ready
    caller.send({ type: 'status', session_id: 'session-a', turn_id: 'turn-a' })
    const forwarded = await service.next()
    // The relay adds an id the service answers by, and keeps the caller's fields.
    assert.equal(typeof forwarded.id, 'number')
    assert.equal(forwarded.type, 'status')
    assert.equal(forwarded.session_id, 'session-a')
    assert.equal(forwarded.turn_id, 'turn-a')

    service.send({ id: forwarded.id, ok: true, result: { computerUse: { activeApplications: [] } } })
    const reply = await caller.next()
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.result, { computerUse: { activeApplications: [] } })
  } finally {
    caller.close()
    service.close()
    await relay.close()
    cleanup()
  }
})

test('a refusal from the service is a refusal, not an empty answer', async () => {
  const { path, cleanup } = socketPath()
  const relay = await ControlServer.open(path)
  const service = client(path)
  const caller = client(path)
  try {
    await service.ready
    service.send({ type: 'service' })
    await until(() => relay.connected)
    await caller.ready
    caller.send({ type: 'stop', session_id: 's', turn_id: 't', app: 'com.apple.finder' })
    const forwarded = await service.next()
    service.send({ id: forwarded.id, ok: false, error: 'the selected application is not targeted' })
    const reply = await caller.next()
    assert.equal(reply.ok, false)
    assert.match(String(reply.error), /not targeted/)
  } finally {
    caller.close()
    service.close()
    await relay.close()
    cleanup()
  }
})

test('the service reports turn contexts, and the relay tracks them', async () => {
  const { path, cleanup } = socketPath()
  const relay = await ControlServer.open(path)
  const service = client(path)
  try {
    await service.ready
    service.send({ type: 'service' })
    await until(() => relay.connected)
    service.send({ type: 'context', token: 'a', session_id: 's1', turn_id: 't1', app: 'com.apple.finder' })
    service.send({ type: 'context', token: 'b', session_id: 's1', turn_id: 't2', app: 'com.apple.TextEdit' })
    await until(() => relay.contexts.length === 2)

    service.send({ type: 'context-ended', token: 'a' })
    await until(() => relay.contexts.length === 1)
    assert.deepEqual(relay.contexts.map((context) => context.token), ['b'])
  } finally {
    service.close()
    await relay.close()
    cleanup()
  }
})

test('only one service may attach, and losing it is noticed', async () => {
  const { path, cleanup } = socketPath()
  const relay = await ControlServer.open(path)
  const first = client(path)
  const second = client(path)
  try {
    await first.ready
    first.send({ type: 'service' })
    await until(() => relay.connected)
    await second.ready
    second.send({ type: 'service' })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    assert.equal(relay.connected, true)

    // A second claimant is refused rather than allowed to take the channel: two
    // services answering for one runtime would be indistinguishable to a caller.
    first.close()
    await until(() => !relay.connected)
    assert.equal(relay.connected, false, 'the channel is down once its service goes')
  } finally {
    second.close()
    await relay.close()
    cleanup()
  }
})

test('closing removes the socket it served', async () => {
  const { path, cleanup } = socketPath()
  const relay = await ControlServer.open(path)
  try {
    assert.equal(existsSync(path), true)
    await relay.close()
    assert.equal(existsSync(path), false, 'a closed relay leaves nothing behind')
    assert.equal(relay.connected, false)
  } finally {
    cleanup()
  }
})
