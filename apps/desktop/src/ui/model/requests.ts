/** One normalized shape for /telemetry/requests rows, plus the pure helpers around it. */
import { number, object, rows, text } from '../../core'
import { modelName } from './format'

export interface RouteHopView { profile: string; ok: boolean; status: number | null; error: string; refusedBucket: string }
export interface RequestRow {
  id: string; timestamp: number;
  model: string; longContext: boolean; requestModel: string; mode: string;
  adapter: string; source: string; provider: string; profile: string;
  status: number | null; failed: boolean; error: string; keepalive: boolean;
  cacheHit: number | null;
  inputTokens: number; cacheRead: number; cacheWrite: number; outputTokens: number;
  /** Prompt size: uncached + cache read + cache write. */
  promptTokens: number;
  queueMs: number | null; proxyMs: number | null; ttfbMs: number | null; upstreamMs: number | null; totalMs: number | null;
  sessionQueueMs: number | null; sdkQueueMs: number | null;
  lineage: string; isResume: boolean; messageCount: number | null; toolCount: number | null;
  deferredTools: number | null; discoveredTools: string[];
  sessionId: string; routeKind: string; routeGroupId: string; refusedBucket: string;
  chain: RouteHopView[]; envelope: string[];
  raw: Record<string, unknown>;
}

const nullable = (value: unknown) => number(value) ?? null

export function requestRow(raw: Record<string, unknown>): RequestRow {
  const { name, longContext } = modelName(raw.model)
  const input = number(raw.inputTokens) ?? 0, read = number(raw.cacheReadInputTokens) ?? 0, write = number(raw.cacheCreationInputTokens) ?? 0
  const status = nullable(raw.status)
  const error = text(raw.error)
  const keepalive = text(raw.requestSource) === 'cache-keepalive'
  return {
    id: text(raw.requestId), timestamp: number(raw.timestamp) ?? 0,
    model: name, longContext, requestModel: text(raw.requestModel), mode: text(raw.mode),
    adapter: text(raw.adapter), source: text(raw.requestSource), provider: text(raw.provider) || 'claude', profile: text(raw.profileId),
    status, error, keepalive,
    // A keepalive beat that never reached upstream was skipped, not failed.
    failed: !keepalive && (error !== '' || (status ?? 0) >= 400),
    cacheHit: nullable(raw.cacheHitRate),
    inputTokens: input, cacheRead: read, cacheWrite: write, outputTokens: number(raw.outputTokens) ?? 0, promptTokens: input + read + write,
    queueMs: nullable(raw.queueWaitMs), proxyMs: nullable(raw.proxyOverheadMs), ttfbMs: nullable(raw.ttfbMs), upstreamMs: nullable(raw.upstreamDurationMs), totalMs: nullable(raw.totalDurationMs),
    sessionQueueMs: nullable(raw.sessionQueueWaitMs), sdkQueueMs: nullable(raw.sdkQueueWaitMs),
    lineage: text(raw.lineageType), isResume: raw.isResume === true, messageCount: nullable(raw.messageCount), toolCount: nullable(raw.toolCount),
    deferredTools: nullable(raw.deferredToolCount), discoveredTools: Array.isArray(raw.discoveredTools) ? raw.discoveredTools.map(text).filter(Boolean) : [],
    sessionId: text(raw.sdkSessionId), routeKind: text(raw.routeKind), routeGroupId: text(raw.routeGroupId), refusedBucket: text(raw.routeRefusedBucket),
    chain: rows(raw.routeChain).map(hop => ({ profile: text(hop.profileId) || 'default', ok: hop.ok === true, status: nullable(hop.status), error: text(hop.error), refusedBucket: text(hop.refusedBucket) })),
    envelope: Array.isArray(raw.envelopeViolations) ? raw.envelopeViolations.map(text).filter(Boolean) : [],
    raw,
  }
}

/** Newest first. */
export function requestRows(value: unknown): RequestRow[] {
  return rows(value).map(requestRow).filter(row => row.id || row.timestamp).sort((a, b) => b.timestamp - a.timestamp)
}

export interface Pricing { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }
/** Effective rates from GET /settings/api/pricing: overrides win over built-ins. */
export function pricingTable(value: unknown): Record<string, Pricing> {
  const body = object(value)
  const table: Record<string, Pricing> = {}
  for (const source of [object(body.builtin), object(body.overrides)]) {
    for (const [model, raw] of Object.entries(source)) {
      const rates = object(raw)
      const input = number(rates.inputPerMTok), output = number(rates.outputPerMTok)
      if (input === undefined || output === undefined) continue
      table[model] = { inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: number(rates.cacheReadPerMTok) ?? input * 0.1, cacheWritePerMTok: number(rates.cacheWritePerMTok) ?? input * 1.25 }
    }
  }
  return table
}
export function ratesFor(table: Record<string, Pricing>, ...models: string[]): Pricing | undefined {
  for (const model of models) if (model && table[model]) return table[model]
  return undefined
}
/** API-equivalent list price of one request, null when its model has no price. Base rates only. */
export function requestCost(row: RequestRow, table: Record<string, Pricing>): number | null {
  const rates = ratesFor(table, row.requestModel, row.raw.model === undefined ? '' : text(row.raw.model), row.model)
  if (!rates) return null
  return (row.inputTokens * rates.inputPerMTok + row.outputTokens * rates.outputPerMTok + row.cacheRead * rates.cacheReadPerMTok + row.cacheWrite * rates.cacheWritePerMTok) / 1e6
}

export interface WaterfallSegment { key: 'queue' | 'proxy' | 'first-token' | 'generation'; label: string; ms: number }
/** Total = queue + proxy + upstream; upstream splits into waiting for the first token and generating. */
export function waterfall(row: RequestRow): WaterfallSegment[] {
  const upstream = row.upstreamMs ?? Math.max(0, (row.totalMs ?? 0) - (row.queueMs ?? 0) - (row.proxyMs ?? 0))
  const first = row.ttfbMs === null ? upstream : Math.min(row.ttfbMs, upstream)
  return [
    { key: 'queue', label: 'Queue', ms: row.queueMs ?? 0 },
    { key: 'proxy', label: 'Proxy', ms: row.proxyMs ?? 0 },
    { key: 'first-token', label: row.ttfbMs === null ? 'Upstream (no first token)' : 'Waiting for first token', ms: first },
    { key: 'generation', label: 'Generating', ms: Math.max(0, upstream - first) },
  ]
}
