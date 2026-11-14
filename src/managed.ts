/** Public host-owned SDK attachment, GUI admission, evidence and cleanup. @module */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { generationOf, planLaunch, resolveApp } from './app.ts'
import { nativeAppApproval, normalizeApps, normalizeOrigins, originApprovalOrigin } from './approval.ts'
import { presentLcuApproval } from './authority.ts'
import { LcuConnection, type LcuTurnEndEvent } from './connection.ts'
import { claimManagedAgent } from './ownership.ts'
import { CUA_TOOL_NAME, ptcBridgeInstructions, registerCuaTool, type CuaRequest } from './ptc.ts'
import { ManagedSession } from './session.ts'

/** Identity supplied by the trusted scheduler; it is never read from model arguments. */
export interface ManagedLcuIdentity {
  readonly runId: string
  readonly invocationId: string
  readonly rootSessionId: string
  readonly candidateId?: string
}

/** A reference to an existing host lease, not a grant of GUI permission. */
export interface ManagedLcuLease {
  readonly leaseId: string
  readonly resourceId: string
  readonly leaseEpoch: string
  readonly ownerInvocationId: string
}

export interface ManagedLcuConfig {
  readonly app?: string
  readonly command?: string
  readonly chrome?: boolean
  readonly audio?: boolean
  readonly allowedApps?: string[]
  readonly allowedOrigins?: string[]
}

export interface ManagedLcuAdmission {
  readonly identity: ManagedLcuIdentity
  readonly lease: ManagedLcuLease
  readonly agentSessionId: string
  readonly runtimeEpoch: string
  readonly phase: 'attach' | 'call' | 'approval'
  readonly turnId?: string
  readonly callId?: string
  readonly method?: string
}

export interface ManagedLcuEvent {
  readonly schemaVersion: 1
  readonly sequence: number
  readonly type: 'attached' | 'turn.started' | 'call.started' | 'call.completed' | 'call.failed' | 'approval' | 'media' | 'turn.stopped' | 'cleanup'
  readonly identity: ManagedLcuIdentity
  readonly lease: ManagedLcuLease
  readonly agentSessionId: string
  readonly runtimeEpoch: string
  readonly turnId?: string
  readonly callId?: string
  readonly facts: Readonly<Record<string, unknown>>
}

export interface ManagedLcuSnapshot {
  readonly schemaVersion: 1
  readonly identity: ManagedLcuIdentity
  readonly lease: ManagedLcuLease
  readonly agentSessionId: string
  readonly runtimeEpoch: string
  readonly state: 'ready' | 'active' | 'stopping' | 'blocked' | 'closed'
  readonly toolName: typeof CUA_TOOL_NAME
  readonly valueContract: 'canonical-json-with-deferred-images'
  readonly cleanup: 'not-requested' | 'confirmed' | 'unknown'
  readonly turnCleanupConfirmed: boolean
  readonly runtimeExitConfirmed: boolean
  readonly turnId?: string
  readonly errors: readonly string[]
}

export interface ManagedLcuOptions {
  readonly agent: Agent
  readonly identity: ManagedLcuIdentity
  readonly lease: ManagedLcuLease
  readonly config?: ManagedLcuConfig
  /** Verify a current scheduler grant and this actor's lineage; rejection blocks dispatch. */
  readonly verifyLease: (admission: ManagedLcuAdmission) => Promise<void>
  /** Awaited durability/observation callback. Throwing blocks new operations. */
  readonly onEvent: (event: ManagedLcuEvent) => Promise<void>
}

export interface ManagedLcuHandle {
  snapshot(): ManagedLcuSnapshot
  beginTurn(turnId: string): Promise<void>
  stopTurn(reason?: LcuTurnEndEvent): Promise<ManagedLcuSnapshot>
  close(reason?: LcuTurnEndEvent): Promise<ManagedLcuSnapshot>
}

/** The exception retains a cleanup receipt even when attachment never returns a handle. */
export class ManagedLcuError extends Error {
  readonly receipt?: ManagedLcuSnapshot
  constructor(message: string, receipt?: ManagedLcuSnapshot, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedLcuError'
    if (receipt !== undefined) this.receipt = receipt
  }
}

const lanes = new Map<string, Promise<void>>()
// A canceled native request may still touch the shared desktop. Keep siblings
// blocked until the exact owner's turn cleanup is acknowledged.
const blockers = new Map<string, Set<string>>()
function blockResource(resource: string, owner: string): void {
  const owners = blockers.get(resource) ?? new Set<string>()
  owners.add(owner); blockers.set(resource, owners)
}
function unblockResource(resource: string, owner: string): void {
  const owners = blockers.get(resource); owners?.delete(owner)
  if (owners?.size === 0) blockers.delete(resource)
}

/** Different Agents sharing one lease still serialize complete GUI operations. */
async function serial<T>(resource: string, operation: () => Promise<T>): Promise<T> {
  const previous = lanes.get(resource) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  lanes.set(resource, tail)
  await previous.catch(() => {})
  try { return await operation() } finally {
    release()
    if (lanes.get(resource) === tail) lanes.delete(resource)
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048)
}
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) throw new ManagedLcuError(`invalid ${name}`)
}

/**
 * Attach real CUA tools to a real SDK Agent without inventing a preset header.
 * Exact app/origin approvals and the original host guard remain authoritative.
 * A scheduler owns cross-process leases and must inspect every cleanup receipt.
 */
export async function attachManagedLcu(ctx: Context, options: ManagedLcuOptions): Promise<ManagedLcuHandle> {
  const { agent } = options
  for (const [key, value] of Object.entries(options.identity)) nonempty(value, `identity.${key}`)
  for (const key of ['runId', 'invocationId', 'rootSessionId'] as const) nonempty(options.identity[key], `identity.${key}`)
  for (const key of ['leaseId', 'resourceId', 'leaseEpoch', 'ownerInvocationId'] as const) nonempty(options.lease[key], `lease.${key}`)
  nonempty(agent.id, 'agent.id')
  if (options.lease.ownerInvocationId !== options.identity.invocationId) throw new ManagedLcuError('lease belongs to another invocation')
  if (typeof options.verifyLease !== 'function' || typeof options.onEvent !== 'function') throw new ManagedLcuError('verifyLease and onEvent are required host callbacks')
  if (ctx.get('agents')?.get(String(agent.id)) !== agent) throw new ManagedLcuError('managed attachment requires the exact live registered Agent')
  if (agent.ctx.tools.schemas(agent).some(tool => ['cua', CUA_TOOL_NAME, 'js', 'js_reset'].includes(tool.name))) {
    throw new ManagedLcuError('unmanaged CUA tools are already registered; use an exclusive managed composition')
  }
  if (blockers.has(options.lease.resourceId)) throw new ManagedLcuError('GUI resource has unconfirmed prior cleanup')
  const releaseOwner = claimManagedAgent(agent)
  const identity = Object.freeze({ ...options.identity })
  const lease = Object.freeze({ ...options.lease })
  const config = options.config ?? {}
  const settings = { managed: true, allowedApps: normalizeApps(config.allowedApps), allowedOrigins: normalizeOrigins(config.allowedOrigins ?? []) }
  let connection: LcuConnection | undefined
  let runtime: ManagedSession | undefined
  let epoch: string = randomUUID()
  const resourceOwner = `${options.identity.invocationId}:${String(agent.id)}:${epoch}`
  let state: ManagedLcuSnapshot['state'] = 'ready'
  let cleanup: ManagedLcuSnapshot['cleanup'] = 'not-requested'
  let turnId: string | undefined
  let turnCleanupConfirmed = true
  let runtimeExitConfirmed = false
  let sequence = 0
  let turnController = new AbortController()
  let stopping: Promise<ManagedLcuSnapshot> | undefined
  let closing: Promise<ManagedLcuSnapshot> | undefined
  let disposed = false
  const errors: string[] = []
  const disposers: (() => void)[] = []

  const snapshot = (): ManagedLcuSnapshot => ({
    schemaVersion: 1, identity, lease, agentSessionId: String(agent.id), runtimeEpoch: runtime?.epoch ?? epoch,
    state, toolName: CUA_TOOL_NAME, valueContract: 'canonical-json-with-deferred-images', cleanup,
    turnCleanupConfirmed, runtimeExitConfirmed,
    ...(turnId === undefined ? {} : { turnId }), errors: [...errors],
  })
  const admission = (phase: ManagedLcuAdmission['phase'], exec?: ToolRunContext, method?: string): ManagedLcuAdmission => ({
    identity, lease, agentSessionId: String(agent.id), runtimeEpoch: runtime?.epoch ?? epoch, phase,
    ...(turnId === undefined ? {} : { turnId }), ...(exec === undefined ? {} : { callId: exec.callId }),
    ...(method === undefined ? {} : { method }),
  })
  const verifyAdmission = async (phase: ManagedLcuAdmission['phase'], exec?: ToolRunContext, method?: string): Promise<void> => {
    const isLive = () => ctx.get('agents')?.get(String(agent.id)) === agent
    if (!isLive()) throw new ManagedLcuError('managed LCU actor is no longer the registered live Agent', snapshot())
    await options.verifyLease(admission(phase, exec, method))
    if (!isLive()) throw new ManagedLcuError('managed LCU actor changed during admission', snapshot())
  }
  const emit = async (type: ManagedLcuEvent['type'], facts: Readonly<Record<string, unknown>>, exec?: ToolRunContext): Promise<void> => {
    const event: ManagedLcuEvent = {
      schemaVersion: 1, sequence: ++sequence, type, identity, lease,
      agentSessionId: String(agent.id), runtimeEpoch: runtime?.epoch ?? epoch,
      ...(turnId === undefined ? {} : { turnId }), ...(exec === undefined ? {} : { callId: exec.callId }), facts,
    }
    try { await options.onEvent(event) } catch (error) {
      state = 'blocked'; blockResource(lease.resourceId, resourceOwner); errors.push(`event receipt: ${errorText(error)}`)
      throw new ManagedLcuError('managed LCU event receipt was not committed', snapshot(), { cause: error })
    }
  }
  const recordError = (error: unknown): void => { errors.push(errorText(error)); if (errors.length > 16) errors.shift() }
  const canApprove = (): boolean => turnId !== undefined && !turnController.signal.aborted && (state === 'active' || state === 'ready')
  const handle: ManagedLcuHandle = {
    snapshot,
    async beginTurn(id) {
      nonempty(id, 'turnId')
      if (state === 'closed' || state === 'blocked' || state === 'stopping') throw new ManagedLcuError('LCU is not admitting a new turn', snapshot())
      if (turnId === id) return
      if (turnId !== undefined && !turnCleanupConfirmed) throw new ManagedLcuError('previous LCU turn has not stopped', snapshot())
      turnId = id; turnController = new AbortController(); turnCleanupConfirmed = true
      cleanup = 'not-requested'; state = 'ready'
      await emit('turn.started', {})
    },
    async stopTurn(reason = 'Stop') {
      if (stopping !== undefined) return stopping
      if (state === 'closed') return snapshot()
      state = 'stopping'; turnController.abort(new Error('LCU turn is stopping'))
      const pending = serial(lease.resourceId, async () => {
        if (turnId !== undefined && !turnCleanupConfirmed) {
          try {
            if (runtime === undefined) throw new Error('runtime unavailable for turn cleanup')
            await runtime.turnEnded(String(agent.id), turnId, reason)
            turnCleanupConfirmed = true
          } catch (error) { recordError(error); cleanup = 'unknown'; state = 'blocked'; blockResource(lease.resourceId, resourceOwner) }
        }
        if (turnCleanupConfirmed) { cleanup = 'confirmed'; state = 'ready'; unblockResource(lease.resourceId, resourceOwner) }
        await emit('turn.stopped', { reason, turnCleanupConfirmed, cleanup })
        return snapshot()
      })
      stopping = pending
      try { return await pending } finally { stopping = undefined }
    },
    async close(reason = 'Interrupt') {
      if (closing !== undefined) return closing
      if (disposed) return snapshot()
      const pending = (async () => {
        try { await handle.stopTurn(reason) } catch (error) { recordError(error); cleanup = 'unknown' }
        state = 'stopping'; turnController.abort()
        for (const dispose of disposers.splice(0)) dispose()
        try { await (runtime?.close() ?? connection?.close()); runtimeExitConfirmed = true } catch (error) { recordError(error) }
        cleanup = turnCleanupConfirmed && runtimeExitConfirmed ? 'confirmed' : 'unknown'
        state = cleanup === 'confirmed' ? 'closed' : 'blocked'
        try { await emit('cleanup', { reason, turnCleanupConfirmed, runtimeExitConfirmed, cleanup }) }
        catch (error) { recordError(error); cleanup = 'unknown'; state = 'blocked' }
        if (cleanup === 'confirmed') { disposed = true; unblockResource(lease.resourceId, resourceOwner); releaseOwner() }
        else blockResource(lease.resourceId, resourceOwner)
        return snapshot()
      })()
      closing = pending
      try { return await pending } finally { if (!disposed) closing = undefined }
    },
  }

  try {
    await verifyAdmission('attach')
    const plan = planLaunch({
      ...(config.app === undefined ? {} : { appPath: config.app }),
      ...(config.command === undefined ? {} : { command: config.command }),
      chrome: config.chrome === true, audio: config.audio === true, identity: `dsh-${String(agent.id)}`,
    })
    runtime = await ManagedSession.open({
      generationPolicy: 'pin',
      generation: () => generationOf(resolveApp(config.app)),
      connect: async () => {
        connection = new LcuConnection({
          command: plan.command, args: plan.args, env: plan.env,
          onElicitation: async (request, signal) => {
            if (!canApprove()) return { action: 'cancel' }
            await verifyAdmission('approval')
            if (!canApprove()) return { action: 'cancel' }
            const answer = await presentLcuApproval(ctx, agent, settings, request, AbortSignal.any([signal, turnController.signal]))
            // A human question and its durable receipt can outlive the lease.
            // Revalidate the actual actor and epoch after each awaited boundary
            // before returning an approval to the original runtime request.
            if (!canApprove() || signal.aborted) return { action: 'cancel' }
            await verifyAdmission('approval')
            if (!canApprove() || signal.aborted) return { action: 'cancel' }
            const app = nativeAppApproval(request)?.resource
            const origin = originApprovalOrigin(request)
            await emit('approval', { action: answer.action, responseSent: 'unverified', requestId: request.requestId ?? null,
              target: app === undefined ? (origin === undefined ? { kind: 'unknown' } : { kind: 'origin', value: origin }) : { kind: 'app', value: app } })
            await verifyAdmission('approval')
            if (!canApprove() || signal.aborted) return { action: 'cancel' }
            return answer
          },
          onStderr: line => { ctx.logger.debug(`lcu: ${line}`) },
          onDiag: message => { ctx.logger.debug(`lcu: ${message}`) },
        })
        connection.sessionId = String(agent.id)
        await connection.connect()
        if (!connection.allTools.some(tool => tool.name === 'turn_ended')) throw new Error('runtime does not expose turn_ended cleanup')
        return connection
      },
    })
    epoch = runtime.epoch
    runtime.sessionId = String(agent.id)
    const boundRuntime = runtime
    const aroundCall = async (request: CuaRequest, exec: ToolRunContext, operation: () => Promise<unknown>): Promise<unknown> => serial(lease.resourceId, async () => {
      if (blockers.has(lease.resourceId)) throw new ManagedLcuError('GUI resource has unconfirmed cleanup', snapshot())
      if (state === 'closed' || state === 'stopping' || state === 'blocked' || turnId === undefined || turnController.signal.aborted) {
        throw new ManagedLcuError('managed LCU is not admitting tool calls', snapshot())
      }
      if (exec.agent !== agent || exec.signal.aborted) throw new ManagedLcuError('LCU call actor or cancellation state is invalid', snapshot())
      await verifyAdmission('call', exec, request.method)
      await boundRuntime.prepare()
      if (turnController.signal.aborted || exec.signal.aborted) throw new ManagedLcuError('LCU call canceled during admission', snapshot())
      state = 'active'
      await emit('call.started', { method: request.method, ...(request.target === undefined ? {} : { target: request.target }) }, exec)
      turnCleanupConfirmed = false
      try {
        const result = await operation()
        await emit('call.completed', { method: request.method, runtimeEpoch: boundRuntime.epoch }, exec)
        state = 'ready'
        return result
      } catch (error) {
        recordError(error)
        // An operation may have reached the remote runtime before its promise failed.
        state = 'blocked'; cleanup = 'unknown'; turnController.abort(error); blockResource(lease.resourceId, resourceOwner)
        await emit('call.failed', { method: request.method, error: errorText(error), remoteOutcome: 'unknown' }, exec)
        throw error
      }
    })
    disposers.push(registerCuaTool(agent.ctx, boundRuntime, ctx, {
      currentTurn: () => turnId,
      callSignal: () => turnController.signal,
      aroundCall,
      onMedia: async (observation, exec) => { await emit('media', { ...observation, evidenceAttachedToRun: false, candidateId: identity.candidateId ?? null }, exec) },
    }))
    disposers.push(agent.ctx.systemPrompt.section({
      name: 'lcu-managed-instructions', order: 0,
      text: ptcBridgeInstructions(new URL('./bridge.js', import.meta.url).href),
    }))
    let observedTurn: number | undefined
    disposers.push(ctx.on('agent/pre-step', async ({ agent: current, turn }, next) => {
      if (current === agent && observedTurn !== turn) {
        await handle.beginTurn(randomUUID()); observedTurn = turn
      }
      return next()
    }))
    disposers.push(ctx.on('agent/turn-stopping', async ({ agent: current, signal }) => {
      if (current !== agent) return
      const result = await handle.stopTurn(signal.aborted ? 'Interrupt' : 'Stop')
      if (result.cleanup === 'unknown') throw new ManagedLcuError('LCU turn cleanup is unknown', result)
    }))
    agent.ctx.effect(() => async () => {
      const result = await handle.close('SubagentStop')
      if (result.cleanup !== 'confirmed') throw new ManagedLcuError('LCU disposal cleanup is unknown', result)
    })
    await emit('attached', {
      toolName: CUA_TOOL_NAME, valueContract: 'canonical-json-with-deferred-images',
      runtime: connection?.serverInfo ?? {}, appVersion: plan.paths.version,
      runtimeVersion: plan.paths.runtimeVersion, hostControlConnected: boundRuntime.hasHostControl,
      userQuestionsService: ctx.get('userQuestions') !== undefined,
      authorization: 'exact-app-origin-or-human', imageDelivery: 'unverified',
    })
    return handle
  } catch (error) {
    recordError(error)
    const receipt = await handle.close('Interrupt')
    throw new ManagedLcuError(`managed LCU attachment failed: ${errorText(error)}`, receipt, { cause: error })
  }
}

/** Install the supported Agent-created seam; the resolver owns root/child lineage. */
export function installManagedLcu(
  ctx: Context,
  resolve: (agent: Agent) => Promise<Omit<ManagedLcuOptions, 'agent'> | undefined>,
): { get(agent: Agent): ManagedLcuHandle | undefined; closeAll(): Promise<readonly ManagedLcuSnapshot[]> } {
  const handles = new Map<Agent, ManagedLcuHandle>()
  const failures: ManagedLcuSnapshot[] = []
  const pending = new Set<Promise<void>>()
  let closed = false
  const stop = ctx.on('agent/created', async ({ agent }) => {
    if (closed) return
    const operation = (async () => {
      const options = await resolve(agent)
      if (options === undefined || closed) return
      let handle: ManagedLcuHandle
      try { handle = await attachManagedLcu(ctx, { ...options, agent }) }
      catch (error) {
        if (error instanceof ManagedLcuError && error.receipt !== undefined) failures.push(error.receipt)
        throw error
      }
      handles.set(agent, handle)
      if (closed) await handle.close('Interrupt')
    })()
    pending.add(operation)
    try { await operation } finally { pending.delete(operation) }
  })
  const closeAll = async (): Promise<readonly ManagedLcuSnapshot[]> => {
    closed = true; stop()
    await Promise.allSettled([...pending])
    return [...failures, ...await Promise.all([...handles.values()].map(handle => handle.close('Interrupt')))]
  }
  ctx.effect(() => async () => {
    const receipts = await closeAll()
    if (receipts.some(receipt => receipt.cleanup !== 'confirmed')) throw new ManagedLcuError('one or more LCU runtimes have unknown cleanup')
  })
  return { get: agent => handles.get(agent), closeAll }
}
