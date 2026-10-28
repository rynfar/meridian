import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />
}
/** DESIGN table header: uppercase micro-labels. */
export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('hairline-b sticky top-0 z-10 whitespace-nowrap border-border bg-surface px-2 py-1.5 text-left text-3xs font-semibold uppercase tracking-wide text-muted first:pl-4 last:pr-4', className)} {...props} />
}
export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('hairline-t whitespace-nowrap border-border px-2 py-[5px] first:pl-4 last:pr-4', className)} {...props} />
}
export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('hover:bg-accent/6', className)} {...props} />
}
