import type { ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts'
import type { TimeseriesBucket } from '../../uiData'
import { bucketLabel } from '../model/series'
import { fmtInt, fmtTok, pct } from '../model/format'

interface TipProps { active?: boolean; label?: string | number; payload?: readonly { name?: string | number; value?: unknown; dataKey?: unknown; color?: string }[] }
function ChartTip({ active, label, payload, format, names }: TipProps & { format(key: string, value: number): string; names: Record<string, string> }) {
  if (!active || !payload?.length) return null
  return (
    <div className="hairline rounded-md border-border bg-surface px-2 py-1.5 text-xs shadow-panel">
      <div className="mb-0.5 font-semibold">{label}</div>
      {payload.map(item => {
        const key = String(item.dataKey ?? item.name ?? '')
        return typeof item.value === 'number' ? <div key={key} className="num flex justify-between gap-4 text-muted"><span>{names[key] ?? key}</span><span className="text-text">{format(key, item.value)}</span></div> : null
      })}
    </div>
  )
}

const axis = { tickLine: false, axisLine: false, minTickGap: 24 } as const

/** Requests per bucket, failures stacked on top in red. */
export function RequestsChart({ buckets, bucketMs, height = 104 }: { buckets: TimeseriesBucket[]; bucketMs: number; height?: number }) {
  const data = buckets.map(bucket => ({ label: bucketLabel(bucket.start, bucketMs), ok: Math.max(0, bucket.requests - bucket.errors), failed: bucket.errors }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} strokeDasharray="2 3" />
        <XAxis dataKey="label" {...axis} height={18} />
        <YAxis {...axis} width={34} allowDecimals={false} tickCount={3} minTickGap={0} domain={[0, 'auto']} tickFormatter={(value: number) => fmtInt(value)} />
        <Tooltip cursor={{ className: 'recharts-tooltip-cursor' }} isAnimationActive={false} content={<ChartTip names={{ ok: 'Succeeded', failed: 'Failed' }} format={(_, value) => fmtInt(value)} />} />
        <Bar dataKey="ok" stackId="r" fill="var(--accent)" fillOpacity={0.75} isAnimationActive={false} />
        <Bar dataKey="failed" stackId="r" fill="var(--red)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Cache hit rate per bucket; buckets without traffic leave a gap rather than a bridge. */
export function HitRateChart({ buckets, bucketMs, height = 150 }: { buckets: TimeseriesBucket[]; bucketMs: number; height?: number }) {
  const data = buckets.map(bucket => ({ label: bucketLabel(bucket.start, bucketMs), hit: bucket.requests > 0 && bucket.cacheHitRate !== null ? bucket.cacheHitRate : null }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="hit-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent2)" stopOpacity={0.3} />
            <stop offset="1" stopColor="var(--accent2)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="2 3" />
        <XAxis dataKey="label" {...axis} height={18} />
        <YAxis {...axis} width={34} domain={[0, 1]} ticks={[0, 0.5, 1]} tickFormatter={(value: number) => pct(value)} />
        <Tooltip isAnimationActive={false} content={<ChartTip names={{ hit: 'Cache hit' }} format={(_, value) => pct(value)} />} />
        <Area type="monotone" dataKey="hit" connectNulls={false} stroke="var(--accent2)" strokeWidth={2} fill="url(#hit-fill)" dot={{ r: 1.5, strokeWidth: 0, fill: 'var(--accent2)' }} activeDot={{ r: 3 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Prompt tokens per bucket: cache read, cache write and uncached input, stacked. */
export function CacheTokensChart({ buckets, bucketMs, height = 150 }: { buckets: TimeseriesBucket[]; bucketMs: number; height?: number }) {
  const data = buckets.map(bucket => ({ label: bucketLabel(bucket.start, bucketMs), read: bucket.cacheReadTokens, write: bucket.cacheCreationTokens, uncached: bucket.inputTokens }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} strokeDasharray="2 3" />
        <XAxis dataKey="label" {...axis} height={18} />
        <YAxis {...axis} width={40} tickFormatter={(value: number) => fmtTok(value)} />
        <Tooltip cursor={{ className: 'recharts-tooltip-cursor' }} isAnimationActive={false} content={<ChartTip names={{ read: 'Cache read', write: 'Cache write', uncached: 'Uncached input' }} format={(_, value) => fmtTok(value)} />} />
        <Bar dataKey="read" stackId="t" fill="var(--accent2)" fillOpacity={0.85} isAnimationActive={false} />
        <Bar dataKey="write" stackId="t" fill="var(--accent2)" fillOpacity={0.4} isAnimationActive={false} />
        <Bar dataKey="uncached" stackId="t" fill="var(--muted)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function Legend({ items }: { items: { label: ReactNode; className: string }[] }) {
  return <div className="flex flex-wrap gap-3 text-xs text-muted">{items.map((item, index) => <span key={index} className="flex items-center gap-1.5"><span className={`size-2 rounded-xs ${item.className}`} />{item.label}</span>)}</div>
}
