import type { ReactNode } from 'react'
import { KeyRound, Plug, Power, RefreshCw, CircleAlert } from 'lucide-react'
import { cn } from '../lib/cn'
import { Button } from './button'
import type { DesktopState } from '../../contracts'
import type { DataState } from '../model/status'

/** Loading placeholder in the well tone; pulses opacity only. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-well', className)} />
}

/** Empty state: calm, centred, t3 — never red. */
export function Empty({ title, detail, children, className }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1 px-6 py-10 text-center', className)}>
      <div className="text-base font-medium text-t2">{title}</div>
      {detail ? <div className="max-w-96 text-cap text-t3 [text-wrap:pretty]">{detail}</div> : null}
      {children ? <div className="mt-3 flex gap-2">{children}</div> : null}
    </div>
  )
}

/** The viewed service cannot be read: say exactly why and how to fix it, with the button that does. On the canvas, no box. */
export function ConnectionProblem({ data, state, run, goService, busy, compact }: { data: Extract<DataState, { kind: 'failed' }>; state: DesktopState; run(action: 'redetect' | 'start'): void; goService(): void; busy: boolean; compact?: boolean }) {
  const kind = state.connection.kind
  const Icon = kind === 'unauthorized' ? KeyRound : kind === 'stopped' ? Power : kind === 'wrong-port' ? Plug : CircleAlert
  const canStart = state.preferences.mode === 'managed' && !state.owned && Boolean(state.preferences.selected)
  return (
    <div role="alert" className={cn('flex items-start gap-3.5', compact ? 'py-2' : 'mx-auto mt-16 max-w-[520px]')}>
      <Icon aria-hidden strokeWidth={1.6} className={cn('mt-0.5 size-5 shrink-0', kind === 'wrong-port' ? 'text-yellow' : 'text-red')} />
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold tracking-title text-t1">{data.title}</div>
        <p className="mt-1 text-base text-t2 [text-wrap:pretty]">{data.message}</p>
        {data.fix ? <p className="mt-1 text-cap text-t3 [text-wrap:pretty]">{data.fix}</p> : null}
        <div className="mt-3.5 flex flex-wrap gap-2">
          {canStart ? <Button onClick={() => run('start')} disabled={busy}><Power />Start Meridian</Button> : null}
          <Button variant={canStart ? 'subtle' : 'default'} onClick={() => run('redetect')} disabled={busy}><RefreshCw />Re-detect</Button>
          <Button variant="subtle" onClick={goService}>{kind === 'unauthorized' ? 'Enter API key' : 'Open Service'}</Button>
        </div>
      </div>
    </div>
  )
}
