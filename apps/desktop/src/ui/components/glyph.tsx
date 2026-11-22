import { Check, CircleX, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export type GlyphKind = 'warn' | 'bad' | 'ok'
const glyphs = { warn: [TriangleAlert, 'text-yellow'], bad: [CircleX, 'text-red'], ok: [Check, 'text-green'] } as const

/** 14px stroke glyph: warn triangle, bad circle-x, ok check. */
export function Glyph({ kind, className }: { kind: GlyphKind; className?: string }) {
  const [Icon, tone] = glyphs[kind]
  return <Icon aria-hidden strokeWidth={1.7} className={cn('size-3.5 shrink-0', tone, className)} />
}

/** Attention item: glyph · title 500 · detail t3 · outcome. */
export function GlyphItem({ kind, title, detail, outcome, aside, className }: { kind: GlyphKind; title: ReactNode; detail?: ReactNode; outcome?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-[9px] text-cap', className)}>
      <Glyph kind={kind} className="mt-[3px]" />
      <div className="min-w-0">
        <div className="font-medium text-t1">{title}</div>
        {detail ? <div className="mt-px text-t3">{detail}</div> : null}
        {outcome ? <div className="mt-px">{outcome}</div> : null}
      </div>
      {aside ? <div className="flex items-start gap-2">{aside}</div> : <span />}
    </div>
  )
}
