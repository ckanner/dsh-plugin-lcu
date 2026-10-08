# dsh-plugin-lcu

English | [中文](docs/README.zh.md)

Drive the desktop and Chrome from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) using the
computer-use runtime that ships **inside the ChatGPT desktop application**.

This plugin launches that runtime directly and speaks to it over MCP. It is the whole integration: locating and
validating the application, building the environment the runtime expects, the approval bridge, the turn
lifecycle, and the macOS service wrapper that performs per-turn cleanup. **Nothing else has to be installed** —
no wrapper project, no second interpreter, no Python.

**No Codex or ChatGPT authentication is involved.** The runtime comes from your local installation and is never
downloaded, rewritten or authenticated.

## Table of Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [Use](#use)
- [Configuration](#configuration)
- [Approvals and the security model](#approvals-and-the-security-model)
- [Understand the implementation](#understand-the-implementation)
- [Troubleshooting](#troubleshooting)
- [Relationship to LCU](#relationship-to-lcu)
- [Companion tools](#companion-tools)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Development](#development)
- [License](#license)

## What you get

| Tool | What it does |
|---|---|
| `js` | Run one JavaScript program against the `cua` desktop/browser API. The first call returns the API documentation, and app or tab selection returns the initial UI state. |
| `js_reset` | Discard the persistent JavaScript session and start a fresh runtime. |

Two host-only tools stay reachable by the plugin and are **never** shown to the model:
`turn_ended` (per-turn cleanup) and `js_add_node_module_dir`.

The plugin adds exactly one tool of its own:

| Tool | What it does |
|---|---|
| `computer_use_stop` | With no argument, list the applications the runtime currently holds for this session. With `app` set to one of their bundle identifiers, release it. It clears the host application's "computer use is active" state for one application without ending the session. |

Screenshots arrive as durable images through DSH's attachment store, so a model route that declares
image input can actually look at the screen.

## Requirements

| | |
|---|---|
| OS | **macOS on Apple Silicon.** The launcher resolves a macOS application bundle and the lifecycle wrapper is a macOS service; other platforms would need both revisited. |
| ChatGPT desktop app | Installed at `/Applications/ChatGPT.app` (or configured with `app`). It supplies the runtime, its instructions and the signed helper. |
| DSH | A profile you can install a bundle into. |

There is **no** Python requirement and **no** separate runtime to install. The plugin starts the application's
own `node` and its own entry point.

## Install

### 1. Install the plugin into a profile

Installing makes the plugin's one row active in that profile. It opens nothing at load time.

```sh
dsh plugin --profile <profile> add dsh-plugin-lcu
```

For the **desktop** app's managed profile, the CLI refuses; install it through the app's plugin
manager (Settings ▸ Plugins) instead, which runs the same pnpm operation.

### 2. Generate the presets

DSH agent presets have **no inheritance**: a preset's `config.plugins` is its complete plugin list, and
a patch replaces a whole entry rather than merging into it. So a custom preset must restate its base.
Rather than hand-copying that list, generate it from the preset that is actually installed:

```sh
node node_modules/dsh-plugin-lcu/scripts/gen-presets.mjs --profile ~/.dsh/profiles/<profile>
```

This writes a marked block into that profile's `cordis.patch.yml` containing two presets:

| Preset | Base | Adds |
|---|---|---|
| `daily` | the shipped `ptc` preset | `subagent_codex` enabled |
| `heavy` | the same, with `tool-presentation: both` | everything above, and this plugin attaches |

Re-run it after a DSH upgrade so the copies keep up. `--with-heavy` is implied; `--dry-run` prints
without writing, and `--out FILE` writes somewhere else.

> `heavy` sets the tool presentation to `both` on purpose. In pure `ptc` presentation the model only
> sees `run_code`, so `js` would have to be nested as a JavaScript string inside another JavaScript
> program. `both` keeps `js` directly callable.

### 3. Configure which modes get the capability

The plugin is one root row with a `presets` allowlist. Edit the installed `cordis.patch.yml`
(or the profile patch) to match the preset ids you generated:

```yaml
- id: lcu
  name: 'dsh-plugin-lcu'
  config:
    presets:
      - heavy
```

### 4. Restart, then make one call

Restart the harness — plugin **code and configuration changes are not hot-reloaded**. Then start a
task in the `heavy` mode (displayed as **重活**) and ask it to do something harmless:

> Use the `js` tool to run `await cua.getState();` and tell me which apps are running.

The first time an app is touched, the runtime asks for approval. See below.

On the first attach the plugin resolves the application and writes what it found to the diagnostic log:

```
app: /Applications/ChatGPT.app version=26.1002.52244 runtime=0.0.29/20261003001300-807782c586fc
attach: launching /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node [...]
```

If the application is missing or one of its files is writable by another account, attach is refused with the
reason instead, and the session simply runs without the capability.

### Optional: enable Chrome

```yaml
config:
  chrome: true
```

This turns on the runtime's browser surface. The browser half of the runtime is OpenAI's, and driving a page
happens through the **official ChatGPT Chrome extension**, which talks to a native messaging host. On a machine
where the ChatGPT desktop application is installed that host is already registered, so nothing further is
needed: enable the extension in the profile you want to drive, and confirm it appears in `cua.getState()`.

Sites stay exact-origin approvals.

### Optional: pre-approve sites

Every site the runtime wants to use asks once. To skip the prompt for origins you trust, list exact
origins — the message must round-trip through `new URL(...).origin` unchanged:

```yaml
config:
  allowedOrigins:
    - http://localhost:3000
```

The diagnostic log names every origin that was asked, which is the easiest way to discover them.

## Use

Pick an enabled mode when you start a task. The tools are attached per Agent: a session in any other
mode never sees them, and never spawns the runtime.

Typical asks:

```
Take a screenshot of the Finder window and tell me its resolution.
List my current Chrome tabs.
Open Safari, go to example.com and read the page title.
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `app` | `/Applications/ChatGPT.app` | The application whose runtime provides computer use. |
| `command` | unset | An explicit executable that replaces the computed launch, for an application the built-in resolution cannot reach. It bypasses the runtime's own environment setup. |
| `chrome` | `false` | Enable the browser surface. |
| `audio` | `false` | Enable the runtime's computer-audio API. |
| `presets` | `["heavy"]` | Agent preset ids whose sessions get the tools. |
| `allowedOrigins` | `[]` | Exact HTTP(S) origins answered without asking. Invalid entries are dropped, never widened. |
| `allowedApps` | `[]` | Bundle identifiers computer use may use without asking. The application hosting the agent is refused even when it is listed here. |
| `sectionOrder` | `0` | Prompt section order for the injected runtime instructions. |

## Approvals and the security model

The model cannot approve anything. Every decision is a person's:

- **Per-app approval.** The runtime asks before it uses an app. The plugin renders its own choices —
  *Allow once*, *Allow for this session* and *Always allow* when the runtime offers them, and
  *Decline* — through DSH's question surface. An answer is mapped back to exactly what was offered; a
  scope the runtime did not offer cannot be granted.
- **Site approval.** Browser access asks per exact origin. `allowedOrigins` only ever matches an exact
  origin; a trailing slash, a path, or different case is a different origin and is asked, not granted.
- **The agent's own host is never approvable.** Computer use can click anything an approved app shows,
  including the approval prompt itself. The guard refuses the application hosting the agent — its
  process ancestry and a list of agent hosts and terminals — before any question is asked.
- **Fail closed.** No question surface, a dismissed prompt, an unrecognized request shape, or an
  aborted call all end as *cancel*, which the runtime treats as a refusal.

The plugin keeps no permission cache of its own; `Always allow` is remembered by the runtime, per app.

### Unattended operation

Every approval belongs to a person, and an unanswered question is a **refusal** —
the runtime does not default to granting. A run with nobody at the keyboard
therefore has to have both halves already decided:

```yaml
config:
  allowedApps:
    - com.google.Chrome        # use this application without asking
  allowedOrigins:
    - https://example.com      # and reach this exact origin without asking
```

- `allowedApps` is matched against the bundle identifier, case-insensitively. The
  application hosting the agent is refused **before** the list is consulted, so no
  entry can authorize it.
- `allowedOrigins` matches an exact origin only; a path, a trailing slash or
  different case is a different origin and is still asked.
- Anything not listed is asked, and with nobody there it is declined.

The diagnostic log names every application and origin that was asked
(`approval: site https://example.com asking (add it to allowedOrigins to skip this)`),
which is how to discover the exact values a run needs.

## Understand the implementation

```
src/app.ts          locate and validate the application; build the runtime environment; plan the launch
src/connection.ts   the MCP client: handshake, tool discovery, calls, elicitation, lifecycle
src/approval.ts     approval-shape recognition and label→value mapping
src/host-guard.ts   the anti-self-approval guard
src/tool.ts         tool definitions, text projection, durable screenshots
src/index.ts        the plugin: per-Agent attach, instructions, turn_ended, approvals
src/control.ts      the relay that carries the runtime's control API to and from the wrapper
src/session.ts      the connection, following the application across an update
src/diag.ts         the attach/approval diagnostic log
helper/sky-service.mjs  the runtime's Sky service: the turn-ended hook and the control channel
```

**The runtime is launched directly.** `src/app.ts` finds `ChatGPT.app`, checks that the pieces it needs are
present and not writable by another account, and computes the environment the runtime expects — its own `node`
and `node_repl`, its module roots, its trusted code paths, the API surface, the signed helper it launches for
the macOS native pipe. It does not set `NODE_REPL_TRUSTED_SERVICES` to the application's default: see below.

**The turn-ended hook is the one thing the runtime lacks.** A turn that never ends is a turn whose
per-application Stop is never released, and the application then refuses every later turn. The runtime exposes
`addTurnEndedHandler` to its trusted services but installs no handler of its own, so
`helper/sky-service.mjs` is loaded **as** the `sky` trusted service: it forwards every request to the
application's own service unchanged and adds the hook, which asks the application to clean up a finished turn
through the application's own signed client.

That is deliberately less than the obvious implementation. Signalling a supervisor process, which then spawns
the signed client with a `turn-ended` argument, needs **Apple Events** — which macOS refuses to grant, and
refuses to even prompt for, when a hardened-runtime harness is the responsible process. That step always times
out. The application's own IPC is the step that performs the cleanup, it needs no Apple Events, and it settles
in tens of milliseconds. There is no supervisor process, and no lifetime socket.

**The control channel is a relay, and the plugin serves it.** Releasing one application early needs the
runtime's control API, which lives inside the runtime's process. The wrapper connects to a socket the plugin
serves, announces itself as the *service*, reports the turn contexts it has seen, and answers `status` and
`stop` requests there. The relay decides nothing: whether a session and turn are real, and whether an
application is actually held, are questions only the wrapper can answer, because only it has the turn
metadata the runtime keys that state by.

Two details of that channel are not guessable. The wrapper runs inside the runtime's JavaScript sandbox, which
refuses an ordinary socket connection with `EPERM` — for the per-user temporary directory and `/private/tmp`
alike — so it connects through the runtime's own `nativePipe` API instead. And that pipe **silently drops a
string write**; messages have to be written as buffers, which is easy to mistake for a peer that never
answered.

**No MCP SDK dependency.** The harness's own MCP bridge declares `capabilities: {}` and therefore cannot answer
elicitation — which is exactly how the runtime asks for approval — and pulling a second SDK into a profile
plugin would pin a version the host does not own. MCP over stdio is newline-delimited JSON-RPC, so the wire is
owned here. Together with type-only imports of the DSH packages, the plugin has **no runtime dependencies at
all**.

**Tools are registered per Agent, not at mount.** The server owns the tool schemas, so they can only be
fetched after the handshake. An Agent's connection is opened when the Agent is created or when it commits a
preset choice, and everything the plugin contributes is registered into that Agent's own context, so it unwinds
on disposal.

**Both preset timings are handled.** A new task is created with the deployment default and the picker's
choice is applied afterwards, so `agent/created` alone would see the wrong composition; the registry
re-emits `agent-preset/selected`, and the plugin reacts to that too.

**Lazy by construction.** Nothing starts at load time. No enabled session, no runtime process.

**Instructions are injected.** The server's `initialize.instructions` becomes a prompt section on the
Agent. It is short by design — the API manual lives in the `js` tool description and in the first tool
result.

## Troubleshooting

Everything the plugin decides about attaching, launching and approving is appended to:

```
~/.dsh/lcu-diag.log
```

It rotates by starting over past 1 MB. `LCU_DIAG=0` disables it. This is the first place to look: the
harness has no plugin-log surface a running session can read, and a failing `agent/created` listener is
otherwise swallowed silently.

| Symptom | Cause and fix |
|---|---|
| Tools never appear in an enabled mode | Check the log for `decide … composed=`. If the composed preset is not in `presets`, fix the allowlist. If there is no `agent-preset/selected` line, the mode was never committed. |
| `computer use is unavailable (…)` at load, or no tools | The application could not be resolved. The log names the reason and the path; check `app`. |
| `no userQuestions service -> cancel (fail closed)` | The approval surface is not mounted in this profile. |
| `refusing to approve the app hosting this agent` | Working as designed; ask for a different app. |
| The ChatGPT app still shows computer use on an app | Ask for `computer_use_stop`, or close the session — the connection owns the runtime process tree and releases it on the way out. |
| Chrome tabs never appear with `chrome: true` | The official extension is not enabled in that browser profile. Open `chrome://extensions`, enable it, and confirm it shows up in `cua.getState()`. |
| An application refuses every turn with "explicitly stopped by the user" | The host application's turn cleanup has not run. Check the log for a `turn cleanup` failure, and quit and relaunch the ChatGPT application to clear the state. |

`node scripts/probe-lcu.mjs` starts the runtime with no harness involved and prints the protocol version,
server identity, instructions length and the tool list — useful to separate a plugin problem from a runtime
problem.

`helper/sky-service.mjs` has three diagnostic switches, all default off, because it runs where the obvious
channels do not work: the runtime's JavaScript sandbox denies file writes, and it captures console output.
`DSH_SKY_DEBUG=1` traces the hook, `DSH_SKY_REPORT=1` makes the next call fail with the last cleanup outcome,
and `DSH_SKY_FORCE_ERROR=1` proves the module loaded at all.

## Relationship to LCU

[LCU](https://github.com/amontlabs/lcu) (MIT, Amont Labs) is the project that showed this was possible:
*Codex computer use, decoupled from the app*. It locates the same runtime and exposes it over MCP.

This plugin does that job itself, and no longer installs or invokes LCU. The differences that matter:

- **No second interpreter.** LCU's launcher is Python and requires 3.12+; this is TypeScript, and its only
  requirement is the application itself. Attach is roughly an order of magnitude faster for it.
- **No supervisor process, and no Apple Events.** The turn cleanup goes through the application's own IPC
  instead of a supervisor that shells out to the signed client.
- **Diagnostics at the moment of failure.** The application is resolved and reported at load, and every
  attach, launch and approval decision is one line in the log.

## Companion tools

`scripts/` also ships two tools for the sibling Codex subagent bundle, because the same profile
usually wants both:

- **`update-codex.mjs`** — keeps the profile's `@openai/codex` on the newest release that still passes
  three gates (handshake, protocol-schema assertions, and a real turn), rolling back automatically when
  one fails. The published `@deepseek-ai/dsh-subagent-codex` pins `0.153.4`, which does not serve every
  current ChatGPT-account model; this bumps it through a profile-level, scoped pnpm override. See
  `node scripts/update-codex.mjs --help` for `--check`, `--verify-only`, `--to` and `--rollback`.
- **`codex-baseline.json`** — the last version that passed all three gates.

## Known limitations and deferred work

- **A delegated child cannot be asked for approval.** DSH only accepts a human answer for a live
  runtime root, so a subagent's approval fails closed. Subagents can perform read-only work that
  needs no approval; anything that needs one must be driven from the top-level session.
- **A per-application Stop is released by the turn that asked for it.** `computer_use_stop` — and pressing
  Esc on the host application's "using your computer" banner — ask the runtime to stop using one application
  for the current turn. The plugin performs the host application's turn-ended cleanup through its own IPC, so
  the next turn can use that application again, and `computer_use_stop` with no argument reports what is held.
  If an application is still refused every turn, that cleanup failed and the log says so. **Ordinary use —
  screenshots, clicks, typing, browser tabs — is unaffected**; the plugin's tool description says so, so a
  model does not stop an application on its own initiative.
- **The `js` sandbox cannot write files.** Every write fails with `EPERM`, including in the temporary
  directory, so a screenshot cannot be saved from inside `js`. Images are delivered to the harness as
  attachments instead, and each stored image reports its host filesystem path in the tool result;
  copying one into the workspace is a one-line `bash` call (`install -m 644 '<path>' <target>` — the
  store keeps its objects mode 400). The plugin states both in the tool result and in the instructions
  it injects.
- **macOS permissions belong to the harness, not to the OpenAI helper.** macOS attributes a permission
  request to the *responsible* process, which for anything the harness spawns is the harness itself.
  Screen Recording and Accessibility must therefore be enabled for **DeepSeek Harness** in System
  Settings; granting them only to ChatGPT or to "Codex Computer Use" is not enough, and macOS will not
  prompt for the missing ones on its own.
- **A browser surface without a Codex account is not wired up.** Driving a page works through the native
  messaging host the desktop application registers. The relay that makes it work on a machine with no Codex
  app present — forcing the extension's agent-request header — is not implemented.
- **The application updating under a running session is only warned about.** The runtime is executed from
  files the application replaces when it updates, so a long session can run a mix of two generations.
  Restart the harness after the application updates.
- **One connection per Agent.** The runtime's JavaScript session is per connection and its approvals are
  bound to a real session and turn, so sharing one connection across Agents would interleave both.
- **Not verified on Linux or Windows.** See [Requirements](#requirements).

## Development

```sh
npm install
npm run typecheck     # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run build         # emits lib/
npm test              # node --test, no build step
```

The connection and launcher suites talk to the **real** installed computer-use runtime and skip themselves
when the application is not present, so `npm test` is meaningful locally and still passes on CI. The
approval, projection, guard and wrapper suites are pure and always run.

Plugin code and configuration are **not hot-reloaded** by the harness: a running process keeps the
module it loaded. Rebuild and restart to see a change.

## License

MIT. Nothing is vendored: the native half is the application's own, and this package has no runtime
dependencies. The ChatGPT application and its instructions remain under their own terms and are used from
your local installation.
