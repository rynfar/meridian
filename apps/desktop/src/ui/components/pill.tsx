import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'
import type { Tone } from '../model/tone'

/** Tinted pill: token text on the same token at ≤ 16% alpha. Blue = active, violet = meta. */
export const pillVariants = cva('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-px text-2xs font-semibold leading-snug', {
  variants: {
    tone: {
      green: 'bg-green/14 text-green',
      yellow: 'bg-yellow/16 text-yellow',
      red: 'bg-red/14 text-red',
      violet: 'bg-accent2/14 text-accent2',
      accent: 'bg-accent/16 text-accent',
      muted: 'bg-surface2 text-muted',
    },
  },
  defaultVariants: { tone: 'muted' },
})
export interface PillProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}
export function Pill({ className, tone, ...props }: PillProps) {
  return <span className={cn(pillVariants({ tone }), className)} {...props} />
}

const dotTone: Record<Tone, string> = {
  green: 'bg-green shadow-[0_0_0_3px_color-mix(in_srgb,var(--green)_18%,transparent)]',
  yellow: 'bg-yellow shadow-[0_0_0_3px_color-mix(in_srgb,var(--yellow)_18%,transparent)]',
  red: 'bg-red shadow-[0_0_0_3px_color-mix(in_srgb,var(--red)_18%,transparent)]',
  muted: 'bg-muted',
  accent: 'bg-accent',
  violet: 'bg-accent2',
}
/** Health dot with the soft glow DESIGN asks for. */
export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-[7px] shrink-0 rounded-full', dotTone[tone], className)} />
}

export const toneText: Record<Tone, string> = { green: 'text-green', yellow: 'text-yellow', red: 'text-red', muted: 'text-muted', accent: 'text-accent', violet: 'text-accent2' }
export const toneFill: Record<Tone, string> = { green: 'bg-green', yellow: 'bg-yellow', red: 'bg-red', muted: 'bg-muted', accent: 'bg-accent', violet: 'bg-accent2' }
