#!/usr/bin/env node
/**
 * probe-lcu.mjs — talk to the computer-use runtime directly.
 *
 * A diagnostic for `dsh-plugin-lcu` development: it builds the same launch plan
 * the plugin builds, connects the way the plugin does (newline-delimited
 * JSON-RPC over stdio, `capabilities.elicitation` declared), prints what the
 * server advertises, and optionally calls one tool. No harness is involved, so
 * this separates a plugin problem from a runtime problem.
 *
 * Usage
 * -----
 *   node scripts/probe-lcu.mjs                          # initialize + tools/list
 *   node scripts/probe-lcu.mjs --instructions           # also dump server instructions
 *   node scripts/probe-lcu.mjs --call js --code 'await cua.getState();'
 *   node scripts/probe-lcu.mjs --chrome                 # enable the browser surface
 *   node scripts/probe-lcu.mjs --app /path/ChatGPT.app  # a different installation
 *   node scripts/probe-lcu.mjs --command /path/binary   # bypass the computed launch
 *
 * It never answers elicitations, so any call that needs an approval fails closed
 * exactly like a host that cannot present the request.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { planLaunch } from '../lib/app.js'

/** Newest protocol revision the MCP SDK pair here is expected to negotiate. */
const PROTOCOL_VERSION = '2025-06-18'

function parseArgs(argv) {
  const opts = {
    app: undefined, command: undefined, chrome: false, audio: false,
    instructions: false, call: undefined, code: undefined, limit: 2000,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--app') opts.app = argv[++i]
    else if (arg === '--command') opts.command = argv[++i]
    else if (arg === '--chrome') opts.chrome = true
    else if (arg === '--audio') opts.audio = true
    else if (arg === '--instructions') opts.instructions = true
    else if (arg === '--call') opts.call = argv[++i]
    else if (arg === '--code') opts.code = argv[++i]
    else if (arg === '--limit') opts.limit = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

/** One request/response session with the computer-use runtime. */
class LcuSession {
  constructor(plan) {
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.stderr = ''
    this.child = spawn(plan.command, [...plan.args], { stdio: ['pipe', 'pipe', 'pipe'], env: plan.env })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`the runtime exited (${code})\n${this.stderr.slice(-800)}`))
      this.pending.clear()
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.#onLine(line))
  }

  #onLine(line) {
    if (line.trim() === '') return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
      return
    }
    this.notifications.push(message)
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
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

  close() { this.child.kill('SIGTERM') }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const plan = planLaunch({
    ...(opts.app === undefined ? {} : { appPath: opts.app }),
    ...(opts.command === undefined ? {} : { command: opts.command }),
    chrome: opts.chrome,
    audio: opts.audio,
    identity: 'dsh-plugin-lcu-probe',
  })
  console.log('=== launch plan ===')
  console.log(`  app:      ${plan.paths.app}`)
  console.log(`  version:  ${plan.paths.version}`)
  console.log(`  runtime:  ${plan.paths.runtimeVersion}`)
  console.log(`  command:  ${plan.command}`)
  console.log(`  args:     ${JSON.stringify(plan.args)}`)
  console.log(`  surfaces: ${String(plan.env.CUA_REPL_ENABLED_SURFACES)}`)
  const session = new LcuSession(plan)
  try {
    const initialized = await session.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: { name: 'dsh-plugin-lcu-probe', version: '0.0.1' },
    }, 120_000)
    console.log('=== initialize ===')
    console.log(JSON.stringify({
      protocolVersion: initialized.protocolVersion,
      serverInfo: initialized.serverInfo,
      capabilities: initialized.capabilities,
      instructionBytes: initialized.instructions?.length ?? 0,
    }, null, 2))

    if (opts.instructions) {
      console.log('\n=== instructions ===')
      console.log(initialized.instructions ?? '(none)')
    }

    session.notify('notifications/initialized')

    const listed = await session.request('tools/list', {}, 120_000)
    console.log('\n=== tools ===')
    for (const tool of listed.tools ?? []) {
      const required = tool.inputSchema?.required ?? []
      const props = Object.keys(tool.inputSchema?.properties ?? {})
      console.log(`  ${tool.name.padEnd(26)} required=[${required.join(',')}] props=[${props.join(',')}]`)
    }
    const hostOnly = (listed.tools ?? []).filter((tool) => tool.name !== 'js' && tool.name !== 'js_reset')
    if (hostOnly.length > 0) {
      console.log(`\n  ⚠ host-only tools that must NOT reach the model: ${hostOnly.map((t) => t.name).join(', ')}`)
    }

    if (opts.call !== undefined) {
      console.log(`\n=== tools/call ${opts.call} ===`)
      const result = await session.request('tools/call', {
        name: opts.call,
        arguments: opts.code === undefined ? {} : { code: opts.code },
      }, 300_000)
      const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
      console.log(`isError: ${result.isError === true}`)
      console.log(text.slice(0, opts.limit) || `(no text; content types: ${(result.content ?? []).map((i) => i.type).join(',')})`)
      if (text.length > opts.limit) console.log(`… (${text.length - opts.limit} more chars; raise --limit)`)
    }

    if (session.notifications.length > 0) {
      console.log(`\n=== ${session.notifications.length} notification(s) ===`)
      for (const note of session.notifications.slice(0, 5)) console.log(`  ${note.method}`)
    }
  } finally {
    session.close()
  }
}

await main()
