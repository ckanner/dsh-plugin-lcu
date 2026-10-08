/**
 * The ChatGPT application, and the runtime it carries.
 *
 * The computer-use provider is the original one inside the application: this
 * module locates it, checks the pieces it needs are present and not writable by
 * anyone else, and builds the environment the runtime expects. Nothing here
 * launches a third-party wrapper — the launcher is
 * `.../@oai/cua-repl/bin/cua-repl.mjs` inside the application itself.
 *
 * The environment is not guesswork. Every variable below is one the original
 * launcher sets, and each is named in a comment for the thing it selects.
 *
 * @module dsh-plugin-lcu/app
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { diag } from './diag.ts'

/** The default installation the original app uses. */
const DEFAULT_APP = '/Applications/ChatGPT.app'

/**
 * The Sky service module this plugin loads instead of the application's own.
 *
 * It forwards to the application unchanged and adds the turn-ended hook the
 * runtime has no handler for. See its own header for why that hook matters and
 * what it deliberately leaves out.
 */
export function skyServicePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'sky-service.mjs')
}

/** A failure that names the application as its source. */
export class AppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppError'
  }
}

/** The paths one intact application generation offers. */
export interface AppPaths {
  readonly app: string
  readonly resources: string
  readonly runtime: string
  /** The application's `CFBundleShortVersionString`. */
  readonly version: string
  /** The computer-use runtime generation recorded in its manifest. */
  readonly runtimeVersion: string
}

/** Everything needed to start the provider. */
export interface LaunchPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly paths: AppPaths
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Read a plist string without depending on `plutil`. */
function plistValue(plist: string, key: string): string | undefined {
  try {
    const text = readFileSync(plist, 'utf8')
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * Refuse a file another account could replace.
 *
 * The runtime is executed from inside the application, so a world-writable file
 * in that tree is a way for someone else to choose what this session runs. This
 * is the cheap half of what the original installer checks; it is not a
 * signature verification.
 *
 * @param path - the file to inspect.
 * @returns whether the file is a regular file owned by this account or root and writable by neither others nor group.
 */
export function isPrivateFile(path: string): boolean {
  try {
    const info = statSync(path)
    if (!info.isFile()) return false
    // Group or other write is enough for another account to choose what runs.
    if ((info.mode & 0o022) !== 0) return false
    const me = typeof process.getuid === 'function' ? process.getuid() : undefined
    return info.uid === 0 || me === undefined || info.uid === me
  } catch {
    return false
  }
}

/**
 * Locate the application and the runtime inside it.
 *
 * @param appPath - the application to use; defaults to the standard install.
 * @returns the paths and both versions.
 * @throws AppError when the application or a required piece is missing.
 */
export function resolveApp(appPath: string = DEFAULT_APP): AppPaths {
  const app = resolve(appPath)
  if (!isDirectory(app) || !app.endsWith('.app')) {
    throw new AppError(`not an application bundle: ${app}`)
  }
  const resources = join(app, 'Contents', 'Resources')
  const runtime = join(resources, 'cua_node')
  if (!isDirectory(runtime)) {
    throw new AppError(`the application has no computer-use runtime: ${runtime}`)
  }

  for (const [label, path] of [
    ['runtime node', join(runtime, 'bin/node')],
    ['runtime module directory', join(runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')],
    ['Sky service', join(runtime, 'lib/node_modules/@oai/sky/Codex Computer Use.app')],
    ['Codex CLI', join(resources, 'codex-cli/bin/codex')],
  ] as const) {
    if (!exists(path) && !isDirectory(path)) {
      throw new AppError(`the application is missing its ${label}: ${path}`)
    }
    if (exists(path) && !isPrivateFile(path)) {
      throw new AppError(`the application's ${label} is writable by another account: ${path}`)
    }
  }

  const manifest = join(runtime, 'manifest.json')
  let runtimeVersion = 'unknown'
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { runtime_archive_version?: unknown }
    if (typeof parsed.runtime_archive_version === 'string') runtimeVersion = parsed.runtime_archive_version
  } catch {
    // A missing manifest is not fatal: the paths above are what actually matter.
  }

  return {
    app,
    resources,
    runtime,
    version: plistValue(join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString') ?? 'unknown',
    runtimeVersion,
  }
}

/**
 * Build the environment the runtime expects.
 *
 * Every entry mirrors the original launcher. The ones that matter most:
 * `CUA_REPL_NODE_REPL_PATH`/`NODE_REPL_NODE_PATH` select the application's own
 * node, `NODE_REPL_NODE_MODULE_DIRS` and `NODE_REPL_TRUSTED_CODE_PATHS` let it
 * load its modules, `CUA_REPL_ENABLED_SURFACES` chooses the API surface,
 * `SKY_CUA_SERVICE_PATH` is the signed helper the macOS native pipe launches,
 * and `NODE_REPL_REQUEST_META` supplies the identity the runtime uses when a
 * call carries none of its own.
 *
 * `NODE_REPL_TRUSTED_SERVICES` selects the `sky` service. It names this plugin's
 * wrapper rather than the application's own module, because the runtime has no
 * turn-ended handler of its own and a turn that never ends is a turn whose
 * per-application Stop is never released.
 *
 * @param paths - the resolved application paths.
 * @param options - surface selection and the identity fallback.
 * @returns the child environment.
 */
export function buildEnvironment(
  paths: AppPaths,
  options: { readonly chrome: boolean; readonly audio: boolean; readonly identity?: string },
): NodeJS.ProcessEnv {
  const separator = ':'
  const moduleDir = join(paths.runtime, 'lib/node_modules')
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const existingPath = process.env.PATH ?? '/usr/bin:/bin'

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The original runtime selects and trusts CODEX_HOME verbatim.
    CODEX_HOME: codexHome,
    PATH: `${join(paths.runtime, 'bin')}${separator}${existingPath}`,
    CUA_REPL_NODE_REPL_PATH: join(paths.runtime, 'bin/node_repl'),
    NODE_REPL_NODE_PATH: join(paths.runtime, 'bin/node'),
    NODE_REPL_NODE_MODULE_DIRS: [moduleDir, process.env.NODE_REPL_NODE_MODULE_DIRS].filter(Boolean).join(separator),
    NODE_REPL_TRUSTED_CODE_PATHS: [
      codexHome, moduleDir, join(paths.resources, 'plugins'), process.env.NODE_REPL_TRUSTED_CODE_PATHS,
    ].filter(Boolean).join(separator),
    // The original launcher picks both its API and its instructions from this.
    CUA_REPL_ENABLED_SURFACES: options.chrome ? 'browser,computer' : 'computer',
    CUA_REPL_BROWSER_ENV: 'codex-app',
    CODEX_CLI_PATH: join(paths.resources, 'codex-cli/bin/codex'),
    // The signed helper the macOS native pipe transport launches.
    SKY_CUA_SERVICE_PATH: join(moduleDir, '@oai/sky/Codex Computer Use.app'),
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
    BROWSER_USE_AVAILABLE_BACKENDS: 'chrome',
    BROWSER_USE_TINYSKY_ENABLED: '1',
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
    BROWSER_USE_CODEX_APP_VERSION: paths.version,
    NODE_REPL_DISABLE_ANALYTICS: '1',
    BROWSER_USE_DISABLE_AMBIENT_NETWORK: '1',
    // The application's own service and the signed client its turn cleanup goes
    // through. The wrapper reads these two; they name the application's files,
    // not ours.
    DSH_SKY_SERVICE_PATH: join(moduleDir, '@oai/sky/dist/project/cua/sky_js/src/service.js'),
    DSH_SKY_CLIENT_PATH: join(moduleDir, '@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js'),
  }

  // Load our Sky service in place of the application's. The map has to keep the
  // runtime's other defaults, so `browser` is restated when that surface is on.
  const wrapper = skyServicePath()
  if (existsSync(wrapper)) {
    const services: Record<string, string> = {}
    if (options.chrome) services.browser = '@oai/browser-desktop/service'
    services.sky = wrapper
    env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(services)
    // A trusted service is only loaded from a trusted code path, so the wrapper's
    // own directory has to be one.
    env.NODE_REPL_TRUSTED_CODE_PATHS = [dirname(wrapper), env.NODE_REPL_TRUSTED_CODE_PATHS]
      .filter(Boolean)
      .join(separator)
    diag(`environment: sky service -> ${wrapper}`)
  } else {
    diag(`environment: no wrapper at ${wrapper}; the application's own Sky service will be used`)
  }

  if (options.audio) {
    env.SKY_ENABLE_AUDIO = '1'
    env.NODE_REPL_ENABLE_AUDIO = '1'
  }

  // Supplied metadata keeps precedence, as the original runtime intends; this is
  // only the identity used when a call arrives with none of its own.
  if (env.NODE_REPL_REQUEST_META === undefined) {
    const identity = options.identity ?? `dsh-${String(process.pid)}-${Date.now().toString(36)}`
    env.NODE_REPL_REQUEST_META = JSON.stringify({
      'x-codex-turn-metadata': { session_id: identity, turn_id: `${identity}-connection` },
    })
  }

  return env
}

/**
 * The full plan for one connection.
 *
 * @param options - the application, surfaces and override.
 * @returns the command, its arguments, the environment and the paths.
 */
export function planLaunch(options: {
  readonly appPath?: string
  readonly chrome: boolean
  readonly audio: boolean
  readonly identity?: string
  /** An explicit command that replaces the computed one, for an unusual install. */
  readonly command?: string
}): LaunchPlan {
  const paths = resolveApp(options.appPath ?? DEFAULT_APP)
  const env = buildEnvironment(paths, {
    chrome: options.chrome,
    audio: options.audio,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  })

  if (options.command !== undefined && options.command !== '') {
    diag(`launch: explicit command ${options.command}`)
    return { command: options.command, args: options.chrome ? ['--chrome'] : [], env, paths }
  }

  const launcher = join(paths.runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
  diag(`launch: app=${paths.app} version=${paths.version} runtime=${paths.runtimeVersion} launcher=${launcher}`)
  return { command: env.NODE_REPL_NODE_PATH ?? join(paths.runtime, 'bin/node'), args: [launcher], env, paths }
}

/**
 * A fingerprint of the application generation the runtime is run from.
 *
 * The runtime is executed from files the application replaces when it updates, so
 * a session that is already connected can end up running a mix of two
 * generations. Both versions are read from the bundle and both timestamps are
 * part of the answer, because an update replaces the whole bundle and a
 * same-version reinstall is still a different set of files.
 *
 * @param paths - the resolved application paths.
 * @returns a value that changes exactly when the files underneath change.
 */
export function generationOf(paths: AppPaths): string {
  const stamps: string[] = []
  for (const file of [join(paths.runtime, 'manifest.json'), join(paths.app, 'Contents', 'Info.plist')]) {
    try {
      const info = statSync(file)
      stamps.push(`${String(info.mtimeMs)}:${String(info.size)}`)
    } catch {
      stamps.push('missing')
    }
  }
  return `${paths.version}|${paths.runtimeVersion}|${stamps.join('|')}`
}

/** Whether the application can be executed by this account. */
export function appIsRunnable(paths: AppPaths): boolean {
  try {
    accessSync(join(paths.runtime, 'bin/node'), constants.X_OK)
    return true
  } catch {
    return false
  }
}
