/** Exercise the published exports and emitted JS using the public MCP fixtures. */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'lcu-packed-consumer-'))
try {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' })
  const [{ filename }] = JSON.parse(output)
  writeFileSync(join(scratch, 'package.json'), '{"private":true,"type":"module"}\n')
  // Exercise npm's real peer resolver with an exact supported host. Unpacking
  // files alone cannot prove prerelease ranges are installable with that host.
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
    join(scratch, filename), '@deepseek-ai/cordis@4.1.0',
    '@deepseek-ai/dsh-tools@0.2.2-rc.3', '@deepseek-ai/dsh-system-prompt@0.2.2-rc.3'],
  { cwd: scratch, stdio: 'inherit' })
  mkdirSync(join(scratch, 'tests'))
  cpSync(join(root, 'tests', 'fixtures'), join(scratch, 'tests', 'fixtures'), { recursive: true })
  const test = readFileSync(join(root, 'tests', 'managed.spec.ts'), 'utf8')
    .replaceAll("'../src/managed.ts'", "'dsh-plugin-lcu/managed'")
    .replaceAll("'../src/bridge.ts'", "'dsh-plugin-lcu/bridge'")
    .replaceAll("'../src/index.ts'", "'dsh-plugin-lcu'")
    .replace("import { CUA_TOOL_NAME } from '../src/ptc.ts'", "const CUA_TOOL_NAME = 'lcu_cua'")
  writeFileSync(join(scratch, 'tests', 'managed.spec.ts'), test)
  execFileSync(process.execPath, ['--test', 'tests/managed.spec.ts'], { cwd: scratch, stdio: 'inherit' })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
