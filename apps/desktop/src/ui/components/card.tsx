import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * The one raised surface: content the user acts on (the serving account, an
 * account, a settings group, a side panel). Everything else sits on the canvas.
 */
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('lift min-w-0 rounded-xl bg-surface px-4 py-3.5', className)} {...props} />
}

/** Section label: 12/500, sentence case, t3 (t2 for list headers). Never uppercase. */
export function Label({ className, children, strong, ...props }: HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return <div className={cn('flex items-center gap-1.5 text-sm font-medium', strong ? 'text-t2' : 'text-t3', className)} {...props}>{children}</div>
}

/** 8px square swatch beside a label that names a series. */
export function Swatch({ className }: { className: string }) {
  return <i aria-hidden className={cn('inline-block size-2 shrink-0 rounded-xs', className)} />
}

/**
 * Hero: label → 44px figure → data strip → caption. No box.
 * `unit` sits at 22/500/t3; `side` is a small note on the baseline.
 */
export function Hero({ label, figure, unit, side, strip, caption, className }: { label: ReactNode; figure: ReactNode; unit?: ReactNode; side?: ReactNode; strip?: ReactNode; caption?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <Label>{label}</Label>
      <div className="num mt-2 flex items-baseline gap-2 font-display text-hero font-semibold leading-none tracking-hero text-t1">
        <span>{figure}</span>
        {unit ? <span className="-ml-0.5 text-unit font-medium tracking-unit text-t3">{unit}</span> : null}
        {side ? <span className="ml-1 font-sans text-base font-medium leading-none tracking-normal">{side}</span> : null}
      </div>
      {strip ? <div className="mt-3">{strip}</div> : null}
      {caption ? <div className="num mt-[7px] text-cap text-t3 [&_b]:font-medium [&_b]:text-t2">{caption}</div> : null}
    </div>
  )
}

/** A quiet inline strip of figures: label t3 · value 20/600 · detail t4. No boxes, no dividers. */
export function InlineStats({ cells, className }: { cells: { label: ReactNode; value: ReactNode; detail?: ReactNode; className?: string }[]; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-x-8 gap-y-3', className)}>
      {cells.map((cell, index) => (
        <div key={index} className={cn('min-w-0', cell.className)}>
          <Label>{cell.label}</Label>
          <div className="num mt-1 truncate font-display text-xl font-semibold leading-tight tracking-title text-t1">{cell.value}</div>
          {cell.detail ? <div className="num mt-0.5 truncate text-xs text-t4" title={typeof cell.detail === 'string' ? cell.detail : undefined}>{cell.detail}</div> : null}
        </div>
      ))}
    </div>
  )
}
