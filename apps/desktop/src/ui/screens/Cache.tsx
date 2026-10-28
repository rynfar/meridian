import { useMemo } from 'react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Hero, InlineStats, Label, Swatch } from '../components/card'
import { PromptRibbon, RibbonLegend } from '../components/ribbon'
import { ConnectionProblem, Empty, Skeleton } from '../components/state'
import { CacheTokensChart, HitRateChart } from '../charts/charts'
import { fmtInt, fmtTok, pct, plural, usd, when } from '../model/format'
import { cacheMisses, cacheSavings, cacheTotals, keepalive } from '../model/cache'
import { promptShare } from '../model/prompt'
import { bucketWord, chartSeries } from '../model/series'
import { windowRange } from '../../uiData'
import type { Navigate } from '../shell/nav'

export function Cache({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data, requests, pricing } = useModels()
  const series = useMemo(() => state ? chartSeries(state, now) : null, [state, now])
  const kind = state?.window.kind ?? 'today'
  const misses = useMemo(() => cacheMisses(requests, 0.5, 50, windowRange(kind, now).start), [requests, kind, now])

  if (data.kind === 'failed' && state) return <div className="px-[26px] py-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <div className="flex flex-col gap-5 px-[26px] pt-[22px]"><div className="grid grid-cols-2 gap-9"><Skeleton className="h-24" /><Skeleton className="h-24" /></div><div className="grid grid-cols-2 gap-9"><Skeleton className="h-44" /><Skeleton className="h-44" /></div><Skeleton className="h-48" /></div>

  const totals = cacheTotals(state.summary)
  const savings = cacheSavings(state.summary, pricing)
  const beats = keepalive(state.summary)
  // The same token-weighted definition as Today, the sidebar and the menu bar.
  const prompt = promptShare(state.summary)
  const per = series ? bucketWord(series.series.bucketMs) : 'hour'

  return (
    <div className="scroll-y flex h-full min-h-0 flex-col px-[26px] pb-[18px] pt-[22px]">
      {totals ? (
        <div className="grid shrink-0 grid-cols-[1.15fr_1fr] gap-9">
          <Hero label={<><Swatch className="bg-cache" />Prompt from cache</>}
            figure={prompt.share === null ? '—' : Math.round(prompt.share * 100)} unit={prompt.share === null ? undefined : '%'}
            strip={<PromptRibbon tokens={prompt} size="hero" />}
            caption={<><b>{fmtTok(prompt.read)}</b> read · {fmtTok(prompt.write)} written · {fmtTok(prompt.fresh)} fresh of {fmtTok(prompt.total)} prompt tokens</>} />
          <InlineStats className="content-start pt-0.5" cells={[
            { label: 'Mean per request', value: <span className="text-cache">{pct(totals.hit)}</span>, detail: 'cache hit, averaged over requests' },
            { label: 'Misses on resume', value: <span className={totals.missesOnResume ? 'text-yellow' : undefined}>{fmtInt(totals.missesOnResume)}</span>, detail: 'resumed with 0% reuse' },
            savings ? { label: 'Saved by caching', value: usd(savings.netUsd), detail: `${usd(savings.savedUsd)} reads − ${usd(savings.writePremiumUsd)} writes${savings.partial ? ' · partial' : ''}` }
              : { label: 'Saved by caching', value: '—', detail: state.settings.unavailable.includes('pricing') ? 'pricing unavailable' : 'needs model pricing' },
          ]} />
        </div>
      ) : <div className="grid grid-cols-2 gap-9"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}

      <div className="mt-[26px] grid shrink-0 grid-cols-2 gap-9">
        <section className="min-w-0">
          <div className="flex items-baseline justify-between gap-3"><Label>Prompt tokens per {per}</Label><RibbonLegend /></div>
          <div className="mt-2">{series ? <CacheTokensChart buckets={series.series.buckets} bucketMs={series.series.bucketMs} height={150} /> : <Skeleton className="h-[150px]" />}</div>
        </section>
        <section className="min-w-0">
          <div className="flex items-baseline justify-between gap-3"><Label><Swatch className="bg-cache" />Hit rate · mean per request</Label>{series?.estimated ? <span className="text-xs text-t4" title={series.note}>estimated from recent requests</span> : null}</div>
          <div className="mt-2">{series ? <HitRateChart buckets={series.series.buckets} bucketMs={series.series.bucketMs} height={150} /> : <Skeleton className="h-[150px]" />}</div>
        </section>
      </div>

      <div className={cn('mt-6 grid min-h-[220px] flex-1 gap-9', beats ? 'grid-cols-[minmax(0,1fr)_240px]' : 'grid-cols-1')}>
        <section className="flex min-h-0 flex-col">
          <div className="rule-b flex items-baseline gap-2.5 pb-[7px]">
            <Label strong>Low-cache continuations</Label>
            <span className="text-sm text-t3">· resumed conversations that reused ≤ 50% · loaded requests</span>
          </div>
          {state.requests === null ? <Skeleton className="mt-2 h-32" /> : misses.length ? (
            <div className="scroll-y -mx-2 mt-0.5 min-h-0 flex-1">
              {misses.map(({ row, why, severity }) => (
                <button key={row.id} type="button" onClick={() => navigate('traffic', { request: row.id })}
                  className="num grid h-[29px] w-full grid-cols-[84px_40px_minmax(0,170px)_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-md px-2 text-left text-base transition-colors duration-150 hover:bg-hover">
                  <span className="text-t4">{when(row.timestamp, now)}</span>
                  <span className={cn('text-right font-medium', severity === 'miss' ? 'text-red' : 'text-yellow')}>{pct(row.cacheHit)}</span>
                  <span className="truncate"><span className="font-medium text-t1">{row.model}</span> <span className="text-t3">· {row.adapter || row.source} · {row.profile || 'default'}</span></span>
                  <span className="truncate text-t3" title={why}>{why}</span>
                  <span className="text-t4">{fmtTok(row.cacheWrite)} written</span>
                </button>
              ))}
            </div>
          ) : <Empty title="No cache misses" detail="Every resumed conversation in the loaded requests reused most of its prompt." />}
        </section>
        {beats ? (
          <section>
            <div className="rule-b pb-[7px]"><Label strong>Cache keepalive</Label></div>
            <div className="num mt-2.5 font-display text-xl font-semibold tracking-title text-t1">{fmtInt(beats.beats)} <span className="font-sans text-cap font-normal text-t3">{plural(beats.beats, 'beat').replace(/^[\d,]+ /, '')}</span></div>
            <div className="num mt-2 flex flex-col text-base">
              {([['Reached upstream', fmtInt(beats.reached)], ['Skipped', fmtInt(beats.skipped)], ['Cache read', fmtTok(beats.read)], ['Cache write', fmtTok(beats.write)], ['API-equivalent', usd(beats.costUsd)]] as const).map(([label, value]) => (
                <div key={label} className="flex h-[22px] items-center justify-between"><span className="text-t3">{label}</span><span className="text-t1">{value}</span></div>
              ))}
            </div>
            <p className="mt-2 text-xs text-t3">Beats keep the cache warm between turns. They answer no client and are excluded from every other figure.</p>
          </section>
        ) : null}
      </div>
    </div>
  )
}
