import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts'
import type { TimeseriesBucket } from '../../uiData'
import { bucketLabel } from '../model/series'
import { fmtInt, fmtTok, pct } from '../model/format'

interface TipProps { active?: boolean; label?: string | number; payload?: readonly { name?: string | number; value?: unknown; dataKey?: unknown; color?: string }[] }
function ChartTip({ active, label, payload, format, names }: TipProps & { format(key: string, value: number): string; names: Record<string, string> }) {
  if (!active || !payload?.length) return null
  return (
    <div className="pop rounded-md bg-surface px-2 py-1.5 text-xs">
      <div className="num mb-0.5 font-medium text-t1">{label}</div>
      {payload.map(item => {
        const key = String(item.dataKey ?? item.name ?? '')
        return typeof item.value === 'number' ? <div key={key} className="num flex justify-between gap-4 text-t3"><span>{names[key] ?? key}</span><span className="text-t1">{format(key, item.value)}</span></div> : null
      })}
    </div>
  )
}

const axis = { tickLine: false, axisLine: false, minTickGap: 24 } as const

/** Requests per bucket in a quiet grey, failures stacked on top in red. */
export function RequestsChart({ buckets, bucketMs, height = 104 }: { buckets: TimeseriesBucket[]; bucketMs: number; height?: number }) {
  const data = buckets.map(bucket => ({ label: bucketLabel(bucket.start, bucketMs), ok: Math.max(0, bucket.requests - bucket.errors), failed: bucket.errors }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="16%">
        <CartesianGrid vertical={false} strokeDasharray="2 3" />
        <XAxis dataKey="label" {...axis} height={18} />
        <YAxis {...axis} width={34} allowDecimals={false} tickCount={3} minTickGap={0} domain={[0, 'auto']} tickFormatter={(value: number) => fmtInt(value)} />
        <Tooltip cursor={{ className: 'recharts-tooltip-cursor' }} isAnimationActive={false} content={<ChartTip names={{ ok: 'Succeeded', failed: 'Failed' }} format={(_, value) => fmtInt(value)} />} />
        <Bar dataKey="ok" stackId="r" fill="var(--t4)" fillOpacity={0.55} radius={[1, 1, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="failed" stackId="r" fill="var(--red)" radius={[1, 1, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Mean cache hit per request, per bucket; buckets without traffic leave a gap rather than a bridge. */
export function HitRateChart({ buckets, bucketMs, height = 150 }: { buckets: TimeseriesBucket[]; bucketMs: number; height?: number }) {
  const data = buckets.map(bucket => ({ label: bucketLabel(bucket.start, bucketMs), hit: bucket.requests > 0 && bucket.cacheHitRate !== null ? bucket.cacheHitRate : null }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="2 3" />
        <XAxis dataKey="label" {...axis} height={18} />
        <YAxis {...axis} width={40} domain={[0, 1]} ticks={[0, 0.5, 1]} tickFormatter={(value: number) => pct(value)} />
        <Tooltip isAnimationActive={false} content={<ChartTip names={{ hit: 'Mean per request' }} format={(_, value) => pct(value)} />} />
        <Area type="monotone" dataKey="hit" connectNulls={false} stroke="var(--accent2)" strokeWidth={1.75} fill="none" dot={{ r: 1.5, strokeWidth: 0, fill: 'var(--accent2)' }} activeDot={{ r: 3 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Prompt tokens per bucket in the ribbon colours: cache read · cache write · fresh, stacked. */
export function CacheTokensChart({ buckets, bucketMs, height = 150 }: { buckets: TimeseriesBucket[]; bucketMs: number; height?: number }) {
  const data = buckets.map(bucket => ({ label: bucketLabel(bucket.start, bucketMs), read: bucket.cacheReadTokens, write: bucket.cacheCreationTokens, fresh: bucket.inputTokens }))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }} barCategoryGap="16%">
        <CartesianGrid vertical={false} strokeDasharray="2 3" />
        <XAxis dataKey="label" {...axis} height={18} />
        <YAxis {...axis} width={40} tickFormatter={(value: number) => fmtTok(value)} />
        <Tooltip cursor={{ className: 'recharts-tooltip-cursor' }} isAnimationActive={false} content={<ChartTip names={{ read: 'Cache read', write: 'Cache write', fresh: 'Fresh input' }} format={(_, value) => fmtTok(value)} />} />
        <Bar dataKey="read" stackId="t" fill="var(--accent2)" isAnimationActive={false} />
        <Bar dataKey="write" stackId="t" fill="var(--cache-write)" isAnimationActive={false} />
        <Bar dataKey="fresh" stackId="t" fill="var(--fresh)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}
