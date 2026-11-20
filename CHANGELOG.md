# Changelog

## 0.5.1

- Accept the DSH 0.2.1-rc.5 through 0.3 compatibility window for the host
  tools/system-prompt peers. Required capability checks remain fail-closed.

## 0.5.0

Managed SDK computer use and an explicit PTC/media contract.

- Export `dsh-plugin-lcu/managed` for real Agent attachment without preset-header fabrication; require host-owned identity, lease verification and durable event callbacks.
- Admit roots and real descendants with shared invocation leases, while serializing every complete GUI operation per resource across Agents. Retain unknown cleanup as a resource blocker.
- Name the structured RPC tool `lcu_cua` so DSH PTC image special-casing cannot replace callable JSON handles. The program object remains `cua`; update hand-written `tools.cua` bindings. Preserve runtime Image identity and scope handles to runtime epochs.
- Pin managed runtime generations, propagate abort to wire cancellation, await turn and process cleanup, and expose separate cleanup receipts. The trusted wrapper now reports failed application IPC cleanup instead of silently treating it as success.
- Revoke desktop CUA tools immediately when a session switches to a disallowed preset, cancel in-flight calls and await the original runtime's turn cleanup before admitting a replacement. Failed startup no longer leaks a child process.
- Detect application updates during runtime startup and retire a replacement that finishes after its session closes. Recheck the live Agent and lease after asynchronous approval boundaries so late answers cannot revive a revoked owner.
- Preserve original app/origin approvals and real Agent identity; managed mode cannot enable the legacy host-approval test override.
- Emit media hashes, attachment references, model-route facts and explicit unverified model delivery/run evidence states.
- Support the Node 22.18+ runtime used by Flywheel and current Node 24 releases.
- Exercise the public managed API through a real subprocess MCP fixture and a normally npm-installed packed consumer with exact host peers; explicitly admit the supported DSH prerelease tuples. Document remaining target-Mac and DSH executor probes.

## 0.4.2

Expose read-only scalar properties on PTC handles.

- Handle objects now carry a snapshot of their non-function properties
  (tab.id, tab.title, app.name, browserId, and similar), so returning or reading
  those values no longer yields a function and invalid JSON.
- Methods remain routed through tools.cua; nested handles are decoded with their
  properties intact.


## 0.4.1

Fix two PTC bridge edge cases found by a live macOS run.

- Treat cross-realm ArrayBuffer views (including the runtime screenshot Buffer)
  as byte payloads instead of opaque handles, so cua.getScreenshot() can be
  returned as lossless JSON while the image still enters the attachment pipeline.
- Decode handles nested inside plain objects, so browser metadata and tab
  handles from cua.getState() are callable objects rather than raw handle values.


## 0.4.0

PTC Computer Use.

**The model interface is now `cua`, not `js`.** PTC programs get a
`connectCua` prelude and call `tools.cua` underneath. App, browser and tab
objects come back as opaque handles, so `cua.getApp`, `cua.getTab`,
`cua.createBrowserTab` and handle methods all run in one `run_code` program.
`cua.stopApp(app?)` replaces the old `computer_use_stop` tool, and
`cua.documentation()` returns the runtime API manual.

**Both generated presets use PTC.** `heavy` no longer swaps in
`tool-executor-native`; the generator emits `tool-executor-ptc` for both
`daily` and `heavy`, and the profile's LCU allowlist covers both.

The underlying ChatGPT runtime, Chrome surface, approvals, `allowedOrigins`,
turn cleanup and image attachment pipeline are unchanged.


## 0.3.8

The Codex upgrade script works across DSH Desktop releases again, and its
baseline now records `@openai/codex` 0.164.0.

- Resolve the app-bundled pnpm from the location current Desktop builds use
  (`runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`), keeping the old
  `runtime/pnpm/...` path as a fallback. The 0.2.1-rc.3 release moved it, and the
  script's stale constant made every install fail with a null status.
- Keep the two-space indent when rewriting an existing override line. Dropping
  it turned the key into a top-level entry, so pnpm ignored the override and
  installed the dependency's own 0.153.4 pin; the script then reported
  "installed 0.153.4, wanted 0.164.0" instead of applying the target.
- Include the spawn error when pnpm cannot start, instead of an empty detail.
- Verified 0.164.0 through all three gates (handshake, protocol schema, real
  turn) and recorded it in `scripts/codex-baseline.json`; this profile now pins
  `@deepseek-ai/dsh-subagent-codex>@openai/codex` to 0.164.0.

## 0.3.7

Documentation only; no behaviour change.

The preset recipe now describes DSH 0.2.1's presentation modes: `heavy` uses `native`, because the old `both`
mode was removed and a preset declares exactly one of `native | ptc`. It also records that the official
`subagent_codex` is a global Host tool since 0.2.1, and that `dsh-subagent-codex-pro` shadows it per Agent for the
generated presets rather than a per-preset disabled row switching it off.

## 0.3.6

Metadata only; no behaviour change.

The package's keywords and homepage now use the same vocabulary as the repository's topics:
`deepseek-harness`, `dsh`, `cordis` and `dsh-plugin` plus the capabilities this package provides.

## 0.3.5

Diagnostics only — no behaviour change.

`onDiag` existed on the connection and nothing passed it, so the control channel's decisions never reached the
diagnostic log. The client maps "no runtime service is connected" and "nothing is held" to the same empty list,
and only the connection knows which happened, so a `computer_use_stop` that found nothing was indistinguishable
in the log from one whose channel was never up.

Found by reading a real session's log after a successful browser and computer-use test: the control channel had
been working there the whole time, and there was no line to say so.

## 0.3.4


**The plugin no longer installs, invokes or depends on LCU.** It locates and validates the ChatGPT application
itself, builds the environment the computer-use runtime expects, and starts the application's own entry point.

- **Direct launch.** `src/app.ts` resolves the application, refuses files another account could replace, and
  computes the runtime environment — its own `node` and `node_repl`, its module roots, trusted code paths, the
  API surface, and the signed helper the macOS native pipe launches. No second interpreter: the Python 3.12+
  requirement is gone, and attaching is roughly an order of magnitude faster.
- **Turn cleanup through the application's own IPC.** `helper/sky-service.mjs` is loaded as the runtime's `sky`
  trusted service. It forwards every request to the application's service unchanged and adds the one thing the
  runtime has no handler for: the turn-ended hook that releases a per-application Stop. It deliberately omits
  the step that signalled a supervisor process and spawned the signed client with a `turn-ended` argument —
  that needs Apple Events, which macOS refuses a hardened-runtime harness, so it always timed out. The
  application's own IPC needs no Apple Events and settles in tens of milliseconds.
- **A Stop is released by the turn that asked for it.** `computer_use_stop` now works: the plugin serves the
  runtime's control channel and relays `status` and `stop` to the wrapper, which answers them from inside the
  runtime. Verified end to end — a Stop refuses the application for the turn that asked for it, and the next
  turn can use it again.
- **A long session stays on one generation.** The runtime is executed from files the application replaces when
  it updates, so a facade compares the application's fingerprint before every call and reconnects when it
  changes, carrying the session identity across the replacement.
- **The preset generator moved out.** It generates presets that serve more than one plugin, and the region it
  writes is also written by DSH's settings UI, so it is now
  [its own project](https://github.com/ckanner/dsh-preset-generator). `scripts/gen-presets.mjs` and the
  `presets` script are gone from this package.
- Fixed: a per-connection temporary directory leaked on every path that had to signal the child rather than
  have it exit on stdin.
- Fixed: an unreadable application fingerprint was treated as a change, which started a second runtime for a
  bundle that was merely unreadable for a moment mid-update.

### A note on the version numbers

`v0.3.0` through `v0.3.3` are **git tags**, each with its own content, and npm's `0.3.0` is not any of them:
it was published from the tree *after* `v0.3.3`, and so contains everything below plus the work above. The
next number that is unambiguous is `0.3.4`, which is this release.

## 0.3.3

Reverted the Codex model-selection change from 0.3.2. `modelSelectionSettings: true` cannot be enabled on the
Codex row: the provider declares `NO_START_CAPABILITIES`, which has no `agentOptions`, and `tool-subagent`
asserts that pairing at load — the row vanished with no tool and no error. The "never drop a preset" guardrail
from 0.3.2 is kept.

## 0.3.2

Added the guardrail that a run never drops a preset the profile already defines, and `--daily-only` refuses when
the file already has `heavy`. Also attempted the Codex model surface, reverted in 0.3.3.

## 0.3.1

The `apply` log line records the two lists that decide whether an unattended run can proceed, so an empty
allowlist can be told from a populated one without opening the patch layers.

## 0.3.0

An application can be pre-approved with `allowedApps`, so an unattended run — where an unanswered question is a
refusal — can proceed without a person at the keyboard.
