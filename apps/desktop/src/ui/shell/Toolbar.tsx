import { LoaderCircle, Radar, RotateCw } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { Button } from '../components/button'
import { Segmented, Tip } from '../components/controls'
import { Dot } from '../components/pill'
import type { HealthChip } from '../model/status'
import { hhmm } from '../model/format'
import type { WindowKind } from '../../uiData'

const windows: { value: WindowKind; label: string; title: string }[] = [
  { value: '1h', label: '1h', title: 'Last hour' },
  { value: 'today', label: 'Today', title: 'Since local midnight' },
  { value: '24h', label: '24h', title: 'Last 24 hours' },
  { value: '7d', label: '7d', title: 'Last 7 days' },
]

export function Toolbar({ title, chip, showWindow }: { title: string; chip: HealthChip; showWindow: boolean }) {
  const { state, run, busy, pending } = useDesktop()
  const working = state?.busy ?? (pending && pending !== 'set-window' ? 'Working' : '')
  return (
    <header className="drag glass-toolbar hairline-b flex h-[52px] shrink-0 items-center gap-3 border-border px-5">
      <h1 className="text-lg font-semibold">{title}</h1>
      <Tip content={chip.title} side="bottom">
        <span className="no-drag hairline inline-flex h-6 max-w-[300px] items-center gap-1.5 rounded-md border-control-border bg-control px-2.5 text-sm">
          <Dot tone={chip.tone} /><span className="truncate">{chip.label}</span>
        </span>
      </Tip>
      <span className="flex-1" />
      {working ? <span className="flex items-center gap-1.5 text-xs text-muted"><LoaderCircle className="size-3.5 animate-spin" />{working}…</span>
        : state?.lastChecked ? <span className="num text-xs text-muted">Updated {hhmm(state.lastChecked)}</span> : null}
      {showWindow && state ? (
        <Segmented label="Time window" value={state.window.kind} options={windows} onChange={kind => { void run('set-window', kind) }} />
      ) : null}
      <Tip content="Refresh now" side="bottom">
        <Button variant="ghost" size="icon" aria-label="Refresh" disabled={!state || busy} onClick={() => { void run('refresh') }}><RotateCw className={pending === 'refresh' ? 'animate-spin' : undefined} /></Button>
      </Tip>
      <Tip content="Re-detect the Meridian your clients use" side="bottom">
        <Button variant="ghost" size="icon" aria-label="Re-detect Meridian" disabled={!state || busy} onClick={() => { void run('redetect') }}><Radar /></Button>
      </Tip>
    </header>
  )
}
