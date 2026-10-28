import { useId } from 'react'
import type { TimeseriesBucket } from '../../uiData'
import { hitDomain, sparkPaths } from '../model/series'
import { fmtInt, hhmm, pct } from '../model/format'

const W = 240, H = 46

/** Hourly cache-hit area in violet. Hours without traffic break the line. */
export function HitSpark({ slots, now }: { slots: (TimeseriesBucket | null)[]; now: number | null }) {
  const id = useId()
  const values = slots.map(bucket => (bucket && bucket.requests > 0 ? bucket.cacheHitRate : null))
  const { line, area } = sparkPaths(values, W, H, hitDomain(values))
  const step = slots.length ? W / slots.length : W
  return (
    <svg className="mt-2.5 block h-[46px] w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Cache hit rate over the window">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="[stop-color:var(--accent2)] [stop-opacity:0.32]" />
          <stop offset="1" className="[stop-color:var(--accent2)] [stop-opacity:0]" />
        </linearGradient>
      </defs>
      {now !== null ? <line x1={now * W} x2={now * W} y1={0} y2={H} className="stroke-border" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" /> : null}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" className="stroke-accent2" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {slots.map((bucket, index) => bucket && bucket.requests > 0 ? (
        <rect key={index} x={index * step} y={0} width={step} height={H} fill="transparent"><title>{`${hhmm(bucket.start)} · ${pct(bucket.cacheHitRate)} hit · ${fmtInt(bucket.requests)} requests`}</title></rect>
      ) : null)}
    </svg>
  )
}

/** Requests per bucket in blue, with the failed share in red at the base. */
export function RequestBars({ slots }: { slots: (TimeseriesBucket | null)[] }) {
  const max = Math.max(1, ...slots.map(bucket => bucket?.requests ?? 0))
  const step = slots.length ? W / slots.length : W
  const gap = Math.min(3, step * 0.25)
  return (
    <svg className="mt-2.5 block h-[46px] w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Requests over the window">
      {slots.map((bucket, index) => {
        const x = index * step + gap / 2, width = Math.max(1, step - gap)
        if (!bucket || bucket.requests === 0) return <rect key={index} x={x} y={H - 2} width={width} height={2} rx={1} className="fill-surface2" />
        const height = Math.max(3, (bucket.requests / max) * (H - 4))
        const failed = bucket.errors ? Math.max(2, (bucket.errors / max) * (H - 4)) : 0
        return (
          <g key={index}>
            <title>{`${hhmm(bucket.start)} · ${fmtInt(bucket.requests)} requests${bucket.errors ? ` · ${bucket.errors} failed` : ''}`}</title>
            <rect x={x} y={H - height} width={width} height={height} rx={1.5} className="fill-accent opacity-75" />
            {failed ? <rect x={x} y={H - failed} width={width} height={failed} rx={1.5} className="fill-red" /> : null}
          </g>
        )
      })}
    </svg>
  )
}

export function AxisLabels({ labels }: { labels: string[] }) {
  return <div className="num mt-1 flex justify-between text-2xs text-muted">{labels.map((label, index) => <span key={index}>{label}</span>)}</div>
}
