# Changelog

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
