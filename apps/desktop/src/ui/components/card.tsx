import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('hairline min-w-0 rounded-2xl border-border bg-surface px-4 py-3.5 shadow-card', className)} {...props} />
}

/** Micro-label: 11px, semibold, muted. */
export function Label({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-1.5 text-xs font-semibold text-muted', className)} {...props}>{children}</div>
}

export function SectionTitle({ title, detail, actions, className }: { title: ReactNode; detail?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-md font-semibold">{title}</h2>
        {detail ? <p className="mt-0.5 text-sm text-muted">{detail}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** DESIGN stats strip: one card, cells separated by hairlines. */
export function StatsStrip({ cells, className }: { cells: { label: ReactNode; value: ReactNode; detail?: ReactNode; className?: string }[]; className?: string }) {
  return (
    <Card className={cn('flex p-0', className)}>
      {cells.map((cell, index) => (
        <div key={index} className={cn('min-w-0 flex-1 px-4 py-3', index > 0 && 'hairline-l border-border', cell.className)}>
          <Label>{cell.label}</Label>
          <div className="num mt-1 truncate text-xl font-bold leading-tight tracking-tight">{cell.value}</div>
          {cell.detail ? <div className="num mt-0.5 truncate text-xs text-muted" title={typeof cell.detail === 'string' ? cell.detail : undefined}>{cell.detail}</div> : null}
        </div>
      ))}
    </Card>
  )
}
