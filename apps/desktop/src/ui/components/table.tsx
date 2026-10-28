import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

/**
 * Native list (`inset` inside a grouped panel): 29px rows, no borders or zebra; the header is underlined by the
 * ring; hover and selection fill the whole row with radius 6.
 */
export function Table({ className, inset, ...props }: HTMLAttributes<HTMLTableElement> & { inset?: boolean }) {
  return <table className={cn('num w-full border-separate border-spacing-0 text-base', inset && '[--list-bg:var(--surface)] [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td]:rounded-none', className)} {...props} />
}
/** Header: sentence case, 12/500, t3. Sticky over a scrolling list; inside a panel set --list-bg. */
export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('rule-b sticky top-0 z-10 h-7 whitespace-nowrap bg-[var(--list-bg,var(--bg))] px-2 text-left text-sm font-medium text-t3 first:pl-2 last:pr-2', className)} {...props} />
}
export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-[29px] whitespace-nowrap px-2 first:rounded-l-md last:rounded-r-md', className)} {...props} />
}
export function Tr({ className, selected, ...props }: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return <tr className={cn('[&>td]:transition-colors [&>td]:duration-150 hover:[&>td]:bg-hover', selected && '[&>td]:bg-ring hover:[&>td]:bg-ring', className)} {...props} />
}
