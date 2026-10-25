# dsh-desktop-restart

[English](README.md) | 中文

给 **DeepSeek Harness 桌面端**侧栏底部加两个按钮：刷新界面，或重启整个应用（应用 + Host）。

正式发布的桌面壳既没有「刷新页面」菜单，也没有内置快捷键，更没有重新拉起自己的入口 —— `app.relaunch()` 在 Electron 主进程里，只接到崩溃恢复。本插件把这两件事做成普通侧栏动作。

```
[⟲ 刷新界面] [↻ 重启应用]
```

| 按钮 | 作用 |
|---|---|
| **刷新界面** | `location.reload()`。重载页面与全部客户端插件；Host 继续运行，正在跑的回合不中断。 |
| **重启应用** | 请求 Host 结束该可执行文件的全部进程，再从同一路径拉起。需二次确认；有 Agent 回合在跑时标签变红提示。 |

## 环境要求

- **仅 Windows**。重启链路建立在 Windows 计划任务与 Windows Script Host 之上。
- DeepSeek Harness 桌面端 `0.2.1-rc.2` 或更高（已在 `engines.dsh` 声明；实测 `0.2.1-rc.3`），Node `>=20`。
- 无 npm 依赖。`index.js` 只用 Node 内置模块；`client.js` 只用外壳提供的 `react`。

## 安装

从 npm 安装：

```powershell
pnpm add @moonsand/dsh-desktop-restart
```

或者从本地目录安装（开发时）：

```powershell
# "dependencies": { "@moonsand/dsh-desktop-restart": "link:D:/path/to/dsh-desktop-restart" }
pnpm install
```

无论哪种方式，都必须把包名登记进 bundle —— **这一条才真正决定加载**：

```json
"dsh": { "profile": { "bundles": [ ..., "@moonsand/dsh-desktop-restart" ] } }
```

**只装进 `dependencies` 而不进 `dsh.profile.bundles`，插件会静默不加载**：不报错、也不出按钮。加好 bundle 条目后重启应用。

包自带 `cordis.patch.yml` 用于插入 Host 侧服务，所以不必改 profile 的补丁层。反过来说：**不要在 profile 的 `cordis.patch.yml` 里再写一份本插件的 insert** —— 那会让同一份客户端 bundle 被加载两次，抛 `duplicate factory registration` 并挡住启动。

## 插件市场索引（自托管）

仓库里的 `market/index.json` 是**格式 1 的插件市场索引**，由 DSH 自带的 `@deepseek-ai/dsh-plugin-market-index` 校验。想在本机「插件页 → 发现」里看到本插件：

1. 把仓库推到 GitHub，索引地址即 `https://raw.githubusercontent.com/MoonSand/dsh-desktop-restart/main/market/index.json`（也可以走 GitHub Pages）。
2. 插件页 → **发现** → **添加索引源**，粘贴该 https 地址。索引源只接受 `http:` / `https:`，且不能带凭据或片段。
3. 卡片会显示中英双语的标题与描述（索引里的 `description` 是 `{ "en": …, "zh": … }` 对象，**必须含 `en`**，只写中文会被校验器拒绝），安装使用 npm 上的精确版本。

每个版本条目都带 `engines.dsh` 且与 `package.json` 一致——发现页的兼容性与「默认版本」按它计算；没有兼容版本的插件，安装按钮是禁用的。新增版本时追加一条 `versions`：`version`、真实发布时间的 Unix 秒 `publishTimestamp`、`source.type: "npm"`。

## 重启是怎么实现的

三条平台事实决定了这个设计，均在本机实测：

1. **detached** 的 `powershell.exe` 起得来，但 `-EncodedCommand` 里的脚本一句都不执行，且不报错。所以帮手以普通子进程启动。
2. Host 启动的所有进程都继承 Chromium 的 **job object**（kill-on-close），宿主主进程一死，它 spawn 的东西全部陪葬。"先杀后拉"的帮手会死在这两步之间。
3. **计划任务**服务在自己的进程里解析启动项，位于那个 job 之外 —— 这是唯一能把东西留在杀进程之后继续跑的通道。

所以顺序是反过来的：

```
客户端点击
  -> POST /desktop-restart/restart
    -> Host 写 watchdog.ps1 + launch.vbs，spawn 帮手（powershell -EncodedCommand，不 detached）
      -> 帮手建一次性计划任务：wscript.exe launch.vbs（GUI 子系统，不建控制台）
        -> launch.vbs 以 window style 0 隐藏启动 watchdog.ps1
      -> 帮手轮询 marker 文件（≤ 5 秒）确认看门狗活着
      -> 拿不到证据就中止，一个进程都不杀
      -> 帮手退出 —— 它住在 job 里，绝不能自己动手杀
  -> 看门狗（在 job 之外）：睡 1.2 秒 -> 杀掉该可执行文件的全部进程
      -> 等全部消失 -> 睡 0.6 秒 -> Start-Process 同一路径
      -> 回验是否起来了（最多 3 次，每次间隔 6 秒）-> 追加日志
```

### HTTP 路由

| 路由 | 用途 |
|---|---|
| `GET /desktop-restart/status` | 返回 `{ desktop, restarting, activeAgents, logPath }` |
| `POST /desktop-restart/restart` | 需要请求头 `x-dsh-desktop-restart: 1`（或桌面代理形态：回环对端、无 `Host`/`Origin` 头） |
| `POST /desktop-restart/diagnose` | 以 probe 模式武装看门狗并回报 `{ armed, method }`。**不杀任何进程**，用来验证链路是否完好。 |

### 文件职责

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半边：路由、helper/watchdog 生成、武装、杀进程与拉起 |
| `client.js` | Client 半边：两个侧栏动作、样式、中英文字典、确认状态机 |
| `cordis.patch.yml` | 把 Host 侧服务插入 profile |
| `package.json` | 声明两半（`dsh.bundle.patch` + `dsh.client`） |
| `locale/*.json` | 插件页显示名与描述 |
| `icon.svg` | 侧栏图标 |

因为声明了 Host 半边，**Host 改动必须重启应用**；纯客户端改动只需刷新页面。

## 已知限制

- **重启是硬杀**（`TerminateProcess`），正在进行的回合会中断。会话历史与已落盘内容不受影响。
- **包管理器正在往 profile 里装东西时拒绝重启**（`409 installing`）。三路信号都查：①插件管理器自己广播的 `plugin-manager/install-state`（`installing` / `cancelling` / `applying`）——这条最权威，但它不发“完成”事件，所以相位十分钟后自动过期；②lockfile 或 `node_modules/.modules.yaml` 在最近 10 秒内被写过，抓的是安装**刚结束**那一刻（lockfile 是最后才写的）；③兜底是有命令行里带 `pnpm` 的 `node` 进程在跑。10 秒这个窗口故意留得短：已经装完的安装不该继续挡住重启。三路都是尽力而为，判不出来就放行。
- 只支持 Windows 桌面端。在普通 `dsh web` 下路由回 `409 not-desktop`，按钮退化为刷新页面。
- 计划任务通道被策略禁用时，帮手会退化为直接启动 PowerShell，可能闪一下控制台窗口；日志标记 `(direct powershell)`。
- 没有键盘快捷键。桌面端会把快捷键组合交给可信原生桥、在页面处理器之前拦截，页面级监听看不到；改走产品快捷键服务又会引入本插件并不需要的依赖。
- 进程检测**不用** `tasklist.exe`：实测该上下文下它返回 `Access denied`（退出码 1），若拿它判断存活，每次轮询都会报告"应用已消失"，进而拉起多份应用。改为先按镜像名过滤（`Get-Process -Name`）再校验 `.Path`。

## 开发

```powershell
npm test          # 冒烟：生成器、安装保护、两个侧栏动作、PS 5.1 解析
node --check index.js
node --check client.js
```

三个脚本生成函数已导出为纯函数，可以在不武装任何任务的前提下生成脚本、交给 Windows PowerShell 解析器校验：

```js
import { watchdogSource, watchdogLauncherSource, restartHelperScript } from '@moonsand/dsh-desktop-restart'
```

不碰真实应用的全链路干跑：用**不存在的**可执行路径生成 watchdog，`powershell -File` 跑，观察日志依次走 `matched pids:` -> `application gone=True` -> `relaunch issued` -> `watchdog end`。

### 日志

helper 与看门狗做的一切都追加到 `%TEMP%\dsh-desktop-restart.log`。重启行为异常时先看这里；`GET /status` 会回报确切路径。

## 许可证

MIT，见 [LICENSE](LICENSE)。
