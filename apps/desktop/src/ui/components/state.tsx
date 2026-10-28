import type { ReactNode } from 'react'
import { CircleAlert, KeyRound, Plug, Power, RefreshCw } from 'lucide-react'
import { cn } from '../lib/cn'
import { Card } from './card'
import { Button } from './button'
import type { DesktopState } from '../../contracts'
import type { DataState } from '../model/status'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-surface2', className)} />
}

/** DESIGN empty state: calm, centred, muted — never red. */
export function Empty({ title, detail, children, className }: { title: ReactNode; detail?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1 px-6 py-10 text-center', className)}>
      <div className="text-base font-medium text-text">{title}</div>
      {detail ? <div className="max-w-96 text-sm text-muted">{detail}</div> : null}
      {children ? <div className="mt-3 flex gap-2">{children}</div> : null}
    </div>
  )
}

/** The viewed service cannot be read: say exactly why and how to fix it, with the button that does. */
export function ConnectionProblem({ data, state, run, goService, busy, compact }: { data: Extract<DataState, { kind: 'failed' }>; state: DesktopState; run(action: 'redetect' | 'start'): void; goService(): void; busy: boolean; compact?: boolean }) {
  const kind = state.connection.kind
  const Icon = kind === 'unauthorized' ? KeyRound : kind === 'stopped' ? Power : kind === 'wrong-port' ? Plug : CircleAlert
  const canStart = state.preferences.mode === 'managed' && !state.owned && Boolean(state.preferences.selected)
  return (
    <Card className={cn('flex items-start gap-4', compact ? 'px-4 py-3.5' : 'mx-auto mt-10 max-w-[560px] px-6 py-5')}>
      <div className={cn('grid size-9 shrink-0 place-items-center rounded-lg', kind === 'wrong-port' ? 'bg-yellow/14 text-yellow' : 'bg-red/12 text-red')}><Icon className="size-4.5" /></div>
      <div className="min-w-0 flex-1">
        <div className="text-md font-semibold">{data.title}</div>
        <p className="mt-1 text-sm text-text">{data.message}</p>
        {data.fix ? <p className="mt-1 text-sm text-muted">{data.fix}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {canStart ? <Button onClick={() => run('start')} disabled={busy}><Power />Start Meridian</Button> : null}
          <Button variant={canStart ? 'subtle' : 'default'} onClick={() => run('redetect')} disabled={busy}><RefreshCw />Re-detect</Button>
          <Button variant="subtle" onClick={goService}>{kind === 'unauthorized' ? 'Enter API key' : 'Open Service'}</Button>
        </div>
      </div>
    </Card>
  )
}
