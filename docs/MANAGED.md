# Managed SDK attachment

[中文](MANAGED.zh.md) | [Desktop installation](../README.md)

Version 0.5 adds a public host integration at `dsh-plugin-lcu/managed`. A scheduler can mount the same real CUA runtime on a live DSH SDK Agent without creating a desktop session, changing `agentPreset`, impersonating a root session, or replacing the app/origin approval bridge. The desktop plugin and its preset allowlist continue to work through the existing entry point. Switching away from an allowed desktop preset now unregisters its tools, cancels active calls and awaits turn cleanup plus process exit; unknown cleanup blocks automatic reattachment.

## Public interface

```ts
import { attachManagedLcu, installManagedLcu } from 'dsh-plugin-lcu/managed'

const lcu = await attachManagedLcu(ctx, {
  agent, // the exact Agent already registered in ctx.get('agents')
  identity: { runId, invocationId, rootSessionId, candidateId },
  lease: { leaseId, resourceId, leaseEpoch, ownerInvocationId: invocationId },
  config: {
    app: '/Applications/ChatGPT.app',
    chrome: true,
    allowedApps: ['com.google.Chrome'],
    allowedOrigins: ['https://example.com'],
  },
  async verifyLease(admission) {
    // Check the current cross-process lease and the actual Agent lineage.
    // Throw on unknown ownership, a revoked epoch, or an unrelated Agent.
    await scheduler.verify(admission)
  },
  async onEvent(event) {
    // Await a durable, ordered event receipt. A rejection prevents more GUI work.
    await journal.append(event)
  },
})

// Normally driven by DSH's real pre-step/turn-stopping/disposal hooks.
// Hosts with a manual loop may instead supply their own unique turn id.
await lcu.beginTurn(hostTurnId)
const turnReceipt = await lcu.stopTurn('Stop')
const finalReceipt = await lcu.close('Interrupt')
if (finalReceipt.cleanup !== 'confirmed') await scheduler.blockResource(finalReceipt)
else await scheduler.releaseLease(finalReceipt)
```

The example's `scheduler` and `journal` are host responsibilities, not package globals. `verifyLease` runs before attachment, before every complete bridge call, and before each approval. Approval handling checks it again after the answer and after its event is committed, so a revoked lease cannot authorize a delayed response. Each check also verifies that the exact Agent remains registered before and after the callback. It receives `identity`, `lease`, `agentSessionId`, `runtimeEpoch`, `phase`, and, when available, `turnId`, `callId`, and `method`. These values are host-owned; tool arguments cannot supply them.

`installManagedLcu(ctx, resolve)` is an optional convenience around the public `agent/created` hook. The asynchronous resolver returns the attachment options without `agent`, or `undefined` for an unadmitted Agent. It returns `get(agent)` and awaited `closeAll()` methods. A host that already admits Agents in its own `agent/created` hook should call `attachManagedLcu` directly after its permission and lineage checks. The package installs per-Agent pre-step, turn-stopping and disposal handlers itself.

`config` accepts `app`, `command`, `chrome`, `audio`, `allowedApps`, and `allowedOrigins`. There is deliberately no `presets` field in the managed path. An SDK worker does not inherit a desktop preset merely because it runs inside a desktop application's process tree.

## Ownership and parallel Agents

The scheduler must acquire one cross-process lease for the actual GUI resource before attaching any Agent. A lease identifies `leaseId`, `resourceId`, `leaseEpoch`, and `ownerInvocationId`. Its reference is not a permission grant; `verifyLease` must verify live ownership, not just compare fields from the same request.

The root and admitted descendants may share that invocation's lease. There is no root-only restriction and no fixed helper-count limit. Every Agent gets its own runtime connection, real session ID, and unique turn IDs. Complete GUI calls are serialized per `resourceId`, including both native calls used by one PTC RPC. A canceled or failed native operation blocks sibling Agents until that exact owner's turn cleanup is acknowledged. A module-local lane complements the scheduler's cross-process lease; it cannot replace it.

Attachment rejects pre-existing `cua`, `lcu_cua`, `js`, or `js_reset` tools in the Agent's visible schema. Use one exclusive managed composition so a legacy tool cannot bypass lease checks. The ordinary desktop plugin skips an Agent already claimed by managed attachment. The host must keep this composition exclusive after attachment as well.

## PTC and media contract

The registered RPC tool is **`lcu_cua`**. The JavaScript object remains **`cua`**:

```ts
var { connectCua } = await import('dsh-plugin-lcu/bridge')
var cua = connectCua(request => tools.lcu_cua(request))
var app = await cua.getApp('Finder')
await app.activate()
```

Update hand-written `tools.cua` bindings when moving from 0.4.x. The public `connectCua` signature and object method tree remain compatible. No legacy `cua` tool alias is registered: the newer DSH PTC executor reserves that name for image-value conversion, which replaces a single-image JSON result and rejects multi-image results. Namespacing keeps canonical JSON handles and projected images separate in the ordinary tool contract on both executor families.

Handles include an opaque runtime epoch. A reset rotates the epoch, and old handles fail with `LCU_STALE_HANDLE`. The managed session pins the application generation; a changed or unreadable bundle fails admission instead of replacing the runtime underneath a GUI owner. The generation is checked on both sides of startup, including an application update during the runtime handshake. Image class instances and symbol-branded values returned by a PTC runtime retain their identity in the program-side bridge. Use `inspect` only if the installed executor declares it; legacy programs can use `console.log` for structured values.

A `media` event contains the operation, target handle if present, observation time, current model route, `capturedImages`, `preparedImages`, and one SHA-256/mime/byte record per observed image. When preparation succeeds, the record also contains an attachment reference and, if the attachment backend supplies one, its host path. The host path comes from the attachment store, never from model arguments.

The facts have separate meanings:

| Fact | What it proves |
|---|---|
| `capturedImages` | Image blocks were observed from the CUA runtime. This alone does not validate their bytes or model delivery. |
| `preparedImages` | The active model route declared image input and the DSH attachment store returned a projected image reference. Later executor or policy steps may still change the result. |
| `imageDeliveredToModel: 'unverified'` | This package has no downstream model-consumption receipt. It does not turn projection into a delivery claim. |
| `evidenceAttachedToRun: false` | The package has not copied and verified the image in the scheduler's run/candidate evidence store. The scheduler may do so and record its own receipt. |

The fixture matrix exercises zero, one, and multiple projected images with callable handles and preserves Image identity. These tests do not run the full rc.3 or master DSH PTC executors, a vision model, or the macOS desktop. Those deployed routes still require their own capability probes before advertising image delivery.

## Approvals

The original exact app/origin allowlists, `userQuestions` service, host-app guard, and real runtime elicitation request remain authoritative. An absent question service cancels even a listed target. Unknown request shapes cancel. A pending or newly answered question cannot grant access after the owning turn is aborted. Managed mode ignores the legacy `LCU_ALLOW_AGENT_HOST_APPROVAL` test override.

A descendant that DSH cannot present a human question for may still use already authorized targets; otherwise its request is canceled by the real service. No host/root identity is substituted to make a child's question succeed. `approval` records carry the actual request ID and target plus `responseSent: 'unverified'`: choosing an answer is not proof of remote receipt.

## Cancellation and cleanup receipts

`stopTurn()` blocks admission, aborts the active turn signal, waits for the resource lane, and awaits the original runtime's `turn_ended` hook. Aborting a tool also sends a best-effort MCP cancellation notification; that notification is a request, not a cleanup acknowledgement. The trusted Sky wrapper keeps failed application IPC cleanup pending, rejects the turn hook and later GUI operations, and never discards an exhausted retry as success.

`close()` first stops the turn, removes registered tools/hooks, then awaits the kernel's exit. Stdin shutdown, TERM, and KILL are bounded; if the child is still alive, close reports an error. Kernel exit alone does not prove the host application released a turn. The final receipt has independent `turnCleanupConfirmed` and `runtimeExitConfirmed` fields, and `cleanup` is `confirmed` only when both are true and the final event receipt was committed. A confirmed turn-stop receipt proves only turn cleanup while its runtime remains available; schedulers must use the **close receipt** for final lease release.

Snapshots contain `schemaVersion`, identity, lease, Agent and runtime identities, state, tool/value contract, cleanup state, and errors. Events add a per-Agent `sequence`, type, turn/call IDs and facts. Types are `attached`, `turn.started`, `call.started`, `call.completed`, `call.failed`, `approval`, `media`, `turn.stopped`, and `cleanup`.

When cleanup is `unknown`, keep the external resource blocked. A later successful acknowledgment may recover it; killing only the kernel, timing out a promise, or losing the worker must not release the lease. Attachment exceptions expose a `ManagedLcuError.receipt` when a runtime lifecycle began; the convenience installer retains those receipts in `closeAll()` as well.

## Verification

`npm run test:packed` builds and packs the package, runs normal `npm install` for that tarball alongside exact Cordis 4.1.0 and DSH tools/system-prompt 0.2.2-rc.3 in a temporary consumer directory, and then runs the public managed suite through the exported JavaScript. No `--force` or legacy peer resolver is used; this checks real prerelease peer compatibility as well as the emitted package. Its real subprocess MCP peer executes the generated bridge programs, handles wire cancellation and elicitation, and produces deterministic images. There is no runtime/approval guard override. Wrapper tests independently assert that failed cleanup remains unknown and blocks subsequent operations.

The fixtures validate the package contract, not macOS accessibility, the signed application's IPC behavior, Chrome extension connectivity, or a downstream model. Run the deployed app probes and a real turn/abort/image test on the target Mac before reporting those capabilities as observed.
