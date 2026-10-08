/**
 * The agent-host guard.
 *
 * The application hosting the agent is refused, because
 * computer use can click anything an approved app shows — including the very
 * approval prompt — so approving the host would let the agent approve itself.
 *
 * The runtime's own shared client does this; a host that replaces that client owns the
 * rule. This is the DSH implementation: the agent's own process ancestry plus a
 * static list of dedicated agent hosts and terminals.
 *
 * A failed or unavailable process lookup falls back to the static list, so the
 * guard degrades to "known hosts are refused" rather than "nothing is refused".
 *
 * @module dsh-plugin-lcu/host-guard
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Dedicated agent hosts, terminals, and this harness.
 *
 * Editors and IDEs are deliberately absent: they are common computer-use
 * targets, and when an editor hosts the agent its bundle is an ancestor of this
 * process, which the dynamic check already refuses.
 */
export const STATIC_HOST_BUNDLE_IDS: readonly string[] = [
  'com.deepseek.dsh',
  'com.anthropic.claudefordesktop',
  'com.anthropic.claude-code',
  'com.openai.codex',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'com.github.wez.wezterm',
  'io.alacritty',
  'net.kovidgoyal.kitty',
  'co.zeit.hyper',
  'com.raphaelamorim.rio',
  'dev.commandline.wave',
]

/** Set `LCU_ALLOW_AGENT_HOST_APPROVAL=1` to disable the guard for testing only. */
const OVERRIDE_ENV = 'LCU_ALLOW_AGENT_HOST_APPROVAL'

let cachedAncestorBundles: Promise<ReadonlySet<string>> | undefined

/** Run a command, resolving to its trimmed stdout or `undefined` on any failure. */
function tryExec(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile(command, [...args], { timeout: 5_000 }, (error, stdout) => {
      resolvePromise(error === null ? stdout.trim() : undefined)
    })
  })
}

/** The enclosing `.app` bundle of an executable path, if any. */
export function enclosingAppBundle(executablePath: string): string | undefined {
  let current = resolve(executablePath)
  for (;;) {
    if (current.endsWith('.app')) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Read one bundle identifier, preferring the modern plist helper. */
async function bundleIdentifier(appPath: string): Promise<string | undefined> {
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return undefined
  const value = await tryExec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * The bundle identifiers of every `.app` on this process's ancestry.
 *
 * This is the dynamic half of the guard: whatever application actually launched
 * DSH — a terminal, an editor, a launcher — is refused by construction, even
 * when it is not on the static list.
 *
 * @returns the ancestor bundle identifiers; empty when the lookup fails.
 */
export async function ancestorBundleIds(): Promise<ReadonlySet<string>> {
  cachedAncestorBundles ??= (async () => {
    const found = new Set<string>()
    let pid = process.pid
    for (let depth = 0; depth < 24; depth += 1) {
      const parentText = await tryExec('ps', ['-o', 'ppid=', '-p', String(pid)])
      const executable = await tryExec('ps', ['-o', 'comm=', '-p', String(pid)])
      if (executable !== undefined) {
        const bundle = enclosingAppBundle(executable)
        if (bundle !== undefined) {
          const id = await bundleIdentifier(bundle)
          if (id !== undefined) found.add(id)
        }
      }
      const parent = Number(parentText)
      if (!Number.isInteger(parent) || parent <= 1) break
      pid = parent
    }
    return found
  })()
  return await cachedAncestorBundles
}

/**
 * Whether an approval would grant the agent control of its own host.
 *
 * @param app - the app the runtime is asking about: a display name, bundle id, or path.
 * @returns `true` when the request must be declined without asking the user.
 */
export async function isAgentHostApp(app: string): Promise<boolean> {
  if (process.env[OVERRIDE_ENV] === '1') return false
  const candidate = app.trim()
  if (candidate === '') return false

  // A path is decided by its own bundle, not by the ancestor set.
  if (candidate.includes('/')) {
    const bundle = enclosingAppBundle(candidate)
    const id = bundle === undefined ? undefined : await bundleIdentifier(bundle)
    if (id !== undefined && STATIC_HOST_BUNDLE_IDS.includes(id)) return true
    const ancestors = await ancestorBundleIds()
    return id !== undefined && ancestors.has(id)
  }

  if (STATIC_HOST_BUNDLE_IDS.includes(candidate)) return true
  const ancestors = await ancestorBundleIds()
  return ancestors.has(candidate)
}

/** Reset the memoized ancestry; for tests only. */
export function resetAncestorCache(): void {
  cachedAncestorBundles = undefined
}
