/** One normalized shape for /telemetry/requests rows, plus the pure helpers around it. */
import { number, object, rows, text } from '../../core'
import { modelName } from './format'
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, estimateRequestCostUsd, normalizeModelKey, resolveRequestPricing, type ModelPricing } from '../../../../../src/telemetry/pricing'

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

/** User pricing overrides keyed by normalized model, as computeCostEstimate takes them. */
export type PricingOverrides = Record<string, ModelPricing>
/**
 * The overrides from GET /settings/api/pricing, validated as pricingStore
 * validates them. Built-in rates (and their long-context tiers) come from the
 * bundled src/telemetry/pricing, not the response, so a request is valued the
 * way the server's computeCostEstimate values it.
 */
export function pricingTable(value: unknown): PricingOverrides {
  const overrides: PricingOverrides = {}
  for (const [model, raw] of Object.entries(object(object(value).overrides))) {
    const rates = object(raw)
    const input = rate(rates.inputPerMTok), output = rate(rates.outputPerMTok)
    if (input === undefined || output === undefined) continue
    overrides[normalizeModelKey(model)] = { inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: rate(rates.cacheReadPerMTok) ?? input * CACHE_READ_MULTIPLIER, cacheWritePerMTok: rate(rates.cacheWritePerMTok) ?? input * CACHE_WRITE_MULTIPLIER }
  }
  return overrides
}
const rate = (value: unknown) => { const n = number(value); return n !== undefined && n >= 0 ? n : undefined }

/**
 * API-equivalent list price of one request, null when its model has no price
 * (the server counts those as unpriced, never $0). Same resolution as the
 * server: request-key override, recorded SDK pin, family fallback, GPT suffix
 * stripping, Haiku and long-context tiers.
 */
export function requestCost(row: RequestRow, overrides: PricingOverrides): number | null {
  const pricing = resolveRequestPricing({ model: text(row.raw.model), requestModel: row.requestModel || undefined, resolvedModel: text(row.raw.resolvedModel) || undefined }, overrides)
  if (!pricing) return null
  return estimateRequestCostUsd({ inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadInputTokens: row.cacheRead, cacheCreationInputTokens: row.cacheWrite }, pricing)
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
