/**
 * Sidebar-foot restart action for the DeepSeek Harness desktop application.
 *
 * The button sits in the sidebar foot, right-aligned above the account row, and asks the
 * Host half (`POST /desktop-restart/restart`) to restart the application together with
 * its Host. The Host answers `409 not-desktop` outside the desktop shell, in which case
 * this action falls back to reloading the page and says so.
 *
 * @module @moonsand/dsh-desktop-restart/client
 */
window.__ModuleLoader__.load({
  id: '@moonsand/dsh-desktop-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = '@moonsand/dsh-desktop-restart'
    /** How long the second click stays armed before the button reverts to idle. */
    const ARM_TIMEOUT_MS = 6000
    /** How long a restart may take before the button reports that nothing happened. */
    const WATCHDOG_MS = 20000

    /**
     * Restart phase shared by both footer actions.
     *
     * The reload and restart actions are separate slot registrations, so React state inside
     * one is invisible to the other. While a restart is in flight the reload button must be
     * disabled: reloading the page mid-kill would race the watchdog and could leave the
     * window blank until the relaunch wins. A module-level store with a subscriber set is
     * the smallest thing that makes that visible across both components.
     */
    const restartPhase = { value: 'idle', since: 0, listeners: new Set() }

    /**
     * Read the shared phase, healing a value that outlived its attempt.
     *
     * A hot module swap can remount the actions while a phase is still set, and a request
     * that never got an answer leaves nothing to clear it. Each phase therefore carries its
     * own lifetime — the arming window for `confirm`, the watchdog window for `restarting`
     * — and anything older is reported as idle, so the reload button cannot stay disabled
     * forever and the restart button cannot come back stuck on a prompt.
     *
     * @returns The phase both footer actions should render.
     */
    function currentPhase() {
      const spent = Date.now() - restartPhase.since
      if (restartPhase.value === 'restarting' && spent > WATCHDOG_MS + 5000) {
        restartPhase.value = 'idle'
      } else if (restartPhase.value !== 'idle' && restartPhase.value !== 'restarting' && spent > ARM_TIMEOUT_MS + 2000) {
        restartPhase.value = 'idle'
      }
      return restartPhase.value
    }

    /**
     * Publish a phase to every mounted footer action.
     *
     * @param next - One of `idle`, `confirm`, `restarting`, `failed`.
     */
    function publishPhase(next) {
      restartPhase.value = next
      restartPhase.since = Date.now()
      for (const listener of restartPhase.listeners) listener(next)
    }

    /**
     * Subscribe a component to the shared restart phase.
     *
     * @returns The current phase, re-rendering on every change.
     */
    function useRestartPhase() {
      const [phase, setLocal] = React.useState(currentPhase)
      React.useEffect(() => {
        const listener = (next) => setLocal(next)
        restartPhase.listeners.add(listener)
        setLocal(currentPhase())
        return () => {
          restartPhase.listeners.delete(listener)
        }
      }, [])
      return phase
    }

    const zh = {
      label: '重启应用',
      hint: '重启 DeepSeek Harness（应用与 Host）',
      refresh: '刷新界面',
      refreshHint: '只重新加载界面与客户端插件，Host 继续运行，任务不中断',
      refreshBlocked: '正在重启，稍等…',
      reloading: '刷新中…',
      confirm: '确认重启？',
      confirmBusy: '确认重启？有任务在跑',
      restarting: '重启中…',
      failed: '重启失败',
      stillAlive: '应用没有重启，请手动重启，或再点一次',
      notDesktop: '当前不是桌面端，改为刷新界面',
      unreachable: '联系不到 Host，改为刷新界面',
    }
    const en = {
      label: 'Restart app',
      hint: 'Restart DeepSeek Harness (app and Host)',
      refresh: 'Reload UI',
      refreshHint: 'Reloads the interface and client plugins only; the Host keeps running',
      refreshBlocked: 'Restarting — hold on…',
      reloading: 'Reloading…',
      confirm: 'Restart now?',
      confirmBusy: 'Restart now? Tasks are running',
      restarting: 'Restarting…',
      failed: 'Restart failed',
      stillAlive: 'The app did not restart — restart it manually, or click again',
      notDesktop: 'Not the desktop app — reloading the page instead',
      unreachable: 'The Host did not answer — reloading the page instead',
    }

    const CSS = `
.dsr-slot{display:flex;align-items:center;justify-content:flex-start;margin-right:0;min-width:0;padding:0 2px 2px 0}
.dsr-slot.is-trailing{margin-right:auto;padding-right:6px}
.dsr-btn{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:26px;max-width:100%;padding:0 8px;
  border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit)}
.dsr-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.dsr-btn[data-phase="confirm"]{color:var(--dsw-alias-state-error-primary,#d1453b);font-weight:600;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsr-btn[data-phase="restarting"]{cursor:progress;opacity:.75}
.dsr-btn[data-phase="blocked"]{cursor:not-allowed;opacity:.45}
.dsr-btn[data-phase="failed"]{color:var(--dsw-alias-state-error-primary,#d1453b)}
.dsr-icon{flex:none;display:block}
.dsr-btn[data-phase="restarting"] .dsr-icon{animation:dsr-spin 1s linear infinite}
@keyframes dsr-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
`

    /**
     * Round-arrow glyph that marks the control as a restart.
     *
     * A power symbol was tried here for a bigger silhouette contrast against the reload's
     * two arrows, but the round arrow is what reads as "restart" on this shell, so the pair
     * is back to two circular arrows told apart by arc count.
     *
     * @returns The icon element.
     */
    function RestartIcon() {
      return h(
        'svg',
        {
          className: 'dsr-icon',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.8-3.95' }),
        h('path', { d: 'M13.2 2.4v3.2h-3.2' }),
      )
    }

    /**
     * Two opposing arrows: the page reload, distinguished from the restart's single arc.
     *
     * @returns The icon element.
     */
    function RefreshIcon() {
      return h(
        'svg',
        {
          className: 'dsr-icon',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M2.6 8a5.4 5.4 0 0 1 9.2-3.8' }),
        h('path', { d: 'M12.1 1.9v2.9H9.2' }),
        h('path', { d: 'M13.4 8a5.4 5.4 0 0 1-9.2 3.8' }),
        h('path', { d: 'M3.9 14.1v-2.9h2.9' }),
      )
    }

    /**
     * The sidebar-foot reload action: one click reloads the page, no Host call.
     *
     * This is the cheap half of the pair. A client plugin, a stylesheet, or a locale change
     * arrives with the next page load, and reloading leaves the Host — and every running
     * turn — untouched.
     *
     * It is disabled while the other button is restarting: the watchdog kills the
     * application a moment after the Host answers, and a page reload racing that kill can
     * leave the window blank until the relaunch wins.
     *
     * @param props - the slot's owner props (`wide`) plus the bound translator.
     * @returns The action element.
     */
    function RefreshAction(props) {
      const { wide = true, t } = props
      const [busy, setBusy] = React.useState(false)
      const restart = useRestartPhase()
      const blocked = restart === 'restarting'
      const timer = React.useRef(0)
      React.useEffect(() => () => clearTimeout(timer.current), [])
      const onClick = () => {
        if (busy || blocked) return
        setBusy(true)
        timer.current = window.setTimeout(() => {
          window.location.reload()
        }, 120)
      }
      const label = blocked ? t('refreshBlocked') : busy ? t('reloading') : t('refresh')
      return h(
        'div',
        { className: 'dsr-slot' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsr-btn',
            'data-phase': blocked ? 'blocked' : busy ? 'restarting' : 'idle',
            disabled: busy || blocked,
            'aria-label': t('refresh'),
            title: blocked ? t('refreshBlocked') : t('refreshHint'),
            onClick,
          },
          h(RefreshIcon),
          wide ? h('span', { className: 'dsr-text' }, label) : null,
        ),
      )
    }

    /**
     * Read the Host's restart status.
     *
     * @returns Parsed status, or `undefined` when the Host cannot be reached.
     */
    async function readStatus() {
      try {
        const response = await fetch('/desktop-restart/status', {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        })
        if (!response.ok) return undefined
        return await response.json()
      } catch {
        return undefined
      }
    }

    /**
     * Ask the Host to restart the application.
     *
     * @returns The parsed answer, or `undefined` when the request produced no answer.
     */
    async function requestRestart() {
      try {
        const response = await fetch('/desktop-restart/restart', {
          method: 'POST',
          headers: { accept: 'application/json', 'x-dsh-desktop-restart': '1' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        })
        let body
        try {
          body = await response.json()
        } catch {
          body = undefined
        }
        return { status: response.status, body }
      } catch {
        return undefined
      }
    }

    /**
     * The sidebar-foot action: one compact control, a second click to confirm.
     *
     * @param props - the slot's owner props (`wide`) plus the bound translator.
     * @returns The action element.
     */
    function RestartAction(props) {
      const { wide = true, t } = props
      // The phase lives in the module store, not in this component: the reload action reads
      // the same value to disable itself while the kill is in flight.
      const phase = useRestartPhase()
      const [note, setNote] = React.useState('')
      const [busyTasks, setBusyTasks] = React.useState(0)
      const armTimer = React.useRef(0)
      const watchdog = React.useRef(0)

      React.useEffect(
        () => () => {
          clearTimeout(armTimer.current)
          clearTimeout(watchdog.current)
        },
        [],
      )

      const settle = () => {
        clearTimeout(armTimer.current)
        publishPhase('idle')
        setNote('')
        setBusyTasks(0)
      }

      const reloadInsteadOfRestart = (message) => {
        clearTimeout(armTimer.current)
        publishPhase('failed')
        setNote(message)
        window.setTimeout(() => {
          window.location.reload()
        }, 1200)
      }

      const arm = async () => {
        clearTimeout(armTimer.current)
        publishPhase('confirm')
        setNote(t('confirm'))
        armTimer.current = window.setTimeout(settle, ARM_TIMEOUT_MS)
        const status = await readStatus()
        if (status === undefined) return
        if (status.desktop !== true) {
          reloadInsteadOfRestart(t('notDesktop'))
          return
        }
        if (typeof status.activeAgents === 'number' && status.activeAgents > 0) {
          setBusyTasks(status.activeAgents)
          setNote(t('confirmBusy'))
        }
      }

      const restart = async () => {
        clearTimeout(armTimer.current)
        publishPhase('restarting')
        setNote(t('restarting'))
        const answer = await requestRestart()
        if (answer === undefined) {
          reloadInsteadOfRestart(t('unreachable'))
          return
        }
        const reason = answer.body?.reason
        if (answer.status === 409 || reason === 'not-desktop') {
          reloadInsteadOfRestart(t('notDesktop'))
          return
        }
        if (answer.body?.ok !== true) {
          publishPhase('failed')
          setNote(typeof answer.body?.message === 'string' ? answer.body.message : t('failed'))
          return
        }
        watchdog.current = window.setTimeout(() => {
          publishPhase('failed')
          setNote(t('stillAlive'))
        }, WATCHDOG_MS)
      }

      const onClick = () => {
        if (phase === 'restarting') return
        if (phase === 'confirm') {
          void restart()
          return
        }
        void arm()
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape' && phase === 'confirm') {
          event.preventDefault()
          settle()
        }
      }

      const label =
        phase === 'confirm'
          ? busyTasks > 0
            ? t('confirmBusy')
            : t('confirm')
          : phase === 'restarting'
            ? t('restarting')
            : phase === 'failed'
              ? t('failed')
              : t('label')

      return h(
        'div',
        { className: 'dsr-slot is-trailing' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsr-btn',
            'data-phase': phase,
            disabled: phase === 'restarting',
            'aria-label': t('label'),
            title: note === '' ? t('hint') : note,
            onClick,
            onKeyDown,
          },
          h(RestartIcon),
          wide || phase !== 'idle' ? h('span', { className: 'dsr-text' }, label) : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries, the component styles, and the sidebar-foot action.
       *
       * @param ctx - Browser plugin context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-desktop-restart', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        })
        const t = ctx.locale.bind(NS)
        // No keyboard accelerator, by design. The Windows desktop shell hands shortcut
        // combinations to a trusted native bridge before page handlers run, so a page-level
        // listener here could never see them, and the product's own shortcut service would
        // add a dependency this plugin does not otherwise need. The button is the way in.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'desktop-refresh',
              order: -110,
              label: () => t('refresh'),
              locale: NS,
              inject: () => ({ t }),
            },
            RefreshAction,
          ),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'desktop-restart',
              order: -100,
              label: () => t('label'),
              locale: NS,
              inject: () => ({ t }),
            },
            RestartAction,
          ),
        )
      },
    }
  },
})
