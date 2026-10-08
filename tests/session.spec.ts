/**
 * The connection facade that follows the application across an update.
 *
 * The runtime is executed from files the ChatGPT application replaces when it
 * updates, so a long session can otherwise run a mix of two generations. The
 * cases that matter are the ones where getting it wrong is silent: a reconnect
 * that never happens, two reconnects racing into two runtimes, and a failed
 * reconnect that takes a working session down with it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { LcuConnection } from '../src/connection.ts'
import { ManagedSession } from '../src/session.ts'

interface Fake {
  readonly connection: LcuConnection
  /** Calls the connection received, as `name` or `name:arg`. */
  readonly calls: string[]
  /** Whether this connection has been closed. */
  readonly closed: () => boolean
}

let counter = 0
function fakeConnection(options: { readonly failConnect?: boolean } = {}): Fake {
  counter += 1
  const id = counter
  const calls: string[] = []
  let closed = false
  const connection = {
    sessionId: `session-${String(id)}`,
    hasHostControl: false,
    modelTools: () => [],
    async callTool(name: string) { calls.push(`callTool:${name}`); return { content: [], isError: false } },
    async turnEnded(sessionId: string, turnId: string) { calls.push(`turnEnded:${sessionId}/${turnId}`) },
    async controlStatus() { calls.push('controlStatus'); return [] },
    async controlStop(_s: string, _t: string, app: string) { calls.push(`controlStop:${app}`) },
    async close() { closed = true },
  } as unknown as LcuConnection
  if (options.failConnect === true) throw new Error('connect failed')
  return { connection, calls, closed: () => closed }
}

/** A session whose generation the test controls. */
async function openSession(overrides: {
  readonly failRegenerate?: boolean
  readonly onRegenerated?: (t: { from: string; to: string }) => void
  readonly onRegenerateFailed?: (error: unknown) => void
} = {}): Promise<{ session: ManagedSession; opened: Fake[]; setGeneration(value: string): void }> {
  const opened: Fake[] = []
  let generation = 'generation-1'
  const session = await ManagedSession.open({
    connect: async (reason) => {
      // A replacement that is told to fail fails, so the previous connection has
      // to survive it.
      const created = fakeConnection({ failConnect: reason === 'regenerated' && overrides.failRegenerate === true })
      opened.push(created)
      return created.connection
    },
    generation: () => generation,
    ...(overrides.onRegenerated === undefined ? {} : { onRegenerated: overrides.onRegenerated }),
    ...(overrides.onRegenerateFailed === undefined ? {} : { onRegenerateFailed: overrides.onRegenerateFailed }),
  })
  return { session, opened, setGeneration: (value: string) => { generation = value } }
}

test('an unchanged application keeps the one connection', async () => {
  const { session, opened } = await openSession()
  try {
    await session.callTool('js', {})
    await session.callTool('js', {})
    assert.equal(opened.length, 1, 'no replacement when nothing changed')
    assert.deepEqual(opened[0]?.calls, ['callTool:js', 'callTool:js'])
    assert.equal(session.sessionId, opened[0]?.connection.sessionId)
  } finally {
    await session.close()
  }
})

test('a changed application replaces the connection, and only once', async () => {
  const seen: { from: string; to: string }[] = []
  const { session, opened, setGeneration } = await openSession({ onRegenerated: (t) => seen.push(t) })
  try {
    await session.callTool('js', {})
    setGeneration('generation-2')

    // Two calls that both notice the change must produce one replacement, not
    // two runtimes.
    await Promise.all([session.callTool('js', {}), session.callTool('js', {})])
    assert.equal(opened.length, 2, 'exactly one replacement')
    assert.equal(opened[0]?.closed(), true, 'the stale connection is retired')
    assert.equal(opened[1]?.closed(), false)
    assert.equal(session.sessionId, opened[1]?.connection.sessionId, 'later calls use the replacement')
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { from: 'generation-1', to: 'generation-2' })

    // And it does not reconnect again until the application changes again.
    await session.callTool('js', {})
    assert.equal(opened.length, 2)
  } finally {
    await session.close()
  }
})

test('every delegated call goes through the replacement', async () => {
  const { session, opened, setGeneration } = await openSession()
  try {
    setGeneration('generation-2')
    await session.turnEnded('s', 't')
    await session.controlStatus('s', 't')
    await session.controlStop('s', 't', 'com.apple.finder')
    assert.equal(opened.length, 2)
    assert.deepEqual(opened[1]?.calls, ['turnEnded:s/t', 'controlStatus', 'controlStop:com.apple.finder'])
    assert.deepEqual(opened[0]?.calls, [], 'the stale connection received nothing')
  } finally {
    await session.close()
  }
})

test('a failed replacement leaves the working session alone', async () => {
  const failures: unknown[] = []
  const { session, opened, setGeneration } = await openSession({
    failRegenerate: true,
    onRegenerateFailed: (error) => failures.push(error),
  })
  try {
    await session.callTool('js', {})
    setGeneration('generation-2')
    // The call still succeeds on the connection that is still alive.
    await session.callTool('js', {})
    assert.equal(failures.length, 1, 'the failure is reported rather than swallowed')
    assert.equal(opened[0]?.closed(), false, 'the previous connection keeps working')
    assert.deepEqual(opened[0]?.calls, ['callTool:js', 'callTool:js'])
    // A later call retries, so a transient failure is not permanent.
    await session.callTool('js', {})
    assert.equal(failures.length, 2)
  } finally {
    await session.close()
  }
})

test('an unreadable application keeps the connection and is only reported', async () => {
  const failures: unknown[] = []
  let generation = 'generation-1'
  const opened: Fake[] = []
  const session = await ManagedSession.open({
    connect: async () => {
      const created = fakeConnection()
      opened.push(created)
      return created.connection
    },
    generation: () => {
      if (generation === 'broken') throw new Error('the application is unreadable')
      return generation
    },
    onGenerationUnreadable: (error) => failures.push(error),
  })
  try {
    await session.callTool('js', {})
    generation = 'broken'
    await session.callTool('js', {})
    // Mid-update the bundle can be briefly unreadable. Treating that as "it
    // changed" would start a second runtime for no reason, so the call keeps
    // using the connection that works and the read failure is only reported.
    assert.deepEqual(opened[0]?.calls, ['callTool:js', 'callTool:js'])
    assert.equal(opened.length, 1, 'an unreadable fingerprint must not open a second runtime')
    assert.equal(failures.length, 1, 'the read failure is reported once, for the one check that saw it')
    // And it recovers once the fingerprint is readable again.
    generation = 'generation-1'
    await session.callTool('js', {})
    assert.equal(opened.length, 1)
  } finally {
    await session.close()
  }
})

test('the session identity survives a replacement', async () => {
  const { session, opened, setGeneration } = await openSession()
  try {
    // The runtime keys its per-turn state by this identity, so a replacement
    // connection that had not been told it would send calls it cannot attribute.
    session.sessionId = 'the-real-session'
    setGeneration('generation-2')
    await session.callTool('js', {})
    assert.equal(opened.length, 2)
    assert.equal(opened[1]?.connection.sessionId, 'the-real-session')
    assert.equal(session.sessionId, 'the-real-session')
  } finally {
    await session.close()
  }
})

test('closing retires the connection and refuses later calls', async () => {
  const { session, opened } = await openSession()
  await session.callTool('js', {})
  await session.close()
  assert.equal(opened[0]?.closed(), true)
  await assert.rejects(() => session.callTool('js', {}), /closed/)
  // Closing twice is not an error, and does not resurrect anything.
  await session.close()
  assert.equal(opened.length, 1)
})

test('the delegated surface reflects the current connection', async () => {
  const { session, opened, setGeneration } = await openSession()
  try {
    assert.equal(session.sessionId, opened[0]?.connection.sessionId)
    assert.equal(session.hasHostControl, false)
    assert.deepEqual(session.modelTools(), [])
    setGeneration('generation-2')
    await session.callTool('js', {})
    assert.equal(session.sessionId, opened[1]?.connection.sessionId)
    assert.equal(opened.length, 2)
  } finally {
    await session.close()
  }
})
