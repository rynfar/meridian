import { cn } from '../lib/cn'
import { pct, when } from '../model/format'
import { pace, resetText } from '../model/pace'
import { barWidth, utilTone } from '../model/tone'
import type { LimitWindow } from '../model/accounts'
import { toneFill, toneText } from './pill'
import { Tip } from './controls'

/** 4px well track with the usage fill and, when known, the pace tick. */
export function LimitTrack({ window, now, className, label }: { window: LimitWindow | undefined; now: number; className?: string; label: string }) {
  const value = window?.utilization ?? null
  // A stale reading keeps its colour, dimmed, so a full account never reads as free.
  const fill = !window ? 'bg-t4' : cn(toneFill[utilTone(value)], window.stale && 'opacity-55')
  const tick = pace(window, now)
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}
      className={cn('relative h-1 rounded-xs bg-well', className)}>
      {value !== null ? <i className={cn('absolute inset-y-0 left-0 rounded-xs', fill)} style={{ width: `${barWidth(value, 0.015) * 100}%` }} /> : null}
      {tick ? <span aria-hidden className="absolute -top-[3px] h-2.5 w-[1.5px] rounded-[1px] bg-t2" style={{ left: `calc(${tick.elapsed * 100}% - 0.75px)` }} /> : null}
    </div>
  )
}

/**
 * Signature: a limit bar with its pace tick. Name and percentage above;
 * beneath, "on pace / ahead of pace / under pace" left and the reset right.
 */
export function LimitBar({ name, window, now, className }: { name: string; window: LimitWindow | undefined; now: number; className?: string }) {
  const value = window?.utilization ?? null
  const tone = !window || window.stale ? 'muted' : utilTone(value)
  const tick = pace(window, now)
  return (
    <Tip content={window ? `${window.label}: ${pct(value)} used · ${window.resetsAt ? `${window.stale ? 'last known reset' : 'resets'} ${when(window.resetsAt, now)}` : 'reset time unavailable'}${tick ? ` · ${Math.round(tick.elapsed * 100)}% of the window elapsed` : ''}` : 'No reading'}>
      <div className={cn('min-w-0', className)}>
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-t2">{name}</span>
          <b className={cn('num font-semibold', value !== null && value >= 0.6 && !window?.stale ? toneText[tone] : 'text-t1')}>{pct(value)}</b>
        </div>
        <LimitTrack window={window} now={now} className="mt-1.5" label={`${name} usage`} />
        <div className="num mt-[5px] flex justify-between gap-2 text-xs text-t4">
          <span className={cn('truncate', tick?.state === 'ahead' && 'text-yellow', tick?.state === 'full' && 'text-red')}>{tick?.label ?? (window?.stale ? 'last reading' : '')}</span>
          <span className="truncate">{resetText(window, now)}</span>
        </div>
      </div>
    </Tip>
  )
}
