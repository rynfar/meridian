/**
 * Runs one prompt-cache keepalive beat against a session's published transcript.
 *
 * `cacheKeepalive.ts` decides when; this module sends the request. It resumes
 * the mapping's current transcript exactly as the next turn would, so the
 * upstream prefix is byte-identical, then appends a short prompt. The fork is
 * never persisted (`persistSession: false`), so there is no transcript to
 * journal, publish or collect; the source is only read, and it stays pinned
 * against GC until the SDK child has been joined. Only `message_start` is
 * needed: the cache is refreshed when the request is received, and its usage
 * reports the cache read. Stopping there also keeps the model from generating
 * a reply.
 *
 * The query itself runs through the server's gated, joined SDK path, so
 * shutdown waits for it like any other query and no CLI child outlives it.
 */

import { randomUUID } from "node:crypto"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeLog } from "../logger"
import { telemetryStore } from "../telemetry"
import {
  CACHE_KEEPALIVE_MAX_PENDING_TOOL_CALLS,
  CACHE_KEEPALIVE_PROMPT,
  CACHE_KEEPALIVE_SOURCE,
  CACHE_KEEPALIVE_TIMEOUT_MS,
  classifyCacheTier,
  type CacheKeepaliveBeatOutcome,
  type CacheTierUsage,
} from "./cacheKeepalive"
import type { SemaphoreLease } from "./concurrency"
import { rateLimitStore } from "./rateLimitStore"
import type { TokenUsage } from "./session/lineage"
import type { TranscriptLocator } from "./sessionLifecycle"
import { lookupSharedSessionResult } from "./sessionStore"
import { computeCacheHitRate } from "./tokenUsage"

/** What a beat needs to repeat a session's latest real request shape. */
export interface CacheKeepaliveRecipe {
  /** Durable mapping key; each beat resumes its current SDK session. */
  mappingKey: string
  /** Options of the latest real request, without per-attempt fields. */
  options: Options
  /** A private MCP server for the beat. A server instance takes one
   *  transport connection, and the session's next turn builds its own. */
  createMcpServers: () => NonNullable<Options["mcpServers"]>
  adapterName: string
  /** The account the mapping was published under. Beats never fail over. */
  profileId: string
  profileType: string
  /** Session key the [1m] bench is scoped to, when the client has one. */
  benchSessionKey?: string
  /** The turn ran on a [1m] model; a bench would move the next turn off it. */
  extendedContext: boolean
  model: string
  requestModel?: string
}

/** Keep only the request shape: everything else belongs to one attempt. */
export function cacheKeepaliveOptions(options: Options): Options {
  const {
    abortController, hooks, stderr, spawnClaudeCodeProcess, mcpServers,
    resume, resumeSessionAt, forkSession, sessionId, ...shape
  } = options
  return shape
}

/** The cache fields of one SDK message's usage, when it carries any. */
export function cacheTierUsageOf(message: SDKMessage): CacheTierUsage | undefined {
  if (message.type === "stream_event" && message.event.type === "message_start") return message.event.message.usage
  if (message.type === "assistant") return message.message.usage
  if (message.type === "result") return message.usage
  return undefined
}

/** The SDK session the recipe's mapping currently resumes, if any. */
export function currentCacheKeepaliveSessionId(recipe: CacheKeepaliveRecipe): string | undefined {
  const mapping = lookupSharedSessionResult(recipe.mappingKey)
  return mapping.status === "found" ? mapping.session.claudeSessionId : undefined
}

export interface CacheKeepaliveRunnerDeps {
  /** Take an SDK permit now, or not at all. A beat never queues for one. */
  tryAcquirePermit: () => SemaphoreLease | undefined
  /**
   * Run the query on the server's gated SDK path: process gate, close and
   * join before the generator finishes. The permit is the one taken above.
   */
  runQuery: (
    params: { prompt: string; options: Options },
    signal: AbortSignal,
    lease: SemaphoreLease,
  ) => AsyncGenerator<SDKMessage>
  /** Keep a transcript from GC until the returned release is called. */
  pinTranscript: (locator: TranscriptLocator) => () => void
  isDraining: () => boolean
  /** Why the account may not be used for a beat now, if it may not. */
  accountBlock: (recipe: CacheKeepaliveRecipe) => string | undefined
}

type BeatUsage = TokenUsage & CacheTierUsage

export function createCacheKeepaliveRunner(deps: CacheKeepaliveRunnerDeps) {
  return async (recipe: CacheKeepaliveRecipe, sessionId: string, signal: AbortSignal): Promise<CacheKeepaliveBeatOutcome> => {
    const skip = (reason: string, outcome: CacheKeepaliveBeatOutcome): CacheKeepaliveBeatOutcome => {
      claudeLog("cache_keepalive.skipped", { sessionId, profile: recipe.profileId, reason })
      return outcome
    }
    if (deps.isDraining() || signal.aborted) return skip("draining", "retry")
    const mapping = lookupSharedSessionResult(recipe.mappingKey)
    if (mapping.status === "error") return skip("mapping-unreadable", "retry")
    const session = mapping.status === "found" && mapping.session.claudeSessionId === sessionId
      ? mapping.session
      : undefined
    const source = session?.currentTranscript?.sessionId === sessionId ? session.currentTranscript : undefined
    // The SDK finds the transcript under the project of the request's cwd.
    if (!source || (source.projectDir && source.projectDir !== recipe.options.cwd)) return skip("mapping-moved", "stop")
    // At a tool checkpoint the transcript ends with each call and its denial,
    // all after the cached prefix. Anthropic looks back only about 20 blocks
    // for a cache hit, so a wide batch would rewrite the prefix, not refresh it.
    if ((session?.passthroughToolCallIds?.length ?? 0) > CACHE_KEEPALIVE_MAX_PENDING_TOOL_CALLS) {
      return skip("pending-tool-calls", "stop")
    }
    const blocked = deps.accountBlock(recipe)
    if (blocked) return skip(blocked, "retry")

    const abort = new AbortController()
    // Built before the permit is taken: nothing may throw between taking it
    // and handing it to the gated query, which releases it.
    const params = {
      prompt: CACHE_KEEPALIVE_PROMPT,
      options: {
        ...recipe.options,
        // A transcript near the context limit must not turn a beat into a
        // summarization request; the next real turn decides that.
        env: { ...recipe.options.env, DISABLE_AUTO_COMPACT: "1" },
        mcpServers: recipe.createMcpServers(),
        abortController: abort,
        resume: sessionId,
        forkSession: true,
        persistSession: false,
        maxTurns: 1,
        includePartialMessages: true,
      },
    }
    // Pin before taking the permit: nothing may throw between taking it and
    // handing it to the gated query, which releases it.
    let releasePin: () => void
    try {
      releasePin = deps.pinTranscript(source)
    } catch {
      return skip("transcript-unpinnable", "stop")
    }
    const lease = deps.tryAcquirePermit()
    if (!lease) {
      releasePin()
      return skip("no-free-permit", "retry")
    }

    const startedAt = Date.now()
    const stop = (): void => abort.abort(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    const timeout = setTimeout(() => abort.abort(new Error("Cache keepalive timed out")), CACHE_KEEPALIVE_TIMEOUT_MS)
    timeout.unref?.()
    let usage: BeatUsage | undefined
    let error: string | null = null
    let ttfbMs: number | null = null
    try {
      const messages = deps.runQuery(params, abort.signal, lease)
      for await (const message of messages) {
        if (message.type === "rate_limit_event") {
          rateLimitStore.record(recipe.profileId, message.rate_limit_info)
        } else if (message.type === "stream_event" && message.event.type === "message_start") {
          usage = message.event.message.usage as BeatUsage
          ttfbMs = Date.now() - startedAt
          break
        } else if (message.type === "result") {
          break
        }
      }
      if (!usage) error = "Cache keepalive ended before message_start"
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      // The generator has returned, so its SDK child is joined and the
      // permit released; only now may the source become collectible.
      clearTimeout(timeout)
      signal.removeEventListener("abort", stop)
      releasePin()
    }

    const finishedAt = Date.now()
    const reached = usage !== undefined
    // A beat that found the cache gone rewrote the prefix; a five-minute
    // write means the session is not on the one-hour tier after all.
    const tier = classifyCacheTier(usage)
    const coldOrShortLived = reached && ((usage?.cache_read_input_tokens ?? 0) === 0 || tier === "5m")
    claudeLog("cache_keepalive.sent", {
      sessionId,
      profile: recipe.profileId,
      reached,
      cacheReadInputTokens: usage?.cache_read_input_tokens,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      ...(error ? { error } : {}),
    })
    telemetryStore.record({
      requestId: randomUUID(),
      timestamp: finishedAt,
      adapter: recipe.adapterName,
      requestSource: CACHE_KEEPALIVE_SOURCE,
      profileId: recipe.profileId,
      model: recipe.model,
      requestModel: recipe.requestModel,
      mode: "stream",
      isResume: true,
      isPassthrough: true,
      sdkSessionId: sessionId,
      // No client is answered. A beat that did not reach upstream is a
      // skipped refresh, not a failed request, so it carries no error status.
      status: reached ? 200 : 0,
      queueWaitMs: 0,
      sdkQueueWaitMs: 0,
      proxyOverheadMs: 0,
      ttfbMs,
      upstreamDurationMs: finishedAt - startedAt,
      totalDurationMs: finishedAt - startedAt,
      contentBlocks: 0,
      textEvents: 0,
      error,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheReadInputTokens: usage?.cache_read_input_tokens,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      cacheHitRate: computeCacheHitRate(usage),
    })
    if (!reached) return "retry"
    return coldOrShortLived ? "stop" : "reached"
  }
}
