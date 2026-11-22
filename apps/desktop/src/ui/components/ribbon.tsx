import { cn } from '../lib/cn'
import { fmtInt, fmtTok, pct } from '../model/format'
import { ribbonSplit, type PromptTokens } from '../model/prompt'
import { Swatch } from './card'

const heights = { hero: 'h-1.5', row: 'h-1', mini: 'h-[3px]' } as const

/**
 * Signature: the prompt ribbon. One bar split cache read (violet) · cache
 * write (violet 40%) · fresh, 1px gaps, radius 3. 6px in heroes, 4px in rows.
 */
export function PromptRibbon({ tokens, size = 'row', minFresh, className }: { tokens: PromptTokens; size?: keyof typeof heights; minFresh?: number; className?: string }) {
  const split = ribbonSplit(tokens, minFresh ?? (size === 'hero' ? 0.004 : 0.01))
  const total = tokens.read + tokens.write + tokens.fresh
  const label = split ? `Prompt ${fmtInt(total)} tokens: ${pct(tokens.read / total)} cache read, ${pct(tokens.write / total)} cache write, ${pct(tokens.fresh / total)} fresh` : 'No prompt tokens'
  return (
    <div role="img" aria-label={label} title={label} className={cn('flex w-full gap-px overflow-hidden rounded-sm bg-well', heights[size], className)}>
      {split ? <>
        {split.read > 0 ? <i className="block h-full bg-cache" style={{ flexGrow: split.read, flexBasis: 0 }} /> : null}
        {split.write > 0 ? <i className="block h-full bg-cache-write" style={{ flexGrow: split.write, flexBasis: 0 }} /> : null}
        {split.fresh > 0 ? <i className="block h-full bg-fresh" style={{ flexGrow: split.fresh, flexBasis: 0 }} /> : null}
      </> : null}
    </div>
  )
}

/** Row form: the ribbon with the prompt size beside it. */
export function RibbonCell({ tokens, className }: { tokens: PromptTokens; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-[9px]', className)}>
      <PromptRibbon tokens={tokens} className="min-w-6 flex-1" />
      <em className="num w-[38px] shrink-0 text-right not-italic text-t3">{fmtTok(tokens.read + tokens.write + tokens.fresh)}</em>
    </span>
  )
}

/** Legend for anything drawn in the ribbon colours. */
export function RibbonLegend({ requests, className }: { requests?: boolean; className?: string }) {
  const items: [string, string][] = [['cache read', 'bg-cache'], ['cache write', 'bg-cache-write'], ['fresh', 'bg-fresh']]
  if (requests) items.push(['requests', 'bg-t4 opacity-55'])
  return (
    <div className={cn('flex flex-wrap gap-3 text-meta text-t3', className)}>
      {items.map(([label, fill]) => <span key={label} className="flex items-center gap-[5px]"><Swatch className={fill} />{label}</span>)}
    </div>
  )
}
