# dsh-plugin-lcu

English | [中文](docs/README.zh.md)

Drive the desktop and Chrome from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by
plugging in [LCU](https://github.com/amontlabs/lcu) — *Codex computer use, decoupled from the app*.

LCU exposes the computer-use runtime that ships inside the ChatGPT desktop app as an MCP server.
This plugin makes that runtime a first-class DSH capability: an Agent in an enabled mode gets a `js`
tool that can read and operate real application windows and real Chrome tabs. **No Codex
authentication is involved** — the runtime comes from your local ChatGPT installation, and LCU never
downloads, installs, authenticates, or rewrites it.

## Table of Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [Use](#use)
- [Configuration](#configuration)
- [Approvals and the security model](#approvals-and-the-security-model)
- [Understand the implementation](#understand-the-implementation)
- [Troubleshooting](#troubleshooting)
- [Companion tools](#companion-tools)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Development](#development)
- [License](#license)

## What you get

Two model-facing tools, exactly as LCU defines them — this plugin does not invent a schema:

| Tool | What it does |
|---|---|
| `js` | Run one JavaScript program against the `cua` desktop/browser API. The first call returns the API documentation, and app or tab selection returns the initial UI state. |
| `js_reset` | Discard the persistent JavaScript session and start a fresh runtime. |

Two host-only tools stay reachable by the plugin and are **never** shown to the model:
`turn_ended` (per-turn cleanup) and `js_add_node_module_dir`.

The plugin adds exactly one tool of its own:

| Tool | What it does |
|---|---|
| `computer_use_stop` | With no argument, list the applications the runtime currently holds for this session. With `app` set to one of their bundle identifiers, release it. This is LCU's explicit per-app Stop — the same action its Pi adapter surfaces as `/lcu stop` — which clears the host application's "computer use is active" state for an app without ending the session. |

Screenshots arrive as durable images through DSH's attachment store, so a model route that declares
image input can actually look at the screen.

## Requirements

| | |
|---|---|
| OS | macOS on Apple Silicon. LCU supports Linux too, but this plugin is developed and verified on macOS. |
| ChatGPT desktop app | Installed and signed by OpenAI. It supplies the runtime and the instructions. |
| Python | 3.12 or newer, on `PATH` or in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`. |
| LCU | Installed separately — see below. |
| DSH | A profile you can install a bundle into. |

The plugin targets **macOS**; the `host-guard` uses `ps`/`plutil` and the lifecycle uses LCU's macOS
path. Linux would need those two pieces revisited.

## Install

### 1. Install LCU

Download the release archive for your platform, verify its checksum, and run its installer. Do **not**
register another harness: this plugin is your harness.

```sh
TAG=v0.9.6
TARGET=darwin-arm64
curl -fLO "https://github.com/amontlabs/lcu/releases/download/$TAG/lcu-${TAG#v}-$TARGET.tar.gz"
curl -fLO "https://github.com/amontlabs/lcu/releases/download/$TAG/lcu-${TAG#v}-$TARGET.tar.gz.sha256"
shasum -a 256 -c "lcu-${TAG#v}-$TARGET.tar.gz.sha256"   # must print OK
tar -xzf "lcu-${TAG#v}-$TARGET.tar.gz" && cd "lcu-${TAG#v}-$TARGET"
./scripts/install.sh --runtime-only --yes
```

Then confirm the runtime loads:

```sh
~/.local/share/lcu/current/bin/lcu doctor --non-interactive
```

You want `Original Mac provider loaded; app listing and app-state methods are available`. Privacy
permissions are granted on first use, not here.

### 2. Install the plugin into a profile

Installing makes the plugin's one row — an LCU host — active in that profile. It opens nothing at load
time.

```sh
dsh plugin --profile <profile> add dsh-plugin-lcu
```

For the **desktop** app's managed profile, the CLI refuses; install it through the app's plugin
manager (Settings ▸ Plugins) instead, which runs the same pnpm operation.

### 3. Generate the presets

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

### 4. Configure which modes get the capability

The plugin is one root row with a `presets` allowlist. Edit the installed
`cordis.patch.yml` (or the profile patch) to match the preset ids you generated:

```yaml
- id: lcu
  name: 'dsh-plugin-lcu'
  config:
    presets:
      - heavy
```

### 5. Restart, then make one call

Restart the harness — plugin **code and configuration changes are not hot-reloaded**. Then start a
task in the `heavy` mode (displayed as **重活**) and ask it to do something harmless:

> Use the `js` tool to run `await cua.getState();` and tell me which apps are running.

The first time an app is touched, the runtime asks for approval. See below.

### Optional: enable Chrome

```yaml
config:
  chrome: true
```

Then:

```sh
~/.local/share/lcu/current/bin/lcu browser install
```

Enable the official ChatGPT extension in the Chrome profile you want to drive, and restart Chrome (or
toggle the extension at `chrome://extensions`) so it reconnects through LCU's relay rather than Codex's.
`lcu browser status` reports whether the connector points at this installation. Sites stay
exact-origin approvals.

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
| `command` | `~/.local/share/lcu/current/bin/lcu` | LCU launcher. Set it for a custom `--prefix`. |
| `chrome` | `false` | Pass `--chrome` to enable the browser surface. |
| `audio` | `false` | Pass `--audio` to enable the runtime's computer-audio API. |
| `presets` | `["heavy"]` | Agent preset ids whose sessions get the tools. |
| `allowedOrigins` | `[]` | Exact HTTP(S) origins answered without asking. Invalid entries are dropped, never widened. |
| `allowedApps` | `[]` | Bundle identifiers computer use may use without asking. The application hosting the agent is refused even when it is listed here. |
| `sectionOrder` | `0` | Prompt section order for the injected LCU instructions. |

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

LCU keeps no permission cache of its own; `Always allow` is remembered by the runtime, per app.

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
src/connection.ts   the MCP client: handshake, tool discovery, calls, elicitation, lifecycle
src/approval.ts     approval-shape recognition and label→value mapping
src/host-guard.ts   the anti-self-approval guard
src/tool.ts         tool definitions, text projection, durable screenshots
src/index.ts        the plugin: per-Agent attach, instructions, turn_ended, approvals
src/diag.ts         the attach/approval diagnostic log
```

**No MCP SDK dependency.** The harness's own MCP bridge declares `capabilities: {}` and therefore
cannot answer elicitation — which is exactly how LCU asks for approval — and pulling a second SDK into a
profile plugin would pin a version the host does not own. MCP over stdio is newline-delimited JSON-RPC,
so the wire is owned here. Together with type-only imports of the DSH packages, the plugin has **no
runtime dependencies at all**.

**Tools are registered per Agent, not at mount.** The server owns the tool schemas, so they can only be
fetched after the handshake. An Agent's connection is opened when the Agent is created or when it
commits a preset choice, and everything the plugin contributes is registered into that Agent's own
context, so it unwinds on disposal.

**Both preset timings are handled.** A new task is created with the deployment default and the picker's
choice is applied afterwards, so `agent/created` alone would see the wrong composition; the registry
re-emits `agent-preset/selected`, and the plugin reacts to that too.

**Lazy by construction.** Nothing starts at load time. No enabled session, no `lcu` process.

**Instructions are injected.** The server's `initialize.instructions` becomes a prompt section on the
Agent. It is short by design — the API manual lives in the `js` tool description and in the first tool
result.

## Troubleshooting

Everything the plugin decides about attaching and approving is appended to:

```
~/.dsh/lcu-diag.log
```

It rotates by starting over past 1 MB. `LCU_DIAG=0` disables it. This is the first place to look: the
harness has no plugin-log surface a running session can read, and a failing `agent/created` listener is
otherwise swallowed silently.

| Symptom | Cause and fix |
|---|---|
| Tools never appear in an enabled mode | Check the log for `decide … composed=`. If the composed preset is not in `presets`, fix the allowlist. If there is no `agent-preset/selected` line, the mode was never committed. |
| `no userQuestions service -> cancel (fail closed)` | The approval surface is not mounted in this profile. |
| `refusing to approve the app hosting this agent` | Working as designed; ask for a different app. |
| Calls blocked after a turn | The runtime's turn cleanup had not settled; the plugin retries it before the next call and refuses until it does. |
| `lcu doctor` reports a socket-path error | The signed helper binds under your home folder and refuses a path over 103 bytes. Use an account with a shorter home path. |
| Attach fails with a spawn error | Run `~/.local/share/lcu/current/bin/lcu doctor` directly, then check `command` in the config. |
| The ChatGPT app still shows computer use on an app | The runtime is still holding it. Ask for `computer_use_stop`, or close the session — the connection owns the runtime process tree and releases it on the way out. |
| `lcu status` reports `changed_since_install` | The ChatGPT app updated underneath a running session. LCU warns that such a session can run "a mix of old and new files": stop those sessions and restart the harness so everything comes from one app version. |

`node scripts/probe-lcu.mjs` talks to LCU with no harness involved and prints the protocol version,
server identity, instructions length and the tool list — useful to separate a plugin problem from an
LCU problem.

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
  runtime root, so a subagent's LCU approval fails closed. Subagents can perform read-only work that
  needs no approval; anything that needs one must be driven from the top-level session.
- **A per-application Stop can outlive its session.** `computer_use_stop` — and pressing Esc on the
  host application's "using your computer" banner — ask the runtime to stop using one application. That
  request is cleared by the host application's own turn-ended cleanup, and that cleanup does not run
  reliably here: its Apple Events step is refused, because macOS will not prompt a hardened-runtime
  harness for automation. If an application then refuses every later turn with "explicitly stopped by
  the user", quitting and relaunching the ChatGPT application clears it. **Ordinary use — screenshots,
  clicks, typing, browser tabs — is unaffected and never needs a restart**; the plugin's tool
  description says so, so a model does not stop an application on its own initiative.
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
- **One LCU connection per Agent.** LCU's JavaScript session is per connection and its approvals are
  bound to a real session and turn, so sharing one connection across Agents would interleave both.
- **`chrome` needs the extension.** Enabling the flag without the official ChatGPT extension, or without
  `lcu browser install`, yields no browser surface.
- **Not verified on Linux.** See [Requirements](#requirements).

## Development

```sh
npm install
npm run typecheck     # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run build         # emits lib/
npm test              # node --test, no build step
```

The connection suite talks to the **real** installed `lcu` and skips itself when none is present, so
`npm test` is meaningful locally and still passes on CI. The approval, projection and guard suites are
pure and always run.

Plugin code and configuration are **not hot-reloaded** by the harness: a running process keeps the
module it loaded. Rebuild and restart to see a change.

## License

MIT. LCU is MIT (Amont Labs); the ChatGPT application and its instructions remain under their own
terms and are used from your local installation.
