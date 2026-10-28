import { ArrowRight, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { Pill } from '../components/pill'
import { Meter } from '../components/meter'
import { Label } from '../components/card'
import { fmtInt, fmtTok, ms, pct, usd, when } from '../model/format'
import { failureCause } from '../model/failures'
import { waterfall, type RequestRow } from '../model/requests'

const segmentClass = { queue: 'bg-yellow', proxy: 'bg-muted', 'first-token': 'bg-accent', generation: 'bg-green' } as const

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className={cn('min-w-0 truncate text-right', mono && 'selectable font-mono text-xs text-accent2')} title={typeof children === 'string' ? children : undefined}>{children}</span>
    </div>
  )
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="hairline-t border-border py-3"><Label className="mb-1.5">{title}</Label>{children}</section>
}

/** Per-request detail: timing waterfall, tokens and cache, lineage, routing chain and ids. */
export function RequestDetail({ row, cost, now, onClose }: { row: RequestRow; cost: number | null; now: number; onClose(): void }) {
  const segments = waterfall(row)
  const total = Math.max(1, segments.reduce((sum, segment) => sum + segment.ms, 0))
  const prompt = Math.max(1, row.promptTokens)
  return (
    <aside aria-label="Request detail" className="hairline-l absolute inset-y-0 right-0 z-20 flex w-[400px] flex-col border-border bg-surface shadow-panel">
      <div className="hairline-b flex items-start gap-2 border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-md font-semibold">
            {row.model}{row.longContext ? <Pill tone="violet">1M</Pill> : null}
            <Pill tone={row.failed ? 'red' : 'green'}>{row.status ?? '—'}</Pill>
          </div>
          <div className="num text-xs text-muted">{when(row.timestamp, now)} · {[row.adapter || row.source, row.profile].filter(Boolean).join(' · ')}</div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close detail" onClick={onClose}><X /></Button>
      </div>
      <div className="scroll-y min-h-0 flex-1 px-4 pb-4">
        {row.failed ? <div className="mt-3 rounded-lg bg-red/10 px-3 py-2 text-sm"><div className="font-semibold text-red">{failureCause(row)}</div>{row.error ? <div className="selectable mt-0.5 break-words font-mono text-xs text-text">{row.error}</div> : null}</div> : null}
        {row.envelope.length ? <div className="mt-2 rounded-lg bg-red/10 px-3 py-2 text-sm text-red">Response integrity: {row.envelope.join(', ')}</div> : null}

        <Section title="Timing">
          <div className="flex h-3 gap-px overflow-hidden rounded-xs bg-surface2">
            {segments.map(segment => segment.ms > 0 ? <div key={segment.key} title={`${segment.label} ${ms(segment.ms)}`} className={segmentClass[segment.key]} style={{ flexGrow: segment.ms / total, minWidth: 2 }} /> : null)}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4">
            {segments.map(segment => <div key={segment.key} className="flex items-center justify-between gap-2 py-px text-xs"><span className="flex items-center gap-1.5 text-muted"><span className={cn('size-2 rounded-xs', segmentClass[segment.key])} />{segment.label.replace('Waiting for first token', 'First token')}</span><span className="num">{ms(segment.ms)}</span></div>)}
          </div>
          <Row label="Total">{ms(row.totalMs)}</Row>
          {row.sessionQueueMs || row.sdkQueueMs ? <Row label="Queue split">session {ms(row.sessionQueueMs)} · SDK {ms(row.sdkQueueMs)}</Row> : null}
        </Section>

        <Section title="Tokens and cache">
          <div className="flex items-center gap-2"><Meter value={row.cacheHit} tone="violet" label="Cache hit" /><span className="num w-10 text-right text-sm font-semibold text-accent2">{pct(row.cacheHit)}</span></div>
          <div className="mt-2 flex h-2 overflow-hidden rounded-xs bg-surface2">
            <div className="bg-accent2 opacity-85" style={{ flexGrow: row.cacheRead / prompt }} title="Cache read" />
            <div className="bg-accent2 opacity-40" style={{ flexGrow: row.cacheWrite / prompt }} title="Cache write" />
            <div className="bg-muted opacity-70" style={{ flexGrow: row.inputTokens / prompt }} title="Uncached input" />
          </div>
          <Row label="Cache read">{fmtInt(row.cacheRead)}</Row>
          <Row label="Cache write">{fmtInt(row.cacheWrite)}</Row>
          <Row label="Uncached input">{fmtInt(row.inputTokens)}</Row>
          <Row label="Output">{fmtInt(row.outputTokens)}</Row>
          <Row label="API-equivalent">{cost === null ? 'no price for this model' : usd(cost)}</Row>
        </Section>

        <Section title="Conversation">
          <Row label="Lineage">{row.lineage ? <Pill tone="violet">{row.lineage}</Pill> : '—'}</Row>
          <Row label="Resumed session">{row.isResume ? 'yes' : 'no'}</Row>
          <Row label="Messages">{fmtInt(row.messageCount)}</Row>
          <Row label="Tools">{row.toolCount === null ? '—' : `${row.toolCount}${row.deferredTools ? ` · ${row.deferredTools} deferred` : ''}`}</Row>
          {row.discoveredTools.length ? <Row label="Discovered">{row.discoveredTools.join(', ')}</Row> : null}
          <Row label="Mode">{row.mode || '—'}</Row>
        </Section>

        <Section title="Routing">
          <Row label="Provider">{row.provider}</Row>
          <Row label="Account">{row.profile || 'default'}</Row>
          <Row label="Route">{row.routeKind || 'direct'}</Row>
          {row.refusedBucket ? <Row label="Refused on">{row.refusedBucket.replaceAll('_', ' ')}</Row> : null}
          {row.chain.length > 1 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {row.chain.map((hop, index) => (
                <span key={index} className="flex items-center gap-1">
                  {index ? <ArrowRight className="size-3 text-muted" /> : null}
                  <Pill tone={hop.ok ? 'green' : 'red'} title={[hop.error || (hop.status ? `status ${hop.status}` : ''), hop.refusedBucket].filter(Boolean).join(' · ')}>{hop.profile} {hop.ok ? '✓' : '✗'}</Pill>
                </span>
              ))}
            </div>
          ) : null}
        </Section>

        <Section title="Identifiers">
          <Row label="Request" mono>{row.id}</Row>
          {row.sessionId ? <Row label="SDK session" mono>{row.sessionId}</Row> : null}
          {row.routeGroupId ? <Row label="Route group" mono>{row.routeGroupId}</Row> : null}
          {row.source ? <Row label="Source" mono>{row.source}</Row> : null}
          {row.requestModel ? <Row label="Requested model" mono>{row.requestModel}</Row> : null}
          <Row label="Prompt">{fmtTok(row.promptTokens)} tokens</Row>
        </Section>
      </div>
    </aside>
  )
}
