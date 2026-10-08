/**
 * `dsh-plugin-lcu` — drive the desktop and Chrome from DeepSeek Harness.
 *
 * The plugin is one root-scoped row. It does not open anything at load time:
 * The runtime starts only for an Agent whose preset is
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

import {
  approvalValueForLabel, isPreApprovedApp, isPreApprovedOrigin, nativeAppApproval,
  nativeAppApprovalResponse, normalizeApps, normalizeOrigins, originApprovalOrigin,
} from './approval.ts'
import {
  LcuConnection, LcuError, TURN_CLEANUP_TIMEOUT_CODE, resolveElicitation,
  type LcuElicitationRequest, type LcuElicitationResponse,
} from './connection.ts'
import { randomUUID } from 'node:crypto'

import { ManagedSession, type RuntimeConnection } from './session.ts'

import { AppError, generationOf, planLaunch, resolveApp } from './app.ts'
import { diag, describe } from './diag.ts'
import { isAgentHostApp } from './host-guard.ts'
import { registerLcuTools } from './tool.ts'

export const name = 'lcu'
export const inject = ['tools', 'systemPrompt']


/**
 * What this host adds to the server's own instructions.
 *
 * Everything here is a property of this harness, not of the runtime: the server
 * cannot describe a sandbox it does not own. Stating it up front is the
 * difference between a model that copies a stored image with bash and one that
 * spends a turn discovering that `fs.writeFileSync` returns EPERM.
 */
const LCU_HOST_NOTE = [
  'Host notes for this environment:',
  '- `js` runs in a sandbox that cannot write files anywhere (writes fail with EPERM, including in the',
  '  temporary directory). Do not try to save with `fs`; it will not work.',
  '- Screenshots are delivered to the harness as images, and every stored image reports its host',
  '  filesystem path in the tool result. To put a copy in the workspace use bash, setting the mode as',
  "  you copy: `install -m 644 '<path>' <target>`. A plain `cp` leaves the mode 400 object unreadable.",
  '- Anything the sandbox cannot do — writing files, reading the host filesystem — is available through',
  '  the `bash` tool instead.',
].join('\n')

/** The section order of the injected instructions, after the tool guidance. */
const DEFAULT_SECTION_ORDER = 0

/** Plugin configuration. */
export interface Config {
  /**
   * The ChatGPT application whose runtime provides computer use.
   *
   * Defaults to the standard installation. The plugin launches the runtime from
   * inside this application directly — it does not go through a wrapper.
   */
  app?: string
  /**
   * An explicit executable replacing the computed launch, for an unusual install.
   *
   * Set this only when the application is somewhere the built-in resolution
   * cannot reach; it bypasses the runtime's own environment setup.
   */
  command?: string
  /** Enable the runtime's browser surface; needs the official browser extension and site approvals. */
  chrome?: boolean
  /** Enable the runtime's computer-audio recording API. */
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
  /**
   * Bundle identifiers computer use may use without asking.
   *
   * The runtime asks before it first uses each application, and an unanswered
   * question is a refusal, so an unattended run needs its targets listed here.
   * The application hosting the agent can never be admitted this way.
   */
  allowedApps?: string[]
  /** Prompt section order for the injected runtime instructions. */
  sectionOrder?: number
}

/** Resolved, defaulted configuration. */
interface Settings {
  readonly appPath: string | undefined
  readonly command: string | undefined
  readonly chrome: boolean
  readonly audio: boolean
  readonly presets: readonly string[]
  readonly allowedOrigins: ReadonlySet<string>
  readonly allowedApps: ReadonlySet<string>
  readonly sectionOrder: number
}

/** The message shown for a browser-origin approval. */
const ORIGIN_QUESTION = 'Allow computer use to access this site?'

function resolveSettings(config: Config): Settings {
  return {
    appPath: config.app,
    command: config.command,
    chrome: config.chrome === true,
    audio: config.audio === true,
    presets: config.presets ?? ['heavy'],
    allowedOrigins: normalizeOrigins(config.allowedOrigins ?? []),
    allowedApps: normalizeApps(config.allowedApps),
    sectionOrder: config.sectionOrder ?? DEFAULT_SECTION_ORDER,
  }
}

/**
 * Mount the computer-use capability.
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
    readonly connection: RuntimeConnection
    /** Explicitly `| undefined` so the gate can be cleared under exactOptionalPropertyTypes. */
    pendingCleanup?: { readonly sessionId: string; readonly turnId: string } | undefined
    /** The turn number last seen from the step pipeline, for change detection only. */
    turnNumber?: number | undefined
    /**
     * A fresh identity for that turn, which is what the runtime actually keys its
     * per-turn state by. It must be unique across sessions: an ordinal restarts
     * at 1 in every session, so reusing one makes the runtime treat a new turn as
     * the previous session's already-finished turn.
     */
    turnId?: string | undefined
  }
  const connections = new Map<Agent, Attached>()
  diag(`apply: presets=${JSON.stringify(settings.presets)} chrome=${String(settings.chrome)} app=${describe(settings.appPath)}`
    + ` allowedApps=${JSON.stringify([...settings.allowedApps])} allowedOrigins=${JSON.stringify([...settings.allowedOrigins])}`)

  // Resolve the application once, up front, so a machine that cannot run the
  // runtime says so at load rather than at the first tool call.
  try {
    const probe = planLaunch({
      ...(settings.appPath === undefined ? {} : { appPath: settings.appPath }),
      ...(settings.command === undefined ? {} : { command: settings.command }),
      chrome: settings.chrome,
      audio: settings.audio,
    })
    diag(`  app: ${probe.paths.app} version=${probe.paths.version} runtime=${probe.paths.runtimeVersion}`)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    diag(`  app: UNAVAILABLE ${reason}`)
    ctx.logger.warn(`lcu: computer use is unavailable (${reason})`)
  }
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
      // Anti-self-approval first, and unconditionally: a configured allowlist
      // must never be able to authorize the agent's own host.
      if (await isAgentHostApp(approval.resource)) {
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
        return nativeAppApprovalResponse(request, value)
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
    // One plan per connection: the identity the runtime falls back to is per
    // connection, so two sessions never share one.
    let first: LcuConnection | undefined
    /** Build a plan and open one connection from it. */
    async function connectRuntime(): Promise<LcuConnection> {
      const plan = planLaunch({
        ...(settings.appPath === undefined ? {} : { appPath: settings.appPath }),
        ...(settings.command === undefined ? {} : { command: settings.command }),
        chrome: settings.chrome,
        audio: settings.audio,
        identity: `dsh-${String(agent.id)}`,
      })
      diag(`  attach: launching ${plan.command} ${JSON.stringify(plan.args)}`)
      const opened = new LcuConnection({
        command: plan.command,
        args: plan.args,
        env: plan.env,
        onElicitation: (request, elicitSignal) => presentApproval(agent, request, elicitSignal),
        onStderr: (line) => { ctx.logger.debug(`lcu: ${line}`) },
      })
      await opened.connect(signal)
      first ??= opened
      return opened
    }

    let session: ManagedSession
    try {
      session = await ManagedSession.open({
        connect: async (reason) => {
          const opened = await connectRuntime()
          if (reason === 'regenerated') {
            diag(`  reattach: new runtime ${describe(opened.serverInfo)}`)
          }
          return opened
        },
        // The runtime is executed from files the application replaces when it
        // updates, so this is what keeps a long session on one generation.
        generation: () => generationOf(resolveApp(settings.appPath)),
        onRegenerated: ({ from, to }) => {
          diag(`  regenerate: application changed; runtime replaced (${from.slice(0, 40)} -> ${to.slice(0, 40)})`)
          ctx.logger.info('lcu: the ChatGPT application changed; the runtime was restarted from the new files')
        },
        onRegenerateFailed: (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          diag(`  regenerate FAILED: ${reason}`)
          ctx.logger.warn(`lcu: could not restart the runtime after an application change (${reason})`)
        },
        onGenerationUnreadable: (error: unknown) => {
          // Not a warning: the bundle can be briefly unreadable mid-update, and the
          // next call checks again.
          diag(`  generation unreadable, keeping the current connection: ${error instanceof Error ? error.message : String(error)}`)
        },
      })
    } catch (error: unknown) {
      // A missing or unusable runtime must not fail the session: the preset simply
      // runs without the desktop tools.
      const reason = error instanceof AppError ? error.message : (error instanceof Error ? error.message : String(error))
      diag(`  attach: cannot launch: ${reason}`)
      ctx.logger.warn(`lcu: computer use is unavailable (${reason})`)
      return
    }
    if (first === undefined) {
      diag('  attach: no connection was opened')
      return
    }
    const connection = session
    diag(`  attach: connected, server=${describe(first.serverInfo)} tools=${JSON.stringify(first.allTools.map((t) => t.name))} instructions=${String(first.instructions.length)}B`)
    const state: Attached = { connection }
    // The runtime binds approvals and the per-app Stop to a real session and
    // turn, so the connection carries the session identity from the start.
    connection.sessionId = String(agent.id)
    connections.set(agent, state)

    // Everything below is agent-scoped: it unwinds when the Agent is disposed.
    agent.ctx.effect(() => () => {
      connections.delete(agent)
      void connection.close()
    })

    try {
      registerLcuTools(agent.ctx, connection, ctx, {
        currentTurn: () => state.turnId,
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

    // The server's own pointer, plus what the server cannot know: the sandbox it
    // runs inside here. Without it a model asked to save a screenshot discovers
    // the boundary by probing, one failed call at a time.
    agent.ctx.systemPrompt.section({
      name: 'lcu-instructions',
      order: settings.sectionOrder,
      text: first.instructions === ''
        ? LCU_HOST_NOTE
        : `${first.instructions}\n\n${LCU_HOST_NOTE}`,
    })

    ctx.logger.info(`lcu: ${first.serverInfo.name ?? 'server'} attached for this session`)
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

  // LCU binds its approvals and its explicit per-app Stop to a real turn, and
  // nothing else hands us the number: the first step of each turn opens the
  // waterfall, so record it there and pass it through untouched.
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    const state = connections.get(agent)
    if (state !== undefined && state.turnNumber !== turn) {
      state.turnNumber = turn
      state.turnId = randomUUID()
    }
    return decision
  })

  // LCU's lifecycle contract: the runtime owns per-turn cleanup (native helper
  // and Sky contexts on macOS, temporary Chrome tabs), and only the host knows
  // when a turn really ended.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = connections.get(agent)
    diag(`agent/turn-stopping id=${String(agent.id)} turn=${String(turn)} aborted=${String(signal.aborted)} haveConnection=${String(state !== undefined)}`)
    if (state === undefined) return
    const sessionId = String(agent.id)
    // The identity minted for this turn, never the ordinal.
    const turnId = state.turnId
    if (turnId === undefined) return
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
