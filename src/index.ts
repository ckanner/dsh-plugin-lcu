/**
 * `dsh-plugin-lcu` — drive the desktop and Chrome from DeepSeek Harness.
 *
 * The plugin is one root-scoped row. It does not open anything at load time:
 * LCU (and the CUA runtime behind it) starts only for an Agent whose preset is
 * listed in `presets`, and stops when that Agent is disposed. That keeps a
 * heavy, permission-bearing capability off every session that does not need it.
 *
 * Visibility is decided per Agent rather than by mounting rows inside a preset,
 * because the server owns the tool schemas: they can only be fetched after the
 * handshake, so the tools are registered into the Agent's own context once its
 * connection is up.
 *
 * @module dsh-plugin-lcu
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use'

import { approvalValueForLabel, isPreApprovedOrigin, nativeAppApproval, nativeAppApprovalResponse, normalizeOrigins, originApprovalOrigin } from './approval.ts'
import {
  LcuConnection, LcuError, TURN_CLEANUP_TIMEOUT_CODE, resolveElicitation,
  type LcuElicitationRequest, type LcuElicitationResponse,
} from './connection.ts'
import { diag, describe } from './diag.ts'
import { isAgentHostApp } from './host-guard.ts'
import { registerLcuTools } from './tool.ts'

export const name = 'lcu'
export const inject = ['tools', 'systemPrompt']

/** Where the installer puts the launcher. */
const DEFAULT_COMMAND = join(homedir(), '.local/share/lcu/current/bin/lcu')

/** The section order of the injected instructions, after the tool guidance. */
const DEFAULT_SECTION_ORDER = 0

/** Plugin configuration. */
export interface Config {
  /** LCU launcher; defaults to the installed path, overridable for a custom prefix. */
  command?: string
  /** Enable the Chrome surface (`lcu --chrome`); needs the extension and site approvals. */
  chrome?: boolean
  /** Enable the original computer-audio recording API (`lcu --audio`). */
  audio?: boolean
  /**
   * Agent preset ids whose sessions get the tools.
   *
   * Presets are independent compositions, so this is an explicit list rather
   * than a capability the preset itself declares; `heavy` is the preset the
   * generator script builds for this plugin.
   */
  presets?: string[]
  /** Exact HTTP(S) origins pre-approved for browser access, never widened. */
  allowedOrigins?: string[]
  /** Prompt section order for the injected LCU instructions. */
  sectionOrder?: number
}

/** Resolved, defaulted configuration. */
interface Settings {
  readonly command: string
  readonly args: readonly string[]
  readonly presets: readonly string[]
  readonly allowedOrigins: ReadonlySet<string>
  readonly sectionOrder: number
}

/** The message shown for a browser-origin approval. */
const ORIGIN_QUESTION = 'Allow computer use to access this site?'

function resolveSettings(config: Config): Settings {
  const args: string[] = []
  if (config.chrome === true) args.push('--chrome')
  if (config.audio === true) args.push('--audio')
  return {
    command: config.command ?? DEFAULT_COMMAND,
    args,
    presets: config.presets ?? ['heavy'],
    allowedOrigins: normalizeOrigins(config.allowedOrigins ?? []),
    sectionOrder: config.sectionOrder ?? DEFAULT_SECTION_ORDER,
  }
}

/**
 * Mount the LCU capability.
 *
 * @param ctx - the host context this row mounts into.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveSettings(config)
  /**
   * Per-Agent state. `pendingCleanup` records a turn whose runtime cleanup
   * outlived the host's wait: the runtime retries it, and until that succeeds
   * the desktop may still be mid-teardown, so calls are refused.
   */
  interface Attached {
    readonly connection: LcuConnection
    /** Explicitly `| undefined` so the gate can be cleared under exactOptionalPropertyTypes. */
    pendingCleanup?: { readonly sessionId: string; readonly turnId: string } | undefined
  }
  const connections = new Map<Agent, Attached>()
  diag(`apply: presets=${JSON.stringify(settings.presets)} command=${settings.command} args=${JSON.stringify(settings.args)}`)
  diag(`  services: agentPresets=${describe(ctx.get('agentPresets'))} userQuestions=${describe(ctx.get('userQuestions'))} computerUse=${describe(ctx.get('computerUse'))} attachments=${describe(ctx.get('attachments'))} llm=${describe(ctx.get('llm'))}`)

  // Reserve the deployment's computer-use provider slot when the seam exists.
  // This is bookkeeping: the tools below are what the model actually calls.
  ctx.effect(() => {
    const computerUse = ctx.get('computerUse')
    if (computerUse === undefined) return () => {}
    const release = computerUse.register(computerUseProviderName('lcu'))
    ctx.logger.info('lcu: registered as the computer-use provider')
    return () => { void release() }
  })

  /**
   * Present one approval to the user.
   *
   * The model cannot answer this: `userQuestions.ask` is the same surface the
   * `ask_user_question` tool uses, and only a person can reply to it.
   */
  async function presentApproval(agent: Agent, request: LcuElicitationRequest, signal: AbortSignal): Promise<LcuElicitationResponse> {
    const questions = ctx.get('userQuestions')
    const approval0 = nativeAppApproval(request)
    diag(`approval: asked kind=${approval0 === undefined ? (originApprovalOrigin(request) === undefined ? 'unknown' : 'browser-origin') : 'native-app'} userQuestions=${describe(questions)}`)
    if (questions === undefined) {
      diag('  approval: no userQuestions service -> cancel (fail closed)')
      return { action: 'cancel' }
    }

    const approval = approval0
    if (approval !== undefined) {
      // Anti-self-approval: never let the agent approve its own host.
      if (await isAgentHostApp(approval.resource)) {
        diag(`  approval: REFUSED agent-host app ${approval.resource}`)
        ctx.logger.warn(`lcu: refusing to approve the app hosting this agent (${approval.resource})`)
        return { action: 'decline' }
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
        return nativeAppApprovalResponse(request, value)
      } catch (error: unknown) {
        ctx.logger.debug(`lcu: native-app approval ended without a choice (${String(error)})`)
        return { action: 'cancel' }
      }
    }

    const origin = originApprovalOrigin(request)
    if (origin !== undefined) {
      // LCU keeps no permission cache; an exact pre-approved origin is the only
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

  /** Open and prepare one Agent's connection; never throws. */
  async function attach(agent: Agent, signal?: AbortSignal): Promise<void> {
    if (connections.has(agent)) return
    const connection = new LcuConnection({
      command: settings.command,
      args: settings.args,
      onElicitation: (request, elicitSignal) => presentApproval(agent, request, elicitSignal),
      onStderr: (line) => { ctx.logger.debug(`lcu: ${line}`) },
    })
    diag(`  attach: connecting ${settings.command}`)
    try {
      await connection.connect(signal)
    } catch (error: unknown) {
      await connection.close()
      // A missing or broken LCU must not fail the session: the preset simply
      // runs without the desktop tools.
      ctx.logger.warn(`lcu: could not start for this session (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    diag(`  attach: connected, server=${describe(connection.serverInfo)} tools=${JSON.stringify(connection.allTools.map((t) => t.name))} instructions=${String(connection.instructions.length)}B`)
    const state: Attached = { connection }
    connections.set(agent, state)

    // Everything below is agent-scoped: it unwinds when the Agent is disposed.
    agent.ctx.effect(() => () => {
      connections.delete(agent)
      void connection.close()
    })

    try {
      registerLcuTools(agent.ctx, connection, ctx, {
        beforeCall: async () => {
          const pending = state.pendingCleanup
          if (pending === undefined) return
          // Retry the unfinished cleanup; only a settled one clears the gate.
          await connection.turnEnded(pending.sessionId, pending.turnId)
          state.pendingCleanup = undefined
          diag('  cleanup gate: retry succeeded, calls unblocked')
        },
      })
      diag('  attach: tools registered')
    } catch (error: unknown) {
      diag(`  attach: TOOL REGISTRATION FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      throw error
    }

    if (connection.instructions !== '') {
      agent.ctx.systemPrompt.section({
        name: 'lcu-instructions',
        order: settings.sectionOrder,
        text: connection.instructions,
      })
    }

    ctx.logger.info(`lcu: ${connection.serverInfo.name ?? 'server'} attached for this session`)
  }

  /**
   * Whether this session's Agent should hold an LCU connection.
   *
   * The registry is authoritative; the session header is only the value the
   * session was created with, which the picker replaces afterwards.
   */
  function presetAllows(agent: Agent): boolean {
    const registry = ctx.get('agentPresets')
    let composed: string | undefined
    let composeError: string | undefined
    try {
      composed = registry?.composedPreset(agent.ctx)
    } catch (error: unknown) {
      composeError = error instanceof Error ? error.message : String(error)
    }
    const header = agent.session.header.agentPreset
    diag(`decide id=${String(agent.id)} composed=${describe(composed)} header=${describe(header)} err=${describe(composeError)}`)
    const preset = composed ?? header
    if (preset === undefined) { diag('  -> skip: no preset'); return false }
    const allowed = settings.presets.includes(preset)
    diag(`  -> preset ${preset} ${allowed ? 'allowed' : 'not in allowlist'}`)
    return allowed
  }

  /**
   * A session's committed preset choice.
   *
   * This is the event that matters: a new task is created with the deployment
   * default and the picker's mode is applied afterwards, so `agent/created`
   * alone sees the wrong composition.
   */
  ctx.on('agent-preset/selected', async (sessionId, agentPreset) => {
    diag(`agent-preset/selected session=${String(sessionId)} preset=${describe(agentPreset)}`)
    if (!settings.presets.includes(agentPreset)) return
    const agent = ctx.get('agents')?.get(String(sessionId))
    if (agent === undefined) { diag('  -> no live agent for that session'); return }
    try {
      await attach(agent)
      diag(`  -> attached=${String(connections.has(agent))}`)
    } catch (error: unknown) {
      diag(`  -> attach THREW: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
  })

  ctx.on('agent/created', async ({ agent, signal }) => {
    // Ask the registry which preset this Agent actually uses. The session header
    // records the deployment default at creation, which the new-task picker may
    // replace afterwards — so the header is a fallback, never the authority.
    diag(`agent/created id=${String(agent.id)} agentCtxTools=${describe((agent.ctx as unknown as { tools?: unknown }).tools)}`)
    if (!presetAllows(agent)) return
    try {
      await attach(agent, signal)
    } catch (error: unknown) {
      diag(`  -> attach THREW: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      return
    }
    diag(`  -> attach done, connections=${String(connections.size)}, tools=${JSON.stringify(agent.ctx.tools.schemas(agent).map((t) => t.name).slice(-4))}`)
  })

  // LCU's lifecycle contract: the runtime owns per-turn cleanup (native helper
  // and Sky contexts on macOS, temporary Chrome tabs), and only the host knows
  // when a turn really ended.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = connections.get(agent)
    diag(`agent/turn-stopping id=${String(agent.id)} turn=${String(turn)} aborted=${String(signal.aborted)} haveConnection=${String(state !== undefined)}`)
    if (state === undefined) return
    const sessionId = String(agent.id)
    const turnId = String(turn)
    try {
      await state.connection.turnEnded(sessionId, turnId, signal.aborted ? 'Interrupt' : 'Stop')
      state.pendingCleanup = undefined
    } catch (error: unknown) {
      const code = error instanceof LcuError ? error.code : undefined
      if (code === TURN_CLEANUP_TIMEOUT_CODE) {
        // Expected on macOS when the signed helper is slow. The runtime keeps
        // cleaning in the background; block the next call until it settles.
        state.pendingCleanup = { sessionId, turnId }
        diag('turn_ended: cleanup still running; LCU calls blocked until it settles')
        ctx.logger.warn('lcu: turn cleanup is still running; computer-use calls are blocked until it settles')
      } else {
        diag(`turn_ended FAILED: ${error instanceof Error ? error.message : String(error)}`)
        ctx.logger.warn(`lcu: turn_ended failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  })

  // Drain every connection if the plugin itself unloads.
  ctx.effect(() => () => {
    const live = [...connections.values()]
    connections.clear()
    for (const { connection } of live) void connection.close()
  })
}

/**
 * The computer-use seam brands its provider name, but the brand is compile-time
 * only: the runtime value is the plain string, and importing the seam's own
 * helper would be a value import from a package this plugin only type-checks
 * against.
 */
function computerUseProviderName(value: string): ComputerUseProviderName {
  return value as unknown as ComputerUseProviderName
}

export { resolveElicitation }
