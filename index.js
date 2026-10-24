/**
 * Restart endpoint for the DeepSeek Harness desktop application.
 *
 * The renderer exposes no restart channel: `app.relaunch()` lives in the Electron main
 * process, and the production shell wires it only to crash recovery. The Host, however,
 * runs as the application binary itself in Electron's Node mode, so it can end every
 * process of this executable and start it again from the same path.
 *
 * Three platform facts shape the implementation, all measured on this machine:
 *
 * 1. A detached `powershell.exe` starts but never runs its `-EncodedCommand` script, so
 *    the helper is spawned as a plain child.
 * 2. Every process the Host starts inherits Chromium's job object, whose kill-on-close
 *    flag ends the helper the moment the application's main process dies. A helper that
 *    kills first and starts afterwards therefore dies between those two steps.
 * 3. The Scheduled Task service and the shell resolve launches in their own processes,
 *    outside that job, which is the only way to leave something behind that outlives
 *    the kill.
 *
 * So the order is inverted: the helper first arms a *watchdog* through the Task
 * Scheduler, falls back to the shell (`explorer.exe` running a script-host watchdog),
 * and only kills the application once the watchdog has proven it is alive by touching a
 * marker file. Without that proof it refuses to kill anything. The watchdog waits for the
 * application to disappear and starts it again, so the timing of the kill does not matter.
 *
 * Every step is appended to a temporary log, which is the only evidence available after
 * such a restart.
 *
 * @module @moonsand/dsh-desktop-restart
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'desktop-restart'

/** The web carrier is the only Host service this plugin needs. */
export const inject = ['webServer']

/** Route prefix owned by this plugin; the page calls `POST <prefix>/restart`. */
const PREFIX = '/desktop-restart'

/** The one path that performs a restart. */
const RESTART_PATH = `${PREFIX}/restart`

/** Read-only path the button polls before arming, so it can warn about running tasks. */
const STATUS_PATH = `${PREFIX}/status`

/** Arming self-test: arms a watchdog without killing anything, and reports the outcome. */
const DIAGNOSE_PATH = `${PREFIX}/diagnose`

/** Milliseconds the helper waits before arming, so the reply can flush. */
const RESTART_LEAD_MS = 300

/** How long the helper waits for the armed watchdog to prove it started. */
const ARM_POLLS = 25

/** After this long an unfinished restart no longer blocks a new attempt. */
const RETRY_WINDOW_MS = 45_000

/** Scheduled-task name used to escape the application's job object; deleted after the run. */
const TASK_NAME = 'DSH-Desktop-Restart-Watchdog'

/** Directory holding the log and the watchdog scripts. */
const HELPER_DIR = tmpdir()

/** Where the helper and the watchdog record what they did. */
const HELPER_LOG_PATH = join(HELPER_DIR, 'dsh-desktop-restart.log')

/** Watchdog script armed through the Task Scheduler. */
const WATCHDOG_PS1_PATH = join(HELPER_DIR, 'dsh-desktop-restart-watchdog.ps1')

/** Console-free launcher: the script host starts the watchdog with window style 0. */
const WATCHDOG_LAUNCHER_PATH = join(HELPER_DIR, 'dsh-desktop-restart-launch.vbs')

/** Touched by a watchdog as its first act; the helper kills nothing without it. */
const WATCHDOG_MARKER_PATH = join(HELPER_DIR, 'dsh-desktop-restart-watchdog.armed')

/** Written by a probe helper with which mechanism armed a watchdog, for diagnosis. */
const ARM_STATUS_PATH = join(HELPER_DIR, 'dsh-desktop-restart-armed.json')

/** Start time of the attempt in progress; 0 when nothing is in flight. */
let restartingSince = 0

/**
 * Whether an attempt is recent enough to still count as in flight.
 *
 * A handler that crashed midway can never clear the marker, so the marker expires
 * instead of blocking every later click.
 *
 * @returns true while a restart started less than the retry window ago.
 */
function restartInFlight() {
  return restartingSince !== 0 && Date.now() - restartingSince < RETRY_WINDOW_MS
}

/**
 * The desktop application's executable, or `undefined` on any other Host.
 *
 * Electron's Node mode sets `ELECTRON_RUN_AS_NODE` for the Host child it spawns from
 * the application binary, so both markers together identify a desktop-managed Host.
 *
 * @returns Absolute executable path, or undefined when this is not the desktop shell.
 */
function desktopExecutable() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return undefined
  if (typeof process.versions.electron !== 'string') return undefined
  const executable = process.execPath
  if (typeof executable !== 'string' || executable === '') return undefined
  return executable
}

/**
 * Count the Agent turns this restart would interrupt.
 *
 * @param ctx - Host context owning the composed services.
 * @returns Number of running or queued Agents, or 0 when those services are absent.
 */
function activeAgentCount(ctx) {
  let count = 0
  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      const queued = (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0)
      if (agent.status === 'running' || queued > 0) count += 1
    }
  } catch {
    return 0
  }
  return count
}

/**
 * Quote one PowerShell single-quoted string literal.
 *
 * @param value - Raw text.
 * @returns Literal with embedded quotes doubled.
 */
function psQuote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Quote one VBScript string literal.
 *
 * @param value - Raw text.
 * @returns Literal with embedded quotes doubled.
 */
function vbsQuote(value) {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Build the PowerShell watchdog the Task Scheduler runs outside the application's job.
 *
 * Exported as a pure builder: it reads nothing but its arguments, so a test can generate a
 * script and hand it to the Windows PowerShell parser without ever arming a task.
 *
 * It touches the marker as its first act — that is what proves to the helper that
 * something outside the job is running — and in `restart` mode it does the killing
 * itself. That placement is the whole point: a killer inside the job dies as soon as it
 * touches the process that owns the job, which left the application half dead with a
 * recovery dialog and no relaunch. Out here, killing main simply ends the application.
 *
 * @param executable - Absolute path of the application executable.
 * @param logPath - File the watchdog appends its progress to.
 * @param markerPath - File whose existence proves the watchdog is running.
 * @param mode - `'restart'` to kill and relaunch, `'probe'` to leave the app alone.
 * @returns PowerShell source for the watchdog.
 */
export function watchdogSource(executable, logPath, markerPath, mode) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${psQuote(executable)}`,
    `$log = ${psQuote(logPath)}`,
    `$marker = ${psQuote(markerPath)}`,
    `$mode = ${psQuote(mode)}`,
    // Enumerating every process and reading each one's Path is the slow half of the wait
    // loops below: `.Path` opens a handle per process. Filtering by image name first drops
    // that to the handful that could match, measured on this host at 2.2 ms versus 9.5 ms
    // median for the full sweep, and the gap grows with the process count.
    //
    // `tasklist /FI` was tried first and thrown away: in this context it answers
    // "Access denied" with exit 1 after 47 ms, so a watchdog built on it would report the
    // application as gone in every poll — which is how a relaunch loop starts three copies
    // of the app. Get-Process is the channel that actually works here.
    //
    // The path check stays either way, so a same-named executable in another folder is
    // never mistaken for this one.
    '$name = [System.Management.Automation.WildcardPattern]::Escape([IO.Path]::GetFileNameWithoutExtension($exe))',
    'function Note($line) { "$([DateTime]::Now.ToString(\'o\')) $line" | Out-File -FilePath $log -Encoding utf8 -Append }',
    'function Candidates() {',
    '  $found = @()',
    '  foreach ($p in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {',
    '    try { if ($p.Path -eq $exe) { $found += $p.Id } } catch {}',
    '  }',
    '  return $found',
    '}',
    'function Running() {',
    '  foreach ($procId in (Candidates)) { return $true }',
    '  return $false',
    '}',
    '"$([DateTime]::Now.ToString(\'o\')) armed pid=$PID mode=$mode" | Out-File -FilePath $marker -Encoding utf8 -Append',
    'Note "watchdog start pid=$PID mode=$mode detect=name-filter"',
    'if ($mode -ne "restart") {',
    '  Note "probe mode: leaving the application alone"',
    '  [Threading.Thread]::Sleep(3000)',
    '  Note "watchdog end"',
    '  return',
    '}',
    '# Let the helper record that the watchdog is alive before anything dies.',
    '[Threading.Thread]::Sleep(1200)',
    '$procs = @(Candidates)',
    'Note ("matched pids: " + ($procs -join \',\'))',
    'foreach ($procId in $procs) {',
    '  $killed = $false',
    '  try { (Get-Process -Id $procId -ErrorAction Stop).Kill(); $killed = $true } catch { }',
    '  if (-not $killed) { & taskkill.exe /F /PID $procId | Out-Null }',
    '  Note "kill pid=$procId direct=$killed"',
    '}',
    'for ($i = 0; $i -lt 60; $i++) {',
    '  [Threading.Thread]::Sleep(200)',
    '  if (-not (Running)) { break }',
    '}',
    'Note "application gone=$(-not (Running))"',
    '[Threading.Thread]::Sleep(600)',
    '$attempt = 0',
    '$back = $false',
    'while ($attempt -lt 3) {',
    '  $attempt++',
    '  try {',
    '    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)',
    '    Note "relaunch issued attempt=$attempt"',
    '  } catch {',
    '    Note "relaunch failed attempt=${attempt}: $_"',
    '  }',
    '  for ($j = 0; $j -lt 30; $j++) {',
    '    [Threading.Thread]::Sleep(200)',
    '    if (Running) { $back = $true; break }',
    '  }',
    '  Note "running again=$back attempt=$attempt"',
    '  if ($back) { break }',
    '  [Threading.Thread]::Sleep(800)',
    '}',
    'Note "watchdog end"',
  ].join('\n')
}

/**
 * Windows PowerShell 5.1 executable under the system root.
 *
 * @returns Absolute path of powershell.exe.
 */
function systemPowerShellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Build the console-free launcher the Task Scheduler starts instead of a console program.
 *
 * The script host is a GUI-subsystem executable, so the task creates no console at all,
 * and window style `0` starts the watchdog fully hidden. Launching PowerShell straight
 * from the task instead races with the console the task creates for it, which is the
 * window that stayed on screen after a restart.
 *
 * Exported as a pure builder, like its watchdog counterpart.
 *
 * @param powershellPath - Absolute path of powershell.exe.
 * @param watchdogPath - The watchdog script to start.
 * @returns VBScript source for the launcher.
 */
export function watchdogLauncherSource(powershellPath, watchdogPath) {
  const command = `"${powershellPath}" -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${watchdogPath}"`
  return [
    'Option Explicit',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsQuote(command)}, 0, False`,
  ].join('\r\n')
}

/**
 * Build the helper that arms a watchdog and then ends the application.
 *
 * Killing by executable path — not by process tree — keeps this process alive through its
 * own kill for as long as the job object allows, and the watchdog does not depend on this
 * process surviving at all.
 *
 * Exported as a pure builder. Every path it writes is an argument, with the module's own
 * status path as the default, so a test can generate a helper into a scratch directory.
 *
 * @param executable - Absolute path of the application executable.
 * @param logPath - File the helper appends its progress to.
 * @param watchdogPath - The PowerShell watchdog to arm through the Task Scheduler.
 * @param launcherPath - Script-host launcher that starts the watchdog without a console.
 * @param markerPath - File whose existence proves a watchdog is running.
 * @param taskName - Scheduled-task name that runs the watchdog outside the job.
 * @param mode - `'restart'` to kill after arming, `'probe'` to report and stop.
 * @param statusPath - File the helper publishes its arming result to.
 * @returns PowerShell source for the helper.
 */
export function restartHelperScript(
  executable,
  logPath,
  watchdogPath,
  launcherPath,
  markerPath,
  taskName,
  mode,
  statusPath = ARM_STATUS_PATH,
) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${psQuote(executable)}`,
    `$log = ${psQuote(logPath)}`,
    `$watchdog = ${psQuote(watchdogPath)}`,
    `$launcher = ${psQuote(launcherPath)}`,
    `$marker = ${psQuote(markerPath)}`,
    `$status = ${psQuote(statusPath)}`,
    `$task = ${psQuote(taskName)}`,
    `$mode = ${psQuote(mode)}`,
    '$scriptHost = Join-Path $env:SystemRoot \'System32\\WindowsPowerShell\\v1.0\\powershell.exe\'',
    'function Note($line) { "$([DateTime]::Now.ToString(\'o\')) $line" | Out-File -FilePath $log -Encoding utf8 -Append }',
    'function WaitMarker() {',
    `  for ($i = 0; $i -lt ${String(ARM_POLLS)}; $i++) {`,
    '    if (Test-Path -LiteralPath $marker) { return $true }',
    '    [Threading.Thread]::Sleep(200)',
    '  }',
    '  return $false',
    '}',
    'Note "helper start pid=$PID exe=$exe"',
    `[Threading.Thread]::Sleep(${String(RESTART_LEAD_MS)})`,
    'Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue',
    '$method = "none"',
    '$armed = $false',
    '',
    '# Arm the watchdog outside this process tree: the Scheduled Task service is not the',
    '# application, so its child neither inherits the job object nor dies with the kill.',
    '$startAt = (Get-Date).AddMinutes(5).ToString(\'HH:mm\')',
    '$taskHost = Join-Path $env:SystemRoot \'System32\\wscript.exe\'',
    '',
    '# Attempt 1: let the script host start the watchdog with window style 0. A console',
    '# program launched straight from the Task Scheduler gets a bidirectional console, and',
    '# -WindowStyle Hidden races with it; wscript is a GUI-subsystem host, so no console is',
    '# created at all.',
    '$action = "`"$taskHost`" `"$launcher`""',
    '& schtasks.exe /Create /TN $task /TR $action /SC ONCE /ST $startAt /F | Out-Null',
    '$created = $LASTEXITCODE',
    'Note "schtasks create exit=$created (hidden launcher)"',
    'if ($created -eq 0) {',
    '  & schtasks.exe /Run /TN $task | Out-Null',
    '  Note "schtasks run exit=$LASTEXITCODE (hidden launcher)"',
    '  $armed = WaitMarker',
    '  Note "task watchdog alive=$armed (hidden launcher)"',
    '  if ($armed) { $method = "task-hidden" }',
    '  & schtasks.exe /Delete /TN $task /F | Out-Null',
    '  Note "schtasks delete exit=$LASTEXITCODE (hidden launcher)"',
    '}',
    '',
    '# Attempt 2: the same task running PowerShell directly. This is the shape that may',
    '# flash a console window, kept only so a machine without Windows Script Host still',
    '# restarts instead of doing nothing.',
    'if (-not $armed) {',
    '  $action = "`"$scriptHost`" -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""',
    '  & schtasks.exe /Create /TN $task /TR $action /SC ONCE /ST $startAt /F | Out-Null',
    '  $created = $LASTEXITCODE',
    '  Note "schtasks create exit=$created (direct powershell)"',
    '  if ($created -eq 0) {',
    '    & schtasks.exe /Run /TN $task | Out-Null',
    '    Note "schtasks run exit=$LASTEXITCODE (direct powershell)"',
    '    $armed = WaitMarker',
    '    Note "task watchdog alive=$armed (direct powershell)"',
    '    if ($armed) { $method = "task-visible" }',
    '    & schtasks.exe /Delete /TN $task /F | Out-Null',
    '    Note "schtasks delete exit=$LASTEXITCODE (direct powershell)"',
    '  }',
    '}',
    '',
    '# Nothing else is attempted on purpose. Launching explorer.exe from here produced a',
    '# 0xC0000142 "application could not start" dialog instead of a hidden helper: the shell',
    '# is a singleton GUI process and does not survive being started from this context.',
    '',
    '# Refuse to kill the application without a live watchdog: a restart that closes the',
    '# window and never comes back is worse than no restart at all.',
    'if (-not $armed) {',
    '  Note "abort: no watchdog came alive, application left running"',
    "  ('{{\"armed\":false,\"mode\":\"{0}\"}}' -f $mode) | Out-File -FilePath $status -Encoding utf8",
    '  Note "helper done"',
    '  return',
    '}',
    'Note "watchdog armed via $method"',
    "('{{\"armed\":true,\"method\":\"{0}\",\"mode\":\"{1}\"}}' -f $method, $mode) | Out-File -FilePath $status -Encoding utf8",
    '',
    '# The helper never kills anything. It lives inside the application job, so any kill it',
    '# performed could end the job and take the helper with it — that is exactly how an',
    '# earlier version left the window dead with a recovery dialog. The watchdog owns the',
    '# kill from outside, so this process has finished its work here.',
    'Note "helper done: watchdog owns the kill"',
  ].join('\n')
}

/**
 * Start the helper that arms a watchdog and kills the application.
 *
 * @param executable - Absolute path of the application executable.
 * @param mode - `'restart'` to kill after arming, `'probe'` to report and stop.
 * @returns The helper's process id, or undefined when the platform reports none.
 */
function launchRestartHelper(executable, mode = 'restart') {
  const script = restartHelperScript(
    executable,
    HELPER_LOG_PATH,
    WATCHDOG_PS1_PATH,
    WATCHDOG_LAUNCHER_PATH,
    WATCHDOG_MARKER_PATH,
    TASK_NAME,
    mode,
  )
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // No `detached` here on purpose: a detached powershell.exe never runs its
  // -EncodedCommand script on this platform. See the module doc.
  const helper = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { stdio: 'ignore', windowsHide: true },
  )
  helper.on('error', () => {
    // Reported through the route's answer and the helper log; nothing to recover here.
  })
  helper.unref()
  return helper.pid
}

/**
 * Whether the caller may restart this application.
 *
 * Two shapes are accepted. A page served by this Host sends the header below; without a
 * preflight no cross-origin page can set it, and this route answers no CORS headers, so a
 * third-party site cannot reach the rest. The desktop shell forwards page requests to the
 * Host with `Host`, `Origin`, and cookies stripped, so on a loopback peer that absence is
 * the trusted desktop shape rather than a missing signal.
 *
 * @param request - Node request.
 * @returns true when the caller is this application's own page.
 */
function sameOriginCaller(request) {
  if (request.headers['x-dsh-desktop-restart'] === '1') return true
  if (request.headers.host !== undefined || request.headers.origin !== undefined) return false
  if (request.headers.forwarded !== undefined) return false
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Write both watchdog scripts for the current executable.
 *
 * @param executable - Absolute path of the application executable.
 */
function writeWatchdogs(executable, mode) {
  writeFileSync(WATCHDOG_PS1_PATH, watchdogSource(executable, HELPER_LOG_PATH, WATCHDOG_MARKER_PATH, mode), 'ascii')
  writeFileSync(WATCHDOG_LAUNCHER_PATH, watchdogLauncherSource(systemPowerShellPath(), WATCHDOG_PS1_PATH), 'ascii')
}

/**
 * Wait for a probe helper to publish its arming result.
 *
 * @param deadlineMs - Upper bound in milliseconds.
 * @returns Parsed status, or undefined when the helper never published one.
 */
async function waitForArmStatus(deadlineMs) {
  const limit = Date.now() + deadlineMs
  while (Date.now() < limit) {
    if (existsSync(ARM_STATUS_PATH)) {
      try {
        // Windows PowerShell 5.1 writes UTF-8 *with* a BOM for `-Encoding utf8`, and
        // JSON.parse rejects a leading BOM as an unexpected token. Strip it first.
        return JSON.parse(readFileSync(ARM_STATUS_PATH, 'utf8').replace(/^\uFEFF/, ''))
      } catch {
        // The helper creates the file before writing it, so a parse failure here may just
        // mean half a file. Keep polling until the deadline instead of giving up.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return undefined
}

/**
 * Answer one HTTP request on this plugin's route.
 *
 * @param ctx - Host context owning the composed services.
 * @param request - Node request.
 * @param response - Node response.
 */
async function handleRequest(ctx, request, response) {
  const reply = (status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }
  let pathname = RESTART_PATH
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return reply(400, { ok: false, reason: 'bad-url' })
  }
  if (pathname === STATUS_PATH) {
    if (request.method !== 'GET') return reply(405, { ok: false, reason: 'method-not-allowed' })
    return reply(200, {
      ok: true,
      desktop: desktopExecutable() !== undefined,
      restarting: restartInFlight(),
      activeAgents: activeAgentCount(ctx),
      logPath: HELPER_LOG_PATH,
    })
  }
  if (pathname === DIAGNOSE_PATH) {
    if (request.method !== 'POST') return reply(405, { ok: false, reason: 'method-not-allowed' })
    if (!sameOriginCaller(request)) return reply(403, { ok: false, reason: 'cross-origin' })
    const executable = desktopExecutable()
    if (executable === undefined) return reply(409, { ok: false, reason: 'not-desktop' })
    try {
      rmSync(ARM_STATUS_PATH, { force: true })
      writeWatchdogs(executable, 'probe')
      launchRestartHelper(executable, 'probe')
    } catch (error) {
      return reply(500, {
        ok: false,
        reason: 'spawn-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const status = await waitForArmStatus(15_000)
    return reply(200, {
      ok: status?.armed === true,
      diagnostic: status ?? { armed: false, reason: 'helper did not report in time' },
      logPath: HELPER_LOG_PATH,
    })
  }
  if (pathname !== RESTART_PATH) return reply(404, { ok: false, reason: 'not-found' })
  if (request.method !== 'POST') return reply(405, { ok: false, reason: 'method-not-allowed' })
  if (!sameOriginCaller(request)) {
    return reply(403, { ok: false, reason: 'cross-origin' })
  }

  const executable = desktopExecutable()
  if (executable === undefined) {
    return reply(409, {
      ok: false,
      reason: 'not-desktop',
      message: 'This Host is not the desktop application, so there is no application to restart.',
    })
  }
  if (!existsSync(executable)) {
    return reply(500, { ok: false, reason: 'missing-executable', message: executable })
  }
  if (restartInFlight()) {
    return reply(202, {
      ok: true,
      restarting: true,
      duplicate: true,
      executable,
      logPath: HELPER_LOG_PATH,
    })
  }

  const activeAgents = activeAgentCount(ctx)
  let helperPid
  try {
    writeWatchdogs(executable, 'restart')
    helperPid = launchRestartHelper(executable, 'restart')
  } catch (error) {
    return reply(500, {
      ok: false,
      reason: 'spawn-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  if (helperPid === undefined) {
    return reply(500, {
      ok: false,
      reason: 'spawn-failed',
      message: 'The restart helper process could not be started.',
    })
  }
  restartingSince = Date.now()
  try {
    ctx.logger?.('desktop-restart')?.info?.('restart requested', {
      executable,
      activeAgents,
      helperPid,
      logPath: HELPER_LOG_PATH,
    })
  } catch {
    // Logging is best effort; the restart already owns the outcome.
  }
  return reply(202, {
    ok: true,
    restarting: true,
    activeAgents,
    helperPid,
    executable,
    logPath: HELPER_LOG_PATH,
  })
}

/**
 * Register the restart route for this Host's lifetime.
 *
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (request, response) => {
        const fail = (error) => {
          try {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            response.end(
              JSON.stringify({
                ok: false,
                reason: 'internal',
                message: error instanceof Error ? error.message : String(error),
              }),
            )
          } catch {
            // The response is already gone; nothing else can be reported.
          }
        }
        try {
          const pending = handleRequest(ctx, request, response)
          if (pending !== undefined) pending.catch(fail)
        } catch (error) {
          fail(error)
        }
      },
    }),
  )
}
