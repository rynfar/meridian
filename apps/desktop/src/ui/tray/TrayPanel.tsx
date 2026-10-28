import { useEffect, useLayoutEffect, useRef } from 'react'
import { Play, Radar, RotateCcw, Square } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { Dot, Pill } from '../components/pill'
import { Meter } from '../components/meter'
import { Tip } from '../components/controls'
import { Skeleton } from '../components/state'
import { fmtInt, fmtTok, hhmm, pct, relative, when } from '../model/format'
import { healthChip, host } from '../model/status'
import { lastFailure } from '../model/failures'
import { limitPill, type AccountView } from '../model/accounts'
import { hero } from '../model/today'
import type { WindowKind } from '../../uiData'

const since: Record<WindowKind, string> = { today: 'since 00:00', '1h': 'last hour', '24h': 'last 24h', '7d': 'last 7 days' }
const reused: Record<WindowKind, string> = { today: 'reused today', '1h': 'reused this hour', '24h': 'reused in 24h', '7d': 'reused this week' }

/** Menu-bar panel: health, cache, requests, account limits, last failure; everything else opens the window. */
export function TrayPanel() {
  const { state, now, run, busy, notice } = useDesktop()
  const { data, requests, accounts, serving } = useModels()
  const root = useRef<HTMLDivElement>(null)

  // The panel sizes itself to its content (main clamps it to 320–640).
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const resize = () => { void window.meridian.action('resize-panel', Math.ceil(element.getBoundingClientRect().height)).catch(() => undefined) }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') void window.meridian.action('close-panel') }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const chip = healthChip(state, serving)
  const kind = state?.window.kind ?? 'today'
  const h = hero(state?.summary)
  const failure = lastFailure(requests)
  const list = accounts.accounts.filter(account => account.provider !== 'antigravity')
  const label = chip.label.split(' · ')[0]
  const plan = serving ? [serving.id, serving.plan].filter(Boolean).join(' · ') : ''
  const quiet = (state?.preferences.quietUntil ?? 0) > now

  return (
    <div ref={root} className="tray-root flex flex-col gap-3 p-3.5 text-base">
      <div className="flex items-center gap-2">
        <Dot tone={chip.tone} />
        <b className="font-semibold">{label}</b>
        {plan && data.kind === 'ready' ? <span className="truncate text-muted">· {plan}</span> : null}
        <span className="flex-1" />
        {state?.instance ? <Tip content={state.instance.baseUrl}><span className="font-mono text-xs text-muted">:{state.instance.port}</span></Tip> : null}
      </div>

      {data.kind === 'failed' && state ? (
        <div className="tile rounded-xl px-3 py-2.5">
          <div className="text-sm font-semibold">{data.title}</div>
          <div className="mt-0.5 text-sm text-muted">{data.fix || data.message}</div>
          <div className="mt-2 flex gap-2">
            {state.preferences.mode === 'managed' && !state.owned && state.preferences.selected ? <Button onClick={() => { void run('start') }} disabled={busy}><Play />Start</Button> : null}
            <Button variant="subtle" onClick={() => { void run('redetect') }} disabled={busy}><Radar />Re-detect</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <div className="tile rounded-xl px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-muted"><span className="text-accent2">●</span> Cache hit</div>
            {data.kind === 'loading' || state?.summary === null ? <Skeleton className="mt-1.5 h-7 w-16" /> : <div className="num mt-0.5 text-2xl font-bold tracking-tight text-accent2">{pct(h.hit)}</div>}
            <div className="num truncate text-sm text-muted">{fmtTok(h.reused)} {reused[kind]}</div>
          </div>
          <div className="tile rounded-xl px-3 py-2.5">
            <div className="text-xs font-semibold text-muted">Requests</div>
            {data.kind === 'loading' || state?.summary === null ? <Skeleton className="mt-1.5 h-7 w-16" /> : <div className="num mt-0.5 text-2xl font-bold tracking-tight">{fmtInt(h.requests ?? 0)}</div>}
            <div className="num truncate text-sm text-muted">{h.failed ? <span className="text-red">{fmtInt(h.failed)} failed</span> : 'none failed'} · {since[kind]}</div>
          </div>
        </div>
      )}

      {list.length ? (
        <div>
          <div className="mb-1 flex justify-between text-xs font-semibold text-muted"><span>Accounts</span><span>5h · weekly</span></div>
          <div className="scroll-y flex max-h-[220px] flex-col">
            {list.map(account => <TrayAccount key={account.id} account={account} now={now} canSwitch={!busy && data.kind === 'ready' && !accounts.follow} onUse={() => { void run('switch-profile', account.id) }} followed={Boolean(accounts.follow)} />)}
          </div>
        </div>
      ) : null}

      {data.kind === 'ready' ? (
        <div className="hairline-t flex items-start gap-2.5 border-border pt-2.5 text-sm">
          {failure ? <>
            <Pill tone="red" className="mt-px">{failure.row.status ?? 'err'}</Pill>
            <div className="min-w-0"><div>Last failure · {when(failure.row.timestamp, now)}</div><div className="truncate text-muted">{failure.cause}</div></div>
          </> : <span className="text-muted">No failures in the loaded requests.</span>}
        </div>
      ) : null}

      {state?.owned ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="flex-1">Meridian’s own copy on {host(state.instance?.baseUrl)}</span>
          <Button size="xs" variant="subtle" onClick={() => { void run('restart') }} disabled={busy}><RotateCcw />Restart</Button>
          <Button size="xs" variant="danger" onClick={() => { void run('stop') }} disabled={busy}><Square />Stop</Button>
        </div>
      ) : null}

      {notice?.tone === 'error' ? <div role="alert" className="rounded-md bg-red/10 px-2 py-1 text-xs text-red">{notice.text}</div> : null}

      <div className="hairline-t flex justify-between border-border pt-2.5 text-sm">
        <button type="button" className="text-muted hover:text-accent" onClick={() => { void run('open-desktop') }}>Open Meridian</button>
        <button type="button" className="text-muted hover:text-accent disabled:opacity-45" disabled={!state?.preferences.notifications} title={state?.preferences.notifications ? undefined : 'Notifications are off'} onClick={() => { void run('toggle-snooze') }}>{quiet ? `Alerts paused · ${hhmm(state?.preferences.quietUntil)}` : 'Pause alerts'}</button>
        <button type="button" className="text-muted hover:text-accent" onClick={() => { void run('quit-app') }}>Quit</button>
      </div>
    </div>
  )
}

function TrayAccount({ account, now, canSwitch, onUse, followed }: { account: AccountView; now: number; canSwitch: boolean; onUse(): void; followed: boolean }) {
  const describe = (name: string, window: AccountView['fiveHour']) => window ? `${name} ${pct(window.utilization)} used · ${window.resetsAt ? window.stale ? 'last reading' : `resets ${relative(window.resetsAt, now)}` : 'reset unknown'}` : `${name}: no reading`
  const title = `${account.id} · ${describe('5h', account.fiveHour)} · ${describe('weekly', account.weekly)}`
  return (
    <div className={cn('flex items-center gap-2 rounded-lg px-2 py-[7px]', account.active && 'bg-accent/12')} aria-label={title} title={title}>
      <span className="w-[72px] truncate font-semibold">{account.id}</span>
      <div className="grid flex-1 grid-cols-2 gap-1.5">
        <Meter value={account.fiveHour?.utilization ?? null} stale={account.fiveHour?.stale} label={`${account.id} 5-hour usage`} />
        <Meter value={account.weekly?.utilization ?? null} stale={account.weekly?.stale} label={`${account.id} weekly usage`} />
      </div>
      <span className="flex w-[58px] justify-end">
        {account.active ? <Pill tone="accent">{followed ? 'Following' : 'Active'}</Pill>
          : account.needsLogin ? <Pill tone="red">login</Pill>
          : account.limited ? <Pill tone="red">{limitPill(account.limited).replace(/^(5h|weekly) /, '')}</Pill>
          : followed ? <Pill tone="muted">followed</Pill>
          : <Button size="xs" onClick={onUse} disabled={!canSwitch} aria-label={`Use ${account.id}`}>Use</Button>}
      </span>
    </div>
  )
}
