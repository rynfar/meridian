import { useMemo, useState } from 'react'
import { BellOff, CheckCheck, Search } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Card } from '../components/card'
import { Button } from '../components/button'
import { Pill } from '../components/pill'
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
  if (!state) return <div className="p-5"><Skeleton className="h-96" /></div>
  const search = query.trim().toLowerCase()
  const incidents = state.incidents.filter(item => !search || `${item.title} ${item.detail} ${item.severity}`.toLowerCase().includes(search))
  const output = state.serviceLog.filter(line => !search || line.toLowerCase().includes(search))

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col px-5 pb-5 pt-[14px]">
      <div className="flex items-end gap-3">
        <TabList className="flex-1">
          <Tab value="diagnostics">Diagnostics <span className="num text-2xs text-muted">{fmtInt(logs.length)}</span></Tab>
          <Tab value="alerts">Alerts {state.incidents.length ? <Pill tone="yellow">{state.incidents.length}</Pill> : <span className="text-2xs text-muted">0</span>}</Tab>
          <Tab value="output">Service output <span className="num text-2xs text-muted">{fmtInt(state.serviceLog.length)}</span></Tab>
        </TabList>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="relative w-72"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" /><Input className="pl-7" type="search" aria-label="Search logs" placeholder={tab === 'alerts' ? 'Search alerts' : tab === 'output' ? 'Search service output' : 'Search diagnostics'} value={query} onChange={event => setQuery(event.target.value)} /></div>
        {tab === 'diagnostics' ? <>
          <Select aria-label="Level" value={level} onChange={event => setLevel(event.target.value)} className="w-32"><option value="all">All levels</option>{facets.levels.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}</Select>
          <Select aria-label="Category" value={category} onChange={event => setCategory(event.target.value)} className="w-40"><option value="all">All categories</option>{facets.categories.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}</Select>
        </> : null}
        <span className="flex-1" />
        {tab === 'alerts' && state.incidents.length ? <Button onClick={() => { void run('acknowledge') }} disabled={busy}><CheckCheck />Acknowledge all</Button> : null}
        {tab === 'alerts' ? <Button variant="subtle" onClick={() => { void run('toggle-snooze') }} disabled={busy || !state.preferences.notifications}><BellOff />{state.preferences.quietUntil > now ? 'Resume notifications' : 'Pause notifications 1h'}</Button> : null}
      </div>

      <TabPanel value="diagnostics" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        {data.kind === 'failed' ? <ConnectionProblem compact data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /> : (
          <Card className="flex min-h-0 flex-1 flex-col p-0">
            {state.connection.kind !== 'ok' && !logs.length ? <Skeleton className="m-4 h-40" /> : shown.length ? (
              <div className="selectable scroll-y min-h-0 flex-1 py-1 font-mono text-xs">
                {shown.map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} className={cn('flex gap-3 px-4 py-1', index && 'hairline-t border-border')}>
                    <time className="num w-20 shrink-0 text-muted">{when(log.timestamp, now)}</time>
                    <span className="w-28 shrink-0"><Pill tone={levelTone(log.level) === 'muted' ? 'violet' : levelTone(log.level)}>{log.category}</Pill></span>
                    <span className="min-w-0 flex-1 break-words text-text">{log.message}</span>
                  </div>
                ))}
              </div>
            ) : <Empty title={search || level !== 'all' || category !== 'all' ? 'No matching events' : 'No diagnostic events'} detail={search ? 'Try a different search.' : 'Meridian records session, lineage, token and error events here.'} />}
          </Card>
        )}
      </TabPanel>

      <TabPanel value="alerts" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <Card className="flex min-h-0 flex-1 flex-col p-0">
          {incidents.length ? (
            <div className="scroll-y min-h-0 flex-1">
              {incidents.map((item, index) => (
                <div key={item.id} className={cn('flex items-start gap-3 px-4 py-2.5 text-sm', index && 'hairline-t border-border')}>
                  <Pill tone={item.severity === 'error' ? 'red' : 'yellow'} className="mt-px">{item.severity}</Pill>
                  <div className="min-w-0 flex-1"><div className="font-semibold">{item.title}</div><div className="text-muted">{item.detail}</div></div>
                  <span className="num shrink-0 text-xs text-muted">{when(item.timestamp, now)}</span>
                  {item.requestId ? <Button variant="link" size="xs" onClick={() => navigate('traffic', { request: item.requestId })}>Open request</Button> : null}
                </div>
              ))}
            </div>
          ) : <Empty title={search ? 'No matching alerts' : 'No new alerts'} detail="Repeated failures, cache misses, usage thresholds and service recovery problems are recorded here." />}
          <p className="hairline-t border-border px-4 py-2 text-xs text-muted">
            {state.preferences.notifications ? state.preferences.quietUntil > now ? `Notifications paused until ${when(state.preferences.quietUntil, now)}.` : 'Desktop notifications are on.' : 'Desktop notifications are off.'} Choose which alerts notify in Service → Desktop.
          </p>
        </Card>
      </TabPanel>

      <TabPanel value="output" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <Card className="flex min-h-0 flex-1 flex-col p-0">
          {output.length ? <pre className="selectable scroll-y min-h-0 flex-1 whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed">{output.join('\n')}</pre>
            : <Empty title={search ? 'No matching output' : 'No service output'} detail="Output from the app-managed Meridian, installs and detection appears here." />}
        </Card>
      </TabPanel>
    </Tabs>
  )
}
