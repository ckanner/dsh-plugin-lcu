/**
 * The application locator and the launch environment.
 *
 * The environment is the contract with the original runtime: a wrong or missing
 * variable does not fail loudly, it makes the runtime load a different service or
 * lose its module roots. So the pieces that select behaviour are asserted rather
 * than assumed.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { AppError, buildEnvironment, generationOf, isPrivateFile, planLaunch, resolveApp, skyServicePath } from '../src/app.ts'

/** Every fixture directory this file makes, removed when the file is done. */
const fixtures: string[] = []
after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true })
})

/** A temporary directory that cleans up after itself. */
function fixture(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  fixtures.push(directory)
  return directory
}

const DEFAULT_APP = '/Applications/ChatGPT.app'
const appPresent = existsSync(join(DEFAULT_APP, 'Contents/Resources/cua_node'))
const skip = appPresent ? false : 'the ChatGPT application is not installed'

test('a bundle that is not an application, or is missing its runtime, is refused', () => {
  assert.throws(() => resolveApp('/definitely/not/here.app'), AppError)
  const notAnApp = fixture('dsh-lcu-notapp-')
  assert.throws(() => resolveApp(notAnApp), /not an application bundle/)
  // An .app without the runtime inside is the interesting failure: it looks like
  // an application but cannot provide computer use.
  const emptyApp = join(fixture('dsh-lcu-empty-'), 'Empty.app')
  mkdirSync(join(emptyApp, 'Contents', 'Resources'), { recursive: true })
  assert.throws(() => resolveApp(emptyApp), /no computer-use runtime/)
})

test('a file another account could replace is refused', () => {
  const dir = fixture('dsh-lcu-mode-')
  const privateFile = join(dir, 'private')
  writeFileSync(privateFile, 'x')
  chmodSync(privateFile, 0o600)
  assert.equal(isPrivateFile(privateFile), true)

  const shared = join(dir, 'shared')
  writeFileSync(shared, 'x')
  chmodSync(shared, 0o666)
  assert.equal(isPrivateFile(shared), false, 'a world-writable file must not be trusted')

  const groupShared = join(dir, 'group')
  writeFileSync(groupShared, 'x')
  chmodSync(groupShared, 0o660)
  assert.equal(isPrivateFile(groupShared), false, 'a group-writable file must not be trusted either')

  assert.equal(isPrivateFile(join(dir, 'absent')), false)
  assert.equal(isPrivateFile(dir), false, 'a directory is not a file to execute')
})

test('the environment selects the application runtime, never a wrapper', { skip }, () => {
  const paths = resolveApp()
  assert.ok(paths.version.length > 0)
  assert.match(paths.runtime, /cua_node$/)

  const computer = buildEnvironment(paths, { chrome: false, audio: false, identity: 'probe' })
  // The runtime loads its own modules from here; without these it cannot start.
  assert.equal(computer.NODE_REPL_NODE_PATH, join(paths.runtime, 'bin/node'))
  assert.equal(computer.CUA_REPL_NODE_REPL_PATH, join(paths.runtime, 'bin/node_repl'))
  assert.ok(String(computer.NODE_REPL_NODE_MODULE_DIRS).startsWith(join(paths.runtime, 'lib/node_modules')))
  assert.match(String(computer.NODE_REPL_TRUSTED_CODE_PATHS), /lib\/node_modules/)
  assert.equal(computer.SKY_CUA_SERVICE_PATH, join(paths.runtime, 'lib/node_modules/@oai/sky/Codex Computer Use.app'))
  assert.equal(computer.CODEX_CLI_PATH, join(paths.resources, 'codex-cli/bin/codex'))
  assert.equal(computer.CUA_REPL_BROWSER_ENV, 'codex-app')
  assert.equal(computer.CODEX_HOME, process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  assert.equal(computer.BROWSER_USE_CODEX_APP_VERSION, paths.version)

  // The trusted-service map names this plugin's Sky wrapper, and restates the
  // runtime's own `browser` default when that surface is on. The wrapper exists
  // because the runtime has no turn-ended handler of its own, and a turn that
  // never ends is a turn whose per-application Stop is never released.
  const services = JSON.parse(String(computer.NODE_REPL_TRUSTED_SERVICES)) as Record<string, string>
  assert.equal(services.sky, skyServicePath())
  assert.match(services.sky, /sky-service\.mjs$/)
  assert.ok(existsSync(services.sky ?? ''), 'the wrapper the runtime is told to load must exist')
  assert.equal(services.browser, undefined, 'the browser service is only named when that surface is on')
  assert.equal(
    JSON.parse(String(buildEnvironment(paths, { chrome: true, audio: false }).NODE_REPL_TRUSTED_SERVICES)).browser,
    '@oai/browser-desktop/service',
  )
  // A trusted service is only loaded from a trusted code path, so the wrapper's
  // own directory has to be listed ahead of the runtime's.
  assert.ok(String(computer.NODE_REPL_TRUSTED_CODE_PATHS).startsWith(dirname(services.sky ?? 'x')))
  // The application's own service and client, which the wrapper forwards to and
  // cleans up through, are named separately.
  assert.match(String(computer.DSH_SKY_SERVICE_PATH), /@oai\/sky\/.*\/service\.js$/)
  assert.match(String(computer.DSH_SKY_CLIENT_PATH), /targets\/mac\/client\.js$/)

  // Surfaces are an exact opt-in.
  assert.equal(computer.CUA_REPL_ENABLED_SURFACES, 'computer')
  assert.equal(buildEnvironment(paths, { chrome: true, audio: false }).CUA_REPL_ENABLED_SURFACES, 'browser,computer')

  // Audio is two switches, and absent unless asked for.
  assert.equal(computer.SKY_ENABLE_AUDIO, undefined)
  const audio = buildEnvironment(paths, { chrome: false, audio: true })
  assert.equal(audio.SKY_ENABLE_AUDIO, '1')
  assert.equal(audio.NODE_REPL_ENABLE_AUDIO, '1')

  // The identity the runtime falls back to, used only when a call carries none.
  const identity = JSON.parse(String(computer.NODE_REPL_REQUEST_META)) as {
    'x-codex-turn-metadata': { session_id: string; turn_id: string }
  }
  assert.equal(identity['x-codex-turn-metadata'].session_id, 'probe')
  assert.equal(identity['x-codex-turn-metadata'].turn_id, 'probe-connection')

  // A caller-supplied identity wins, as the original runtime intends.
  process.env.NODE_REPL_REQUEST_META = '{"x-codex-turn-metadata":{"session_id":"caller","turn_id":"t"}}'
  try {
    const kept = buildEnvironment(paths, { chrome: false, audio: false, identity: 'ignored' })
    assert.match(String(kept.NODE_REPL_REQUEST_META), /caller/)
  } finally {
    delete process.env.NODE_REPL_REQUEST_META
  }
})

test('the launch plan starts the application’s own entry point', { skip }, () => {
  const plan = planLaunch({ chrome: false, audio: false, identity: 'probe' })
  assert.equal(plan.command, join(plan.paths.runtime, 'bin/node'))
  assert.equal(plan.args.length, 1)
  assert.match(String(plan.args[0]), /@oai\/cua-repl\/bin\/cua-repl\.mjs$/)
  assert.ok(existsSync(String(plan.args[0])), 'the entry point must exist')
  // The environment travels with the plan: the connection replaces, not layers.
  assert.equal(plan.env.CUA_REPL_ENABLED_SURFACES, 'computer')

  const chrome = planLaunch({ chrome: true, audio: false })
  assert.equal(chrome.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer')
})

test('an explicit command replaces the computed launch', () => {
  const plan = planLaunch({ chrome: true, audio: false, command: '/usr/bin/true' })
  assert.equal(plan.command, '/usr/bin/true')
  assert.deepEqual(plan.args, ['--chrome'])
  // The paths are still resolved, so diagnostics can name the application.
  assert.ok(plan.paths.app.endsWith('.app'))
})

test('the generation fingerprint changes when the application does', { skip }, () => {
  const paths = resolveApp()
  const first = generationOf(paths)
  assert.equal(generationOf(paths), first, 'the same files must produce the same fingerprint')
  // What it is made of: both versions and both timestamps. An update replaces the
  // whole bundle, and a same-version reinstall is still different files.
  assert.ok(first.includes(paths.version))
  assert.ok(first.includes(paths.runtimeVersion))
  assert.equal(first.split('|').length, 4)

  // A path that does not exist is still a fingerprint, and a different one, so a
  // half-removed application is noticed rather than looking unchanged.
  const missing = { ...paths, app: '/nonexistent/ChatGPT.app', runtime: '/nonexistent/cua_node' }
  const other = generationOf(missing)
  assert.notEqual(other, first)
  assert.ok(other.includes('missing'))
})
