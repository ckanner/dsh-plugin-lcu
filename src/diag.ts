/**
 * Best-effort diagnostic log for the LCU attach path.
 *
 * The harness exposes plugin logs only through surfaces a running session
 * cannot read, and a failing `agent/created` listener is swallowed silently. So
 * the attach decision writes here: one line per branch, including the errors
 * that would otherwise vanish. It never throws and never changes behavior.
 *
 * Set `LCU_DIAG=0` to disable. The file is `~/.dsh/lcu-diag.log`.
 *
 * @module dsh-plugin-lcu/diag
 */

import { appendFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lcu-diag.log')

/** Rotate rather than grow without bound: the log records one line per decision. */
const MAX_BYTES = 1_048_576

/** Append one diagnostic line; silently does nothing if the file cannot be written. */
export function diag(message: string): void {
  if (process.env.LCU_DIAG === '0') return
  try {
    // Start over once the file is full; this is a rolling support aid, not a log
    // of record, and truncating keeps it bounded without a rotation scheme.
    if ((statSync(LOG_PATH, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) rmSync(LOG_PATH, { force: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never affect the capability they describe.
  }
}

/** Describe a value for the log without dumping unbounded data. */
export function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'function') return 'function'
  if (Array.isArray(value)) return `array(${String(value.length)})`
  if (typeof value === 'object') return `object{${Object.keys(value).slice(0, 8).join(',')}}`
  return typeof value
}
