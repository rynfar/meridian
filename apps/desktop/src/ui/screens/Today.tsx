import { useMemo } from 'react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Hero, Label, Panel, Swatch } from '../components/card'
import { Dot } from '../components/pill'
import { Button } from '../components/button'
import { Kbd, Tip } from '../components/controls'
import { Avatar } from '../components/brand'
import { GlyphItem } from '../components/glyph'
import { LimitBar, LimitTrack } from '../components/limit'
import { PromptRibbon, RibbonCell, RibbonLegend } from '../components/ribbon'
import { ConnectionProblem, Skeleton } from '../components/state'
import { AxisLabels, DayStrip } from '../charts/spark'
import { fmtInt, fmtTok, hhmm, pct, plural, relative, seconds } from '../model/format'
import { promptShare, stripColumns } from '../model/prompt'
import { untilText } from '../model/pace'
import { axisLabels, bucketWord, chartSeries, firstFutureSlot, nowFraction, slots } from '../model/series'
import { attention, attentionFootnote, feedRows, hero, heroPromptDetail } from '../model/today'
import type { AccountView } from '../model/accounts'
import { pageShortcut, type Navigate } from '../shell/nav'

export function Today({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data, requests, accounts, serving } = useModels()
  const kind = state?.window.kind ?? 'today'
  const series = useMemo(() => state ? chartSeries(state, now) : null, [state, now])
  const items = useMemo(() => attention(accounts, requests, kind, now), [accounts, requests, kind, now])
  const columns = useMemo(() => series ? stripColumns(slots(series.series, kind, now), firstFutureSlot(kind, now)) : [], [series, kind, now])

  if (data.kind === 'failed' && state) return <div className="px-[26px] py-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <TodaySkeleton />

  const h = hero(state.summary)
  const prompt = promptShare(state.summary)
  const labels = axisLabels(kind, series?.series, now)
  const feed = feedRows(requests)
  const others = accounts.accounts.filter(account => account.provider !== 'antigravity' && account.id !== serving?.id)
  const summaryLoading = state.summary === null
  const generating = h.totalP50 !== null && h.ttfbP50 !== null ? Math.max(0, h.totalP50 - h.ttfbP50) : null

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_312px]">
      <section className="flex min-h-0 min-w-0 flex-col px-[26px] pb-[18px] pt-[22px]">
        <div className="grid grid-cols-[1.15fr_1fr] gap-9">
          {summaryLoading ? <><HeroSkeleton /><HeroSkeleton /></> : <>
            <Hero label={<><Swatch className="bg-cache" />Prompt from cache</>}
              figure={prompt.share === null ? '—' : Math.round(prompt.share * 100)} unit={prompt.share === null ? undefined : '%'}
              strip={<PromptRibbon tokens={prompt} size="hero" />}
              caption={prompt.total ? <span title={heroPromptDetail(prompt, h.missesOnResume)}><b>{fmtTok(prompt.read)}</b> of {fmtTok(prompt.total)} prompt tokens reused · {plural(h.missesOnResume, 'miss', 'misses')} on resume</span> : 'No prompt tokens in this window yet'} />
            <Hero label="Requests" figure={fmtInt(h.requests ?? 0)}
              side={h.failed ? <span className="text-red">{fmtInt(h.failed)} failed</span> : <span className="text-t4">none failed</span>}
              strip={<LatencySplit ttfb={h.ttfbP50} generating={generating} />}
              caption={h.totalP50 !== null ? <>median <b>{seconds(h.totalP50)}</b> · first token after {seconds(h.ttfbP50)}</> : 'Timings appear with the first request'} />
          </>}
        </div>

        <div className="mt-[26px]">
          <div className="flex items-baseline gap-3.5">
            <Label>Prompt tokens per {series ? bucketWord(series.series.bucketMs) : 'hour'}{series?.estimated ? <span className="text-t4" title={series.note}>· estimated from recent requests</span> : null}</Label>
            <RibbonLegend requests className="ml-auto" />
          </div>
          {series ? <DayStrip columns={columns} now={nowFraction(kind, now)} className="mt-2.5" /> : <Skeleton className="mt-2.5 h-[111px]" />}
          <AxisLabels labels={labels} quarters={kind === 'today'} />
        </div>

        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <div className="rule-b flex items-baseline gap-2.5 pb-[7px]">
            <Label strong>Live</Label>
            <span className="num text-sm text-t3">· {feed.length} latest</span>
            <Button variant="text" size="sm" className="ml-auto gap-1.5" onClick={() => navigate('traffic')}>Open Traffic <Kbd>{pageShortcut.traffic}</Kbd></Button>
          </div>
          {state.requests === null ? <div className="mt-2 flex flex-col gap-2">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-5" />)}</div> : feed.length ? (
            <div className="scroll-y -mx-2 mt-0.5 min-h-0 flex-1">
              {feed.map(row => (
                <button key={row.id || row.timestamp} type="button" onClick={() => navigate('traffic', { request: row.id })}
                  className="num grid h-[29px] w-full animate-fade grid-cols-[44px_92px_minmax(0,1fr)_150px_44px_52px] items-center gap-x-3.5 rounded-md px-2 text-left text-base transition-colors duration-150 hover:bg-hover">
                  <span className="text-t4">{hhmm(row.timestamp)}</span>
                  <span className="truncate font-medium text-t1">{row.model}{row.longContext ? <sup className="ml-[3px] text-3xs font-semibold tracking-[0.02em] text-t4">1M</sup> : null}</span>
                  <span className="truncate text-t3">{row.client} · {row.profile}{row.lineage ? ` · ${row.lineage}` : ''}</span>
                  {row.failed ? <span className="truncate text-red" title={row.failure}>{row.failure}</span> : <RibbonCell tokens={{ read: row.cacheRead, write: row.cacheWrite, fresh: row.inputTokens }} />}
                  <span className="text-right font-medium text-cache">{row.failed || row.cacheHit === null ? '' : pct(row.cacheHit)}</span>
                  <span className="text-right text-t2">{seconds(row.totalMs)}</span>
                </button>
              ))}
            </div>
          ) : <div className="grid flex-1 place-items-center text-cap text-t3">No requests yet. They appear here as clients send them.</div>}
        </div>
      </section>

      <aside className="flex min-h-0 flex-col gap-[18px] py-[18px] pr-[18px]">
        <ServingPanel serving={serving} others={others} navigate={navigate} />
        <div className="flex min-h-0 flex-1 flex-col">
          <Label strong className="px-0.5 pb-2.5">Needs attention</Label>
          <div className="scroll-y flex min-h-0 flex-1 flex-col gap-3 px-0.5">
            {items.length ? items.map(item => item.kind === 'limit' ? (
              <GlyphItem key={`limit-${item.account.id}`} kind="warn" title={`${item.account.id} · ${item.title}`}
                detail={`${item.detail}${item.account.limited?.resetsAt && !item.account.limited.stale ? ` Resets ${relative(item.account.limited.resetsAt, now)}.` : ''}`} />
            ) : (
              <GlyphItem key={`fail-${item.group.cause}`} kind="bad" title={item.group.cause} detail={item.group.detail}
                outcome={<span className={item.group.outcome.state === 'cleared' ? 'text-green' : item.group.outcome.state === 'ongoing' ? 'text-red' : 'text-t3'}>{item.group.outcome.state === 'cleared' ? '✓ ' : ''}{item.group.outcome.text}</span>} />
            )) : <GlyphItem kind="ok" title="Nothing needs attention" detail="Accounts have room and no requests failed in this window." />}
          </div>
          <button type="button" onClick={() => navigate('traffic', { filter: 'errors' })} className="mt-3 px-0.5 text-left text-xs text-t4 transition-colors hover:text-accent">{attentionFootnote(h.failed, kind)}</button>
        </div>
      </aside>
    </div>
  )
}

/** Under the Requests hero: waiting for the first token (t4) then generating (t2), median. */
function LatencySplit({ ttfb, generating }: { ttfb: number | null; generating: number | null }) {
  if (ttfb === null || generating === null) return <div className="h-1 rounded-xs bg-well" />
  return (
    <Tip content={`Waiting for the first token ${seconds(ttfb)} · generating ${seconds(generating)} (medians)`}>
      <div className="flex h-1 gap-0.5" role="img" aria-label={`Waiting ${seconds(ttfb)}, generating ${seconds(generating)}`}>
        <i className="block rounded-xs bg-t4" style={{ flexGrow: Math.max(ttfb, 1), flexBasis: 0 }} />
        <i className="block rounded-xs bg-t2" style={{ flexGrow: Math.max(generating, 1), flexBasis: 0 }} />
      </div>
    </Tip>
  )
}

/** The worse of the 5-hour and weekly windows, for a mini track. */
function peakWindow(account: AccountView) {
  const windows = [account.fiveHour, account.weekly].filter(window => window !== undefined)
  return windows.sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1))[0]
}

/** The one raised panel: the account serving requests, its limits with pace, and the others. */
function ServingPanel({ serving, others, navigate }: { serving: AccountView | undefined; others: AccountView[]; navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { accounts } = useModels()
  if (!serving) return (
    <Panel className="flex flex-col items-center gap-2 py-6 text-center text-cap text-t3">
      {state?.profiles === null ? <Skeleton className="h-24 w-full" /> : <>No accounts on this service yet.<Button onClick={() => navigate('accounts')}>Add an account</Button></>}
    </Panel>
  )
  const provider = serving.provider === 'chatgpt' ? 'ChatGPT' : serving.provider === 'antigravity' ? 'Google' : 'Claude'
  const canSwitch = !busy && state?.connection.kind === 'ok'
  return (
    <Panel className="flex min-h-0 shrink-0 flex-col pb-1.5">
      <div className="flex items-center gap-2.5">
        <Avatar id={serving.id} provider={serving.provider} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-md font-semibold leading-tight tracking-title text-t1">
            {serving.id}
            <Tip content={accounts.follow ? 'Following the active account of another Meridian' : 'Serving requests now'}><span className="inline-flex"><Dot tone="accent" size={6} /></span></Tip>
            {accounts.follow ? <span className="text-xs font-normal text-t3">following</span> : null}
          </div>
          <div className="mt-0.5 truncate text-meta text-t3">{[serving.email, serving.planDetail || `${provider} ${serving.plan}`.trim()].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {serving.needsLogin ? <div className="mt-3.5 text-cap text-red">Sign-in required — requests to this account fail until it signs in again.</div> : <>
        <LimitBar name="5-hour" window={serving.fiveHour} now={now} className="mt-3.5" />
        <LimitBar name="Weekly" window={serving.weekly} now={now} className="mt-3.5" />
      </>}
      {serving.extraUsage ? <div className="mt-2.5 text-xs text-t4">{serving.extraUsage.text}</div> : null}
      {serving.usageNote && !serving.needsLogin ? <div className="mt-1 text-xs text-t4">{serving.usageNote}</div> : null}
      {others.length ? <>
        <div className="-mx-4 mb-1 mt-3.5 h-[.5px] bg-ring" />
        <div className="scroll-y -mr-1 max-h-[184px] pr-1">
          {others.map(account => {
            const window = peakWindow(account)
            return (
              <div key={account.id} className="grid h-[30px] grid-cols-[minmax(0,1fr)_54px_78px] items-center gap-2.5 text-cap">
                <span className="truncate font-medium text-t1" title={account.email}>{account.id}<small className="ml-[5px] text-xs font-normal text-t4">{account.plan}</small></span>
                <Tip content={`5h ${pct(account.fiveHour?.utilization)} · weekly ${pct(account.weekly?.utilization)}${account.usageNote ? ` · ${account.usageNote}` : ''}`}>
                  <div><LimitTrack window={window} now={now} label={`${account.id} usage`} /></div>
                </Tip>
                <span className="text-right text-meta font-medium">
                  {account.needsLogin ? <span className="text-red">needs sign-in</span>
                    : account.limited ? <span className="text-yellow">{untilText(account.limited.resetsAt, now)}</span>
                    : accounts.follow ? <span className="font-normal text-t4">followed</span>
                    : <Button variant="text" size="sm" className="text-meta" disabled={!canSwitch} onClick={() => { void run('switch-profile', account.id) }} aria-label={`Use ${account.id}`}>Use</Button>}
                </span>
              </div>
            )
          })}
        </div>
      </> : null}
    </Panel>
  )
}

function HeroSkeleton() {
  return <div><Skeleton className="h-3 w-28" /><Skeleton className="mt-3 h-10 w-32" /><Skeleton className="mt-3 h-1.5" /><Skeleton className="mt-2 h-3.5 w-56" /></div>
}

function TodaySkeleton() {
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_312px]" aria-busy="true" aria-label="Loading">
      <section className="flex flex-col px-[26px] pb-[18px] pt-[22px]">
        <div className="grid grid-cols-[1.15fr_1fr] gap-9"><HeroSkeleton /><HeroSkeleton /></div>
        <Skeleton className="mt-[26px] h-3 w-36" />
        <Skeleton className="mt-2.5 h-[111px]" />
        <div className="mt-8 flex flex-col gap-2.5">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className={cn('h-4', index % 3 === 2 && 'w-4/5')} />)}</div>
      </section>
      <aside className="flex flex-col gap-[18px] py-[18px] pr-[18px]">
        <Panel className="flex flex-col gap-3"><div className="flex items-center gap-2.5"><Skeleton className="size-[30px] rounded-lg" /><Skeleton className="h-4 w-32" /></div><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-16" /></Panel>
        <Skeleton className="h-3 w-28" /><Skeleton className="h-10" /><Skeleton className="h-10" />
      </aside>
    </div>
  )
}
