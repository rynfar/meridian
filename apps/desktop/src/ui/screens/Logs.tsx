import { useMemo, useState } from 'react'
import { BellOff, CheckCheck, Search } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { Dot } from '../components/pill'
import { GlyphItem } from '../components/glyph'
import { Input, Select, Tab, TabList, TabPanel, Tabs } from '../components/controls'
import { ConnectionProblem, Empty, Skeleton } from '../components/state'
import { fmtInt, when } from '../model/format'
import { filterLogRows, levelTone, logFacets, logRows } from '../model/logs'
import type { Navigate } from '../shell/nav'

export function Logs({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data } = useModels()
  const [tab, setTab] = useState('diagnostics')
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [category, setCategory] = useState('all')
  const logs = useMemo(() => logRows(state?.logs), [state?.logs])
  const facets = useMemo(() => logFacets(logs), [logs])
  const shown = useMemo(() => filterLogRows(logs, query, level, category), [logs, query, level, category])
  if (!state) return <div className="px-[26px] pt-[22px]"><Skeleton className="h-96" /></div>
  const search = query.trim().toLowerCase()
  const incidents = state.incidents.filter(item => !search || `${item.title} ${item.detail} ${item.severity}`.toLowerCase().includes(search))
  const output = state.serviceLog.filter(line => !search || line.toLowerCase().includes(search))

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col px-[26px] pb-[18px] pt-[18px]">
      <div className="flex items-center gap-2">
        <TabList>
          <Tab value="diagnostics">Diagnostics <span className="num text-xs font-normal text-t4">{fmtInt(logs.length)}</span></Tab>
          <Tab value="alerts">Alerts {state.incidents.length ? <span className="num flex items-center gap-1 text-xs font-normal text-t4"><Dot tone="yellow" size={6} />{state.incidents.length}</span> : <span className="text-xs font-normal text-t4">0</span>}</Tab>
          <Tab value="output">Service output <span className="num text-xs font-normal text-t4">{fmtInt(state.serviceLog.length)}</span></Tab>
        </TabList>
        <span className="flex-1" />
        {tab === 'alerts' && state.incidents.length ? <Button onClick={() => { void run('acknowledge') }} disabled={busy}><CheckCheck />Acknowledge all</Button> : null}
        {tab === 'alerts' ? <Button variant="subtle" onClick={() => { void run('toggle-snooze') }} disabled={busy || !state.preferences.notifications}><BellOff />{state.preferences.quietUntil > now ? 'Resume notifications' : 'Pause notifications 1h'}</Button> : null}
      </div>
      <div className="mt-3.5 flex items-center gap-2">
        <div className="relative w-72"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-t3" /><Input className="pl-7" type="search" aria-label="Search logs" placeholder={tab === 'alerts' ? 'Search alerts' : tab === 'output' ? 'Search service output' : 'Search diagnostics'} value={query} onChange={event => setQuery(event.target.value)} /></div>
        {tab === 'diagnostics' ? <>
          <Select aria-label="Level" value={level} onChange={event => setLevel(event.target.value)} className="w-32"><option value="all">All levels</option>{facets.levels.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}</Select>
          <Select aria-label="Category" value={category} onChange={event => setCategory(event.target.value)} className="w-40"><option value="all">All categories</option>{facets.categories.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}</Select>
        </> : null}
      </div>

      <TabPanel value="diagnostics" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        {data.kind === 'failed' ? <ConnectionProblem compact data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /> : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="rule-b grid grid-cols-[92px_128px_minmax(0,1fr)] gap-x-3.5 px-0 pb-[7px] text-sm font-medium text-t3"><span>Time</span><span>Category</span><span>Message</span></div>
            {state.connection.kind !== 'ok' && !logs.length ? <Skeleton className="mt-2 h-40" /> : shown.length ? (
              <div className="selectable scroll-y -mx-2 mt-0.5 min-h-0 flex-1">
                {shown.map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} className="grid min-h-[29px] grid-cols-[92px_128px_minmax(0,1fr)] items-baseline gap-x-3.5 rounded-md px-2 py-[6px] transition-colors duration-150 hover:bg-hover">
                    <time className="num text-base text-t4">{when(log.timestamp, now)}</time>
                    <span className={cn('truncate text-base', levelText[levelTone(log.level)])} title={log.level}>{log.category}</span>
                    <span className="min-w-0 break-words font-mono text-xs leading-relaxed text-t1">{log.message}</span>
                  </div>
                ))}
              </div>
            ) : <Empty title={search || level !== 'all' || category !== 'all' ? 'No matching events' : 'No diagnostic events'} detail={search ? 'Try a different search.' : 'Meridian records session, lineage, token and error events here.'} />}
          </div>
        )}
      </TabPanel>

      <TabPanel value="alerts" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        {incidents.length ? (
          <div className="scroll-y -mx-2 min-h-0 flex-1">
            {incidents.map(item => (
              <div key={item.id} className="rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-hover">
                <GlyphItem kind={item.severity === 'error' ? 'bad' : 'warn'} title={item.title} detail={item.detail}
                  aside={<><span className="num text-meta text-t4">{when(item.timestamp, now)}</span>{item.requestId ? <Button variant="text" size="sm" onClick={() => navigate('traffic', { request: item.requestId })}>Open request</Button> : null}</>} />
              </div>
            ))}
          </div>
        ) : <Empty title={search ? 'No matching alerts' : 'No new alerts'} detail="Repeated failures, cache misses, usage thresholds and service recovery problems are recorded here." className="flex-1" />}
        <p className="rule-t pt-2.5 text-xs text-t3">
          {state.preferences.notifications ? state.preferences.quietUntil > now ? `Notifications paused until ${when(state.preferences.quietUntil, now)}.` : 'Desktop notifications are on.' : 'Desktop notifications are off.'} Choose which alerts notify in Service → Desktop.
        </p>
      </TabPanel>

      <TabPanel value="output" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        {output.length ? <pre className="selectable scroll-y min-h-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-t2">{output.join('\n')}</pre>
          : <Empty title={search ? 'No matching output' : 'No service output'} detail="Output from the app-managed Meridian, installs and detection appears here." />}
      </TabPanel>
    </Tabs>
  )
}

const levelText = { red: 'text-red', yellow: 'text-yellow', muted: 'text-t3' } as const
