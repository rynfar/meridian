import { useMemo } from 'react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Card, Label, StatsStrip } from '../components/card'
import { Pill } from '../components/pill'
import { ConnectionProblem, Empty, Skeleton } from '../components/state'
import { CacheTokensChart, HitRateChart, Legend } from '../charts/charts'
import { fmtInt, fmtTok, pct, usd, when } from '../model/format'
import { cacheMisses, cacheSavings, cacheTotals, keepalive } from '../model/cache'
import { chartSeries } from '../model/series'
import { windowRange } from '../../uiData'
import type { Navigate } from '../shell/nav'

export function Cache({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data, requests, pricing } = useModels()
  const series = useMemo(() => state ? chartSeries(state, now) : null, [state, now])
  const kind = state?.window.kind ?? 'today'
  const misses = useMemo(() => cacheMisses(requests, 0.5, 50, windowRange(kind, now).start), [requests, kind, now])

  if (data.kind === 'failed' && state) return <div className="p-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <div className="flex flex-col gap-3.5 p-5"><Skeleton className="h-[72px]" /><div className="grid grid-cols-2 gap-3.5"><Skeleton className="h-52" /><Skeleton className="h-52" /></div><Skeleton className="h-60" /></div>

  const totals = cacheTotals(state.summary)
  const savings = cacheSavings(state.summary, pricing)
  const beats = keepalive(state.summary)
  const prompt = totals ? totals.read + totals.write + totals.uncached : 0
  const cells = totals ? [
    { label: <><span className="text-accent2">●</span> Hit rate</>, value: <span className="text-accent2">{pct(totals.hit)}</span>, detail: 'mean per request' },
    { label: 'Reused', value: fmtTok(totals.read), detail: prompt ? `${pct(totals.read / prompt)} of prompt tokens` : 'cache read' },
    { label: 'Written', value: fmtTok(totals.write), detail: 'cache writes' },
    { label: 'Uncached', value: fmtTok(totals.uncached), detail: 'input sent fresh' },
    { label: 'Misses on resume', value: <span className={totals.missesOnResume ? 'text-yellow' : undefined}>{fmtInt(totals.missesOnResume)}</span>, detail: 'resumed with 0% reuse' },
    savings ? { label: 'Saved by caching', value: <span className="text-green">{usd(savings.netUsd)}</span>, detail: `${usd(savings.savedUsd)} reads − ${usd(savings.writePremiumUsd)} writes${savings.partial ? ' · partial' : ''}` }
      : { label: 'Saved by caching', value: '—', detail: state.settings.unavailable.includes('pricing') ? 'pricing unavailable' : 'needs model pricing' },
  ] : []

  return (
    <div className="scroll-y flex h-full min-h-0 flex-col gap-3.5 px-5 pb-5 pt-[18px]">
      {cells.length ? <StatsStrip cells={cells} /> : <Skeleton className="h-[72px] shrink-0" />}

      <div className="grid shrink-0 grid-cols-2 gap-3.5">
        <Card className="px-3 pb-2">
          <div className="flex items-center justify-between px-1"><Label><span className="text-accent2">●</span> Hit rate over time</Label>{series?.estimated ? <span className="text-2xs text-muted" title={series.note}>estimated from recent requests</span> : null}</div>
          {series ? <HitRateChart buckets={series.series.buckets} bucketMs={series.series.bucketMs} height={150} /> : <Skeleton className="mt-2 h-[150px]" />}
        </Card>
        <Card className="px-3 pb-2">
          <div className="flex items-center justify-between px-1"><Label>Prompt tokens per bucket</Label><Legend items={[{ label: 'read', className: 'bg-accent2' }, { label: 'write', className: 'bg-accent2 opacity-40' }, { label: 'uncached', className: 'bg-muted' }]} /></div>
          {series ? <CacheTokensChart buckets={series.series.buckets} bucketMs={series.series.bucketMs} height={150} /> : <Skeleton className="mt-2 h-[150px]" />}
        </Card>
      </div>

      <div className={cn('grid min-h-[240px] flex-1 gap-3.5', beats ? 'grid-cols-[1fr_260px]' : 'grid-cols-1')}>
        <Card className="flex min-h-0 flex-col p-0">
          <div className="flex items-baseline gap-2 px-4 pt-3">
            <Label>Low-cache continuations</Label>
            <span className="text-xs text-muted">resumed conversations that reused ≤ 50% · loaded requests</span>
          </div>
          {state.requests === null ? <Skeleton className="m-4 h-32" /> : misses.length ? (
            <div className="scroll-y mt-1.5 min-h-0 flex-1">
              {misses.map(({ row, why, severity }) => (
                <button key={row.id} type="button" onClick={() => navigate('traffic', { request: row.id })} className="hairline-t flex w-full items-center gap-3 border-border px-4 py-2 text-left text-sm hover:bg-accent/6">
                  <span className="num w-20 shrink-0 text-muted">{when(row.timestamp, now)}</span>
                  <Pill tone={severity === 'miss' ? 'red' : 'yellow'} className="w-10 justify-center">{pct(row.cacheHit)}</Pill>
                  <span className="w-36 shrink-0 truncate"><b className="font-semibold">{row.model}</b> <span className="text-muted">· {row.adapter || row.source} · {row.profile || 'default'}</span></span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={why}>{why}</span>
                  <span className="num shrink-0 text-muted">{fmtTok(row.cacheWrite)} written</span>
                </button>
              ))}
            </div>
          ) : <Empty title="No cache misses" detail="Every resumed conversation in the loaded requests reused most of its prompt." />}
        </Card>
        {beats ? (
          <Card>
            <Label>Cache keepalive</Label>
            <div className="num mt-1.5 text-xl font-bold">{fmtInt(beats.beats)} <span className="text-sm font-medium text-muted">beats</span></div>
            <div className="mt-2 flex flex-col gap-1 text-sm">
              <div className="flex justify-between"><span className="text-muted">Reached upstream</span><span className="num">{fmtInt(beats.reached)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Skipped</span><span className="num">{fmtInt(beats.skipped)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Cache read</span><span className="num">{fmtTok(beats.read)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Cache write</span><span className="num">{fmtTok(beats.write)}</span></div>
              <div className="flex justify-between"><span className="text-muted">API-equivalent</span><span className="num">{usd(beats.costUsd)}</span></div>
            </div>
            <p className="mt-2 text-xs text-muted">Beats keep the cache warm between turns. They answer no client and are excluded from every other figure.</p>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
