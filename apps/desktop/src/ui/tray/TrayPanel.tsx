import { useEffect, useLayoutEffect, useRef } from 'react'
import { Play, Radar } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { Label, Swatch } from '../components/card'
import { Dot } from '../components/pill'
import { Tip } from '../components/controls'
import { GlyphItem } from '../components/glyph'
import { LimitTrack, windowTitle } from '../components/limit'
import { PromptRibbon } from '../components/ribbon'
import { ReadFailed, Skeleton } from '../components/state'
import { fmtInt, fmtTok, hhmm, percentFigure, when } from '../model/format'
import { healthChip, host, sourceRead, summaryScope } from '../model/status'
import { lastFailure } from '../model/failures'
import { promptShare } from '../model/prompt'
import { accountAction, type AccountView } from '../model/accounts'
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
  // The same token-weighted share as the window's Today hero and sidebar.
  const prompt = promptShare(state?.summary)
  const failure = lastFailure(requests)
  // Quota groups stay apart: Claude and ChatGPT share a pool; Antigravity's Google allowance is its own and is never switched here.
  const groups = ([['pool', accounts.accounts.filter(account => account.provider !== 'antigravity')], ['antigravity', accounts.accounts.filter(account => account.provider === 'antigravity')]] as const).filter(([, list]) => list.length)
  const [label, ...context] = chip.label.split(' · ')
  const quiet = (state?.preferences.quietUntil ?? 0) > now
  const summaryRead = sourceRead(state, 'summary')
  const loadingFigures = data.kind === 'loading' || summaryRead.kind !== 'ready'
  // Antigravity reports totals since it started, whatever the window.
  const service = summaryScope(state) === 'service'

  return (
    <div ref={root} className="tray-root flex flex-col gap-3.5 px-3.5 pb-2.5 pt-3.5 text-base">
      <div role="status" className="flex items-center gap-[7px] text-cap">
        <Dot tone={chip.tone} />
        <span className="min-w-0 truncate font-medium text-t1">{label}{context.length && data.kind === 'ready' ? <span className="font-normal text-t3"> · {context.join(' · ')}</span> : null}</span>
        <span className="flex-1" />
        {state?.instance ? <Tip content={state.instance.baseUrl}><span className="num text-xs text-t3">:{state.instance.port}</span></Tip> : null}
      </div>

      {data.kind === 'failed' && state ? (
        <div className="flex items-start gap-3">
          <GlyphItem kind={state.connection.kind === 'wrong-port' ? 'warn' : 'bad'} title={data.title} detail={data.fix || data.message} className="flex-1" />
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {state.preferences.mode === 'managed' && !state.owned && state.preferences.selected ? <Button onClick={() => { void run('start') }} disabled={busy}><Play />Start</Button> : null}
            <Button variant="subtle" onClick={() => { void run('redetect') }} disabled={busy}><Radar />Re-detect</Button>
          </div>
        </div>
      ) : data.kind === 'ready' && summaryRead.kind === 'failed' ? (
        <ReadFailed compact what="the totals" message={summaryRead.message} busy={busy} onRetry={() => { void run('refresh') }} />
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <div className="lift min-w-0 rounded-xl bg-surface px-3 pb-2.5 pt-2.5">
            <Label className="text-xs"><Swatch className="bg-cache" />Prompt from cache</Label>
            {loadingFigures ? <Skeleton className="mt-1.5 h-7 w-16" /> : (
              <div className="num mt-1 flex items-baseline font-display text-2xl font-semibold leading-none tracking-hero text-t1">{prompt.share === null ? '—' : percentFigure(prompt.share)}{prompt.share === null ? null : <span className="ml-0.5 text-lg font-medium tracking-unit text-t3">%</span>}</div>
            )}
            <PromptRibbon tokens={prompt} size="mini" className="mt-2" />
            <div className="num mt-1.5 truncate text-xs text-t3">{fmtTok(prompt.read)} {service ? 'reused since start' : reused[kind]}</div>
          </div>
          <div className="lift min-w-0 rounded-xl bg-surface px-3 pb-2.5 pt-2.5">
            <Label className="text-xs">Requests</Label>
            {loadingFigures ? <Skeleton className="mt-1.5 h-7 w-16" /> : (
              <div className="num mt-1 flex items-baseline gap-1.5 font-display text-2xl font-semibold leading-none tracking-hero text-t1">{fmtInt(h.requests ?? 0)}{h.failed ? <span className="font-sans text-sm font-medium tracking-normal text-red">{fmtInt(h.failed)} failed</span> : null}</div>
            )}
            <div className="mt-2 flex h-[3px] gap-px overflow-hidden rounded-sm bg-well" role="img" aria-label={`${fmtInt(h.failed)} of ${fmtInt(h.requests ?? 0)} failed`}>
              {(h.requests ?? 0) - h.failed > 0 ? <i className="block bg-t4" style={{ flexGrow: (h.requests ?? 0) - h.failed, flexBasis: 0 }} /> : null}
              {h.failed ? <i className="block bg-red" style={{ flexGrow: h.failed, flexBasis: 0, minWidth: 2 }} /> : null}
            </div>
            <div className="num mt-1.5 truncate text-xs text-t3">{h.failed ? '' : 'none failed · '}{service ? 'since service start' : since[kind]}</div>
          </div>
        </div>
      )}

      {groups.length ? (
        <div className="scroll-y -mx-1 flex max-h-[260px] flex-col gap-2 px-1">
          {groups.map(([group, list]) => (
            <div key={group}>
              <div className="mb-0.5 grid grid-cols-[minmax(0,1fr)_54px_54px_74px] gap-2.5 text-xs text-t3"><span>{group === 'antigravity' ? 'Antigravity · Google' : 'Accounts'}</span><span>5-hour</span><span>Weekly</span><span /></div>
              <div className="-mx-1 flex flex-col">
                {list.map(account => <TrayAccount key={account.id} account={account} now={now} canSwitch={!busy && data.kind === 'ready' && !accounts.follow} onUse={() => { void run('switch-profile', account.id) }} followed={Boolean(accounts.follow)} />)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {data.kind === 'ready' && state?.requests !== null ? (
        failure ? <GlyphItem kind="bad" title={`Last failure · ${when(failure.row.timestamp, now)}`} detail={<span className="block truncate" title={failure.cause}>{failure.cause}</span>} />
          : <GlyphItem kind="ok" title="No failures" detail="None in the loaded requests." />
      ) : null}

      {state?.owned ? (
        <div className="flex items-center gap-3 text-xs text-t3">
          <span className="flex-1 truncate">Meridian’s own copy on {host(state.instance?.baseUrl)}</span>
          <Button variant="text" size="sm" className="text-xs" onClick={() => { void run('restart') }} disabled={busy}>Restart</Button>
          <Button variant="text" size="sm" className="text-xs text-red" onClick={() => { void run('stop') }} disabled={busy}>Stop</Button>
        </div>
      ) : null}

      {notice?.tone === 'error' ? <GlyphItem kind="bad" title={<span className="font-normal text-red">{notice.text}</span>} /> : null}

      <div className="rule-t -mx-3.5 flex justify-between px-3.5 pt-2 text-cap">
        <button type="button" className="text-t2 transition-colors hover:text-accent" onClick={() => { void run('open-desktop') }}>Open Meridian</button>
        <button type="button" className="text-t3 transition-colors hover:text-accent disabled:opacity-45" disabled={!state?.preferences.notifications} title={state?.preferences.notifications ? undefined : 'Notifications are off'} onClick={() => { void run('toggle-snooze') }}>{quiet ? `Alerts paused · ${hhmm(state?.preferences.quietUntil)}` : 'Pause alerts'}</button>
        <button type="button" className="text-t3 transition-colors hover:text-accent" onClick={() => { void run('quit-app') }}>Quit</button>
      </div>
    </div>
  )
}

/** Name + plan, two mini tracks with pace ticks (no caption), and the action as text. */
function TrayAccount({ account, now, canSwitch, onUse, followed }: { account: AccountView; now: number; canSwitch: boolean; onUse(): void; followed: boolean }) {
  const title = `${account.id} · ${account.fiveHour ? windowTitle(account.fiveHour, now) : '5-hour: no reading'} · ${account.weekly ? windowTitle(account.weekly, now) : 'Weekly: no reading'}`
  const action = accountAction(account, followed, now)
  return (
    <div role="group" className="grid h-[30px] grid-cols-[minmax(0,1fr)_54px_54px_74px] items-center gap-2.5 rounded-md px-1 text-cap transition-colors duration-150 hover:bg-hover" aria-label={title} title={title}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium text-t1">{account.id}</span>
        {account.active ? <Dot tone="accent" size={6} /> : null}
        <small className="truncate text-xs text-t3">{account.plan}</small>
      </span>
      <LimitTrack window={account.fiveHour} now={now} label={`${account.id} 5-hour usage`} />
      <LimitTrack window={account.weekly} now={now} label={`${account.id} weekly usage`} />
      <span className={cn('truncate text-right text-meta font-medium')}>
        {action.kind === 'serving' ? <span className="font-normal text-t3">{followed && account.provider !== 'antigravity' ? 'following' : 'serving'}</span>
          : action.kind === 'sign-in' ? <span className="text-red">sign in</span>
          : action.kind === 'held' ? <span className="text-yellow">{action.text}</span>
          : action.kind === 'followed' ? <span className="font-normal text-t3">followed</span>
          : action.kind !== 'use' ? null
          : <Button variant="text" size="sm" className="text-meta" onClick={onUse} disabled={!canSwitch} aria-label={`Use ${account.id}`}>Use</Button>}
      </span>
    </div>
  )
}
