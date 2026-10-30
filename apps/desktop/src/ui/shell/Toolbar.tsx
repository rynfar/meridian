import { LoaderCircle, Radar, RotateCw } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { Button } from '../components/button'
import { Kbd, Segmented, Tip } from '../components/controls'
import { Dot } from '../components/pill'
import type { HealthChip } from '../model/status'
import { hhmm } from '../model/format'
import { refreshShortcut } from './nav'
import type { WindowKind } from '../../uiData'

const windows: { value: WindowKind; label: string; title: string }[] = [
  { value: '1h', label: '1h', title: 'Last hour' },
  { value: 'today', label: 'Today', title: 'Since local midnight' },
  { value: '24h', label: '24h', title: 'Last 24 hours' },
  { value: '7d', label: '7d', title: 'Last 7 days' },
]

/** Title, a plain status line (never a boxed chip), the window control and refresh. */
export function Toolbar({ title, chip, showWindow }: { title: string; chip: HealthChip; showWindow: boolean }) {
  const { state, run, busy, pending } = useDesktop()
  const working = state?.busy ?? (pending && pending !== 'set-window' ? 'Working' : '')
  const [label, ...context] = chip.label.split(' · ')
  return (
    <header className="drag rule-b flex h-[52px] shrink-0 items-center gap-3.5 px-[22px]">
      <h1 className="text-lg font-semibold leading-none tracking-title text-t1">{title}</h1>
      <Tip content={chip.title} side="bottom">
        <span role="status" className="no-drag flex min-w-0 max-w-[340px] items-center gap-[7px] text-cap text-t2">
          <Dot tone={chip.tone} /><span className="truncate">{label}{context.length ? <span className="text-t3"> · {context.join(' · ')}</span> : null}</span>
        </span>
      </Tip>
      <span className="flex-1" />
      {working ? <span className="flex items-center gap-1.5 text-meta text-t3"><LoaderCircle className="size-3.5 animate-spin" />{working}…</span>
        : state?.lastChecked ? <span className="num text-meta text-t3">Updated {hhmm(state.lastChecked)}</span> : null}
      {showWindow && state ? (
        <Segmented label="Time window" value={state.window.kind} options={windows} onChange={kind => { void run('set-window', kind) }} />
      ) : null}
      <div className="flex items-center gap-0.5">
        <Tip content={<span className="flex items-center gap-2">Refresh now <Kbd>{refreshShortcut}</Kbd></span>} side="bottom">
          <Button variant="ghost" size="icon" aria-label="Refresh" aria-keyshortcuts="Meta+R" disabled={!state || busy} onClick={() => { void run('refresh') }}><RotateCw className={pending === 'refresh' ? 'animate-spin' : undefined} strokeWidth={1.6} /></Button>
        </Tip>
        <Tip content="Re-detect the Meridian your clients use" side="bottom">
          <Button variant="ghost" size="icon" aria-label="Re-detect Meridian" disabled={!state || busy} onClick={() => { void run('redetect') }}><Radar strokeWidth={1.6} /></Button>
        </Tip>
      </div>
    </header>
  )
}
