# dsh-desktop-restart

English | [中文](README.zh.md)

Two buttons in the sidebar foot of the **DeepSeek Harness desktop app**: reload the interface, or restart the entire application (app + Host).

The production desktop shell ships no *Reload Page* menu item and no built-in accelerator for it, and it exposes no way to relaunch itself — `app.relaunch()` lives in the Electron main process and is wired only to crash recovery. This plugin adds both, as ordinary sidebar actions.

```
[⟲ 刷新界面] [↻ 重启应用]
```

| Button | What it does |
|---|---|
| **Reload UI** | `location.reload()`. Reloads the page and every client plugin; the Host keeps running and turns in flight are not interrupted. |
| **Restart app** | Asks the Host to end every process of the application binary and start it again from the same path. Second click to confirm; the label turns red when Agent turns are running. |

## Requirements

- **Windows only.** The restart path is built on the Windows Task Scheduler and Windows Script Host.
- DeepSeek Harness desktop `0.2.1-rc.3` (tested). Other builds are untested.
- No npm dependencies. `index.js` imports only Node built-ins; `client.js` imports `react`, provided by the shell.

## Install

From npm:

```powershell
pnpm add @moonsand/dsh-desktop-restart
```

From a local checkout, while developing:

```powershell
# "dependencies": { "@moonsand/dsh-desktop-restart": "link:D:/path/to/dsh-desktop-restart" }
pnpm install
```

Either way, the package must also be registered as a bundle — **that entry is what actually loads it**:

```json
"dsh": { "profile": { "bundles": [ ..., "@moonsand/dsh-desktop-restart" ] } }
```

A package that is installed but **absent from `dsh.profile.bundles` silently does nothing**: it produces no error and no button. Add the bundle entry, then restart the app.

The package ships its own `cordis.patch.yml`, which inserts the Host-side service, so no edit to the profile patch layer is needed.

## How the restart works

Three platform facts shape the design, all measured on a real machine:

1. A **detached** `powershell.exe` starts but never runs its `-EncodedCommand` script — silently, with no error. The helper is spawned as a plain child instead.
2. Every process the Host starts inherits Chromium's **job object** with kill-on-close, so anything the Host spawns dies with the application's main process. A helper that kills first and launches afterwards dies between those two steps.
3. The **Task Scheduler** service resolves launches in its own process, outside that job, which is the only way to leave something running that outlives the kill.

So the order is inverted:

```
Client click
  -> POST /desktop-restart/restart
    -> Host writes watchdog.ps1 + launch.vbs, spawns a helper (powershell -EncodedCommand, not detached)
      -> helper creates a one-shot scheduled task: wscript.exe launch.vbs   (GUI subsystem, no console)
        -> launch.vbs starts watchdog.ps1 hidden (window style 0)
      -> helper polls a marker file (<= 5 s) to prove the watchdog is alive
      -> without that proof it aborts and kills nothing
      -> helper exits — it lives inside the job and must not touch the kill
  -> watchdog (outside the job): sleep 1.2 s -> kill every process of the executable
      -> wait for all to disappear -> sleep 0.6 s -> Start-Process the same path
      -> verify it came back (up to 3 attempts, 6 s apart) -> append to the log
```

### HTTP routes

| Route | Purpose |
|---|---|
| `GET /desktop-restart/status` | `{ desktop, restarting, activeAgents, logPath }` |
| `POST /desktop-restart/restart` | Needs header `x-dsh-desktop-restart: 1` (or the desktop proxy shape: loopback peer, no `Host`/`Origin` header) |
| `POST /desktop-restart/diagnose` | Arms a watchdog in probe mode and reports `{ armed, method }`. Kills nothing — use it to check the chain without restarting. |

### Files

| File | Role |
|---|---|
| `index.js` | Host half: routes, helper/watchdog generation, arming, kill/relaunch mode |
| `client.js` | Client half: the two sidebar actions, styles, zh/en dictionaries, confirm state machine |
| `cordis.patch.yml` | Inserts the Host service into the profile |
| `package.json` | Declares both halves (`dsh.bundle.patch` + `dsh.client`) |
| `locale/*.json` | Plugin page name and description |
| `icon.svg` | Sidebar icon |

Because the package declares a Host half, **Host changes need an app restart**; client-half changes only need a page reload.

## Known limitations

- **The restart is a hard kill** (`TerminateProcess`). The turn in flight is interrupted. Session history and anything already written to disk are unaffected.
- Only the Windows desktop app is supported. On a plain `dsh web` Host the route answers `409 not-desktop` and the button falls back to reloading the page.
- When the Scheduled Task channel is blocked by policy, the helper falls back to launching PowerShell directly, which may flash a console window; the log marks it `(direct powershell)`.
- No keyboard accelerator. The desktop shell hands shortcut combinations to a trusted native bridge before page handlers run, so a page-level listener cannot see them; adding one through the product's shortcut service would pull in a dependency this plugin does not otherwise need.
- `tasklist.exe` is *not* used for process detection: on a measured machine it answers `Access denied` (exit 1) in this context, which would make every poll report the app as gone and start several copies. Detection filters by image name first (`Get-Process -Name`) and then checks `.Path`.

## Development

```powershell
node --check index.js
node --check client.js
```

The three script builders are exported as pure functions, so they can be generated and handed to the Windows PowerShell parser without arming anything:

```js
import { watchdogSource, watchdogLauncherSource, restartHelperScript } from '@moonsand/dsh-desktop-restart'
```

Safe way to exercise the whole chain without touching a live app: generate a watchdog with a **non-existent** executable path, run it with `powershell -File`, and watch the log walk `matched pids:` -> `application gone=True` -> `relaunch issued` -> `watchdog end`.

### Logs

Everything the helper and the watchdog do is appended to `%TEMP%\dsh-desktop-restart.log`. This is the first place to look when a restart misbehaves. The `GET /status` route reports the exact path.

## License

MIT. See [LICENSE](LICENSE).
