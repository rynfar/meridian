import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { createColumnHelper, createPaginatedRowModel, createSortedRowModel, rowPaginationFeature, rowSortingFeature, sortFn_basic, sortFn_text, tableFeatures, useTable, type PaginationState, type SortingState } from '@tanstack/react-table'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Card, Label, StatsStrip } from '../components/card'
import { Button } from '../components/button'
import { Input, Segmented, Select, Tab, TabList, TabPanel, Tabs } from '../components/controls'
import { Pill } from '../components/pill'
import { Table, Td, Th, Tr } from '../components/table'
import { ConnectionProblem, Empty, Skeleton } from '../components/state'
import { RequestsChart } from '../charts/charts'
import { RequestDetail } from './RequestDetail'
import { fmtInt, fmtTok, hhmm, ms, pct, seconds, usd } from '../model/format'
import { chartSeries } from '../model/series'
import { requestCost, type RequestRow } from '../model/requests'
import { accountTrafficRows, emptyFilter, facets, filterRows, lineageCounts, modelRows, percentileRows, trafficStats, type RequestFilter, type RequestKind } from '../model/traffic'
import { windowRange } from '../../uiData'
import type { Navigate } from '../shell/nav'

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, sortedRowModel: createSortedRowModel(), paginatedRowModel: createPaginatedRowModel(), sortFns: { basic: sortFn_basic, text: sortFn_text } })
const helper = createColumnHelper<typeof features, RequestRow & { cost: number | null }>()
const num = (value: number | null) => value ?? undefined
const columns = helper.columns([
  helper.accessor('timestamp', { header: 'Time', sortFn: 'basic', cell: info => <span className="num text-muted">{hhmm(info.getValue())}</span> }),
  helper.accessor('model', { header: 'Model', sortFn: 'text', cell: info => <span className="flex items-center gap-1"><span className="font-semibold">{info.getValue()}</span>{info.row.original.longContext ? <Pill tone="violet">1M</Pill> : null}</span> }),
  helper.accessor(row => row.adapter || row.source, { id: 'client', header: 'Client', sortFn: 'text', cell: info => <span className="text-muted">{info.getValue() || '—'}</span> }),
  helper.accessor(row => row.profile, { id: 'account', header: 'Account', sortFn: 'text', cell: info => {
    const row = info.row.original
    return <span className="flex items-center gap-1">{row.provider !== 'claude' ? <span className="text-muted">{row.provider} ·</span> : null}{row.profile || 'default'}{row.chain.length > 1 ? <Pill tone="yellow">failover</Pill> : null}{row.refusedBucket ? <Pill tone="red">{row.refusedBucket.replace('five_hour', '5h').replace('seven_day', '7d')}</Pill> : null}</span>
  } }),
  helper.accessor(row => row.status ?? undefined, { id: 'status', header: 'Status', sortFn: 'basic', sortUndefined: 'last', cell: info => { const row = info.row.original; return <Pill tone={row.failed ? 'red' : 'green'}>{row.status ?? (row.failed ? 'err' : '—')}</Pill> } }),
  helper.accessor(row => num(row.cacheHit), { id: 'cache', header: 'Cache', sortFn: 'basic', sortUndefined: 'last', cell: info => { const value = info.getValue(); return value === undefined ? <span className="text-muted">—</span> : <span className="num text-accent2">{pct(value)}</span> } }),
  helper.accessor('promptTokens', { header: 'In', sortFn: 'basic', cell: info => <span className="num">{fmtTok(info.getValue())}</span> }),
  helper.accessor('outputTokens', { header: 'Out', sortFn: 'basic', cell: info => <span className="num">{fmtTok(info.getValue())}</span> }),
  helper.accessor(row => num(row.ttfbMs), { id: 'ttfb', header: 'TTFB', sortFn: 'basic', sortUndefined: 'last', cell: info => <span className="num">{ms(info.getValue())}</span> }),
  helper.accessor(row => num(row.totalMs), { id: 'total', header: 'Total', sortFn: 'basic', sortUndefined: 'last', cell: info => <span className="num">{seconds(info.getValue())}</span> }),
  helper.accessor(row => num(row.cost), { id: 'cost', header: 'Cost', sortFn: 'basic', sortUndefined: 'last', cell: info => <span className="num text-muted">{info.getValue() === undefined ? '—' : usd(info.getValue())}</span> }),
])
const numeric = new Set(['promptTokens', 'outputTokens', 'ttfb', 'total', 'cost', 'cache'])
const kinds: { value: RequestKind; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'errors', label: 'Errors' }, { value: 'low-cache', label: 'Low cache' }]

export function Traffic({ navigate, focus }: { navigate: Navigate; focus?: { request?: string; filter?: RequestKind } }) {
  const { state, now, run, busy } = useDesktop()
  const { data, requests, pricing } = useModels()
  const [filter, setFilter] = useState<RequestFilter>(emptyFilter)
  const [selected, setSelected] = useState<string>('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'timestamp', desc: true }])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 100 })
  useEffect(() => {
    if (focus?.request) setSelected(focus.request)
    if (focus?.filter) setFilter({ ...emptyFilter, kind: focus.filter })
  }, [focus])

  // The table covers the selected window, like the stats and chart above it.
  const kind = state?.window.kind ?? 'today'
  const since = windowRange(kind, now).start
  const inWindow = useMemo(() => requests.filter(row => row.timestamp >= since), [requests, since])
  const priced = useMemo(() => inWindow.map(row => ({ ...row, cost: requestCost(row, pricing) })), [inWindow, pricing])
  const rows = useMemo(() => filterRows(priced, filter), [priced, filter])
  const options = useMemo(() => facets(inWindow), [inWindow])
  useEffect(() => setPagination(current => ({ ...current, pageIndex: 0 })), [filter])
  const table = useTable({ features, columns, data: rows, state: { sorting, pagination }, onSortingChange: setSorting, onPaginationChange: setPagination, autoResetPageIndex: false })
  const series = useMemo(() => state ? chartSeries(state, now) : null, [state, now])

  if (data.kind === 'failed' && state) return <div className="p-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <div className="flex flex-col gap-3.5 p-5"><Skeleton className="h-[72px]" /><Skeleton className="h-28" /><Skeleton className="h-96" /></div>

  const stats = trafficStats(state.summary, state.routesSummary)
  const detail = selected ? priced.find(row => row.id === selected) : undefined
  const set = (patch: Partial<RequestFilter>) => setFilter(current => ({ ...current, ...patch }))
  const filtered = filter.query || filter.kind !== 'all' || filter.provider !== 'all' || filter.client !== 'all' || filter.profile !== 'all'

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3.5 px-5 pb-5 pt-[18px]">
      {stats.length ? <StatsStrip cells={stats.map(cell => ({ label: cell.label, value: <span className={cell.tone === 'red' ? 'text-red' : cell.tone === 'yellow' ? 'text-yellow' : undefined}>{cell.value}</span>, detail: cell.detail }))} /> : <Skeleton className="h-[72px]" />}

      <Tabs defaultValue="requests" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-end justify-between gap-3">
          <TabList className="flex-1">
            <Tab value="requests">Requests <span className="num text-2xs text-muted">{fmtInt(inWindow.length)}</span></Tab>
            <Tab value="latency">Latency</Tab>
            <Tab value="breakdown">Models &amp; accounts</Tab>
          </TabList>
        </div>

        <TabPanel value="requests" className="mt-3 flex min-h-0 flex-1 flex-col gap-3 data-[state=inactive]:hidden">
          <Card className="px-3 pb-1 pt-2.5">
            <div className="flex items-center justify-between px-1"><Label>Requests per {series && series.series.bucketMs >= 3_600_000 ? (series.series.bucketMs > 3_600_000 ? '6 hours' : 'hour') : '5 minutes'}</Label>{series?.estimated ? <span className="text-2xs text-muted" title={series.note}>estimated from the latest {fmtInt(requests.length)} requests</span> : null}</div>
            {series ? <RequestsChart buckets={series.series.buckets} bucketMs={series.series.bucketMs} height={92} /> : <Skeleton className="h-[92px]" />}
          </Card>
          <div className="flex items-center gap-2">
            <div className="relative w-64"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" /><Input className="pl-7" type="search" placeholder="Search model, account, client or id" aria-label="Search requests" value={filter.query} onChange={event => set({ query: event.target.value })} /></div>
            <Segmented label="Request filter" value={filter.kind} options={kinds} onChange={kind => set({ kind })} />
            {options.providers.length > 1 ? <Select aria-label="Provider" value={filter.provider} onChange={event => set({ provider: event.target.value })} className="w-32"><option value="all">All providers</option>{options.providers.map(id => <option key={id} value={id}>{id}</option>)}</Select> : null}
            <Select aria-label="Client" value={filter.client} onChange={event => set({ client: event.target.value })} className="w-28"><option value="all">All clients</option>{options.clients.map(id => <option key={id} value={id}>{id}</option>)}</Select>
            <Select aria-label="Account" value={filter.profile} onChange={event => set({ profile: event.target.value })} className="w-32"><option value="all">All accounts</option>{options.profiles.map(id => <option key={id} value={id}>{id}</option>)}</Select>
            <span className="flex-1" />
            {filtered ? <Button variant="ghost" size="sm" onClick={() => setFilter(emptyFilter)}>Clear</Button> : null}
            <span className="num text-xs text-muted">{fmtInt(rows.length)} of {fmtInt(inWindow.length)}</span>
          </div>
          <Card className="flex min-h-0 flex-1 flex-col p-0">
            {state.requests === null ? <Skeleton className="m-4 h-full" /> : rows.length ? <>
              <div className="min-h-0 flex-1 overflow-auto rounded-t-2xl">
                <Table>
                  <thead>
                    {table.getHeaderGroups().map(group => (
                      <tr key={group.id}>
                        {group.headers.map(header => {
                          const sorted = header.column.getIsSorted()
                          return (
                            <Th key={header.id} className={cn(numeric.has(header.column.id) && 'text-right')} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
                              <button type="button" onClick={header.column.getToggleSortingHandler()} className={cn('inline-flex items-center gap-0.5 uppercase hover:text-text', sorted && 'text-accent')}>
                                <table.FlexRender header={header} />
                                {sorted === 'asc' ? <ArrowUp className="size-3" /> : sorted === 'desc' ? <ArrowDown className="size-3" /> : null}
                              </button>
                            </Th>
                          )
                        })}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map(row => (
                      <Tr key={row.id} onClick={() => setSelected(row.original.id)} className={cn('cursor-pointer', row.original.id === selected && 'bg-accent/10 hover:bg-accent/10')} aria-selected={row.original.id === selected}>
                        {row.getAllCells().map(cell => <Td key={cell.id} className={cn(numeric.has(cell.column.id) && 'text-right')}><table.FlexRender cell={cell} /></Td>)}
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {table.getPageCount() > 1 ? (
                <div className="hairline-t flex items-center justify-end gap-2 border-border px-3 py-1.5 text-xs text-muted">
                  <span className="num">Page {pagination.pageIndex + 1} of {table.getPageCount()}</span>
                  <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}><ChevronLeft /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}><ChevronRight /></Button>
                </div>
              ) : null}
            </> : filtered ? <Empty title="No matching requests" detail="Clear the filters to see everything in the window."><Button onClick={() => setFilter(emptyFilter)}>Clear filters</Button></Empty>
              : <Empty title="No requests yet" detail="Requests appear here as soon as a client sends one through this Meridian." />}
          </Card>
        </TabPanel>

        <TabPanel value="latency" className="scroll-y mt-3 min-h-0 flex-1 data-[state=inactive]:hidden">
          <LatencyTables summary={state.summary} />
        </TabPanel>
        <TabPanel value="breakdown" className="scroll-y mt-3 min-h-0 flex-1 data-[state=inactive]:hidden">
          <Breakdown summary={state.summary} routes={state.routesSummary} rows={requests} />
        </TabPanel>
      </Tabs>

      {detail ? <RequestDetail row={detail} cost={detail.cost} now={now} onClose={() => setSelected('')} /> : null}
    </div>
  )
}

function LatencyTables({ summary }: { summary: unknown }) {
  const rows = percentileRows(summary)
  if (!rows.length) return <Card><Empty title="No timings yet" detail="Percentiles appear once requests arrive in this window." /></Card>
  return (
    <Card className="p-0">
      <Table>
        <thead><tr>{['Phase', 'p50', 'p95', 'p99', 'Min', 'Max', 'Avg'].map(label => <Th key={label} className={label !== 'Phase' ? 'text-right' : undefined}>{label}</Th>)}</tr></thead>
        <tbody>{rows.map(row => <Tr key={row.label}><Td className="font-medium">{row.label}</Td>{[row.p50, row.p95, row.p99, row.min, row.max, row.avg].map((value, index) => <Td key={index} className="num text-right">{ms(value)}</Td>)}</Tr>)}</tbody>
      </Table>
      <p className="hairline-t border-border px-4 py-2.5 text-xs text-muted">First token counts from the SDK query start; upstream includes every replayed attempt. Total = queue + proxy + upstream.</p>
    </Card>
  )
}

function Breakdown({ summary, routes, rows }: { summary: unknown; routes: unknown; rows: RequestRow[] }) {
  const models = modelRows(summary)
  const accounts = accountTrafficRows(summary, routes)
  const lineage = lineageCounts(rows)
  return (
    <div className="grid grid-cols-[1.4fr_1fr] gap-3.5">
      <Card className="p-0">
        <div className="px-4 pt-3"><Label>By model</Label></div>
        {models.length ? <Table className="mt-1">
          <thead><tr>{['Model', 'Requests', 'Avg', 'Input', 'Output', 'Cache read', 'Cost'].map(label => <Th key={label} className={label !== 'Model' ? 'text-right' : undefined}>{label}</Th>)}</tr></thead>
          <tbody>{models.map(row => <Tr key={row.model}><Td className="font-mono text-xs text-accent2">{row.model}</Td><Td className="num text-right">{fmtInt(row.requests)}</Td><Td className="num text-right">{seconds(row.avgMs)}</Td><Td className="num text-right">{fmtTok(row.input)}</Td><Td className="num text-right">{fmtTok(row.output)}</Td><Td className="num text-right">{fmtTok(row.cacheRead)}</Td><Td className="num text-right">{row.costUsd === null ? <Pill tone="yellow">no price</Pill> : usd(row.costUsd)}</Td></Tr>)}</tbody>
        </Table> : <Empty title="No models yet" />}
        <p className="hairline-t border-border px-4 py-2.5 text-xs text-muted">API-equivalent at list prices (cache writes at the 5-minute rate). Subscription usage is not billed per token. Rates are editable in Service → Pricing.</p>
      </Card>
      <div className="flex flex-col gap-3.5">
        <Card className="p-0">
          <div className="px-4 pt-3"><Label>By account</Label></div>
          {accounts.length ? <Table className="mt-1">
            <thead><tr>{['Account', 'Served', 'Refused', 'Cost'].map(label => <Th key={label} className={label !== 'Account' ? 'text-right' : undefined}>{label}</Th>)}</tr></thead>
            <tbody>{accounts.map(row => <Tr key={row.id}><Td title={row.refusedOn}>{row.id}</Td><Td className="num text-right">{fmtInt(row.served)}</Td><Td className={cn('num text-right', row.refused && 'text-red')}>{fmtInt(row.refused)}</Td><Td className="num text-right">{row.costUsd === null ? '—' : usd(row.costUsd)}</Td></Tr>)}</tbody>
          </Table> : <Empty title="No account activity" />}
          <p className="hairline-t border-border px-4 py-2.5 text-xs text-muted">Refusals include the ones a failover hid from the client.</p>
        </Card>
        <Card>
          <Label>Conversation lineage <span className="font-normal">· loaded requests</span></Label>
          <div className="mt-2 flex flex-wrap gap-2">{lineage.map(([kind, count]) => <span key={kind} className="flex items-center gap-1.5 text-sm"><Pill tone="violet">{kind}</Pill><span className="num">{fmtInt(count)}</span></span>)}</div>
        </Card>
      </div>
    </div>
  )
}

