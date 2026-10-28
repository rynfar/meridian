import { useMemo } from 'react'
import { ChevronRight, CircleCheck } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Card, Label } from '../components/card'
import { Pill, Dot, toneText } from '../components/pill'
import { Meter } from '../components/meter'
import { Button } from '../components/button'
import { Tip } from '../components/controls'
import { Avatar } from '../components/brand'
import { ConnectionProblem, Skeleton } from '../components/state'
import { AxisLabels, HitSpark, RequestBars } from '../charts/spark'
import { fmtInt, fmtTok, hhmm, pct, relative, seconds, when } from '../model/format'
import { utilTone } from '../model/tone'
import { axisLabels, chartSeries, nowFraction, slots } from '../model/series'
import { attention, attentionFootnote, feedRows, hero, heroHitDetail } from '../model/today'
import { limitPill, type AccountView, type LimitWindow } from '../model/accounts'
import type { Navigate } from '../shell/nav'

export function Today({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data, requests, accounts, serving } = useModels()
  const kind = state?.window.kind ?? 'today'
  const series = useMemo(() => state ? chartSeries(state, now) : null, [state, now])
  const items = useMemo(() => attention(accounts, requests, kind, now), [accounts, requests, kind, now])

  if (data.kind === 'failed' && state) return <div className="p-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <TodaySkeleton />

  const h = hero(state.summary)
  const bucketSlots = series ? slots(series.series, kind, now) : []
  const labels = axisLabels(kind, series?.series, now)
  const marker = nowFraction(kind, now)
  const feed = feedRows(requests)
  const others = accounts.accounts.filter(account => account.provider !== 'antigravity' && account.id !== serving?.id)
  const summaryLoading = state.summary === null

  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_1fr_1.05fr] grid-rows-[auto_auto_minmax(0,1fr)] gap-3.5 px-5 pb-5 pt-[18px]">
      <Card>
        <Label><span className="text-accent2">●</span> Cache hit</Label>
        {summaryLoading ? <HeroSkeleton /> : <>
          <div className="num mt-1.5 text-hero font-bold leading-tight tracking-tighter text-accent2">{pct(h.hit)}</div>
          <div className="num mt-0.5 truncate text-sm text-muted">{h.requests ? heroHitDetail(h) : 'No requests in this window yet'}</div>
        </>}
        {series ? <HitSpark slots={bucketSlots} now={marker} /> : <Skeleton className="mt-2.5 h-[46px]" />}
        <AxisLabels labels={labels} />
      </Card>

      <Card>
        <Label>Requests</Label>
        {summaryLoading ? <HeroSkeleton /> : <>
          <div className="num mt-1.5 flex items-baseline gap-1 text-hero font-bold leading-tight tracking-tighter">
            {fmtInt(h.requests ?? 0)}
            <small className={cn('text-lg font-semibold tracking-normal', h.failed ? 'text-muted' : 'text-muted')}>{h.failed ? `${fmtInt(h.failed)} failed` : 'none failed'}</small>
          </div>
          <div className="num mt-0.5 truncate text-sm text-muted">{h.totalP50 !== null ? `p50 ${seconds(h.totalP50)} · first token ${seconds(h.ttfbP50)}` : 'Timings appear with the first request'}</div>
        </>}
        {series ? <RequestBars slots={bucketSlots} /> : <Skeleton className="mt-2.5 h-[46px]" />}
        <AxisLabels labels={labels} />
      </Card>

      <ServingCard serving={serving} others={others} navigate={navigate} />

      <Card className="col-span-2">
        <Label>Where the time goes <Pill tone="violet">median</Pill></Label>
        <Latency ttfb={h.ttfbP50} total={h.totalP50} />
      </Card>

      <Card className="col-span-2 flex min-h-0 flex-col pb-2">
        <div className="flex items-center gap-1.5">
          <Label>Live <Dot tone="green" className="size-1.5" /></Label>
          <span className="flex-1" />
          <Button variant="link" size="xs" className="text-xs font-medium" onClick={() => navigate('traffic')}>Open Traffic <ChevronRight className="-ml-0.5" /></Button>
        </div>
        {state.requests === null ? <Skeleton className="mt-2 h-full" /> : feed.length ? (
          <div className="mt-1.5 min-h-0 flex-1 overflow-hidden">
            <table className="w-full border-collapse text-[12.5px]">
              <tbody>
                {feed.map(row => (
                  <tr key={row.id || row.timestamp} onClick={() => navigate('traffic', { request: row.id })} className="cursor-pointer hover:bg-accent/6">
                    <td className="hairline-t num w-12 border-border py-1.5 pl-1 text-muted">{hhmm(row.timestamp)}</td>
                    <td className="hairline-t border-border py-1.5"><span className="font-semibold">{row.model}</span>{row.longContext ? <Pill tone="violet" className="ml-1.5">1M</Pill> : null}</td>
                    <td className="hairline-t max-w-32 truncate border-border py-1.5 text-muted">{row.client} · {row.profile}</td>
                    <td className="hairline-t w-[110px] border-border py-1.5">
                      {row.failed ? <Pill tone="red">failed{row.status ? ` ${row.status}` : ''}</Pill> : row.cacheHit === null ? <span className="text-muted">—</span> : (
                        <span className="flex items-center gap-1.5"><Meter value={row.cacheHit} tone="violet" className="w-[46px]" height="h-[5px]" label="Cache hit" /><span className="num text-accent2">{pct(row.cacheHit)}</span></span>
                      )}
                    </td>
                    <td className="hairline-t w-[78px] border-border py-1.5">{row.lineage ? <Pill tone="violet">{row.lineage}</Pill> : null}</td>
                    <td className="hairline-t num border-border py-1.5 text-right">{fmtTok(row.promptTokens)} in</td>
                    <td className="hairline-t num w-14 border-border py-1.5 pr-1 text-right">{seconds(row.totalMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="grid flex-1 place-items-center text-sm text-muted">No requests yet. They appear here as clients send them.</div>}
      </Card>

      <Card className="flex min-h-0 flex-col gap-2">
        <Label>Needs attention {items.length ? <Pill tone="red">{items.length}</Pill> : null}</Label>
        {items.length ? (
          <div className="scroll-y -mr-2 min-h-0 flex-1 pr-2">
            {items.map((item, index) => item.kind === 'limit' ? (
              <div key={`limit-${item.account.id}`} className={cn('flex items-start gap-2.5 py-2 text-sm', index && 'hairline-t border-border')}>
                <Pill tone="yellow" className="mt-px">limit</Pill>
                <div className="min-w-0">
                  <div><b className="font-semibold">{item.account.id}</b> <span className="text-muted">· {item.title}</span></div>
                  <div className="text-muted">{item.detail}{item.account.limited?.resetsAt && !item.account.limited.stale ? ` Resets ${relative(item.account.limited.resetsAt, now)}.` : ''}</div>
                </div>
              </div>
            ) : (
              <div key={`fail-${item.group.cause}`} className={cn('flex items-start gap-2.5 py-2 text-sm', index && 'hairline-t border-border')}>
                <Pill tone="red" className="mt-px">{item.group.status ?? 'err'}</Pill>
                <div className="min-w-0">
                  <div className="font-semibold">{item.group.cause}</div>
                  <div className="truncate text-muted" title={item.group.detail}>{item.group.detail}</div>
                  <div className={item.group.outcome.state === 'cleared' ? 'text-green' : item.group.outcome.state === 'ongoing' ? 'text-red' : 'text-muted'}>{item.group.outcome.text}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-sm text-muted"><CircleCheck className="size-5 text-green" />Nothing needs attention</div>
        )}
        <button type="button" onClick={() => navigate('traffic', { filter: 'errors' })} className="mt-auto text-left text-2xs text-muted hover:text-accent">{attentionFootnote(h.failed, kind)}</button>
      </Card>
    </div>
  )
}

function Latency({ ttfb, total }: { ttfb: number | null; total: number | null }) {
  if (ttfb === null || total === null) return <div className="mt-2.5 text-sm text-muted">Timings appear with the first request in this window.</div>
  const generating = Math.max(0, total - ttfb)
  return (
    <div className="mt-2.5">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px]">
        <div className="bg-accent opacity-85" style={{ flexGrow: Math.max(ttfb, 1) }} />
        <div className="bg-green opacity-85" style={{ flexGrow: Math.max(generating, 1) }} />
      </div>
      <div className="mt-2 flex gap-4.5 text-sm">
        <span><span className="text-accent">■</span> Waiting for first token <b className="num font-semibold">{seconds(ttfb)}</b></span>
        <span><span className="text-green">■</span> Generating <b className="num font-semibold">{seconds(generating)}</b></span>
        <span className="flex-1" />
        <span className="text-muted">total <b className="num font-semibold text-text">{seconds(total)}</b></span>
      </div>
    </div>
  )
}

function LimitBar({ name, window, now }: { name: string; window: LimitWindow | undefined; now: number }) {
  const value = window?.utilization ?? null
  const tone = window?.stale ? 'muted' : utilTone(value)
  const reset = window?.resetsAt && !window.stale ? `resets ${relative(window.resetsAt, now)}` : window ? 'last reading' : 'no reading'
  return (
    <Tip content={window ? `${window.label}: ${pct(value)} used · ${window.resetsAt ? `${window.stale ? 'last known reset' : 'resets'} ${when(window.resetsAt, now)}` : 'reset time unavailable'}` : 'No reading'}>
      <div>
        <div className="flex justify-between text-[11.5px] text-muted"><span>{name}</span><b className={cn('num font-semibold', toneText[tone])}>{pct(value)}</b></div>
        <Meter value={value} stale={window?.stale} className="mt-1.5" label={`${name} usage`} />
        <div className="num mt-1 text-2xs text-muted">{reset}</div>
      </div>
    </Tip>
  )
}

function ServingCard({ serving, others, navigate }: { serving: AccountView | undefined; others: AccountView[]; navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { accounts } = useModels()
  if (!serving) return (
    <Card className="row-span-2 flex flex-col gap-3">
      <Label>Serving now</Label>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
        {state?.profiles === null ? <Skeleton className="h-24 w-full" /> : <>No accounts on this service yet.<Button onClick={() => navigate('accounts')}>Add an account</Button></>}
      </div>
    </Card>
  )
  const provider = serving.provider === 'chatgpt' ? 'ChatGPT' : serving.provider === 'antigravity' ? 'Google' : 'Claude'
  return (
    <Card className="row-span-2 flex min-h-0 flex-col gap-3">
      <Label>Serving now</Label>
      <div className="flex items-center gap-2.5">
        <Avatar id={serving.id} provider={serving.provider} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-md font-semibold">{serving.id} <Pill tone="accent">{accounts.follow ? 'Following' : 'Active'}</Pill>{serving.limited ? <Pill tone="red">{limitPill(serving.limited)}</Pill> : null}</div>
          <div className="truncate text-sm text-muted">{[serving.email, `${provider} ${serving.plan}`.trim()].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {serving.needsLogin ? <div className="text-sm text-red">Sign-in required — requests to this account fail until it signs in again.</div> : (
        <div className="grid grid-cols-2 gap-3">
          <LimitBar name="5-hour" window={serving.fiveHour} now={now} />
          <LimitBar name="Weekly" window={serving.weekly} now={now} />
        </div>
      )}
      {serving.extraUsage ? <div className="text-sm text-muted">{serving.extraUsage.text}</div> : null}
      {others.length ? <>
        <Label className="mt-0.5">Other accounts</Label>
        <div className="scroll-y -mr-1 flex min-h-0 flex-col gap-2 pr-1">
          {others.map(account => (
            <div key={account.id} className="flex items-center gap-2.5 text-[12.5px]">
              <span className="w-16 truncate font-semibold" title={account.email}>{account.id}</span>
              <span className="w-10 truncate text-[11.5px] text-muted">{account.plan}</span>
              <Tip content={`5h ${pct(account.fiveHour?.utilization)} · weekly ${pct(account.weekly?.utilization)}${account.usageNote ? ` · ${account.usageNote}` : ''}`}>
                <div className="w-20"><Meter value={account.peak} label={`${account.id} usage`} /></div>
              </Tip>
              <span className="ml-auto">
                {account.needsLogin ? <Pill tone="red">needs login</Pill>
                  : account.limited ? <Pill tone="red">{limitPill(account.limited)}</Pill>
                  : accounts.follow ? <Pill tone="muted">followed</Pill>
                  : <Button size="xs" disabled={busy || state?.connection.kind !== 'ok'} onClick={() => { void run('switch-profile', account.id) }} aria-label={`Use ${account.id}`}>Use</Button>}
              </span>
            </div>
          ))}
        </div>
      </> : null}
    </Card>
  )
}

function HeroSkeleton() {
  return <><Skeleton className="mt-2 h-10 w-32" /><Skeleton className="mt-1.5 h-3.5 w-48" /></>
}

function TodaySkeleton() {
  return (
    <div className="grid h-full grid-cols-[1fr_1fr_1.05fr] grid-rows-[auto_auto_minmax(0,1fr)] gap-3.5 px-5 pb-5 pt-[18px]" aria-busy="true" aria-label="Loading">
      {[0, 1].map(index => <Card key={index}><Skeleton className="h-3 w-16" /><HeroSkeleton /><Skeleton className="mt-3 h-[46px]" /></Card>)}
      <Card className="row-span-2 flex flex-col gap-3"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-40" /><Skeleton className="h-10" /><Skeleton className="h-16" /></Card>
      <Card className="col-span-2"><Skeleton className="h-3 w-32" /><Skeleton className="mt-3 h-2.5" /></Card>
      <Card className="col-span-2 flex flex-col gap-2">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-5" />)}</Card>
      <Card className="flex flex-col gap-2"><Skeleton className="h-3 w-28" /><Skeleton className="h-12" /><Skeleton className="h-12" /></Card>
    </div>
  )
}
