#!/usr/bin/env node
/**
 * update-codex.mjs — keep the profile's `@openai/codex` on the newest version
 * that still passes DSH's own compatibility gates.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-subagent-codex` pins `"@openai/codex": "0.153.4"` and resolves
 * the binary from inside its own package (never the host PATH), so the pinned
 * version is not configurable. DSH pins it because `codex app-server` is an
 * experimental protocol: the package README requires regenerating upstream schema
 * evidence and re-running handshake / answer-selection / approval / cancellation
 * tests on any upgrade.
 *
 * This script automates exactly that: it tracks npm `latest`, installs it through
 * a profile-level pnpm override, and only keeps it if three gates pass. A failing
 * version is rolled back to the last verified one automatically.
 *
 * Gates
 * -----
 *   1. handshake — the new binary answers `initialize`
 *   2. schema    — every protocol method/field DSH's wire uses still exists
 *                  (`codex app-server generate-json-schema`)
 *   3. turn      — a real end-to-end Codex turn through app-server returns an
 *                  `agentMessage` with `phase: final_answer`
 *
 * Gate 3 is the definitive one: it exercises auth, model routing, thread/turn
 * lifecycle and answer selection without DSH in the loop.
 *
 * Usage
 * -----
 *   node scripts/update-codex.mjs              # upgrade if a newer release passes
 *   node scripts/update-codex.mjs --check      # report only, change nothing
 *   node scripts/update-codex.mjs --to 0.161.0 # target an explicit version
 *   node scripts/update-codex.mjs --rollback   # restore the last verified version
 *   node scripts/update-codex.mjs --skip-turn  # skip gate 3 (no Codex quota spend)
 *
 * Options: --profile DIR, --pnpm PATH
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE_FILE = join(HERE, 'codex-baseline.json')
const DEFAULT_PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const CODEX_ENTRY = 'node_modules/@openai/codex/bin/codex.js'
// Scope the override to the single edge that needs it. A bare `@openai/codex`
// override ALSO matches the platform packages — they are `npm:@openai/codex@…`
// aliases of the same name — which strips their os/cpu gating and makes pnpm
// fetch every OS/arch payload (~275 MB each).
const OVERRIDE_KEY = '"@deepseek-ai/dsh-subagent-codex>@openai/codex"'
const OVERRIDE_RE = /^\s*"@deepseek-ai\/dsh-subagent-codex>@openai\/codex":.*$/m
const APP_PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs'

/**
 * The protocol surface dsh-subagent-codex/src/wire.ts actually uses.
 * Gate 2 fails if any of these disappears.
 *
 * Method unions live in the standalone per-type files (`ClientRequest.json`,
 * `ServerNotification.json`, `ServerRequest.json`); parameter definitions live
 * in the combined `*.schemas.json` bundles (v2 first, then the legacy one,
 * because a few definitions — e.g. `ServerRequest` — only exist there).
 */
const REQUIRED_METHODS = {
  'ClientRequest.json': ['initialize', 'thread/start', 'turn/start', 'turn/interrupt'],
  'ServerNotification.json': ['turn/started', 'turn/completed', 'item/completed'],
  'ServerRequest.json': [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ],
}

const REQUIRED_FIELDS = [
  ['InitializeCapabilities', ['experimentalApi', 'requestAttestation']],
  ['ThreadStartParams', ['cwd', 'ephemeral', 'model', 'approvalPolicy', 'approvalsReviewer', 'sandbox']],
  ['TurnStartParams', ['input', 'threadId']],
  ['TurnInterruptParams', ['threadId', 'turnId']],
]

/** Enum values DSH maps permission modes onto. */
const REQUIRED_ENUMS = [
  ['AskForApproval', ['never', 'on-request']],
  ['SandboxMode', ['read-only', 'workspace-write', 'danger-full-access']],
  ['MessagePhase', ['final_answer', 'commentary']],
]

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...args) => process.stderr.write(`${args.join(' ')}\n`)

function run(command, args, options = {}) {
  // stdin must be closed, not merely piped: pnpm (and the app-server) block
  // forever on an open, never-written stdin pipe that the parent never closes.
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function installedCodexVersion(profile) {
  return readJson(join(profile, CODEX_ENTRY, '..', '..', 'package.json')).version
}

function latestPublishedVersion() {
  const result = run('npm', ['view', '@openai/codex', 'version'])
  if (result.status !== 0) throw new Error(`npm view failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

// ---------------------------------------------------------------------------
// The pnpm override lives in the profile's pnpm-workspace.yaml (pnpm >= 10).
// ---------------------------------------------------------------------------

function readOverride(text) {
  const match = text.match(/^\s*"@deepseek-ai\/dsh-subagent-codex>@openai\/codex":\s*"?([^"\s]+)"?\s*$/m)
  return match?.[1]
}

function writeOverride(text, version, key = OVERRIDE_KEY) {
  const line = `  ${key}: "${version}"`
  if (OVERRIDE_RE.test(text)) {
    return text.replace(OVERRIDE_RE, line.trimStart())
  }
  if (/^overrides:/m.test(text)) {
    return text.replace(/^overrides:\s*$/m, `overrides:\n${line}`)
  }
  return `${text.replace(/\s*$/, '')}\n\noverrides:\n${line}\n`
}

function removeOverride(text) {
  return text
    .replace(/^\s*"@deepseek-ai\/dsh-subagent-codex>@openai\/codex":.*\n?/m, '')
    .replace(/^overrides:\s*\n(?=\s*\n|\s*$)/m, '')
}

// ---------------------------------------------------------------------------
// app-server JSON-RPC over newline-delimited stdio (same framing as wire.ts)
// ---------------------------------------------------------------------------

class AppServer {
  constructor(binary, { cwd = tmpdir(), label = 'codex' } = {}) {
    this.label = label
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    this.stderr = ''
    this.child = spawn(process.execPath, [binary, 'app-server', '--stdio'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`${label}: app-server exited (${code})`))
      }
      this.pending.clear()
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.#dispatch(line))
  }

  #dispatch(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return // non-JSON chatter on stdout is not protocol traffic
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${this.label}: ${JSON.stringify(message.error)}`))
      else entry.resolve(message.result)
      return
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners) listener(message)
    }
  }

  onNotification(listener) {
    this.listeners.push(listener)
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  close() {
    this.child.kill('SIGTERM')
  }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

async function gateHandshake(binary) {
  const server = new AppServer(binary, { label: 'gate1' })
  try {
    const result = await server.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, 30_000)
    if (typeof result?.userAgent !== 'string') throw new Error('initialize returned no userAgent')
    return result.userAgent
  } finally {
    server.close()
  }
}

function gateSchema(binary) {
  const out = mkdtempSync(join(tmpdir(), 'codex-schema-'))
  try {
    const result = run(process.execPath, [binary, 'app-server', 'generate-json-schema', '--out', out], { timeout: 120_000 })
    if (result.status !== 0) throw new Error(`generate-json-schema failed: ${result.stderr.trim().slice(0, 400)}`)
    const files = new Set(readdirSync(out))
    const failures = []

    // 1. Method unions, straight from the per-type files.
    for (const [file, methods] of Object.entries(REQUIRED_METHODS)) {
      if (!files.has(file)) { failures.push(`missing schema file: ${file}`); continue }
      const node = readJson(join(out, file))
      const present = new Set((node.oneOf ?? []).map((variant) => variant?.properties?.method?.enum?.[0]))
      for (const method of methods) if (!present.has(method)) failures.push(`missing in ${file}: ${method}`)
    }

    // 2. Parameter definitions: v2 bundle first, legacy bundle as fallback.
    const bundles = ['codex_app_server_protocol.v2.schemas.json', 'codex_app_server_protocol.schemas.json']
      .filter((name) => files.has(name))
    if (bundles.length === 0) throw new Error('no combined *.schemas.json in the generated bundle')
    const defs = Object.assign({}, ...bundles.slice().reverse().map((name) => readJson(join(out, name)).definitions ?? {}))

    for (const [definition, fields] of REQUIRED_FIELDS) {
      const node = defs[definition]
      if (node === undefined) { failures.push(`missing definition ${definition}`); continue }
      const props = new Set(Object.keys(node.properties ?? {}))
      for (const field of fields) if (!props.has(field)) failures.push(`missing ${definition}.${field}`)
    }
    for (const [definition, values] of REQUIRED_ENUMS) {
      const node = defs[definition]
      if (node === undefined) { failures.push(`missing definition ${definition}`); continue }
      const serialized = JSON.stringify(node)
      for (const value of values) if (!serialized.includes(`"${value}"`)) failures.push(`missing ${definition} value: ${value}`)
    }

    // 3. The text user-input variant, its text_elements field, and the agent message phase.
    const textVariant = defs.UserInput?.oneOf?.find((variant) => variant?.properties?.type?.enum?.[0] === 'text')
    if (textVariant === undefined) failures.push('missing UserInput text variant')
    else {
      for (const field of ['text', 'text_elements', 'type']) {
        if (!(field in (textVariant.properties ?? {}))) failures.push(`missing UserInput text.${field}`)
      }
    }
    const agentMessage = defs.ThreadItem?.oneOf?.find((variant) => variant?.properties?.type?.enum?.[0] === 'agentMessage')
    if (agentMessage === undefined) failures.push('missing ThreadItem agentMessage variant')
    else if (!('phase' in (agentMessage.properties ?? {}))) failures.push('missing ThreadItem.agentMessage.phase')

    if (failures.length > 0) throw new Error(`protocol surface changed:\n  - ${failures.join('\n  - ')}`)
    return `${Object.keys(defs).length} definitions, all required methods/fields present`
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

async function gateTurn(binary) {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-turn-'))
  const server = new AppServer(binary, { cwd, label: 'gate3' })
  try {
    await server.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, 30_000)
    server.notify('initialized')

    const threadResponse = await server.request('thread/start', {
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
    }, 60_000)
    const threadId = threadResponse?.thread?.id
    if (threadResponse?.thread?.ephemeral !== true) throw new Error('thread/start did not create an ephemeral thread')
    if (typeof threadId !== 'string') throw new Error('thread/start returned no thread id')

    let finalAnswer
    let unphased
    let resolveTurn
    const completed = new Promise((resolve) => { resolveTurn = resolve })
    const notices = []
    server.onNotification((message) => {
      const params = message.params ?? {}
      if (message.method === 'error') notices.push(`error: ${JSON.stringify(params).slice(0, 300)}`)
      if (params.threadId !== undefined && params.threadId !== threadId) return
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
        const text = params.item.text ?? ''
        if (params.item.phase === 'final_answer') finalAnswer = text
        else if (params.item.phase === null) unphased = text
      }
      if (message.method === 'turn/completed') resolveTurn({ turn: params.turn, notices, stderr: server.stderr })
    })

    await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Reply with exactly the two characters: OK', text_elements: [] }],
    }, 60_000)

    const outcome = await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('turn/completed never arrived within 240s')), 240_000)),
    ])
    const { turn } = outcome
    if (turn?.status !== 'completed') {
      throw new Error([
        `turn status was ${JSON.stringify(turn?.status)}`,
        `turn: ${JSON.stringify(turn).slice(0, 600)}`,
        ...outcome.notices.slice(-5),
        outcome.stderr.trim() === '' ? 'stderr: (empty)' : `stderr: ${outcome.stderr.trim().slice(-500)}`,
      ].join('\n     '))
    }
    const answer = finalAnswer ?? unphased
    if (answer === undefined) throw new Error('no agentMessage answer reached the terminal turn')
    return { answer: answer.trim().slice(0, 120), phased: finalAnswer !== undefined }
  } finally {
    server.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    profile: DEFAULT_PROFILE,
    check: false,
    skipTurn: false,
    rollback: false,
    verifyOnly: false,
    to: undefined,
    pnpm: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--skip-turn') opts.skipTurn = true
    else if (arg === '--rollback') opts.rollback = true
    else if (arg === '--verify-only') opts.verifyOnly = true
    else if (arg === '--to') opts.to = argv[++i]
    else if (arg === '--profile') opts.profile = argv[++i]
    else if (arg === '--pnpm') opts.pnpm = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function applyOverride(profile, version) {
  const path = join(profile, 'pnpm-workspace.yaml')
  const before = readFileSync(path, 'utf8')
  writeFileSync(path, writeOverride(before, version), { mode: 0o600 })
  return before
}

function install(profile, runner) {
  log(`  pnpm install (${runner.length > 1 ? 'app-bundled pnpm 11' : runner[0]}) …`)
  // `--no-frozen-lockfile` is required: changing `overrides` must rewrite the
  // lockfile, and `CI=true` (set below to avoid interactive aborts) otherwise
  // implies a frozen install and fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
  const result = run(runner[0], [...runner.slice(1), 'install', '--no-frozen-lockfile'], {
    cwd: profile,
    timeout: 900_000,
    env: { ...process.env, CI: 'true' },
  })
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('NPM_TOKEN'))
      .slice(-25)
      .join('\n')
    throw new Error(`pnpm install failed (${result.status}):\n${detail}`)
  }
}

/**
 * Resolve the pnpm the Harness plugin manager itself uses. The app bundles its
 * own (11.x); a newer/older PATH pnpm can decide the existing profile's
 * `node_modules` came from an incompatible version and refuse to continue
 * without a TTY (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
 * @returns argv prefix, e.g. `[node, pnpm.cjs]` or `[pnpm]`
 */
function resolvePnpm(explicit) {
  if (explicit !== undefined) return [explicit]
  if (existsSync(APP_PNPM)) return [process.execPath, APP_PNPM]
  return ['pnpm']
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const baseline = existsSync(BASELINE_FILE) ? readJson(BASELINE_FILE) : undefined
  const current = installedCodexVersion(opts.profile)
  const target = opts.rollback ? baseline?.codex : (opts.to ?? latestPublishedVersion())
  if (target === undefined) throw new Error('nothing to roll back to: no baseline recorded')

  log(`profile:  ${opts.profile}`)
  log(`current:  ${current}  (installed)`)
  log(`baseline: ${baseline?.codex ?? '<none recorded>'}`)
  log(`target:   ${target}`)

  if (current === target && !opts.rollback && !opts.verifyOnly) {
    log(`\n已是最新且已通过验证的版本，无需操作。`)
    return
  }
  if (opts.check) {
    log(`\n--check: 目标版本与当前不同，未做任何改动。`)
    return
  }

  const previous = baseline?.codex ?? current
  const binary = join(opts.profile, CODEX_ENTRY)
  const runner = resolvePnpm(opts.pnpm)

  // Verify the version already on disk without touching the override or pnpm.
  if (opts.verifyOnly) {
    try {
      log('\n[gate 1/3] handshake')
      log(`  ok — ${await gateHandshake(binary)}`)
      log('[gate 2/3] protocol schema')
      log(`  ok — ${gateSchema(binary)}`)
      if (opts.skipTurn) {
        log('[gate 3/3] real turn — SKIPPED (--skip-turn)')
      } else {
        log('[gate 3/3] real turn (spends a little Codex quota)')
        const turn = await gateTurn(binary)
        log(`  ok — answer ${JSON.stringify(turn.answer)}${turn.phased ? ' (phase: final_answer)' : ' (unphased fallback)'}`)
      }
      writeFileSync(BASELINE_FILE, `${JSON.stringify({
        codex: current,
        verifiedAt: new Date().toISOString(),
        previous,
        gates: { handshake: 'ok', schema: 'ok', turn: opts.skipTurn ? 'skipped' : 'ok' },
      }, null, 2)}\n`)
      log(`\n✅ ${current} 已就地验证通过（未改动任何东西）`)
    } catch (error) {
      log(`\n❌ ${current} 未通过：${error.message}`)
      process.exitCode = 1
    }
    return
  }

  const beforeWorkspace = applyOverride(opts.profile, target)
  let applied = false
  try {
    install(opts.profile, runner)
    applied = true
    const installed = installedCodexVersion(opts.profile)
    if (installed !== target) throw new Error(`override did not take effect: installed ${installed}, wanted ${target}`)

    log('\n[gate 1/3] handshake')
    const userAgent = await gateHandshake(binary)
    log(`  ok — ${userAgent}`)

    log('[gate 2/3] protocol schema')
    log(`  ok — ${gateSchema(binary)}`)

    if (opts.skipTurn) {
      log('[gate 3/3] real turn — SKIPPED (--skip-turn)')
    } else {
      log('[gate 3/3] real turn (spends a little Codex quota)')
      const turn = await gateTurn(binary)
      log(`  ok — answer ${JSON.stringify(turn.answer)}${turn.phased ? ' (phase: final_answer)' : ' (unphased fallback)'}`)
    }

    writeFileSync(BASELINE_FILE, `${JSON.stringify({
      codex: target,
      verifiedAt: new Date().toISOString(),
      previous,
      gates: { handshake: 'ok', schema: 'ok', turn: opts.skipTurn ? 'skipped' : 'ok' },
    }, null, 2)}\n`)
    log(`\n✅ 升级到 ${target} 并通过验证，已记录到 scripts/codex-baseline.json`)
  } catch (error) {
    log(`\n❌ ${target} 未通过：${error.message}`)
    log(`↩️  回退到 ${previous}`)
    void applied
    // Always restore verbatim: writing an override that pins the *old* version
    // would leave the profile changed by a failed run.
    writeFileSync(join(opts.profile, 'pnpm-workspace.yaml'), beforeWorkspace, { mode: 0o600 })
    try {
      install(opts.profile, runner)
      log(`   回退完成，当前版本 ${installedCodexVersion(opts.profile)}`)
    } catch (rollbackError) {
      log(`   ⚠️ 回退安装失败：${rollbackError.message}`)
      log(`   请手动恢复 ${join(opts.profile, 'pnpm-workspace.yaml')}`)
    }
    process.exitCode = 1
  }
}

await main()
