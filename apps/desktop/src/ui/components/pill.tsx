import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'
import type { Tone } from '../model/tone'

/**
 * A quiet state label, only where a discrete state truly helps (a duplicate
 * account, an override, an installed version): ring outline, coloured text,
 * never a tinted fill.
 */
export const pillVariants = cva('edge-strong inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-kbd px-1.5 py-px text-xs font-medium leading-snug', {
  variants: {
    tone: {
      green: 'text-green',
      yellow: 'text-yellow',
      red: 'text-red',
      violet: 'text-cache',
      accent: 'text-accent',
      muted: 'text-t3',
    },
  },
  defaultVariants: { tone: 'muted' },
})
export interface PillProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}
export function Pill({ className, tone, ...props }: PillProps) {
  return <span className={cn(pillVariants({ tone }), className)} {...props} />
}

const dotTone: Record<Tone, string> = { green: 'bg-green', yellow: 'bg-yellow', red: 'bg-red', muted: 'bg-t4', accent: 'bg-accent', violet: 'bg-cache' }
/** Status dot: 7px for health, 6px for "active" beside a name. */
export function Dot({ tone, className, size = 7 }: { tone: Tone; className?: string; size?: 6 | 7 }) {
  return <span aria-hidden className={cn('inline-block shrink-0 rounded-full', size === 6 ? 'size-1.5' : 'size-[7px]', dotTone[tone], className)} />
}

export const toneText: Record<Tone, string> = { green: 'text-green', yellow: 'text-yellow', red: 'text-red', muted: 'text-t3', accent: 'text-accent', violet: 'text-cache' }
export const toneFill: Record<Tone, string> = { green: 'bg-green', yellow: 'bg-yellow', red: 'bg-red', muted: 'bg-t4', accent: 'bg-accent', violet: 'bg-cache' }
