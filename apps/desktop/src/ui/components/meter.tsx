import { barWidth, utilTone, type Tone } from '../model/tone'
import { cn } from '../lib/cn'
import { toneFill } from './pill'

/** Usage track: a 4px well, fill coloured by the utilization thresholds; a stale reading is grey. */
export function Meter({ value, tone, stale, className, label, height = 'h-1' }: { value: number | null; tone?: Tone; stale?: boolean; className?: string; label?: string; height?: string }) {
  const width = barWidth(value)
  const fill = stale ? 'bg-t4' : toneFill[tone ?? utilTone(value)]
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}
      className={cn('w-full overflow-hidden rounded-xs bg-well', height, className)}>
      {/* Width through React's style object (CSSOM), allowed under style-src 'self'. */}
      <div className={cn('h-full rounded-xs', fill)} style={{ width: `${width * 100}%` }} />
    </div>
  )
}
