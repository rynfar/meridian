import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { createColumnHelper, createPaginatedRowModel, createSortedRowModel, rowPaginationFeature, rowSortingFeature, sortFn_basic, sortFn_text, tableFeatures, useTable, type PaginationState, type SortingState } from '@tanstack/react-table'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { InlineStats, Label } from '../components/card'
import { Button } from '../components/button'
import { Input, Segmented, Select, Tab, TabList, TabPanel, Tabs } from '../components/controls'
import { Table, Td, Th, Tr } from '../components/table'
import { RibbonCell } from '../components/ribbon'
import { ConnectionProblem, Empty, ReadFailed, Skeleton } from '../components/state'
import { RequestsChart } from '../charts/charts'
import { RequestDetail } from './RequestDetail'
import { fmtInt, fmtTok, hhmm, ms, pct, seconds, usd } from '../model/format'
import { bucketWord, chartSeries, historyNote } from '../model/series'
import { sourceRead, summaryScope } from '../model/status'
import { requestCost, type RequestRow } from '../model/requests'
import { failureText, requestCoverage } from '../model/today'
import { accountTrafficRows, emptyFilter, facets, filterRows, findRequest, lineageCounts, modelRows, percentileRows, retentionLine, rowsInWindow, trafficStats, type RequestFilter, type RequestKind } from '../model/traffic'
import { windowRange } from '../../uiData'
import type { Navigate } from '../shell/nav'

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, sortedRowModel: createSortedRowModel(), paginatedRowModel: createPaginatedRowModel(), sortFns: { basic: sortFn_basic, text: sortFn_text } })
const helper = createColumnHelper<typeof features, RequestRow & { cost: number | null }>()
const num = (value: number | null) => value ?? undefined
const columns = helper.columns([
  helper.accessor('timestamp', { header: 'Time', sortFn: 'basic', cell: info => <span className="text-t3">{hhmm(info.getValue())}</span> }),
  // The model cell is the row's keyboard target: Tab reaches it, Enter or Space opens the detail.
  helper.accessor('model', { header: 'Model', sortFn: 'text', cell: info => <button type="button" data-open-request={info.row.original.id} aria-label={`Open request ${info.getValue()} at ${hhmm(info.row.original.timestamp)}`} className="rounded-sm font-medium text-t1 focus-visible:outline-2 focus-visible:outline-accent">{info.getValue()}{info.row.original.longContext ? <sup className="ml-[3px] text-3xs font-semibold text-t3">1M</sup> : null}</button> }),
  helper.accessor(row => row.adapter || row.source, { id: 'client', header: 'Client', sortFn: 'text', cell: info => <span className="text-t3">{info.getValue() || '—'}</span> }),
  helper.accessor(row => row.profile, { id: 'account', header: 'Account', sortFn: 'text', cell: info => {
    const row = info.row.original
    return (
      <span className="text-t2">
        {row.provider !== 'claude' ? <span className="text-t3">{row.provider} · </span> : null}{row.profile || 'default'}
        {row.chain.length > 1 ? <span className="text-yellow"> · failover</span> : null}
        {row.refusedBucket ? <span className="text-red"> · {row.refusedBucket.replace('five_hour', '5h').replace('seven_day', '7d')}</span> : null}
      </span>
    )
  } }),
  // The prompt ribbon; a failure takes its place as "HTTP 500 · api_error".
  helper.accessor('promptTokens', { id: 'prompt', header: 'Prompt', sortFn: 'basic', cell: info => {
    const row = info.row.original
    return row.failed ? <span className="block max-w-[180px] truncate text-red" title={failureText(row)}>{failureText(row)}</span>
      : <RibbonCell tokens={{ read: row.cacheRead, write: row.cacheWrite, fresh: row.inputTokens }} className="w-[150px]" />
  } }),
  helper.accessor(row => (row.failed ? undefined : num(row.cacheHit)), { id: 'hit', header: 'Hit', sortFn: 'basic', sortUndefined: 'last', cell: info => { const value = info.getValue(); return value === undefined ? null : <span className="font-medium text-cache">{pct(value)}</span> } }),
  helper.accessor('outputTokens', { header: 'Out', sortFn: 'basic', cell: info => <span className="text-t2">{fmtTok(info.getValue())}</span> }),
  helper.accessor(row => num(row.ttfbMs), { id: 'ttfb', header: 'First token', sortFn: 'basic', sortUndefined: 'last', cell: info => <span className="text-t2">{ms(info.getValue())}</span> }),
  helper.accessor(row => num(row.totalMs), { id: 'total', header: 'Total', sortFn: 'basic', sortUndefined: 'last', cell: info => <span className="text-t1">{seconds(info.getValue())}</span> }),
  helper.accessor(row => num(row.cost), { id: 'cost', header: 'Cost', sortFn: 'basic', sortUndefined: 'last', cell: info => <span className="text-t3">{info.getValue() === undefined ? '—' : usd(info.getValue())}</span> }),
])
const numeric = new Set(['outputTokens', 'ttfb', 'total', 'cost', 'hit'])
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
  const inWindow = useMemo(() => rowsInWindow(requests, since), [requests, since])
  const priced = useMemo(() => inWindow.map(row => ({ ...row, cost: requestCost(row, pricing) })), [inWindow, pricing])
  // The detail resolves against every loaded request, so a deep link outside the window still opens.
  const found = useMemo(() => findRequest(requests, selected, since), [requests, selected, since])
  const rows = useMemo(() => filterRows(priced, filter), [priced, filter])
  const options = useMemo(() => facets(inWindow), [inWindow])
  useEffect(() => setPagination(current => ({ ...current, pageIndex: 0 })), [filter])
  const table = useTable({ features, columns, data: rows, state: { sorting, pagination }, onSortingChange: setSorting, onPaginationChange: setPagination, autoResetPageIndex: false })
  const series = useMemo(() => state ? chartSeries(state, now) : null, [state, now])

  if (data.kind === 'failed' && state) return <div className="px-[26px] py-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <div className="flex flex-col gap-4 px-[26px] pt-[22px]"><div className="flex gap-8">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-11 w-24" />)}</div><Skeleton className="h-24" /><Skeleton className="h-96" /></div>

  const stats = trafficStats(state.summary, state.routesSummary)
  const summaryRead = sourceRead(state, 'summary')
  const requestsRead = sourceRead(state, 'requests')
  const coverage = requestCoverage(requests, state.summary, since)
  const note = historyNote(series)
  const retention = retentionLine(state.retention, now)
  const refresh = () => { void run('refresh') }
  const set = (patch: Partial<RequestFilter>) => setFilter(current => ({ ...current, ...patch }))
  const filtered = filter.query || filter.kind !== 'all' || filter.provider !== 'all' || filter.client !== 'all' || filter.profile !== 'all'

  return (
    <div className="relative flex h-full min-h-0 flex-col px-[26px] pb-[18px] pt-[22px]">
      {stats.length ? <InlineStats cells={stats.map(cell => ({ label: cell.label, value: <span className={cell.tone === 'red' ? 'text-red' : cell.tone === 'yellow' ? 'text-yellow' : undefined}>{cell.value}</span>, detail: cell.detail }))} />
        : summaryRead.kind === 'failed' ? <ReadFailed what="the totals for this window" message={summaryRead.message} busy={busy} onRetry={refresh} />
        : <div className="flex gap-8">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-11 w-24" />)}</div>}
      {summaryScope(state) === 'service' && stats.length ? <div className="mt-1.5 text-meta text-t3">Totals since the service started; this backend does not report per window.</div>
        : retention ? <div className="mt-1.5 text-meta text-t3" title={retention.title}>{retention.text}</div> : null}

      <Tabs defaultValue="requests" className="mt-6 flex min-h-0 flex-1 flex-col">
        <TabList>
          <Tab value="requests">Requests {requestsRead.kind === 'ready' ? <span className="num text-xs font-normal text-t3">{fmtInt(inWindow.length)}</span> : null}</Tab>
          <Tab value="latency">Latency</Tab>
          <Tab value="breakdown">Models &amp; accounts</Tab>
        </TabList>

        <TabPanel value="requests" className="mt-4 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <div className="flex items-center justify-between">
            <Label>Requests per {series ? bucketWord(series.series.bucketMs) : 'hour'}</Label>
            {series?.estimated ? <span className="text-xs text-t3" title={series.note}>estimated from the latest {fmtInt(requests.length)} requests</span> : null}
          </div>
          {note && series?.series.truncated ? <div className="text-meta text-t3">{note}</div> : null}
          <div className="mt-1">{series ? <RequestsChart buckets={series.series.buckets} bucketMs={series.series.bucketMs} height={84} /> : <Skeleton className="h-[84px]" />}</div>

          <div className="mt-4 flex items-center gap-2">
            <div className="relative w-60"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-t3" /><Input className="pl-7" type="search" placeholder="Search model, account, client or id" aria-label="Search requests" value={filter.query} onChange={event => set({ query: event.target.value })} /></div>
            <Segmented label="Request filter" value={filter.kind} options={kinds} onChange={kind => set({ kind })} />
            {options.providers.length > 1 ? <Select aria-label="Provider" value={filter.provider} onChange={event => set({ provider: event.target.value })} className="w-32"><option value="all">All providers</option>{options.providers.map(id => <option key={id} value={id}>{id}</option>)}</Select> : null}
            <Select aria-label="Client" value={filter.client} onChange={event => set({ client: event.target.value })} className="w-28"><option value="all">All clients</option>{options.clients.map(id => <option key={id} value={id}>{id}</option>)}</Select>
            <Select aria-label="Account" value={filter.profile} onChange={event => set({ profile: event.target.value })} className="w-32"><option value="all">All accounts</option>{options.profiles.map(id => <option key={id} value={id}>{id}</option>)}</Select>
            <span className="flex-1" />
            {filtered ? <Button variant="text" size="sm" onClick={() => setFilter(emptyFilter)}>Clear</Button> : null}
            {requestsRead.kind === 'ready' ? <span className="num text-meta text-t3" title={coverage.partial ? `The window has ${fmtInt(coverage.total)} requests; the latest ${fmtInt(inWindow.length)} are loaded.` : undefined}>{fmtInt(rows.length)} of {fmtInt(inWindow.length)}{coverage.partial ? ` · latest of ${fmtInt(coverage.total)}` : ''}</span> : null}
          </div>

          <div className="mt-2 flex min-h-0 flex-1 flex-col">
            {requestsRead.kind === 'failed' ? <ReadFailed what="the requests" message={requestsRead.message} busy={busy} onRetry={refresh} className="mt-2" />
              : state.requests === null ? <Skeleton className="h-full" /> : rows.length ? <>
              <div className="-mx-2 min-h-0 flex-1 overflow-auto px-0">
                <Table>
                  <thead>
                    {table.getHeaderGroups().map(group => (
                      <tr key={group.id}>
                        {group.headers.map(header => {
                          const sorted = header.column.getIsSorted()
                          return (
                            <Th key={header.id} className={cn(numeric.has(header.column.id) && 'text-right')} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}>
                              <button type="button" onClick={header.column.getToggleSortingHandler()} className={cn('inline-flex items-center gap-1 transition-colors hover:text-t1', sorted && 'text-t1')}>
                                <table.FlexRender header={header} />
                                {sorted === 'asc' ? <ArrowUp className="size-3 text-t3" /> : sorted === 'desc' ? <ArrowDown className="size-3 text-t3" /> : null}
                              </button>
                            </Th>
                          )
                        })}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map(row => (
                      <Tr key={row.id} onClick={() => setSelected(row.original.id)} selected={row.original.id === selected} aria-selected={row.original.id === selected}>
                        {row.getAllCells().map(cell => <Td key={cell.id} className={cn(numeric.has(cell.column.id) && 'text-right')}><table.FlexRender cell={cell} /></Td>)}
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {table.getPageCount() > 1 ? (
                <div className="rule-t flex items-center justify-end gap-2 pt-1.5 text-xs text-t3">
                  <span className="num">Page {pagination.pageIndex + 1} of {table.getPageCount()}</span>
                  <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}><ChevronLeft /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}><ChevronRight /></Button>
                </div>
              ) : null}
            </> : filtered ? <Empty title="No matching requests" detail="Clear the filters to see everything in the window."><Button onClick={() => setFilter(emptyFilter)}>Clear filters</Button></Empty>
              : <Empty title="No requests yet" detail="Requests appear here as soon as a client sends one through this Meridian." />}
          </div>
        </TabPanel>

        <TabPanel value="latency" className="scroll-y mt-4 min-h-0 flex-1 data-[state=inactive]:hidden">
          <LatencyTables summary={state.summary} />
        </TabPanel>
        <TabPanel value="breakdown" className="scroll-y mt-4 min-h-0 flex-1 data-[state=inactive]:hidden">
          <Breakdown summary={state.summary} routes={state.routesSummary} rows={requests} />
        </TabPanel>
      </Tabs>

      {found ? <RequestDetail row={found.row} cost={requestCost(found.row, pricing)} note={found.note} now={now} onClose={() => setSelected('')} /> : null}
    </div>
  )
}

function LatencyTables({ summary }: { summary: unknown }) {
  const rows = percentileRows(summary)
  if (!rows.length) return <Empty title="No timings yet" detail="Percentiles appear once requests arrive in this window." />
  return (
    <div className="max-w-[760px]">
      <Table>
        <thead><tr>{['Phase', 'p50', 'p95', 'p99', 'Min', 'Max', 'Avg'].map(label => <Th key={label} className={label !== 'Phase' ? 'text-right' : undefined}>{label}</Th>)}</tr></thead>
        <tbody>{rows.map(row => <Tr key={row.label}><Td className="font-medium text-t1">{row.label}</Td>{[row.p50, row.p95, row.p99, row.min, row.max, row.avg].map((value, index) => <Td key={index} className={cn('text-right', index === 0 ? 'text-t1' : 'text-t2')}>{ms(value)}</Td>)}</Tr>)}</tbody>
      </Table>
      <p className="mt-3 px-2 text-xs text-t3">First token counts from the SDK query start; upstream includes every replayed attempt. Total = queue + proxy + upstream.</p>
    </div>
  )
}

function Breakdown({ summary, routes, rows }: { summary: unknown; routes: unknown; rows: RequestRow[] }) {
  const models = modelRows(summary)
  const accounts = accountTrafficRows(summary, routes)
  const lineage = lineageCounts(rows)
  return (
    <div className="grid grid-cols-[1.4fr_1fr] gap-10">
      <section>
        <Label className="px-2">By model</Label>
        {models.length ? <Table className="mt-1">
          <thead><tr>{['Model', 'Requests', 'Avg', 'Input', 'Output', 'Cache read', 'Cost'].map(label => <Th key={label} className={label !== 'Model' ? 'text-right' : undefined}>{label}</Th>)}</tr></thead>
          <tbody>{models.map(row => <Tr key={row.model}><Td className="font-mono text-xs text-t1">{row.model}</Td><Td className="text-right">{fmtInt(row.requests)}</Td><Td className="text-right text-t2">{seconds(row.avgMs)}</Td><Td className="text-right text-t2">{fmtTok(row.input)}</Td><Td className="text-right text-t2">{fmtTok(row.output)}</Td><Td className="text-right text-cache">{fmtTok(row.cacheRead)}</Td><Td className="text-right text-t3">{row.costUsd === null ? <span className="text-yellow">no price</span> : usd(row.costUsd)}</Td></Tr>)}</tbody>
        </Table> : <Empty title="No models yet" />}
        <p className="mt-3 px-2 text-xs text-t3">API-equivalent at list prices (cache writes at the 5-minute rate). Subscription usage is not billed per token. Rates are editable in Service → Pricing.</p>
      </section>
      <div className="flex flex-col gap-8">
        <section>
          <Label className="px-2">By account</Label>
          {accounts.length ? <Table className="mt-1">
            <thead><tr>{['Account', 'Served', 'Refused', 'Cost'].map(label => <Th key={label} className={label !== 'Account' ? 'text-right' : undefined}>{label}</Th>)}</tr></thead>
            <tbody>{accounts.map(row => <Tr key={row.id}><Td title={row.refusedOn} className="font-medium text-t1">{row.id}</Td><Td className="text-right">{fmtInt(row.served)}</Td><Td className={cn('text-right', row.refused ? 'text-red' : 'text-t3')}>{fmtInt(row.refused)}</Td><Td className="text-right text-t3">{row.costUsd === null ? '—' : usd(row.costUsd)}</Td></Tr>)}</tbody>
          </Table> : <Empty title="No account activity" />}
          <p className="mt-3 px-2 text-xs text-t3">Refusals include the ones a failover hid from the client.</p>
        </section>
        <section className="px-2">
          <Label>Conversation lineage <span className="font-normal text-t3">· loaded requests</span></Label>
          <div className="num mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-base">{lineage.map(([kind, count]) => <span key={kind}><span className="text-t3">{kind}</span> <span className="text-t1">{fmtInt(count)}</span></span>)}</div>
        </section>
      </div>
    </div>
  )
}
