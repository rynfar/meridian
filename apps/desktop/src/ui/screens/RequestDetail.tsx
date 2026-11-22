import { useEffect, useRef } from 'react'
import { ArrowRight, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { Label, Swatch } from '../components/card'
import { Glyph } from '../components/glyph'
import { PromptRibbon } from '../components/ribbon'
import { fmtInt, fmtTok, ms, pct, usd, when } from '../model/format'
import { failureCause } from '../model/failures'
import { waterfall, type RequestRow } from '../model/requests'
import { failureText } from '../model/today'

// Timing reads from light to dark: waiting is quiet, generating is the work.
const segmentClass = { queue: 'bg-fresh', proxy: 'bg-t4', 'first-token': 'bg-t3', generation: 'bg-t2' } as const

function Row({ label, children, mono, swatch }: { label: string; children: ReactNode; mono?: boolean; swatch?: string }) {
  return (
    <div className="flex h-[22px] items-center justify-between gap-3 text-base">
      <span className="flex shrink-0 items-center gap-1.5 text-t3">{swatch ? <Swatch className={swatch} /> : null}{label}</span>
      <span className={cn('num min-w-0 truncate text-right text-t1', mono && 'selectable font-mono text-xs text-t2')} title={typeof children === 'string' ? children : undefined}>{children}</span>
    </div>
  )
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-5"><Label className="mb-1.5">{title}</Label>{children}</section>
}

/** Per-request detail as a raised side panel: timing, the prompt ribbon, lineage, routing chain and ids. */
export function RequestDetail({ row, cost, now, onClose, note }: { row: RequestRow; cost: number | null; now: number; onClose(): void; note?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Keyboard users land in the panel when it opens and return to where they were when it closes.
  const panel = useRef<HTMLElement>(null)
  // The opener is captured once, when the panel opens; switching rows keeps it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { if (opener && opener !== document.body && document.contains(opener)) opener.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => { panel.current?.focus({ preventScroll: true }) }, [row.id])
  const segments = waterfall(row)
  const total = Math.max(1, segments.reduce((sum, segment) => sum + segment.ms, 0))
  return (
    <aside ref={panel} tabIndex={-1} aria-label="Request detail" className="pop outline-none absolute bottom-2.5 right-2.5 top-2.5 z-20 flex w-[392px] animate-pop flex-col rounded-xl bg-surface">
      <div className="flex items-start gap-2 px-4 pb-1 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-md font-semibold tracking-title text-t1">
            <span>{row.model}{row.longContext ? <sup className="ml-[3px] text-3xs font-semibold text-t3">1M</sup> : null}</span>
            <span className={cn('num text-meta font-medium', row.failed ? 'text-red' : 'text-t3')}>{row.failed ? failureText(row) : row.status ?? ''}</span>
          </div>
          <div className="num mt-0.5 text-meta text-t3">{when(row.timestamp, now)} · {[row.adapter || row.source, row.profile].filter(Boolean).join(' · ')}</div>
          {note ? <div className="mt-0.5 text-xs text-t3">{note}</div> : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close detail" onClick={onClose}><X /></Button>
      </div>
      <div className="scroll-y min-h-0 flex-1 px-4 pb-4">
        {row.failed ? (
          <div className="mt-3 flex items-start gap-2 text-cap">
            <Glyph kind="bad" className="mt-[3px]" />
            <div className="min-w-0"><div className="font-medium text-red">{failureCause(row)}</div>{row.error ? <div className="selectable mt-0.5 break-words font-mono text-xs text-t2">{row.error}</div> : null}</div>
          </div>
        ) : null}
        {row.envelope.length ? <div className="mt-2 flex items-start gap-2 text-cap text-red"><Glyph kind="bad" className="mt-[3px]" />Response integrity: {row.envelope.join(', ')}</div> : null}

        <Section title="Prompt">
          <div className="flex items-center gap-3">
            <PromptRibbon tokens={{ read: row.cacheRead, write: row.cacheWrite, fresh: row.inputTokens }} size="hero" className="flex-1" />
            <span className="num text-md font-semibold text-cache">{pct(row.cacheHit)}</span>
          </div>
          <div className="mt-2">
            <Row label="Cache read" swatch="bg-cache">{fmtInt(row.cacheRead)}</Row>
            <Row label="Cache write" swatch="bg-cache-write">{fmtInt(row.cacheWrite)}</Row>
            <Row label="Fresh input" swatch="bg-fresh">{fmtInt(row.inputTokens)}</Row>
            <Row label="Output">{fmtInt(row.outputTokens)}</Row>
            <Row label="API-equivalent">{cost === null ? 'no price for this model' : usd(cost)}</Row>
          </div>
        </Section>

        <Section title="Timing">
          <div className="flex h-1.5 gap-px overflow-hidden rounded-sm bg-well">
            {segments.map(segment => segment.ms > 0 ? <i key={segment.key} title={`${segment.label} ${ms(segment.ms)}`} className={cn('block', segmentClass[segment.key])} style={{ flexGrow: segment.ms / total, flexBasis: 0, minWidth: 2 }} /> : null)}
          </div>
          <div className="mt-2">
            {segments.map(segment => <Row key={segment.key} label={segment.label.replace('Waiting for first token', 'First token')} swatch={segmentClass[segment.key]}>{ms(segment.ms)}</Row>)}
            <Row label="Total">{ms(row.totalMs)}</Row>
            {row.sessionQueueMs || row.sdkQueueMs ? <Row label="Queue split">session {ms(row.sessionQueueMs)} · SDK {ms(row.sdkQueueMs)}</Row> : null}
          </div>
        </Section>

        <Section title="Conversation">
          <Row label="Lineage">{row.lineage || '—'}</Row>
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
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-base">
              {row.chain.map((hop, index) => (
                <span key={index} className="flex items-center gap-1.5" title={[hop.error || (hop.status ? `status ${hop.status}` : ''), hop.refusedBucket].filter(Boolean).join(' · ')}>
                  {index ? <ArrowRight className="size-3 text-t4" /> : null}
                  <span className="text-t1">{hop.profile}</span><Glyph kind={hop.ok ? 'ok' : 'bad'} className="size-3" />
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
