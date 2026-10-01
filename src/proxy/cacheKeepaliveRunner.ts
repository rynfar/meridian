/**
 * Runs one prompt-cache keepalive against a session's published transcript.
 *
 * `cacheKeepalive.ts` decides when; this module sends the request. It resumes
 * the mapping's current transcript exactly as the next turn would, so the
 * upstream prefix is byte-identical, then appends a short prompt. The fork is
 * never persisted (`persistSession: false`), so there is no transcript to
 * journal, publish or collect; the source is only read, and the caller pins it
 * against GC while that happens. Only `message_start` is needed: the cache is
 * refreshed when the request is received, and its usage reports the cache
 * read. Stopping there also keeps the model from generating a reply.
 */

import { randomUUID } from "node:crypto"
import { query, type Options } from "@anthropic-ai/claude-agent-sdk"
import { claudeLog } from "../logger"
import { telemetryStore } from "../telemetry"
import {
  CACHE_KEEPALIVE_MAX_PENDING_TOOL_CALLS,
  CACHE_KEEPALIVE_PROMPT,
  CACHE_KEEPALIVE_SOURCE,
  CACHE_KEEPALIVE_TIMEOUT_MS,
} from "./cacheKeepalive"
import type { SemaphoreLease } from "./concurrency"
import { rateLimitStore } from "./rateLimitStore"
import type { TokenUsage } from "./session/lineage"
import type { TranscriptLocator } from "./sessionLifecycle"
import { lookupSharedSessionResult } from "./sessionStore"
import { computeCacheHitRate } from "./tokenUsage"

/** What a keepalive needs to repeat a session's latest upstream request shape. */
export interface CacheKeepaliveRecipe {
  /** Durable mapping key; each keepalive resumes its current SDK session. */
  mappingKey: string
  /** Options of the latest upstream request, without per-attempt fields. */
  options: Options
  /** A private copy of the passthrough MCP server. The session's cached
   *  instance may be connected to a live turn, and one instance cannot serve
   *  two queries at once. */
  createMcpServers: () => NonNullable<Options["mcpServers"]>
  adapterName: string
  profileId: string
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

/** The SDK session the recipe's mapping currently resumes, if any. */
export function currentCacheKeepaliveSessionId(recipe: CacheKeepaliveRecipe): string | undefined {
  const mapping = lookupSharedSessionResult(recipe.mappingKey)
  return mapping.status === "found" ? mapping.session.claudeSessionId : undefined
}

export interface CacheKeepaliveRunnerDeps {
  /** The SDK subprocess budget shared with client requests. */
  semaphore: { acquire(signal: AbortSignal): Promise<SemaphoreLease> }
  /** Keep a transcript from GC until the returned release is called. */
  pinTranscript: (locator: TranscriptLocator) => () => void
  isDraining: () => boolean
}

export function createCacheKeepaliveRunner(deps: CacheKeepaliveRunnerDeps) {
  return async (recipe: CacheKeepaliveRecipe, sessionId: string, signal: AbortSignal): Promise<boolean> => {
    if (deps.isDraining()) return false
    const mapping = lookupSharedSessionResult(recipe.mappingKey)
    const session = mapping.status === "found" && mapping.session.claudeSessionId === sessionId
      ? mapping.session
      : undefined
    const source = session?.currentTranscript?.sessionId === sessionId ? session.currentTranscript : undefined
    // The SDK finds the transcript under the project of the request's cwd.
    if (!source || (source.projectDir && source.projectDir !== recipe.options.cwd)) return false
    // At a tool checkpoint the transcript ends with each call and its denial,
    // all after the cached prefix. Anthropic looks back only about 20 blocks
    // for a cache hit, so a wide batch would rewrite the prefix, not refresh it.
    if ((session?.passthroughToolCallIds?.length ?? 0) > CACHE_KEEPALIVE_MAX_PENDING_TOOL_CALLS) return false

    const startedAt = Date.now()
    const abort = new AbortController()
    const stop = (): void => abort.abort(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    const timeout = setTimeout(() => abort.abort(new Error("Cache keepalive timed out")), CACHE_KEEPALIVE_TIMEOUT_MS)
    timeout.unref?.()
    const releasePin = deps.pinTranscript(source)
    let usage: TokenUsage | undefined
    let error: string | null = null
    let sdkWaitedMs = 0
    let sdkStartedAt: number | undefined
    let ttfbMs: number | null = null
    try {
      const lease = await deps.semaphore.acquire(abort.signal)
      sdkWaitedMs = lease.waitedMs
      sdkStartedAt = Date.now()
      let sdkQuery: ReturnType<typeof query> | undefined
      try {
        sdkQuery = query({
          prompt: CACHE_KEEPALIVE_PROMPT,
          options: {
            ...recipe.options,
            // A transcript near the context limit must not turn a keepalive
            // into a summarization request; the next real turn decides that.
            env: { ...recipe.options.env, DISABLE_AUTO_COMPACT: "1" },
            mcpServers: recipe.createMcpServers(),
            abortController: abort,
            resume: sessionId,
            forkSession: true,
            persistSession: false,
            maxTurns: 1,
            includePartialMessages: true,
          },
        })
        for await (const message of sdkQuery) {
          if (message.type === "rate_limit_event") {
            rateLimitStore.record(recipe.profileId, message.rate_limit_info)
          } else if (message.type === "stream_event" && message.event.type === "message_start") {
            usage = message.event.message.usage as TokenUsage
            ttfbMs = Date.now() - sdkStartedAt
            break
          } else if (message.type === "result") {
            break
          }
        }
        if (!usage) error = "Cache keepalive ended before message_start"
      } finally {
        if (typeof sdkQuery?.close === "function") sdkQuery.close()
        lease.release()
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", stop)
      releasePin()
    }

    const finishedAt = Date.now()
    const upstreamDurationMs = sdkStartedAt === undefined ? 0 : finishedAt - sdkStartedAt
    claudeLog("cache_keepalive.sent", {
      sessionId,
      reached: usage !== undefined,
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
      status: usage ? 200 : 500,
      queueWaitMs: sdkWaitedMs,
      sdkQueueWaitMs: sdkWaitedMs,
      proxyOverheadMs: Math.max(0, finishedAt - startedAt - sdkWaitedMs - upstreamDurationMs),
      ttfbMs,
      upstreamDurationMs,
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
    return usage !== undefined
  }
}
