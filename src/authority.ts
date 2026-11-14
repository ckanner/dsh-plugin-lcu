/** Shared desktop and managed-runtime authorization. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LcuElicitationRequest, LcuElicitationResponse } from './connection.ts'
import { approvalValueForLabel, isPreApprovedApp, isPreApprovedOrigin, nativeAppApproval,
  nativeAppApprovalResponse, originApprovalOrigin } from './approval.ts'
import { isAgentHostApp } from './host-guard.ts'
import { diag, describe } from './diag.ts'

export interface ApprovalSettings {
  readonly allowedApps: ReadonlySet<string>
  readonly allowedOrigins: ReadonlySet<string>
  readonly managed?: boolean
}
const ORIGIN_QUESTION = 'Allow computer use to access this site?'

export async function presentLcuApproval(
  ctx: Context, agent: Agent, settings: ApprovalSettings,
  request: LcuElicitationRequest, signal: AbortSignal,
): Promise<LcuElicitationResponse> {
    if (signal.aborted) return { action: 'cancel' }
    const questions = ctx.get('userQuestions')
    const approval0 = nativeAppApproval(request)
    diag(`approval: asked kind=${approval0 === undefined ? (originApprovalOrigin(request) === undefined ? 'unknown' : 'browser-origin') : 'native-app'} userQuestions=${describe(questions)}`)
    if (questions === undefined) {
      diag('  approval: no userQuestions service -> cancel (fail closed)')
      return { action: 'cancel' }
    }

    const approval = approval0
    if (approval !== undefined) {
      // Anti-self-approval first, and unconditionally: a configured allowlist
      // must never be able to authorize the agent's own host.
      if (await isAgentHostApp(approval.resource, { allowTestOverride: settings.managed !== true })) {
        diag(`  approval: REFUSED agent-host app ${approval.resource}`)
        ctx.logger.warn(`lcu: refusing to approve the app hosting this agent (${approval.resource})`)
        return { action: 'decline' }
      }
      // The already-decided case, which is what an unattended run depends on.
      if (isPreApprovedApp(approval, settings.allowedApps)) {
        diag(`  approval: app ${approval.resource} pre-approved by allowedApps`)
        return { action: 'accept', content: {} }
      }
      try {
        const answer = await questions.ask({
          agent,
          signal,
          questions: [{
            id: 'choice',
            header: 'Computer use approval',
            question: approval.message,
            detail: `Computer use will be able to see and control ${approval.resource}.`,
            options: approval.choices.map((choice) => ({ label: choice.label })),
          }],
        })
        // The answer carries the option LABEL; the response needs its VALUE.
        const label = answer.answers.find((item) => item.id === 'choice')?.selected[0]
        const value = approvalValueForLabel(approval, label)
        diag(`  approval: user chose ${describe(label)} -> value ${describe(value)} for ${approval.resource}`)
        return signal.aborted ? { action: 'cancel' } : nativeAppApprovalResponse(request, value)
      } catch (error: unknown) {
        ctx.logger.debug(`lcu: native-app approval ended without a choice (${String(error)})`)
        return { action: 'cancel' }
      }
    }

    const origin = originApprovalOrigin(request)
    if (origin !== undefined) {
      // The plugin keeps no permission cache; an exact pre-approved origin is the only
      // thing answered without asking. The log names every asked origin so a
      // user can add the ones they keep approving to `allowedOrigins`.
      const preApproved = isPreApprovedOrigin(request, settings.allowedOrigins)
      diag(`  approval: site ${origin} ${preApproved ? 'pre-approved' : 'asking'} (add it to allowedOrigins to skip this)`)
      if (preApproved) return { action: 'accept', content: {} }
      try {
        const answer = await questions.ask({
          agent,
          signal,
          questions: [{
            id: 'choice',
            header: 'Computer use site approval',
            question: ORIGIN_QUESTION,
            detail: `The runtime asked to use ${origin}.`,
            options: [{ label: 'Allow' }, { label: 'Decline' }],
          }],
        })
        const selected = answer.answers.find((item) => item.id === 'choice')?.selected[0]
        diag(`  approval: site ${origin} user chose ${describe(selected)}`)
        if (signal.aborted) return { action: 'cancel' }
        if (selected === 'Allow') return { action: 'accept', content: {} }
        return selected === 'Decline' ? { action: 'decline' } : { action: 'cancel' }
      } catch (error: unknown) {
        ctx.logger.debug(`lcu: site approval ended without a choice (${String(error)})`)
        return { action: 'cancel' }
      }
    }

    // Anything else is a shape this host does not understand; cancelling keeps
    // the fail-closed contract rather than silently granting access.
    ctx.logger.warn('lcu: unrecognized approval request was cancelled')
    return { action: 'cancel' }
  }
