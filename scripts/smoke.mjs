/**
 * Smoke test: no third-party dependencies, runs anywhere Node 20+ does.
 *
 * It guards the three things that have actually broken or nearly broken here:
 * a client half that stops registering its sidebar actions, a generated
 * PowerShell script that no longer parses under Windows PowerShell 5.1, and a
 * process detector that regresses to the channels this machine refuses
 * (`tasklist` answers "Access denied", so it must not come back).
 *
 * Run with `npm test` (or `node scripts/smoke.mjs`).
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as host from '../index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const exe = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
const log = join(tmpdir(), 'dsh-desktop-restart-smoke.log')
const marker = join(tmpdir(), 'dsh-desktop-restart-smoke.armed')

let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}

// ---------------------------------------------------------------------------
// 1. Host half: the exported builders stay pure and keep their hard-won shape.
// ---------------------------------------------------------------------------
for (const name of ['watchdogSource', 'watchdogLauncherSource', 'restartHelperScript']) {
  check(typeof host[name] === 'function', `${name} must be exported`)
}

const watchdog = host.watchdogSource(exe, log, marker, 'restart')
check(watchdog === host.watchdogSource(exe, log, marker, 'restart'), 'watchdogSource must be deterministic')
check(/Get-Process -Name \$name/.test(watchdog), 'detection must prefilter by image name')
check(!watchdog.includes('tasklist.exe'), 'tasklist answers "Access denied" here and must not come back')
check(watchdog.includes('detect=name-filter'), 'the start line must identify the detector')
check(watchdog.includes('WildcardPattern]::Escape'), 'the image name must be wildcard-escaped')
check(watchdog.indexOf('Out-File -FilePath $marker') < watchdog.indexOf('Sleep(1200)'), 'marker must be touched before the kill')
check(watchdog.includes('if ($mode -ne "restart")'), 'probe mode must return before killing')
check(watchdog.includes('$procs = @(Candidates)'), 'the kill list must reuse Candidates')

const helper = host.restartHelperScript(exe, log, 'watchdog.ps1', 'launch.vbs', marker, 'DSH-Smoke', 'restart')
check(helper === host.restartHelperScript(exe, log, 'watchdog.ps1', 'launch.vbs', marker, 'DSH-Smoke', 'restart'), 'restartHelperScript must be deterministic')
check(/schtasks\.exe \/Create/.test(helper), 'the helper must arm through the Task Scheduler')
check(helper.includes('abort: no watchdog came alive'), 'the helper must refuse to kill without a live watchdog')
check(!helper.includes('Kill()'), 'the helper must never kill from inside the job')

const launcher = host.watchdogLauncherSource('powershell.exe', 'watchdog.ps1')
check(/shell\.Run .+, 0, False/.test(launcher), 'the launcher must start the watchdog hidden')

// PowerShell 5.1 parses "$var:" inside a double-quoted string as a scope
// reference; that silently broke a log line once.
for (const [label, source] of [['watchdog', watchdog], ['helper', helper]]) {
  for (const line of source.split('\n')) {
    check(!/"[^"]*\$[A-Za-z_][A-Za-z0-9_]*:[^"]*"/.test(line), `${label}: bare $var: inside double quotes -> ${line.trim()}`)
  }
}

// The generated scripts must parse under the Windows PowerShell 5.1 grammar on
// a real Windows host. Other platforms skip this; it cannot be faked.
if (process.platform === 'win32') {
  const script = join(tmpdir(), 'dsh-desktop-restart-smoke.ps1')
  writeFileSync(script, watchdog, 'ascii')
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const probe = [
    '$parseErrors = $null',
    `$null = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$parseErrors)`,
    'if ($parseErrors -and $parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Output $_.Message }; exit 1 }',
    'exit 0',
  ].join('; ')
  try {
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', probe], { stdio: 'ignore' })
    checks += 1
  } catch (error) {
    // A confined sandbox refuses to spawn with piped stdio (EPERM). That is an
    // environment limit rather than a broken script, so it is reported and
    // skipped; CI and an ordinary shell do run the check.
    if (error.code !== 'EPERM') throw error
    console.log('smoke: PowerShell parser check skipped (subprocess spawn blocked in this sandbox)')
  }
}

// ---------------------------------------------------------------------------
// 2. The install guard: fail-open, and it only trips on a freshly written
//    manifest in a profile it can actually locate.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-smoke-'))
  const previous = process.env.DSH_PROFILE_DIR
  try {
    process.env.DSH_PROFILE_DIR = dir
    check(host.installInProgress() === false, 'an empty profile must not block a restart')

    const lock = join(dir, 'pnpm-lock.yaml')
    writeFileSync(lock, 'lockfileVersion: 9\n')
    check(host.installInProgress() === true, 'a fresh lockfile must look like an install in flight')

    const past = new Date(Date.now() - 120_000)
    utimesSync(lock, past, past)
    check(host.installInProgress() === false, 'a stale lockfile must not block a restart')

    delete process.env.DSH_PROFILE_DIR
    check(host.installInProgress() === false, 'an unknown profile must fail open, not block')
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 3. Client half: both sidebar actions still register, and the pair still
//    behaves (reload disabled while a restart is in flight).
// ---------------------------------------------------------------------------
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')

// Minimal React: hooks are routed by whichever instance is rendering.
let rendering = null
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState(initial) {
    const inst = rendering
    const index = inst.cursor++
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(inst.hooks[index]) : next
      if (Object.is(value, inst.hooks[index])) return
      inst.hooks[index] = value
      void Promise.resolve().then(() => render(inst))
    }
    return [inst.hooks[index], set]
  },
  useRef(initial) {
    const inst = rendering
    const index = inst.cursor++
    if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
    return inst.hooks[index]
  },
  useEffect(effect) {
    const inst = rendering
    const index = inst.cursor++
    if (index in inst.hooks) return
    inst.hooks[index] = true
    const cleanup = effect()
    if (typeof cleanup === 'function') inst.cleanups.push(cleanup)
  },
}

function render(inst) {
  inst.cursor = 0
  rendering = inst
  try {
    inst.tree = inst.component(inst.props)
  } finally {
    rendering = null
  }
}

function mount(component, props) {
  const inst = { component, props, hooks: [], cursor: 0, cleanups: [], tree: null }
  render(inst)
  return {
    get button() {
      return inst.tree.props.children[0]
    },
    unmount() {
      for (const cleanup of inst.cleanups) cleanup()
    },
  }
}

let reloads = 0
const fakeWindow = {
  location: { reload: () => { reloads += 1 } },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}
const fakeDocument = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
}

globalThis.fetch = async (url) =>
  url === '/desktop-restart/status'
    ? { ok: true, status: 200, json: async () => ({ ok: true, desktop: true, activeAgents: 0 }) }
    : { ok: true, status: 202, json: async () => ({ ok: true, restarting: true }) }

let clientExports = null
fakeWindow.__ModuleLoader__ = {
  load({ factory }) {
    clientExports = factory((specifier) => {
      if (specifier === 'react') return React
      throw new Error(`unexpected require: ${specifier}`)
    })
  },
}
new Function('window', 'document', clientSource)(fakeWindow, fakeDocument)

let dictionary = {}
const specs = []
const ctx = {
  locale: {
    register(_ns, dict) {
      dictionary = dict.zh
      return () => {}
    },
    bind: () => (key) => dictionary[key] ?? `<${key}>`,
  },
  effect(fn) {
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  slots: {
    inject: (_name, register) => register(),
    register(spec, component) {
      specs.push({ spec, component })
      return () => {}
    },
  },
}
clientExports.apply(ctx)

check(JSON.stringify(clientExports.inject) === JSON.stringify(['slots', 'locale']), 'the client must only need slots and locale')
check(specs.length === 2, `expected 2 sidebar actions, got ${specs.length}`)

const refreshSpec = specs.find((entry) => entry.spec.id === 'desktop-refresh')
const restartSpec = specs.find((entry) => entry.spec.id === 'desktop-restart')
check(refreshSpec?.spec.order === -110, 'reload must sort before restart')
check(restartSpec?.spec.order === -100, 'restart order changed')

const t = (key) => dictionary[key] ?? `<${key}>`
const refresh = mount(refreshSpec.component, { wide: true, t })
const restart = mount(restartSpec.component, { wide: true, t })
const idleTitle = String(refresh.button.props.title)

check(idleTitle.length > 0, 'reload must have a tooltip')
const restartIcon = restart.button.props.children[0].type({})
check(restartIcon.props.children.map((child) => child.props.d).includes('M13.2 8a5.2 5.2 0 1 1-1.8-3.95'), 'restart icon must stay the round arrow')

refresh.button.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 200))
check(reloads === 1, 'clicking reload must reload the page')

restart.button.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
restart.button.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
check(restart.button.props['data-phase'] === 'restarting', 'the second click must start the restart')
check(refresh.button.props.disabled === true, 'reload must be disabled while restarting')

refresh.unmount()
restart.unmount()

console.log(`smoke: ${checks} checks passed`)
