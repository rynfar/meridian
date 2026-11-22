import { useEffect, useRef, useState, type ComponentType } from 'react'
import { RefreshCw } from 'lucide-react'
import { useDesktop } from '../../lib/desktop'
import { cn } from '../../lib/cn'
import { Button } from '../../components/button'
import { Dot } from '../../components/pill'
import { Skeleton } from '../../components/state'
import { Connection } from './Connection'
import { Plugins, Process, Versions } from './Process'
import { Agents, ChatGpt, ClaudeCode, Pricing, Routing, Storage, Updates, WebUi } from './ServerSettings'
import { Clients, DesktopPreferences } from './Desktop'
import { object } from '../../../core'
import type { DesktopState } from '../../../contracts'

interface Section { id: string; label: string; group: string; Panel: ComponentType<{ state: DesktopState }>; show?(state: DesktopState): boolean }
const sections: Section[] = [
  { id: 'connection', label: 'Connection', group: 'Service', Panel: Connection },
  { id: 'process', label: 'Process', group: 'Service', Panel: Process },
  { id: 'versions', label: 'Versions', group: 'Service', Panel: Versions },
  { id: 'plugins', label: 'Plugins', group: 'Service', Panel: Plugins },
  { id: 'routing', label: 'Routing', group: 'Server settings', Panel: Routing },
  { id: 'agents', label: 'Agent features', group: 'Server settings', Panel: Agents },
  { id: 'chatgpt', label: 'ChatGPT', group: 'Server settings', Panel: ChatGpt, show: state => object(state.settings.values.chatgpt).enabled === true },
  { id: 'pricing', label: 'Pricing', group: 'Server settings', Panel: Pricing },
  { id: 'storage', label: 'Telemetry & transcripts', group: 'Server settings', Panel: Storage },
  { id: 'updates', label: 'Update checks', group: 'Server settings', Panel: Updates },
  { id: 'claude-code', label: 'Claude Code', group: 'Server settings', Panel: ClaudeCode },
  { id: 'web', label: 'Web pages', group: 'Server settings', Panel: WebUi },
  { id: 'desktop', label: 'Desktop', group: 'This Mac', Panel: DesktopPreferences },
  { id: 'clients', label: 'Clients & diagnostics', group: 'This Mac', Panel: Clients },
]

export function Service({ section: requested }: { section?: string }) {
  const { state, run, busy } = useDesktop()
  const [current, setCurrent] = useState(requested ?? 'connection')
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => { if (requested) setCurrent(requested) }, [requested])
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [current])
  if (!state) return <div className="p-5"><Skeleton className="h-96" /></div>
  const visible = sections.filter(section => !section.show || section.show(state))
  const active = visible.find(section => section.id === current) ?? visible[0]!
  const groups = [...new Set(visible.map(section => section.group))]
  const Panel = active.Panel
  const flag = (id: string) => id === 'connection' && state.connection.kind !== 'ok' ? <Dot tone={state.connection.kind === 'starting' || state.connection.kind === 'wrong-port' ? 'yellow' : 'red'} />
    : id === 'versions' && state.latest && state.running && state.latest !== state.running ? <Dot tone="accent" size={6} /> : null

  return (
    <div className="grid h-full min-h-0 grid-cols-[188px_minmax(0,1fr)]">
      <nav aria-label="Service sections" className="rule-r scroll-y px-2.5 py-4">
        {groups.map(group => (
          <div key={group} className="mb-4">
            <div className="px-2 pb-1 text-xs font-medium text-t3">{group}</div>
            {visible.filter(section => section.group === group).map(section => (
              <button key={section.id} type="button" onClick={() => setCurrent(section.id)} aria-current={section.id === active.id ? 'true' : undefined}
                className={cn('flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-base transition-colors duration-150', section.id === active.id ? 'lift bg-surface font-medium text-t1' : 'text-t2 hover:bg-hover')}>
                <span className="flex-1 truncate">{section.label}</span>{flag(section.id)}
              </button>
            ))}
          </div>
        ))}
        {state.settings.errors.length || state.settings.fetchedAt ? (
          <div className="mt-2 px-2">
            <Button variant="text" size="sm" className="text-xs" onClick={() => { void run('refresh-settings') }} disabled={busy}><RefreshCw />Refresh settings</Button>
          </div>
        ) : null}
      </nav>
      <div ref={scroller} className="scroll-y min-h-0 px-7 pb-8 pt-[22px]">
        <div className="max-w-[760px]"><Panel key={active.id} state={state} /></div>
      </div>
    </div>
  )
}
