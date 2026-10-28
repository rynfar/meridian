import { cn } from '../lib/cn'
import { fmtInt, fmtTok, hhmm, pct } from '../model/format'
import type { StripColumn } from '../model/prompt'

/**
 * The day strip: prompt tokens stacked per bucket in the ribbon colours, a
 * 22px request strip beneath with failures in red, and a dashed "now" line.
 * Future buckets are a 2px well tick; empty past buckets a 2px well bar.
 */
export function DayStrip({ columns, now, height = 84, className }: { columns: StripColumn[]; now: number | null; height?: number; className?: string }) {
  const gap = columns.length > 26 ? 'gap-0.5' : 'gap-[3px]'
  const grid = { gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }
  return (
    <div className={cn('relative', className)} role="img" aria-label="Prompt tokens and requests over the window">
      <div className={cn('grid items-end', gap)} style={{ ...grid, height }}>
        {columns.map((column, index) => {
          if (column.state !== 'data') return <div key={index} className="flex h-full flex-col justify-end"><i className={cn('block h-0.5 rounded-[1px] bg-well', column.state === 'future' && 'opacity-60')} /></div>
          const total = column.read + column.write + column.fresh
          const px = Math.max(3, column.height * height)
          const part = (value: number) => (total > 0 && value > 0 ? Math.max(1, (value / total) * px) : 0)
          const title = `${column.start === null ? '' : `${hhmm(column.start)} · `}${fmtTok(total)} prompt tokens${total ? ` · ${pct(column.read / total)} from cache` : ''} · ${fmtInt(column.requests)} requests${column.failed ? ` · ${column.failed} failed` : ''}`
          return (
            <div key={index} className="flex h-full flex-col justify-end" title={title}>
              <div className="flex flex-col-reverse overflow-hidden rounded-t-xs rounded-b-[1px] bg-well" style={{ height: px }}>
                {part(column.read) ? <i className="block shrink-0 bg-cache" style={{ height: part(column.read) }} /> : null}
                {part(column.write) ? <i className="block shrink-0 bg-cache-write" style={{ height: part(column.write) }} /> : null}
                {part(column.fresh) ? <i className="block shrink-0 bg-fresh" style={{ height: part(column.fresh) }} /> : null}
              </div>
            </div>
          )
        })}
      </div>
      <div className={cn('mt-[5px] grid h-[22px] items-end', gap)} style={grid}>
        {columns.map((column, index) => {
          if (column.state !== 'data' || !column.requests) return <i key={index} />
          const ok = column.requests - column.failed > 0 ? Math.max(2, column.okHeight * 22) : 0
          const failed = column.failed ? Math.max(2, column.failHeight * 22) : 0
          return (
            <div key={index} className="flex h-full flex-col justify-end gap-px">
              {failed ? <i className="block rounded-[1px] bg-red" style={{ height: failed }} /> : null}
              {ok ? <i className="block rounded-[1px] bg-t4 opacity-55" style={{ height: ok }} /> : null}
            </div>
          )
        })}
      </div>
      {now !== null ? <span aria-hidden className="absolute -top-1 bottom-0 w-0 border-l border-dashed border-ring-strong" style={{ left: `${now * 100}%` }} /> : null}
    </div>
  )
}

/** Axis under a strip: 00:00 · 06:00 · 12:00 · 18:00 · now 10:17 for Today (quarters of the day), else spread. */
export function AxisLabels({ labels, quarters }: { labels: string[]; quarters?: boolean }) {
  return (
    <div className={cn('num mt-1.5 text-2xs text-t4', quarters ? 'grid grid-cols-[repeat(4,minmax(0,1fr))_auto]' : 'flex justify-between')}>
      {labels.map((label, index) => <span key={index}>{label}</span>)}
    </div>
  )
}
