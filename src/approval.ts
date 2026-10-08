/**
 * Approval shapes.
 *
 * The runtime asks the host before it touches an app, and the request
 * is a specific `elicitation/create` form. This ports the recognition and
 * mapping rules from the runtime's shared client so a DSH host presents exactly the
 * choices the runtime offered — no more (granting an unoffered persistence scope
 * would let the agent keep desktop access the runtime meant to bound) and no
 * fewer (dropping `always` would nag the user every turn).
 *
 * @module dsh-plugin-lcu/approval
 */

import type { LcuElicitationRequest, LcuElicitationResponse } from './connection.ts'

/** One choice a native-app approval may offer. */
export interface ApprovalChoice {
  readonly value: 'once' | 'session' | 'always' | 'decline'
  readonly label: string
}

/** A recognized native-app approval request. */
export interface NativeAppApproval {
  readonly message: string
  readonly resource: string
  readonly choices: readonly ApprovalChoice[]
}

/** Persistence scopes the runtime can offer, in the order it presents them. */
const PERSISTENCE: readonly (readonly ['session' | 'always', string])[] = [
  ['session', 'Allow for this session'],
  ['always', 'Always allow'],
]

/** The browser-origin approval's metadata key. */
const ORIGIN_TOOL_NAME = 'access_browser_origin'

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined

/**
 * Recognize the runtime's native-app approval request.
 *
 * The shape is deliberately narrow: an empty-schema form whose `_meta` names the
 * computer-use connector and a concrete app. Every other elicitation the server
 * may send is *not* this, and must be handled elsewhere or cancelled.
 *
 * @param request - one `elicitation/create` payload.
 * @returns the recognized request, or `undefined` when it is a different shape.
 */
export function nativeAppApproval(request: LcuElicitationRequest): NativeAppApproval | undefined {
  const meta = asObject(request._meta)
  const schema = asObject(request.requestedSchema)
  const properties = asObject(schema?.properties)
  const app = asObject(meta?.tool_params)?.app
  if (request.mode !== 'form') return undefined
  if (typeof request.message !== 'string' || request.message === '') return undefined
  if (schema?.type !== 'object' || properties === undefined) return undefined
  if (Object.keys(properties).length !== 0) return undefined
  const required = schema.required
  if (required !== undefined && (!Array.isArray(required) || required.length !== 0)) return undefined
  if (meta?.codex_approval_kind !== 'mcp_tool_call') return undefined
  if (meta?.connector_id !== 'computer-use') return undefined
  if (typeof app !== 'string' || app === '') return undefined

  const requested = new Set(Array.isArray(meta?.persist) ? meta.persist as string[] : [])
  const choices: ApprovalChoice[] = [{ value: 'once', label: 'Allow once' }]
  for (const [value, label] of PERSISTENCE) {
    if (requested.has(value)) choices.push({ value, label })
  }
  choices.push({ value: 'decline', label: 'Decline' })
  return { message: request.message, resource: app, choices }
}

/**
 * Map the user's choice back to the response the runtime accepts.
 *
 * @param request - the same payload the choices came from.
 * @param value - the chosen value, or `'cancel'` for a dismissed prompt.
 * @returns an accept/decline/cancel answer; anything unrecognized cancels.
 */
export function nativeAppApprovalResponse(
  request: LcuElicitationRequest,
  value: string,
): LcuElicitationResponse {
  const approval = nativeAppApproval(request)
  if (approval === undefined) return { action: 'cancel' }
  if (value === 'cancel') return { action: 'cancel' }
  if (value === 'decline') return { action: 'decline' }
  const offered = approval.choices.some((choice) => choice.value === value)
  if (!offered) return { action: 'cancel' }
  if (value === 'once') return { action: 'accept', content: {} }
  if (value === 'session' || value === 'always') {
    return { action: 'accept', content: {}, _meta: { persist: value } }
  }
  return { action: 'cancel' }
}

/**
 * Map a presented option label back to the value the runtime accepts.
 *
 * These are different strings: the question surface answers with the option's
 * LABEL (`"Always allow"`), while the elicitation response needs the choice
 * VALUE (`"always"`). Passing the label straight through looks up nothing and
 * silently cancels a choice the user actually made.
 *
 * @param approval - the request the labels were presented for.
 * @param label - the label the user selected, or `undefined` when dismissed.
 * @returns the choice value, or `'cancel'` when the label matches no option.
 */
export function approvalValueForLabel(approval: NativeAppApproval, label: string | undefined): string {
  if (label === undefined) return 'cancel'
  return approval.choices.find((choice) => choice.label === label)?.value ?? 'cancel'
}

/**
 * Normalize the pre-approved application bundle identifiers.
 *
 * Matching is case-insensitive because a bundle identifier's case is an
 * implementation detail of the application's Info.plist, and a user reading it
 * out of a log should not have to reproduce it exactly. Entries are otherwise
 * kept verbatim: nothing here widens what a match admits.
 *
 * @param raw - configured identifiers, possibly absent or malformed.
 * @returns the normalized set.
 */
export function normalizeApps(raw: readonly string[] | undefined): ReadonlySet<string> {
  const apps = new Set<string>()
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') continue
    const value = entry.trim().toLowerCase()
    // An empty entry would match nothing but reads like a grant; drop it.
    if (value === '') continue
    apps.add(value)
  }
  return apps
}

/**
 * Whether the user has already decided about this application.
 *
 * This is what makes an unattended run possible: without it the runtime asks
 * before it first uses each application, and an unanswered question is a refusal.
 * It is checked only after the agent-host guard, so a list can never authorize
 * the application the agent itself is running in.
 *
 * @param approval - the application approval the runtime sent.
 * @param allowedApps - normalized pre-approved identifiers.
 * @returns whether the application may be admitted without asking.
 */
export function isPreApprovedApp(
  approval: NativeAppApproval,
  allowedApps: ReadonlySet<string>,
): boolean {
  if (allowedApps.size === 0) return false
  return allowedApps.has(approval.resource.trim().toLowerCase())
}

/** The exact origin a browser-site approval names, when it names one. */
export function originApprovalOrigin(request: LcuElicitationRequest): string | undefined {
  const meta = asObject(request._meta) ?? asObject((request as Json).meta)
  if (meta?.tool_name !== ORIGIN_TOOL_NAME || typeof meta.origin !== 'string') return undefined
  try {
    const url = new URL(meta.origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.origin !== meta.origin) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** Whether the request names an already-authorized exact origin. */
export function isPreApprovedOrigin(
  request: LcuElicitationRequest,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = originApprovalOrigin(request)
  return origin !== undefined && allowedOrigins.has(origin)
}

/**
 * Normalize a set of user-configured origins.
 *
 * Only exact HTTP(S) origins are accepted; anything else is dropped rather than
 * widened, because a relaxed match here is a site the user never approved.
 *
 * @param values - raw origin strings from configuration.
 * @returns the accepted origins.
 */
export function normalizeOrigins(values: readonly string[]): Set<string> {
  const accepted = new Set<string>()
  for (const value of values) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (url.origin !== value) continue
      accepted.add(value)
    } catch {
      continue
    }
  }
  return accepted
}
