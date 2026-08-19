import { Hono } from "hono"
import { cors } from "hono/cors"
import { stream } from "hono/streaming"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { rateLimitStore } from "./rateLimitStore"
import { guardUpstreamIdle, UpstreamIdleError } from "./streamIdleGuard"
import { linkRequestAbort } from "./requestAbort"
import { AbortableSemaphore, getProcessSdkSemaphore, type SemaphoreLease } from "./concurrency"
import { closeServerWithGracePeriod, trackServerConnections } from "./shutdown"
import { fetchOAuthUsage, fetchOAuthUsageResult } from "./oauthUsage"
import { resolveSdkWorkingDirectory } from "./cwd"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { env, envBool, envInt } from "../env"
import type { ProxyConfig, ProxyInstance, ProxyServer } from "./types"
export type { ProxyConfig, ProxyInstance, ProxyServer }
// Public plugin-authoring types. Plugins import these to type their
// onRequest / onResponse / onTelemetry hooks against.
export type {
  Transform,
  RequestContext,
  ResponseContext,
  TelemetryContext,
  SessionContext,
  ToolUseContext,
  ToolResultContext,
  ErrorContext,
  TransformHook,
  ObserveHook,
} from "./transform"
// Public plugin-authoring runtime helpers. Plugin authors typically don't
// need these (just call your onRequest function directly in tests), but
// they're exposed for integration-style tests that want to chain multiple
// transforms through the same runner meridian uses internally.
export { runTransformHook, runObserveHook, buildPipeline, createRequestContext } from "./transform"
import { claudeLog } from "../logger"
import { exec as execCallback } from "child_process"
import { promisify } from "util"
import { randomUUID } from "crypto"
import { withClaudeLogContext } from "../logger"
import { createPassthroughMcpServer, stripMcpPrefix, normalizeToolInput, computeToolSetKey, toolUseSignature, PASSTHROUGH_MCP_NAME, PASSTHROUGH_MCP_PREFIX } from "./passthroughTools"
import { detectServerTools, serverToolErrorMessage } from "./tools"
import { clientAbortDisposition, createEarlyStopTracker, isCompleteToolResultContinuation, noteAssistantMessage, noteUserContent, settledToolCallAssistantUuid, shouldEarlyStop } from "./passthroughEarlyStop"
import { checkEmptyToolInputs, checkUndeliveredToolUses, type EnvelopeViolation } from "./envelopeIntegrity"
import { classifyTurnOutcome, createRecoveryLifter, shouldAttemptRecovery, shouldInjectSilentTurn, SILENT_TURN_NUDGE } from "./turnOutcome"
import { resolveAgentAlias } from "./agentMatch"
import { LRUMap } from "../utils/lruMap"

import { telemetryStore, diagnosticLog, createTelemetryRoutes, landingHtml, renderPrometheusMetrics } from "../telemetry"
import type { RequestMetric } from "../telemetry"
import { canRecoverCapturedToolUses, classifyError, extractSdkTermination, formatSdkTermination, classifyResumeRefusal, isRateLimitError, isExtraUsageRequiredError, isExpiredTokenError, isAccountFailoverError, isQuotaRefusal } from "./errors"
import { refreshOAuthToken, ensureFreshToken, startBackgroundRefresh, stopBackgroundRefresh, createPlatformCredentialStore, getAuthRenewalStatus, resolveRenewalWarnDays, type CredentialStore } from "./tokenRefresh"
import {
  createFileDesignTokenStore,
  createDesignLogin,
  getDesignAccessToken,
  resolveDesignAuthHeaders,
  buildDesignForwardHeaders,
  filterUpstreamResponseHeaders,
  isDesignAuthFailure,
  DESIGN_UPSTREAM_ORIGIN,
} from "./design"
import { checkPluginConfigured, notePluginlessOpenCodeRequest } from "./setup"
import { mapModelToClaudeModel, resolveClaudeExecutableAsync, resolveSdkModelDefaults, explicitModelPin, CANONICAL_SONNET_MODEL, isClosedControllerError, getClaudeAuthStatusAsync, getAuthCacheInfo, getResolvedClaudeExecutableInfo, hasExtendedContext, stripExtendedContext, recordExtendedContextUnavailable, subscriptionIncludesExtendedContext } from "./models"
import type { AnthropicSseEvent } from "./openai"
import { translateOpenAiToAnthropic, translateAnthropicToOpenAi, buildModelList, createSseTranslator } from "./openai"
import { normalizeJcodeSessionId } from "./adapters/jcode"
import { translateResponsesToAnthropic, translateAnthropicToResponses, createResponsesSseTranslator, reasoningRequested, type ResponsesRequest, type AnthropicSseEvent as ResponsesAnthropicSseEvent } from "./openaiResponses"
import { extractAdvisorModel, extractSystemText, getLastUserMessage, stripAdvisorTools, stripNonStandardStreamFields, consolidateMultimodalOntoLastUser, MULTIMODAL_TYPES, buildToolUseIndex, describeToolCall, frameReplayTurns } from "./messages"
import { requireAuth, authEnabled } from "./auth"
import { detectAdapter } from "./adapters/detect"
import { buildQueryOptions, type QueryContext } from "./query"
import { normalizeEffort } from "./effort"
import { parseOutputFormat, structuredOutputText } from "./structuredOutput"
import { runTransformHook, buildPipeline, createRequestContext } from "./transform"
import { getAdapterTransforms } from "./transforms/registry"
import { loadPlugins, getActiveTransforms } from "./plugins/loader"
import type { LoadedPlugin } from "./plugins/types"
import { resolveProfile, listProfiles, setActiveProfile, getActiveProfileId, getEffectiveProfiles, restoreActiveProfile, type ResolvedProfile } from "./profiles"
import { getRoutingMode, resolvePriorityOrder, choosePriorityProfile, ProfileExhaustion, AssignmentStore, resolveCooldownUntil } from "./routing"
import { getSetting, setSetting } from "./settings"
import { filterBetasForProfile, getBetaPolicyFromEnv } from "./betas"
import { createFileChangeHook, extractFileChangesFromMessages, formatFileChangeSummary, type FileChange } from "./fileChanges"
import { detectTokenAnomalies, formatAnomalyAlerts, type TokenSnapshot } from "./tokenHealth"
import { computeCacheHitRate, formatUsageSummary } from "./tokenUsage"
import { sanitizeTextContent, sanitizeAssistantText } from "./sanitize"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  normalizeContextUsage,
  withClientAssistantUuid,
  type LineageResult,
  type TokenUsageIteration,
  type TokenUsage,
} from "./session/lineage"
import { getPriorityAssignmentKey } from "./session/fingerprint"
// Re-export for backwards compatibility (existing tests import from here)

import { lookupSession, storeSession, clearSessionCache, getMaxSessionsLimit, evictSession, getSessionByClaudeId } from "./session/cache"
import { processSessionTurns, type SessionTurnLease } from "./session/turnCoordinator"
import { lookupSessionRecovery, listStoredSessions } from "./sessionStore"
// Re-export for backwards compatibility (existing tests import from here)
export { computeLineageHash, hashMessage, computeMessageHashes }
export { clearSessionCache, getMaxSessionsLimit }
export type { LineageResult }











const exec = promisify(execCallback)

let claudeExecutable = ""

// Max gap between real upstream messages before we treat the stream as stalled.
// Must be > slowest legitimate TTFB / server-side thinking pause, and < the
// "feels dead" threshold. Pylon's turn watchdog (120s warn / 180s abort) is the
// looser backstop, so this fires first.
//
// Overridable via MERIDIAN_UPSTREAM_IDLE_MS because the 90s default is not
// always above the "slowest legitimate thinking pause" it assumes: a deep
// agentic turn that reasons for a long stretch before emitting anything gets
// killed mid-turn, and the kill reaches the client as a finished-but-empty
// message (termination reason is `unknown`, so the tool_use recovery path
// cannot fire). The default is left at 90s so upstream behaviour is unchanged;
// keep any override BELOW Pylon's STALL_ABORT_MS (180s), or the two layers race
// to abort the same hung model — see the coordination contract in
// streamIdleGuard.ts.
const UPSTREAM_IDLE_MS = envInt("UPSTREAM_IDLE_MS", 90_000)

// Bounds how long ProxyInstance.close() waits for in-flight /v1/messages
// requests to finish (after beginDrain() stops admitting new ones) before it
// closes the HTTP server anyway. Plugins that already call close() for
// graceful shutdown (see the Stable API Contract) get this drain for free.
const SHUTDOWN_GRACE_MS = envInt("SHUTDOWN_GRACE_MS", 30_000)

interface RequestMeta {
  requestId: string
  endpoint: string
  queueEnteredAt: number
  sessionQueueWaitMs: number
  sdkQueueWaitMs: number
  sdkActiveDurationMs: number
  /** Start of the SDK attempt currently running — the TTFB anchor. */
  currentSdkStartedAt?: number
  /**
   * Captured against the attempt that actually produced the first chunk, not
   * against the request's first attempt: a fresh-replay or failover retry must
   * not report the abandoned attempt's runtime as time-to-first-byte.
   */
  ttfbMs?: number
  sessionTurnLease?: SessionTurnLease
}

interface HandleMessagesOptions {
  body: any
  forcedProfileId?: string
}

function totalQueueWaitMs(meta: RequestMeta): number {
  return meta.sessionQueueWaitMs + meta.sdkQueueWaitMs
}

/**
 * Derive an independent telemetry identity for one failover candidate.
 *
 * Each candidate is its own upstream attempt: sharing the caller's meta would
 * make every attempt inherit the previous one's accumulated SDK timings, so
 * the surviving row would bill the winner for every account that refused
 * first. The session-turn lease is deliberately shared by reference — the
 * request holds exactly one turn no matter how many accounts it tries.
 *
 * `requestId` is deliberately NOT forked. Both telemetry backends append
 * (SQLite always INSERTs against a non-unique `request_id`; the memory store
 * is a ring buffer), so distinct ids were never needed to keep the rows — and
 * rewriting a caller-supplied `x-request-id` to `<id>.1` silently breaks the
 * client's ability to correlate its own request with the row that served it.
 * Attempts stay distinguishable without it: the served row carries `profileId`
 * plus a 2xx status, the refusals carry the failure in `error`/`status`.
 * (The refusal row does not yet record which profile refused — a pre-existing
 * gap on the error path, unrelated to the id.)
 */
function forkAttemptMeta(meta: RequestMeta, attempt: number): RequestMeta {
  if (attempt === 0) return meta
  return {
    ...meta,
    queueEnteredAt: Date.now(),
    // The wait happened once, before the first attempt; re-reporting it on
    // every row would multiply one queue delay across the whole failover.
    sessionQueueWaitMs: 0,
    sdkQueueWaitMs: 0,
    sdkActiveDurationMs: 0,
    currentSdkStartedAt: undefined,
    ttfbMs: undefined,
  }
}

function credentialStoreForProfile(profile: ResolvedProfile): CredentialStore | undefined {
  if (profile.type !== "claude-max") return undefined
  return createPlatformCredentialStore(
    profile.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: profile.env.CLAUDE_CONFIG_DIR } : undefined
  )
}

async function ensureFreshTokenForProfiles(config: ProxyConfig): Promise<void> {
  const profiles = getEffectiveProfiles(config.profiles)
  if (profiles.length === 0) return

  for (const profile of profiles) {
    const resolved = resolveProfile(config.profiles, config.defaultProfile, profile.id)
    const store = credentialStoreForProfile(resolved)
    if (store) await ensureFreshToken(store).catch(() => {})
  }
}

function hasMultimodalContent(content: any): boolean {
  if (!Array.isArray(content)) return false
  return content.some((block: any) => {
    if (!block || typeof block !== "object") return false
    if (MULTIMODAL_TYPES.has(block.type)) return true
    if (block.type === "tool_result") return hasMultimodalContent(block.content)
    return false
  })
}

function stripCacheControlDeep(content: any): any {
  if (!Array.isArray(content)) return content
  return content.map((block: any) => {
    if (!block || typeof block !== "object") return block
    const { cache_control, ...rest } = block
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return {
        ...rest,
        content: stripCacheControlDeep(block.content),
      }
    }
    return rest
  })
}

function normalizeStructuredUserContent(
  content: any,
  preserveToolResultWrapper = false
): any {
  if (!Array.isArray(content)) return content
  const normalized: any[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (
      !preserveToolResultWrapper &&
      block.type === "tool_result" &&
      Array.isArray(block.content) &&
      hasMultimodalContent(block.content)
    ) {
      normalized.push(...normalizeStructuredUserContent(block.content))
      continue
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      normalized.push({
        ...block,
        content: normalizeStructuredUserContent(block.content, preserveToolResultWrapper),
      })
      continue
    }
    normalized.push(block)
  }
  return normalized
}

/**
 * Flatten an assistant message's content to plain text for replay.
 *
 * Drops tool_use blocks entirely. The SDK already has them from its own
 * session state (on resume) or doesn't need them for text-only replay
 * (on rehydration). Emitting `[Tool Use: name(args)]` strings pollutes
 * the context — the model reads them as literal user input and starts
 * inventing fake tool-call patterns back (issue #111, #386).
 */
function flattenAssistantContent(content: any): string {
  // Strips only branded harness markers — notably Meridian's own "Files
  // changed:" summary, which this server appends to the assistant's last text
  // block and which the client then echoes back for replay (#724). The XML tag
  // allowlist is deliberately NOT applied: assistant text is model output, and
  // a model discussing configuration legitimately writes `<env>` (#720).
  if (typeof content === "string") return sanitizeAssistantText(content)
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((b: any) => (b?.type === "text" && b.text ? sanitizeAssistantText(b.text) : ""))
    .filter(Boolean)
    .join("\n")
}

/**
 * Flatten a user message's content to plain text for replay.
 *
 * Unwraps tool_result blocks — emit the raw result content so the model sees
 * a natural "here's the output" user turn instead of verbose
 * `[Tool Result for toolu_xxx: ...]` noise (issue #111, #386). When a
 * toolIndex is provided, each result is prefixed with a compact
 * `[name target]` attribution: the replay drops assistant tool_use blocks,
 * so without this the model sees raw outputs with no cause and denies having
 * made the calls at all (#552 — "a file I never created").
 */
function flattenUserContent(
  content: any,
  sanitizeOpts: import("./sanitize").SanitizeOptions = {},
  toolIndex?: Map<string, import("./messages").ToolCallInfo>
): string {
  if (typeof content === "string") return sanitizeTextContent(content, sanitizeOpts)
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((b: any) => {
      if (b?.type === "text" && b.text) return sanitizeTextContent(b.text, sanitizeOpts)
      if (b?.type === "tool_result") {
        const info = toolIndex?.get(b.tool_use_id)
        const label = info ? describeToolCall(info) : undefined
        const inner = b.content
        let flat = ""
        if (typeof inner === "string") flat = inner
        else if (Array.isArray(inner)) {
          flat = inner
            .map((ib: any) => (ib?.type === "text" && ib.text ? ib.text : ""))
            .filter(Boolean)
            .join("\n")
        }
        if (label) return flat ? `${label}:\n${flat}` : label
        return flat
      }
      if (b?.type === "image") return "[Image attached]"
      if (b?.type === "document") return "[Document attached]"
      if (b?.type === "file") return "[File attached]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}


/**
 * Build a prompt from all messages for a fresh (non-resume) session.
 * Used when retrying after a stale session UUID error.
 */
function buildFreshPrompt(
  messages: Array<{ role: string; content: any }>,
  sanitizeOpts: import("./sanitize").SanitizeOptions = {}
): string | AsyncIterable<any> {
  const hasMultimodal = messages.some((m) => hasMultimodalContent(m.content))
  const toolIndex = buildToolUseIndex(messages)

  if (hasMultimodal) {
    const structured: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> = []
    for (const m of messages) {
      if (m.role === "user") {
        structured.push({
          type: "user" as const,
          message: { role: "user" as const, content: normalizeStructuredUserContent(stripCacheControlDeep(m.content)) },
          parent_tool_use_id: null,
        })
      } else {
        // Drops tool_use blocks and skips tool-use-only assistant messages
        // (flattenAssistantContent returns "" for those).
        const assistantText = flattenAssistantContent(m.content)
        if (assistantText) {
          structured.push({
            type: "user" as const,
            message: { role: "user" as const, content: `[Assistant: ${assistantText}]` },
            parent_tool_use_id: null,
          })
        }
      }
    }
    // See #553 — consolidate earlier-turn multimodal onto the final user turn.
    const prompt = structured.length > 1 ? consolidateMultimodalOntoLastUser(structured) : structured
    return (async function* () { for (const msg of prompt) yield msg })()
  }

  // Same anti-imitation convention as the structured branch above and the
  // main prompt builder: user turns plain, assistant turns bracketed.
  // 'Human:'/'Assistant:' transcript lines teach the model to complete the
  // transcript itself (#496 self-talk). frameReplayTurns then wraps the
  // history in the #619 context-only envelope with the live user message
  // separated as the actual prompt.
  return frameReplayTurns(
    messages.map((m) => {
      if (m.role === "assistant") {
        const assistantText = flattenAssistantContent(m.content)
        return { role: "assistant", text: assistantText ? `[Assistant: ${assistantText}]` : "" }
      }
      return { role: "user", text: flattenUserContent(m.content, sanitizeOpts, toolIndex) }
    })
  )
}

// Routine [PROXY] operational logging. Suppressed when config.silent is set so
// an embedding TUI host (e.g. opencode-with-claude) isn't polluted on its input
// line (#517 was the token_refresh instance of this). Structured telemetry
// (claudeLog) and HTTP responses are unaffected. Module-scoped to match the
// file's existing single-process session caches; createProxyServer sets it.
let proxyLogSilent = false
function plog(message: string): void {
  if (!proxyLogSilent) console.error(message)
}

function logUsage(requestId: string, usage: TokenUsage): void {
  plog(`[PROXY] ${requestId} usage: ${formatUsageSummary(usage)}`)
}

function checkTokenHealth(
  requestId: string,
  sdkSessionId: string | undefined,
  usage: TokenUsage | undefined,
  turnNumber: number,
  isResume: boolean,
  isPassthrough: boolean
): void {
  if (!usage || !sdkSessionId) return

  const cacheHitRate = computeCacheHitRate(usage) ?? 0
  const current: TokenSnapshot = {
    requestId,
    turnNumber,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheHitRate,
    isResume,
    isPassthrough,
  }

  const prevMetric = telemetryStore.getLastForSession(sdkSessionId)
  const previous: TokenSnapshot | undefined = prevMetric ? {
    requestId: prevMetric.requestId,
    turnNumber: turnNumber - 1,
    inputTokens: prevMetric.inputTokens ?? 0,
    outputTokens: prevMetric.outputTokens ?? 0,
    cacheReadInputTokens: prevMetric.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: prevMetric.cacheCreationInputTokens ?? 0,
    cacheHitRate: prevMetric.cacheHitRate ?? 0,
    isResume: prevMetric.isResume,
    isPassthrough: prevMetric.isPassthrough,
  } : undefined

  const anomalies = detectTokenAnomalies(current, previous)
  if (anomalies.length > 0) {
    const alerts = formatAnomalyAlerts(requestId, anomalies)
    for (const line of alerts) {
      plog(line)
    }
    for (const a of anomalies) {
      diagnosticLog.log({
        level: a.severity === "critical" ? "error" : "warn",
        category: "token",
        message: `${requestId} ${a.type}: ${a.detail}`,
        requestId,
      })
    }
  }
}

export function createProxyServer(config: Partial<ProxyConfig> = {}): ProxyServer {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  proxyLogSilent = finalConfig.silent
  const serverVersion = finalConfig.version ?? "unknown"

  // Restore persisted active profile from last session
  restoreActiveProfile(finalConfig.profiles)

  // Track cumulative discovered tools per SDK session (survives across requests)
  const sessionDiscoveredTools = new Map<string, Set<string>>()

  // Cache last-seen tool definitions per agent session to prevent prompt cache
  // invalidation when clients intermittently omit tools on continuation requests.
  const sessionToolCache = new Map<string, any[]>()
  // Cache the passthrough MCP server per session. Reusing the same server
  // across turns (when the tool set is unchanged) avoids subtle prompt-cache
  // invalidation from MCP server re-creation. Key hashes tool name + schema
  // so silently-updated tool definitions force a rebuild.
  const sessionMcpCache = new LRUMap<string, { key: string; mcp: ReturnType<typeof createPassthroughMcpServer> }>(getMaxSessionsLimit())

  // A --resume spawned while the session's previous subprocess is still
  // exiting is refused, in two wordings: "currently running as a background
  // agent" (#630, a consequence of #628's CLAUDE_CODE_SESSION_KIND=bg) and
  // "No conversation found …". Neither means the session is gone — the stale
  // process exits within ~a second — so retry the same resume with linear
  // backoff, and fork only what can be branched. Delay is overridable so
  // tests don't sleep for real.
  const RESUME_REFUSAL_MAX_RETRIES = 3
  // The env name predates the wider refusal set and stays as it is: renaming it
  // would silently drop anyone's existing override.
  const RESUME_REFUSAL_RETRY_DELAY_MS = parseInt(process.env.MERIDIAN_BUSY_RETRY_DELAY_MS ?? "500", 10)

  // Hard ceiling on how long one turn may hold its session lease. The lease is
  // released when the request finishes, which for a stream means when the body
  // completes — so any path that leaves that promise unsettled would wedge the
  // session for the lifetime of the process. On timeout the session degrades to
  // pre-coordination behavior (concurrent turns, possibly a replay), which is
  // recoverable; a permanent deadlock is not. Read per instance (like the busy
  // retry delay above) so tests don't have to wait out the real ceiling.
  const SESSION_TURN_MAX_HOLD_MS = envInt("SESSION_TURN_MAX_HOLD_MS", 600_000)
  // Default: share the process-wide budget, because the failure this guards
  // against (many SDK subprocesses spawned at once) is a property of the host
  // process, not of any one instance. `maxConcurrent` is the opt-out for
  // embedders that deliberately want isolated budgets per instance.
  const sdkSemaphore = finalConfig.maxConcurrent !== undefined
    ? new AbortableSemaphore(finalConfig.maxConcurrent)
    : getProcessSdkSemaphore()
  const responseCompletions = new WeakMap<Response, Promise<void>>()

  // Graceful shutdown (#drain): once true, handleWithQueue fast-fails new
  // requests instead of queueing them, and /health reports it so a fleet
  // manager (e.g. a gateway's account-pool scheduler) can stop routing here
  // before the process actually exits. inFlightRequests only counts requests
  // that were admitted past that gate, so it drains to 0 on its own — no
  // separate bookkeeping of queued vs. active is needed.
  let draining = false
  let inFlightRequests = 0

  // Admission belongs at the PUBLIC entrypoint. /v1/chat/completions and
  // /v1/responses translate their body before re-entering /v1/messages, so
  // gating only the inner hop let a request accepted while healthy be refused
  // halfway through its own translation — and the refusal then arrived wearing
  // the wrong contract. Public routes check the gate; the internal hop is
  // exempted by a per-instance token rather than a fixed header name, so the
  // exemption can never be claimed from the wire.
  const internalHopToken = randomUUID()
  /** Which error envelope a public route speaks. */
  type ErrorShape = "anthropic" | "openai"
  const errorEnvelope = (shape: ErrorShape, type: string, message: string) =>
    shape === "anthropic"
      ? { type: "error", error: { type, message } }
      : { error: { type, message, code: null } }
  const DRAIN_MESSAGE = "Meridian is shutting down and is not accepting new requests. Retry against another instance."
  // Each route answers in its own envelope. /v1/responses reports every other
  // error (both 400s below it) in the OpenAI shape, so handing it the
  // Anthropic one here would make the drain 503 the single reply on that route
  // a Codex-style client cannot parse the way it parses everything else.
  const drainingResponse = (shape: ErrorShape = "anthropic"): Response =>
    new Response(JSON.stringify(errorEnvelope(shape, "overloaded_error", DRAIN_MESSAGE)), {
      status: 503,
      headers: { "Content-Type": "application/json", "x-meridian-draining": "1" },
    })

  /**
   * Relay what the internal /v1/messages hop actually said.
   *
   * The compat routes used to flatten every inner failure into
   * `upstream_error` with the raw JSON stringified into `message`. That
   * collapsed two contracts a caller must be able to act on: the drain 503
   * lost its `x-meridian-draining` header, and the session-conflict 400 —
   * "your history is stale, refetch it" — arrived as an opaque upstream fault
   * that a gateway would retry or fail over instead of resolving.
   */
  async function relayInnerError(
    internalRes: Response,
    shape: ErrorShape,
  ): Promise<Response> {
    const errBody = await internalRes.text()
    let innerType: string | undefined
    let innerMessage: string | undefined
    try {
      const parsed = JSON.parse(errBody) as { error?: { type?: string; message?: string } }
      innerType = parsed?.error?.type
      innerMessage = parsed?.error?.message
    } catch { /* not JSON — fall back to the raw text */ }
    const payload = errorEnvelope(shape, innerType ?? "upstream_error", innerMessage ?? errBody)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const drainingHeader = internalRes.headers.get("x-meridian-draining")
    if (drainingHeader) headers["x-meridian-draining"] = drainingHeader
    return new Response(JSON.stringify(payload), { status: internalRes.status, headers })
  }

  async function* runSdkQueryAttempt(
    params: Parameters<typeof query>[0],
    signal: AbortSignal,
    requestMeta: RequestMeta,
    mode: string,
  ) {
    // Measured around the wait itself, not read from the granted lease: an
    // aborted wait never produces a lease, and crediting queue time only on
    // success dumped the entire wait of every cancelled request into
    // proxyOverheadMs — corrupting the one number that says "the proxy is the
    // bottleneck" precisely under the load that makes clients cancel.
    const acquireStartedAt = Date.now()
    let lease: SemaphoreLease
    try {
      lease = await sdkSemaphore.acquire(signal)
    } catch (error) {
      requestMeta.sdkQueueWaitMs += Date.now() - acquireStartedAt
      throw error
    }
    requestMeta.sdkQueueWaitMs += lease.waitedMs
    const startedAt = Date.now()
    requestMeta.currentSdkStartedAt = startedAt
    let sdkQuery: ReturnType<typeof query> | undefined
    try {
      sdkQuery = query(params)
      yield* guardUpstreamIdle(sdkQuery, UPSTREAM_IDLE_MS, (sinceLastMs) =>
        claudeLog("upstream.stalled", { mode, sinceLastMs }))
    } finally {
      try {
        // Production Query objects expose close(); test doubles and older SDK
        // shims may be plain async generators whose iterator return() is
        // already invoked by guardUpstreamIdle.
        if (typeof sdkQuery?.close === "function") sdkQuery.close()
      } finally {
        requestMeta.sdkActiveDurationMs += Date.now() - startedAt
        lease.release()
      }
    }
  }

  const pluginDir = finalConfig.pluginDir ?? join(homedir(), ".config", "meridian", "plugins")
  const pluginConfigPath = finalConfig.pluginConfigPath ?? join(homedir(), ".config", "meridian", "plugins.json")
  let loadedPlugins: LoadedPlugin[] = []
  let pluginTransforms: ReturnType<typeof getActiveTransforms> = []

  const app = new Hono()

  app.use("*", cors())

  // Optional API key auth — protects all routes except / and /health
  // when MERIDIAN_API_KEY is set. No-op when unset.
  //
  // When adding a new sensitive prefix, add it here. The audit test in
  // proxy-settings-auth.test.ts walks every registered route and fails CI
  // if any non-public path responds with anything other than 401 to an
  // unauthenticated request. That's the safety net against the next "we
  // forgot to gate it" mistake (issue #477 was the catalyst — `/settings/*`
  // was registered without going through requireAuth, so unauthenticated
  // callers could mutate adapter SDK feature config via PATCH).
  app.use("/v1/*", requireAuth)
  app.use("/messages", requireAuth)
  app.use("/telemetry/*", requireAuth)
  app.use("/telemetry", requireAuth)
  app.use("/metrics", requireAuth)
  app.use("/profiles/*", requireAuth)
  app.use("/profiles", requireAuth)
  app.use("/plugins/*", requireAuth)
  app.use("/plugins", requireAuth)
  app.use("/settings/*", requireAuth)
  app.use("/settings", requireAuth)
  app.use("/design-login", requireAuth)

  // --- Priority routing (opt-in, routing="priority") ---
  // Ordered account pool with per-request failover. The /v1/messages handler
  // becomes a thin dispatcher in this mode: it calls handleMessages directly
  // with a forcedProfileId per candidate, so ALL failover logic lives here —
  // no changes to the deep request machinery. Calling in-process rather than
  // re-entering over HTTP matters for more than speed: an internal hop would
  // take a second slot from the same concurrency budget as its own parent and
  // deadlock the pool whenever MERIDIAN_MAX_CONCURRENT is 1. State is per
  // proxy instance.
  const priorityExhaustion = new ProfileExhaustion()
  const PRIORITY_ASSIGNMENTS_MAX = 5000
  const priorityAssignments = new AssignmentStore(PRIORITY_ASSIGNMENTS_MAX)
  // The per-window reset cap lives in routing.ts (cooldownCapMs): a single
  // constant here is what let a 6-hour bound flatten a weekly reset (#790).
  const PRIORITY_DEFAULT_COOLDOWN_MS = 10 * 60_000

  function priorityProfileOrderSetting(): string[] | undefined {
    const env = process.env.MERIDIAN_PROFILE_ORDER
    if (env && env.trim()) return env.split(",").map(s => s.trim()).filter(Boolean)
    const setting = getSetting("profileOrder")
    return Array.isArray(setting) && setting.length > 0 ? setting : undefined
  }

  /** Tier 1 + 3: this profile's own observed five_hour reset, else a
   *  conservative default so a mis-mark self-heals. Never blocks.
   *
   *  Gated the same way as tier 2's `refinePriorityCooldown`: a healthy
   *  account always has a `five_hour` window with a future `resetsAt` —
   *  that boundary exists regardless of consumption, so a scoped entry's
   *  mere presence doesn't prove the five-hour window caused THIS failure
   *  (it could be a seven_day cap, or a transient upstream error). Only
   *  trust the entry's `resetsAt` when it says the window was actually
   *  exhausted (`status === "rejected"`, or `utilization >= 1` for older
   *  entries that predate the `status` field); otherwise fall through to
   *  the conservative default so tier 2 isn't left refining a wrong mark
   *  it has no way to challenge. */
  function priorityCooldownUntil(profileId: string, now: number): number {
    const windows = rateLimitStore.getAll(profileId).map(e => ({
      type: e.rateLimitType ?? "",
      resetsAt: e.resetsAt,
      exhausted: e.status === "rejected" || (e.utilization ?? 0) >= 1,
    }))
    return resolveCooldownUntil(windows, now, PRIORITY_DEFAULT_COOLDOWN_MS)
  }

  /** Tier 2: the authoritative per-account reset from Anthropic's usage
   *  endpoint. Deliberately fire-and-forget — the failover path has already
   *  burned one failed request and must not also wait on a network call.
   *  `ProfileExhaustion.mark` ignores an `until` that isn't later than the
   *  existing one, so a late refinement can only EXTEND a cooldown, never
   *  un-suppress a profile early. A null/failed fetch changes nothing.
   *
   *  Gated on actual exhaustion: a healthy account always has a `five_hour`
   *  window with a future `resetsAt` — that boundary exists regardless of
   *  consumption. The OAuth snapshot is only authoritative about *when* the
   *  five-hour window resets if that window is actually exhausted
   *  (`utilization >= 1`); otherwise the triggering error was not five-hour
   *  exhaustion (upstream overload, a seven_day cap, etc.) and the
   *  conservative tier-3 default must stand rather than being extended out
   *  to a boundary that has nothing to do with the failure. A missing/null
   *  `utilization` is treated as NOT exhausted — under-suppressing is the
   *  safe direction; over-suppressing a healthy profile is the bug this
   *  gate exists to prevent.
   *
   *  `force: true` bypasses `fetchOAuthUsage`'s 30s cache: exhaustion is
   *  rare (off the hot path) and `/v1/usage/quota/all` polling routinely
   *  keeps that cache warm with a snapshot recorded just before the failure,
   *  which would otherwise show "just under 1" and starve this refinement
   *  right when it's needed. `force` only skips the cache read — the
   *  in-flight-request de-dupe still applies after it, so concurrent
   *  exhaustions of the same profile still share one upstream call rather
   *  than stampeding it. The per-profile 429 cooldown suppresses forced
   *  callers too, so an upstream rate limit leaves this refinement on the
   *  conservative default instead of stampeding a limited endpoint. A
   *  `stale: true` snapshot (served when a fresh fetch
   *  failed transiently) is not authoritative about the current window, so
   *  it's skipped too — the conservative default is the safer thing to
   *  leave standing. */
  function refinePriorityCooldown(profileId: string): void {
    const target = getEffectiveProfiles(finalConfig.profiles).find(p => p.id === profileId)
    // Only `claude-max` profiles have credentials this can consult. `api`
    // profiles authenticate with a key and have no usage endpoint; `oauth-token`
    // profiles carry their token in `CLAUDE_CODE_OAUTH_TOKEN` with a config dir
    // that deliberately holds no on-disk credentials, so the store read finds
    // nothing there either. `force: true` also means the 30s cache can't
    // suppress the repeat, so every exhaustion event would pay for a credential
    // read (a `/usr/bin/security` subprocess on macOS) to learn nothing.
    // Mirrors the `not_oauth` guard in `/v1/usage/quota/all` and
    // `credentialStoreForProfile`. Tier 3's conservative default already stands
    // when this returns early (#699).
    if ((target?.type ?? "claude-max") !== "claude-max") return
    void fetchOAuthUsage({ profileId, claudeConfigDir: target?.claudeConfigDir, force: true })
      .then(usage => {
        if (!usage || usage.stale) return
        const now = Date.now()
        const windows = usage.windows.map(w => ({
          type: w.type,
          resetsAt: w.resetsAt,
          exhausted: (w.utilization ?? 0) >= 1,
        }))
        // Sentinel: resolveCooldownUntil falls back to `now + defaultMs` when
        // nothing is exhausted. Passing 0 makes that fallback identifiable, so
        // a snapshot showing a healthy account refines nothing and tier 3's
        // conservative default stands — the same early-return the five-hour-only
        // version did with its `utilization < 1` guard.
        const until = resolveCooldownUntil(windows, now, 0)
        if (until <= now) return
        priorityExhaustion.mark(profileId, until, "rate_limit_error")
        claudeLog("priority.cooldown_refined", { profile: profileId, until, source: "oauth_usage" })
      })
      .catch(err => {
        claudeLog("priority.cooldown_refine_failed", {
          profile: profileId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  /** Inspect an inner response for an account-level failure without destroying
   *  it. Non-stream: an error body on a non-OK status. Stream: an
   *  `event: error` frame BEFORE any content frame (mid-content errors pass
   *  through — never yank a stream a client is already consuming).
   *
   *  `isAccountFailoverError` decides which classified types are worth another
   *  account; anything else is this account's honest answer and belongs to the
   *  client untouched. The non-stream status gate is `!res.ok` rather than a
   *  literal 429 because the qualifying types do not share one status — a
   *  spent quota window is 429, a refused subscription 402. */
  async function sniffAccountFailure(res: Response): Promise<
    | { failed: true; errorPayload: unknown; errorType: string; response: Response }
    | { failed: false; errorPayload: null; errorType: null; response: Response }
  > {
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      if (!res.ok) {
        const body = await res.clone().json().catch(() => null) as { error?: { type?: string } } | null
        const errorType = body?.error?.type
        if (isAccountFailoverError(errorType)) {
          return { failed: true, errorPayload: body, errorType, response: res }
        }
      }
      return { failed: false, errorPayload: null, errorType: null, response: res }
    }
    const reader = res.body?.getReader()
    if (!reader) return { failed: false, errorPayload: null, errorType: null, response: res }
    const decoder = new TextDecoder()
    const consumed: Uint8Array[] = []
    let text = ""
    let failure: { payload: unknown; type: string } | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      consumed.push(value)
      text += decoder.decode(value, { stream: true })
      const frameEnd = text.indexOf("\n\n")
      if (frameEnd === -1) continue
      const frame = text.slice(0, frameEnd)
      if (/^event: error$/m.test(frame)) {
        const dataLine = frame.split("\n").find(l => l.startsWith("data: "))
        try {
          const parsed = dataLine ? JSON.parse(dataLine.slice(6)) as { error?: { type?: string } } : null
          const parsedType = parsed?.error?.type
          if (isAccountFailoverError(parsedType)) {
            failure = { payload: parsed, type: parsedType }
          }
        } catch { /* not an account-failure frame — pass through below */ }
      }
      break // first complete frame decides
    }
    if (failure) {
      await reader.cancel().catch(() => {})
      return { failed: true, errorPayload: failure.payload, errorType: failure.type, response: res }
    }
    const rest = new ReadableStream<Uint8Array>({
      start(ctrl) { for (const chunk of consumed) ctrl.enqueue(chunk) },
      async pull(ctrl) {
        const { done, value } = await reader.read()
        if (done) ctrl.close()
        else ctrl.enqueue(value)
      },
      cancel(reason) { void reader.cancel(reason).catch(() => {}) },
    })
    const response = new Response(rest, { status: res.status, headers: res.headers })
    const completion = responseCompletions.get(res)
    if (completion) responseCompletions.set(response, completion)
    return { failed: false, errorPayload: null, errorType: null, response }
  }

  async function dispatchPriority(c: Context, body: any, requestMeta: RequestMeta, orderedCandidateIds: string[], sessionKey: string | null, wantsStream: boolean): Promise<Response> {
    let lastError: unknown = null
    let lastStatus = 429
    let previous: string | null = null
    let previousReason = "rate_limit_error"
    for (const [attempt, candidate] of orderedCandidateIds.entries()) {
      const inner = await handleMessages(c, forkAttemptMeta(requestMeta, attempt), { body, forcedProfileId: candidate })
      const sniffed = await sniffAccountFailure(inner)
      if (!sniffed.failed) {
        if (sessionKey) priorityAssignments.set(sessionKey, candidate)
        if (previous) {
          claudeLog("profile.failover", { from: previous, to: candidate, reason: previousReason, sessionKey })
          plog(`[PROXY] PRIORITY failover ${previous} -> ${candidate} (${previousReason})`)
        }
        return sniffed.response
      }
      await responseCompletions.get(inner)?.catch(() => {})
      const reason = sniffed.errorType
      // Only a quota refusal has a reset to look up. Both cooldown tiers read
      // the account's five-hour window, which says nothing about entitlement:
      // a refused subscription would be suppressed until an unrelated quota
      // boundary, and `refinePriorityCooldown` could only push that further
      // out (`mark` lets a later refinement extend a cooldown, never shorten
      // it). The conservative default stands instead, so the account is
      // re-probed once the subscription may plausibly have been fixed.
      const quotaRefusal = isQuotaRefusal(reason)
      const cooldownUntil = quotaRefusal
        ? priorityCooldownUntil(candidate, Date.now())
        : Date.now() + PRIORITY_DEFAULT_COOLDOWN_MS
      priorityExhaustion.mark(candidate, cooldownUntil, reason)
      claudeLog("priority.exhausted", { profile: candidate, until: cooldownUntil, reason })
      if (quotaRefusal) refinePriorityCooldown(candidate)
      lastError = sniffed.errorPayload
      lastStatus = inner.status
      previous = candidate
      previousReason = reason
    }
    // Every candidate failed: surface the LAST tried profile's error (owner
    // decision). Stream sniff consumed the inner body, so reconstruct the
    // exact frame for SSE requests; non-stream errors pass through as JSON,
    // carrying the status that came with them — a pool refused for billing
    // must not reach the client as a 429 it would dutifully back off from.
    if (wantsStream) {
      return new Response(`event: error\ndata: ${JSON.stringify(lastError)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      })
    }
    return new Response(JSON.stringify(lastError), { status: lastStatus, headers: { "content-type": "application/json" } })
  }
  app.use("/auth/*", requireAuth)

  app.get("/", (c) => {
    // API clients get JSON, browsers get the landing page
    const accept = c.req.header("accept") || ""
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        status: "ok",
        service: "meridian",
        format: "anthropic",
        endpoints: ["/v1/messages", "/messages", "/v1/chat/completions", "/v1/responses", "/v1/models", "/v1/design/*", "/design-login", "/telemetry", "/metrics", "/health"]
      })
    }
    return c.html(landingHtml)
  })

  const handleMessages = async (
    c: Context,
    requestMeta: RequestMeta,
    options: HandleMessagesOptions,
  ) => {
    const requestStartAt = requestMeta.queueEnteredAt
    const requestAbort = linkRequestAbort(c.req.raw.signal)
    let streamOwnsAbortLink = false

    return withClaudeLogContext({ requestId: requestMeta.requestId, endpoint: requestMeta.endpoint }, async () => {
      // Hoist adapter detection before try so it's available in the catch block for telemetry
      const adapter = detectAdapter(c)
      try {
        const body = options.body

        // Validate required fields
        if (!Array.isArray(body.messages)) {
          return c.json(
            { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
            400
          )
        }
        // Empty messages array would crash sdkUuidMap allocation downstream
        // (`new Array(-1)` throws RangeError) and is invalid per the Anthropic
        // API spec ("messages must contain at least one message"). Reject
        // explicitly with a clear error rather than letting the request fail
        // with a cryptic 500. See issue #450.
        if (body.messages.length === 0) {
          return c.json(
            { type: "error", error: { type: "invalid_request_error", message: "messages: Cannot be empty — at least one message is required" } },
            400
          )
        }

        // Native Anthropic server tools (web_search_*, web_fetch_*) can't run
        // through the Max/SDK path — fail fast with an actionable message
        // instead of silently bouncing an unrunnable tool back to the agent.
        // See #488 (opencode-websearch) / #481 (Cherry Studio).
        const serverTools = detectServerTools(body.tools)
        if (serverTools.length > 0) {
          return c.json(
            { type: "error", error: { type: "invalid_request_error", message: serverToolErrorMessage(serverTools) } },
            400
          )
        }

        const parsedOutputFormat = parseOutputFormat(body.output_config, body.tools)
        if (!parsedOutputFormat.ok) {
          return c.json(
            { type: "error", error: { type: "invalid_request_error", message: parsedOutputFormat.message } },
            400
          )
        }
        const outputFormat = parsedOutputFormat.value

        // Resolve profile: header > sticky (routing="sticky" only) > active >
        // default > first configured. Sticky routing (#383) assigns each
        // client session to a profile via rendezvous hashing so multi-account
        // setups keep per-account prompt caches warm; the same session key
        // Meridian already uses for session tracking is the assignment key,
        // so a session and its subagent/fork requests land on one account.
        const routingMode = getRoutingMode(process.env.MERIDIAN_ROUTING ?? getSetting("routing"))
        // Priority mode (opt-in): unpinned requests are dispatched across the
        // ordered pool with per-request failover. Pinned requests (explicit
        // x-meridian-profile — including our own internal hops) bypass the
        // pool entirely and take the normal path below.
        if (routingMode === "priority" && !options.forcedProfileId && !c.req.header("x-meridian-profile")) {
          const effectivePool = getEffectiveProfiles(finalConfig.profiles)
          if (effectivePool.length > 1) {
            const { order, unknown } = resolvePriorityOrder(effectivePool.map(p => p.id), priorityProfileOrderSetting())
            if (unknown.length > 0) claudeLog("priority.unknown_order_ids", { unknown })
            // Keyless clients (pylon's main process, OpenCode setups that omit
            // x-opencode-session) fall back to the conversation fingerprint —
            // without it they re-pick an account every turn and bounce back to
            // the preferred profile the moment its cooldown expires, replaying
            // the whole history against a cold cache.
            // Deliberately not clientWorkingDirectory (computed below): no
            // MERIDIAN_WORKDIR/CLAUDE_PROXY_WORKDIR override here — that
            // override would collapse every client's account key to one
            // shared value.
            const assignmentCwd = adapter.extractClientWorkingDirectory?.(body)
              ?? adapter.extractWorkingDirectory(body)
            const sessionKey = getPriorityAssignmentKey(
              adapter.getSessionId(c, body),
              body.messages,
              assignmentCwd,
            )
            const assigned = sessionKey ? priorityAssignments.get(sessionKey) : undefined
            // Assignment affinity: an existing conversation stays on its
            // account while that account is healthy (protects warm prompt
            // caches). Only NEW sessions drain back after a reset.
            let first: string
            if (assigned && order.includes(assigned) && !priorityExhaustion.isExhausted(assigned)) {
              first = assigned
            } else {
              const pick = choosePriorityProfile(order, id => priorityExhaustion.isExhausted(id))
              first = pick?.id ?? order[0]!
            }
            const candidates = [first, ...order.filter(id => id !== first && !priorityExhaustion.isExhausted(id))]
            return dispatchPriority(c, body, requestMeta, candidates, sessionKey, body.stream === true)
          }
        }
        const profile = resolveProfile(
          finalConfig.profiles,
          finalConfig.defaultProfile,
          options.forcedProfileId || c.req.header("x-meridian-profile") || undefined,
          routingMode === "sticky"
            ? { routingMode, stickySessionKey: adapter.getSessionId(c, body) }
            : undefined
        )

        const authStatus = await getClaudeAuthStatusAsync(
          profile.id !== "default" ? profile.id : undefined,
          Object.keys(profile.env).length > 0 ? profile.env : undefined
        )
        // Opaque tag clients can send to distinguish concurrent request flows
        // from the same conversation (e.g., pylon's main chat vs. memory-extract fork vs. subagent).
        // Logged for observability; fork-*/subagent-* values also skip fingerprint cache (see below).
        // Examples: "main", "fork-memory-extract", "subagent-scout".
        const requestSource = c.req.header("x-meridian-source")?.slice(0, 64) || undefined
        // NOTE: OpenCode-specific legacy fallback. Older integrations sent
        // this header even when another adapter was selected; preserve that
        // behavior while adapters migrate to the normalized extension point.
        const declaredAgentMode =
          adapter.getAgentMode?.(c, body) ?? c.req.header("x-opencode-agent-mode") ?? null
        // A generic subagent source and an adapter-specific mode declaration
        // describe the same semantic fact. Treat either as authoritative so a
        // client cannot accidentally get cache isolation without the base model
        // tier (or the base tier without safe headerless cache isolation).
        const isSubagentRequest =
          declaredAgentMode === "subagent" || requestSource?.startsWith("subagent-") === true
        const agentMode = isSubagentRequest ? "subagent" : declaredAgentMode
        const requestedModel = typeof body.model === "string" ? body.model : "sonnet"
        let model = mapModelToClaudeModel(requestedModel, authStatus?.subscriptionType, agentMode)
        // Explicitly versioned ids override their tier's canonical pin for
        // this request (spread last in query.ts env, so they also beat
        // operator env) — a proxy must never substitute models. Bare aliases
        // keep the canonical pins. See explicitModelPin for the rules.
        const envOverrides = explicitModelPin(requestedModel)
        // workingDirectory = SDK subprocess cwd (must exist on the proxy host).
        // clientWorkingDirectory = the client's local path (may not exist here);
        // used for per-project fingerprint bucketing and a system-prompt hint
        // so the model reports the user's real path. For same-host clients
        // (OpenCode, Crush) the adapter can leave extractClientWorkingDirectory
        // undefined and the two collapse to the same value.
        //
        // Issue #381 — when meridian runs on a remote host and the client is
        // on another machine, the claimed cwd may not exist locally; the SDK
        // would otherwise fail with a misleading "binary not found" error.
        // resolveSdkWorkingDirectory falls back to process.cwd() in that case.
        const cwdResolution = resolveSdkWorkingDirectory({
          envOverride: process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR,
          // Adapters that hand back an SDK-safe path win. Otherwise fall back to
          // the CLIENT's path (claude-code deliberately returns undefined above
          // so the subprocess never chdirs into a layout that may not exist
          // here). resolveSdkWorkingDirectory validates existence, so this is
          // only adopted when the directory is genuinely present on the proxy
          // host; a remote client still falls back to process.cwd() as in #381.
          //
          // Without this the SDK chdirs to the proxy's own directory and its
          // env block advertises that path, so the model composes absolute
          // paths against the wrong tree and writes land on the proxy host
          // while reporting success (#744). Adopting the client's path when it
          // exists removes the contradiction at the source rather than relying
          // on the cwd note to argue the model out of it.
          adapterCwd: adapter.extractWorkingDirectory(body) ?? adapter.extractClientWorkingDirectory?.(body),
          fallback: process.cwd(),
        })
        const workingDirectory = cwdResolution.workingDirectory
        if (cwdResolution.fellBack) {
          claudeLog("cwd_fallback", {
            claimed: cwdResolution.claimedWorkingDirectory,
            usedInstead: workingDirectory,
          })
        }
        const clientWorkingDirectory = adapter.extractClientWorkingDirectory?.(body) || cwdResolution.claimedWorkingDirectory

        // Strip env vars that would cause the SDK subprocess to loop back through
        // the proxy instead of using its native Claude Max auth. Also strip vars
        // that cause unwanted SDK plugin/feature loading or expose Claude-Code-
        // host-only tools that downstream agents (OpenCode, Crush, Droid, etc.)
        // cannot execute.
        const {
          // Strips infinite loop / wrong-auth conditions:
          ANTHROPIC_API_KEY: _dropApiKey,
          ANTHROPIC_BASE_URL: _dropBaseUrl,
          ANTHROPIC_AUTH_TOKEN: _dropAuthToken,
          // Strips unwanted SDK plugin/feature loading:
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
          // Strips Claude-Code-only tools that other agents can't execute.
          // CLAUDE_CODE_USE_POWERSHELL_TOOL=1 makes the SDK register a
          // `PowerShell` tool the model can call. OpenCode (and other clients)
          // expose `bash` instead and reject `PowerShell` as an unavailable
          // tool. Setting it to "0" doesn't help — the var has to be removed
          // entirely. See issue #441.
          CLAUDE_CODE_USE_POWERSHELL_TOOL: _dropUsePowershell,
          ...cleanEnv
        } = process.env

        // Pin ANTHROPIC_DEFAULT_{TYPE}_MODEL before the inherited env. The
        // Claude Agent SDK resolves the "sonnet"/"opus"/"haiku" aliases
        // (emitted by mapModelToClaudeModel) via these env vars; when unset
        // it falls back to its own bundled defaults, which lag real
        // availability and caused #419 (opus-* requests silently answering
        // as sonnet-4). Spread order: modelDefaults first, then cleanEnv,
        // so user-provided ANTHROPIC_DEFAULT_* values still win.
        const sdkModelDefaults = resolveSdkModelDefaults()

        // Overlay profile-specific env vars (e.g. CLAUDE_CONFIG_DIR for multi-account)
        const profileEnv = { ...sdkModelDefaults, ...cleanEnv, ...profile.env }
        const profileCredentialStore = credentialStoreForProfile(profile)

        // Drops transport metadata some clients pass through `system`.
        let systemContext = extractSystemText(body.system)

        // Run the transform pipeline — adapter transforms populate SDK configuration.
        // INVARIANT (#476): behavior keyed by adapter name — transforms, plugin
        // scoping, and agent-specific branches — resolves via the BASE name so
        // existing transforms and ecosystem plugins keep applying to adapter
        // instances. Only features and telemetry labels use the instance name.
        const adapterBase = adapter.baseName ?? adapter.name
        const adapterTransforms = getAdapterTransforms(adapterBase)
        const pipeline = buildPipeline(adapterTransforms, pluginTransforms)
        const pipelineCtx = runTransformHook(pipeline, "onRequest", createRequestContext({
          adapter: adapterBase,
          body,
          headers: c.req.raw.headers,
          model,
          messages: body.messages || [],
          systemContext,
          tools: body.tools,
          stream: body.stream ?? false,
          workingDirectory,
        }), adapterBase)

        // Allow transform pipeline to override streaming preference (e.g. LiteLLM requires non-streaming)
        const stream = pipelineCtx.prefersStreaming !== undefined ? pipelineCtx.prefersStreaming : (body.stream ?? false)

        // --- SDK parameter passthrough ---
        // Extract effort, thinking, taskBudget, and native structured output
        // from standard Anthropic API fields.
        // Header overrides take precedence over body values.
        const effortHeader = c.req.header("x-opencode-effort")
        const thinkingHeader = c.req.header("x-opencode-thinking")
        const taskBudgetHeader = c.req.header("x-opencode-task-budget")
        // NOTE: anthropic-beta header filtering is delegated to `filterBetasForProfile`.
        // Default policy (`allow-safe`) strips only betas known to trigger Extra-Usage
        // billing (see BILLABLE_BETA_PREFIXES_ON_MAX in betas.ts). Free betas like
        // prompt-caching, context-1m, fine-grained-tool-streaming, and
        // interleaved-thinking pass through so the SDK's caching and 1M context
        // continue to work — blanket stripping caused ~3x TTFB and ~3x token
        // consumption on long conversations.
        //
        // Operators can override the policy at runtime via the MERIDIAN_BETA_POLICY
        // env var: `strip-all` restores the pre-fix behaviour (kill switch),
        // `allow-all` forwards everything unconditionally.
        // See: https://github.com/rynfar/meridian/issues/278
        const rawBetaHeader = c.req.header("anthropic-beta")
        const betaFilter = filterBetasForProfile(rawBetaHeader, profile.type, getBetaPolicyFromEnv())
        if (betaFilter.stripped.length > 0) {
          plog(`[PROXY] ${requestMeta.requestId} stripped anthropic-beta(s) for Max profile: ${betaFilter.stripped.join(", ")}`)
        }

        // Effort can arrive as a header, the Anthropic `effort` field, the
        // standard OpenAI `reasoning_effort`, or an Anthropic-style
        // `output_config.effort`. normalizeEffort gates the value to Claude's
        // vocabulary so an unknown level (e.g. OpenAI's "minimal") falls back to
        // the model default instead of erroring at the SDK boundary.
        let effort = normalizeEffort(
          effortHeader
          || body.effort
          || body.reasoning_effort
          || body.output_config?.effort
        )
        let thinking: QueryContext['thinking'] | undefined = body.thinking || undefined
        if (thinkingHeader !== undefined) {
          try {
            thinking = JSON.parse(thinkingHeader) as QueryContext["thinking"]
          } catch (e) {
            plog(`[PROXY] ${requestMeta.requestId} ignoring malformed x-opencode-thinking header: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        // SDK feature toggles — resolved once per request for use in thinking
        // defaults, settingSources, and buildQueryOptions below.
        const { getFeaturesForAdapter, getExplicitThinking } = require("./sdkFeatures") as typeof import("./sdkFeatures")
        // Instances (#476): base-resolved features with the instance's own
        // overrides layered on top.
        const sdkFeatures = { ...getFeaturesForAdapter(adapterBase), ...(adapter.instanceFeatures ?? {}) }

        // Resolve thinking against the per-adapter setting.
        //
        // An *explicitly* configured "disabled" is authoritative: it overrides
        // any client-supplied thinking (body.thinking / x-opencode-thinking) and
        // drops effort, since effort only tunes thinking depth. This mirrors the
        // beta-stripped hard-disable below. We check the raw setting (not the
        // merged value) because the default is also "disabled" — and that default
        // must stay a no-op so clients can still request thinking per-request.
        // "adaptive"/"enabled" act as a default only when the client sent nothing.
        if ((adapter.instanceFeatures?.thinking ?? getExplicitThinking(adapterBase)) === "disabled") {
          thinking = { type: "disabled" }
          effort = undefined
          plog(`[PROXY] ${requestMeta.requestId} thinking disabled (per-adapter setting)`)
        } else if (!thinking) {
          if (sdkFeatures.thinking === "adaptive") thinking = { type: "adaptive" }
          else if (sdkFeatures.thinking === "enabled") thinking = { type: "enabled" }
        }
        // When the thinking beta is stripped (e.g. strip-all policy), disable thinking
        // at the SDK level to prevent thinking blocks from being generated in the
        // session state. Without this, resumed sessions contain thinking blocks that
        // the API rejects when the thinking beta header is absent.
        const thinkingBetaStripped = betaFilter.stripped.some(b => b.startsWith("interleaved-thinking"))
        if (thinkingBetaStripped) {
          thinking = { type: "disabled" }
          // effort only tunes thinking depth and reaches the SDK independently
          // (query.ts), so it can re-trigger reasoning even with thinking
          // disabled — drop it too, keeping thinking blocks out of session state.
          effort = undefined
          if (betaFilter.stripped.length > 0) {
            plog(`[PROXY] ${requestMeta.requestId} thinking disabled (thinking beta stripped by ${getBetaPolicyFromEnv()} policy)`)
          }
        }
        const parsedBudget = taskBudgetHeader ? Number.parseInt(taskBudgetHeader, 10) : NaN
        const taskBudget = Number.isFinite(parsedBudget)
          ? { total: parsedBudget }
          : body.task_budget ? { total: body.task_budget.total ?? body.task_budget } : undefined
        const betas = betaFilter.forwarded

        // Session resume: look up cached Claude SDK session and classify mutation
        const agentSessionId = adapter.getSessionId(c, body)
        // NOTE: agent-specific (opencode). A plugin-less OpenCode client cannot
        // have its internal title/summary agents told apart from the user's
        // conversation, and that exposure is otherwise silent — the startup
        // warning is gated on an OpenCode config file existing. Once per
        // session; the helper owns the bookkeeping.
        const pluginlessWarning = notePluginlessOpenCodeRequest({
          userAgent: c.req.header("user-agent"),
          agentModeHeader: c.req.header("x-opencode-agent-mode"),
          sessionId: agentSessionId,
        })
        if (pluginlessWarning) {
          plog(`[PROXY] ${requestMeta.requestId} ${pluginlessWarning}`)
          diagnosticLog.log({
            level: "warn",
            category: "session",
            message: `${requestMeta.requestId} ${pluginlessWarning}`,
            requestId: requestMeta.requestId,
          })
        }
        // Scope session keys by profile to isolate resume state across accounts.
        // For agents with session IDs (OpenCode): prefix the key.
        // For agents without (Pi): pass profile-scoped workingDirectory to fingerprint lookup.
        const profileSessionId = profile.id !== "default" && agentSessionId
          ? `${profile.id}:${agentSessionId}` : agentSessionId
        // The turn lease is keyed by the raw client session id (the profile
        // isn't resolved yet when it's acquired, and under priority routing it
        // can differ per attempt), but "did this session advance" is only
        // meaningful within one profile's cache scope — so commits and the
        // conflict check below both carry profileSessionId.
        const commitSessionTurn = () => {
          if (profileSessionId) requestMeta.sessionTurnLease?.markCommitted(profileSessionId)
        }
        // Use the client-local CWD for fingerprint bucketing so that two
        // independent client projects don't collide on the same first-user-
        // message hash even when they share an SDK cwd on the proxy host.
        const profileScopedCwd = profile.id !== "default"
          ? `${clientWorkingDirectory}::profile=${profile.id}` : clientWorkingDirectory
        // Clients that run concurrent sub-request flows in the same conversation
        // (e.g. pylon's memory-extract fork or subagent children) share the same
        // (firstUserMessage, cwd) fingerprint as the parent — so meridian's
        // fingerprint cache conflates them and bounces the parent through
        // continuous undo/modified-continuation/diverged reclassifications as
        // each flow writes different message hashes to the shared key.
        //
        // When x-meridian-source marks a request as an independent fork or
        // either supported signal marks it as a subagent, skip fingerprint
        // lookup (no reclassification) and skip the write at end of turn (no
        // cache pollution). The main conversation keeps its cache entry intact.
        //
        // Clients that declare neither an independent source nor a subagent
        // mode retain the normal fingerprint-cache behavior.
        // Client-driven passthrough loop: the last message is a tool_result,
        // i.e. the client executed a forwarded tool and is sending the result
        // back to continue its own loop. These requests are self-contained
        // (each carries the full growing conversation), so they need no session
        // resume — and, being headerless, they would otherwise all collide on
        // the same (firstUserMessage, cwd) fingerprint when a workflow engine
        // runs several loops concurrently, causing one run to resume another
        // run's Claude session and corrupt the conversation (premature
        // end_turn, dropped tool calls). Treat them as independent: no
        // fingerprint resume, no cache write. Header-keyed sessions (OpenCode's
        // x-opencode-session, LiteLLM's x-litellm-session-id) never reach the
        // fingerprint path, so they are unaffected.
        const lastMessage = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : undefined
        const lastIsToolResult = Array.isArray(lastMessage?.content)
          && lastMessage.content.some((b: any) => b?.type === "tool_result")
        // NOTE: Claude Code owns its tool loop but also expects Meridian to
        // resume the backing SDK session. Older clients may omit metadata, so
        // preserve fingerprint resume instead of treating their tool results
        // as unrelated headerless workflow requests.
        const isClientDrivenLoop = adapterBase !== "claude-code" && !agentSessionId && lastIsToolResult
        // The fork/subagent independence guard protects HEADERLESS flows from
        // colliding on the shared (firstUserMessage, cwd) fingerprint. Adapter
        // mode and generic source declarations share the subagent behavior. An
        // explicit session key can't collide — distinct flows carry distinct
        // keys — so keyed requests resume normally even when marked as a
        // fork/subagent source. Without this, pylon's long-lived subagent
        // workers fresh-replayed every turn: prompt-cache hits decayed to the
        // static-prefix floor and turn latency grew with conversation length.
        const isIndependentSession =
          (!agentSessionId && (requestSource?.startsWith("fork-") || isSubagentRequest)) ||
          isClientDrivenLoop || false
        let lineageResult: LineageResult = isIndependentSession
          ? { type: "diverged", reason: "independent-request" }
          : lookupSession(profileSessionId, body.messages || [], profileScopedCwd)
        // NOTE: agent-specific (opencode) — when OpenCode's chat.headers plugin
        // hook doesn't fire (category-dispatched or title-generation requests),
        // the request has no session header and falls through to fingerprint
        // lookup. A new 1-message session can collide with a stored N-message
        // session and be classified as "undo." Downgrade to "diverged" to
        // prevent leaking the old session's conversation history.
        if (lineageResult.type === "undo" && adapterBase === "opencode" && !agentSessionId) {
          lineageResult = { type: "diverged", reason: "missing-session-header" }
        }
        // Clients that declare a concurrent flow (a fork source or either
        // subagent signal) knowingly run parallel turns under one session key — see
        // the keyed fork/subagent note above. Serializing them is still worth
        // doing, but a reclassification is their normal cost; refusing them
        // would break flows that worked before turn coordination existed.
        const declaresConcurrentFlow =
          requestSource?.startsWith("fork-") === true || isSubagentRequest
        if (
          profileSessionId &&
          !declaresConcurrentFlow &&
          requestMeta.sessionTurnLease?.advancedWhileWaiting(profileSessionId) &&
          lineageResult.type !== "continuation" &&
          lineageResult.type !== "compaction"
        ) {
          const reason = lineageResult.type === "diverged" ? lineageResult.reason : lineageResult.type
          const message = "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID."
          claudeLog("session.concurrent_conflict", {
            reason,
            sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
          })
          diagnosticLog.session(
            `${requestMeta.requestId} session.concurrent_conflict reason=${reason} wait=${requestMeta.sessionQueueWaitMs}ms`,
            requestMeta.requestId,
          )
          // Every other terminal path records; this one must too, or the single
          // event operators most need to count — how often concurrency actually
          // refuses a turn — is invisible in /telemetry, SQLite and Prometheus.
          // The error tag is deliberately more specific than the wire type so a
          // conflict can be separated from ordinary request-validation errors.
          const conflictTotalMs = Date.now() - requestStartAt
          const conflictQueueWaitMs = totalQueueWaitMs(requestMeta)
          telemetryStore.record({
            requestId: requestMeta.requestId,
            timestamp: Date.now(),
            adapter: adapter.name,
            model,
            requestModel: requestedModel,
            mode: stream ? "stream" : "non-stream",
            isResume: false,
            isPassthrough: envBool("PASSTHROUGH"),
            hasDeferredTools: undefined,
            deferredToolCount: undefined,
            toolCount: body.tools?.length ?? 0,
            lineageType: lineageResult.type,
            messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
            sdkSessionId: undefined,
            status: 400,
            queueWaitMs: conflictQueueWaitMs,
            sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
            sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
            proxyOverheadMs: Math.max(0, conflictTotalMs - conflictQueueWaitMs),
            ttfbMs: null,
            // The turn is refused before any SDK query is spawned.
            upstreamDurationMs: 0,
            totalDurationMs: conflictTotalMs,
            contentBlocks: 0,
            textEvents: 0,
            error: "session_turn_conflict",
            profileId: profile.id,
          })
          return new Response(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
            {
              // Keep the public response within the Anthropic-compatible
              // Messages API contract. The diagnostic event above retains the
              // more specific reason for operators.
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          )
        }
        // Publish the decision to plugins. Core has always known WHICH message
        // stopped matching; the log line only ever reported how many matched
        // ("prefix overlap 50/51"), which is why #767 had to hand-patch a build
        // to get any further. The detail is computed only on a divergence — the
        // one case that is both rare and already about to cost a full replay —
        // and carries digests and shapes, never content.
        if (pipeline.some(t => t.onSession)) {
          // verifyLineage attaches the detail on modified-history, where it has
          // the stored digests in hand; nothing recomputes it here.
          const mismatch = lineageResult.type === "diverged" ? lineageResult.mismatch : undefined
          runTransformHook(pipeline, "onSession", {
            adapter: adapterBase,
            lineage: lineageResult.type,
            reason: lineageResult.type === "diverged" ? lineageResult.reason : undefined,
            sessionKey: profileSessionId,
            storedCount: mismatch?.storedCount,
            incomingCount: (body.messages || []).length,
            prefixOverlap: lineageResult.type === "diverged" ? lineageResult.prefixOverlap : undefined,
            mismatch: mismatch && mismatch.index >= 0 ? {
              index: mismatch.index,
              storedDigest: mismatch.storedDigest,
              incomingDigest: mismatch.incomingDigest,
              previousDigest: mismatch.previousDigest,
              incomingShape: mismatch.incomingShape,
            } : undefined,
          }, adapterBase)
        }

        let isResume = lineageResult.type === "continuation" || lineageResult.type === "compaction"
        const isUndo = lineageResult.type === "undo"
        const cachedSession = lineageResult.type !== "diverged" ? lineageResult.session : undefined
        let resumeSessionId = cachedSession?.claudeSessionId
        // --- Passthrough mode ---
        // When enabled, ALL tool execution is forwarded to OpenCode instead of
        // being handled internally. This enables multi-model agent delegation
        // (e.g., oracle on GPT-5.2, explore on Gemini via oh-my-opencode).
        // Adapter can override the global passthrough env var per-agent.
        // Droid always uses internal mode; OpenCode defers to the env var.
        // Instance passthrough override (#476) beats the adapter transform's
        // default, which beats the global env var.
        const passthrough = adapter.instancePassthrough !== undefined
          ? adapter.instancePassthrough
          : pipelineCtx.passthrough !== undefined
            ? pipelineCtx.passthrough
            : envBool("PASSTHROUGH")
        const resumeFrom = lineageResult.type === "continuation" || lineageResult.type === "compaction"
          ? lineageResult.resumeFrom
          : undefined
        const resumeContentFrom = lineageResult.type === "continuation"
          ? lineageResult.resumeContentFrom
          : undefined
        // For undo: fork the session at the rollback point
        const undoRollbackUuid = isUndo && lineageResult.type === "undo" ? lineageResult.rollbackUuid : undefined
        // Early-stopped sessions resume at the assistant tool-use turn, before synthetic denials.
        let passthroughToolCallAssistantUuid = passthrough && isResume ? cachedSession?.passthroughToolCallAssistantUuid : undefined
        const passthroughToolCallIds = passthrough && isResume ? cachedSession?.passthroughToolCallIds : undefined

        // Debug: log request details
        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        const lineageType = lineageResult.type === "diverged" && !cachedSession ? "new" : lineageResult.type
        const msgCount = Array.isArray(body.messages) ? body.messages.length : 0
        const toolCount = body.tools?.length ?? 0
        const sdkSnapshot = sdkSemaphore.snapshot
        const requestLogLine = `${requestMeta.requestId} adapter=${adapter.name}${requestSource ? ` source=${requestSource}` : ""}${profile.id !== "default" ? ` profile=${profile.id}${routingMode === "sticky" ? "(sticky)" : options.forcedProfileId ? "(priority)" : ""}` : ""} model=${model} stream=${stream} tools=${toolCount} lineage=${lineageType} session=${resumeSessionId?.slice(0, 8) || "new"}${isUndo && undoRollbackUuid ? ` rollback=${undoRollbackUuid.slice(0, 8)}` : ""}${agentMode ? ` agent=${agentMode}` : ""} sdkActive=${sdkSnapshot.active}/${sdkSnapshot.limit} sdkQueued=${sdkSnapshot.queued} sessionWait=${requestMeta.sessionQueueWaitMs}ms msgCount=${msgCount}`
        plog(`[PROXY] ${requestLogLine} msgs=${msgSummary}`)
        diagnosticLog.session(`${requestLogLine}`, requestMeta.requestId)

        // Recovery logging: when a session diverges, check if the store has a
        // previous session ID that the user can recover via `claude --resume`.
        if (lineageResult.type === "diverged" && profileSessionId && !isIndependentSession) {
          const recovery = lookupSessionRecovery(profileSessionId)
          if (recovery) {
            const prevId = recovery.previousClaudeSessionId || recovery.claudeSessionId
            const recoveryMsg = `${requestMeta.requestId} SESSION RECOVERY: previous conversation available. Run: claude --resume ${prevId}`
            plog(`[PROXY] ${recoveryMsg}`)
            diagnosticLog.session(recoveryMsg, requestMeta.requestId)
          }
        }

        claudeLog("request.received", {
          model,
          stream,
          queueWaitMs: totalQueueWaitMs(requestMeta),
          sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
          sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system)
        })

      // SDK agent definitions and system context from the transform pipeline.
      const sdkAgents = pipelineCtx.sdkAgents
      const validAgentNames = Object.keys(sdkAgents)
      if ((process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) && validAgentNames.length > 0) {
        claudeLog("debug.agents", { names: validAgentNames, count: validAgentNames.length })
      }
      systemContext = pipelineCtx.systemContext ?? systemContext



      // Adapter-scoped sanitize options (see sanitize.ts).
      const sanitizeOpts: import("./sanitize").SanitizeOptions = {
        stripSystemReminder: pipelineCtx.leaksCwdViaSystemReminder,
        // Escape hatch for harnesses observed leaking raw <thinking> tags into
        // user-authored prompts that haven't been surveyed here. No adapter
        // sets this — a survey of opencode, crush, pi, droid and codex found
        // none injecting it — and it stays off by default because deleting a
        // user's own chain-of-thought is worse than echoing a stray tag.
        stripThinking: env("STRIP_THINKING") === "1",
      }

      // When resuming, only send new messages the SDK doesn't have.
      const allMessages = body.messages || []
      let messagesToConvert: typeof allMessages

      if ((isResume || isUndo) && cachedSession) {
        if (isUndo && undoRollbackUuid) {
          // Undo with SDK rollback: the SDK will fork to the correct point,
          // so we only need to send the new user message.
          messagesToConvert = getLastUserMessage(allMessages)
        } else if (isResume) {
          if (
            resumeFrom !== undefined &&
            resumeContentFrom !== undefined &&
            resumeFrom < allMessages.length &&
            Array.isArray(allMessages[resumeFrom]?.content)
          ) {
            const boundaryMessage = allMessages[resumeFrom]!
            messagesToConvert = [
              {
                ...boundaryMessage,
                content: boundaryMessage.content.slice(resumeContentFrom),
              },
              ...allMessages.slice(resumeFrom + 1),
            ]
          } else if (resumeFrom !== undefined && resumeFrom < allMessages.length) {
            messagesToConvert = allMessages.slice(resumeFrom)
          } else {
            messagesToConvert = getLastUserMessage(allMessages)
          }
        } else {
          // Undo without UUID (legacy session) — fall back to last user message
          // to avoid the catastrophic flat text replay.
          messagesToConvert = getLastUserMessage(allMessages)
        }
      } else {
        messagesToConvert = allMessages
      }

      // Rewinding to a tool-use checkpoint is valid only when the immediate
      // delta settles that exact batch. Partial, late, duplicate, or unknown
      // results get one safe fresh replay rather than an invalid SDK resume.
      if (
        passthroughToolCallAssistantUuid &&
        !isCompleteToolResultContinuation(messagesToConvert, passthroughToolCallIds ?? [])
      ) {
        claudeLog("passthrough.checkpoint_replay", {
          expectedToolIds: passthroughToolCallIds?.length ?? 0,
          reason: "incomplete_or_mismatched_results",
        })
        isResume = false
        resumeSessionId = undefined
        passthroughToolCallAssistantUuid = undefined
        messagesToConvert = allMessages
      }

      // Multimodal blocks and passthrough tool results must remain structured.
      // In particular, a continuation resumed at an assistant tool_use expects
      // the client's real tool_result blocks, not a flattened transcript string.
      const hasMultimodal = messagesToConvert?.some((m: any) => hasMultimodalContent(m.content))
      const hasPassthroughToolResults = Boolean(passthroughToolCallAssistantUuid) &&
        messagesToConvert?.some((m: any) =>
          m.role === "user" && Array.isArray(m.content) &&
          m.content.some((block: any) => block?.type === "tool_result"))

      // Build the prompt — either structured or text.
      // Structured prompts are stored as arrays so they can be replayed on retry.
      let structuredMessages: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> | undefined
      let textPrompt: string | undefined

      if (hasMultimodal || hasPassthroughToolResults) {
        // Structured messages preserve image/document/file and tool_result blocks.
        // On resume, only send user messages (SDK has assistant context already).
        // On first request, include everything.
        structuredMessages = []

        if (isResume) {
          // Resume: only send user messages from the delta (SDK has the rest)
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structuredMessages.push({
                type: "user" as const,
                message: { role: "user" as const, content: normalizeStructuredUserContent(
                  stripCacheControlDeep(m.content),
                  Boolean(passthroughToolCallAssistantUuid)
                ) },
                parent_tool_use_id: null,
              })
            }
          }
        } else {
          // First request: all messages (system context now passed via appendSystemPrompt)
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structuredMessages.push({
                type: "user" as const,
                message: { role: "user" as const, content: normalizeStructuredUserContent(
                  stripCacheControlDeep(m.content),
                  Boolean(passthroughToolCallAssistantUuid)
                ) },
                parent_tool_use_id: null,
              })
            } else {
              // Drops tool_use blocks and skips tool-use-only assistant messages
              // (flattenAssistantContent returns "" for those).
              const assistantText = flattenAssistantContent(m.content)
              if (assistantText) {
                structuredMessages.push({
                  type: "user" as const,
                  message: { role: "user" as const, content: `[Assistant: ${assistantText}]` },
                  parent_tool_use_id: null,
                })
              }
            }
          }
        }

        // The SDK only surfaces multimodal blocks from the LAST user turn of a
        // streamed prompt; images sitting in earlier turns (e.g. a read-tool
        // result mid-conversation) are otherwise dropped and the model replies
        // "I cannot see the image" (#553). Move them onto the final user turn.
        if (structuredMessages.length > 1) {
          structuredMessages = consolidateMultimodalOntoLastUser(structuredMessages)
        }

      } else {
        // Text prompt — convert messages to string.
        // Sanitize each text block before flattening to strip orchestration
        // wrappers (<env>, <task_metadata>, etc.) that harnesses inject.
        // `<system-reminder>` is only stripped for adapters that leak CWD
        // through it (Droid) — preserved otherwise so that harness state
        // like oh-my-opencode's background-task IDs reaches the model.
        // Tool-result attribution is indexed from the FULL history so ids
        // resolve even when the originating call sits before a resume-delta
        // boundary (#552).
        const toolIndex = buildToolUseIndex(allMessages ?? messagesToConvert ?? [])
        // NEVER render 'Human:'/'Assistant:' transcript lines — the model
        // imitates that format, emitting 'Human: ...' turns itself and
        // self-approving actions (#496 self-talk). Match the structured
        // path's proven convention instead: user turns plain, assistant
        // turns bracketed as '[Assistant: ...]'. On resume, drop assistant
        // messages entirely — the resumed SDK session already contains
        // those turns; replaying them as user text is the imitation seed.
        const promptTurns = (messagesToConvert ?? [])
          .map((m: { role: string; content: any }) => {
            if (m.role === "assistant") {
              if (isResume) return { role: "assistant", text: "" }
              const assistantText = flattenAssistantContent(m.content)
              return { role: "assistant", text: assistantText ? `[Assistant: ${assistantText}]` : "" }
            }
            return { role: "user", text: flattenUserContent(m.content, sanitizeOpts, toolIndex) }
          })
        // Fresh (non-resume) replays get the #619 anti-self-play envelope:
        // history framed as context-only, the live user message terminal.
        // Resume deltas are tail-only and stay bare.
        const resumeDelta = promptTurns.map((t: { text: string }) => t.text).filter(Boolean).join("\n\n") || ""
        textPrompt = isResume ? resumeDelta : frameReplayTurns(promptTurns)
      }

      // Create a fresh prompt value — can be called multiple times for retry
      function makePrompt(): string | AsyncIterable<any> {
        if (structuredMessages) {
          const msgs = structuredMessages
          return (async function* () { for (const msg of msgs) yield msg })()
        }
        return textPrompt!
      }

      // SDK setting sources — controls CLAUDE.md and user settings loading.
      const settingSources: import("@anthropic-ai/claude-agent-sdk").SettingSource[] =
        envBool("LOAD_CONTEXT") || sdkFeatures.claudeMd === "full"
          ? ["user", "project"]
          : sdkFeatures.claudeMd === "project"
            ? ["project"]
            : pipelineCtx.settingSources ?? []

      // Passthrough tool_use capture. `capturedToolUses` holds the DISTINCT
      // tool calls to forward to the client; `capturedSignatures` dedupes them
      // by (name, input) so an SDK internal continuation turn re-emitting a
      // blocked call (same args, new id) is dropped instead of concatenated
      // into the response (fixes #528). `sawDuplicateToolUse` records that such
      // a re-emit happened — the signal the model has stopped making progress
      // and started repeating, which the non-streaming loop uses to return the
      // distinct set immediately rather than burning the whole turn budget.
      const capturedToolUses: Array<{ id: string; name: string; input: any }> = []
      const capturedSignatures = new Set<string>()
      const capturedToolNames = new Set<string>()
      // Calls the hook DROPPED (exact duplicate / forced-single overflow /
      // legacy same-tool repeat). The model was told these were NOT forwarded,
      // so the client must never see them — the merge strips them from the
      // response. Without this, a forced-single parallel emission returned
      // BOTH tool_use blocks (unparseable for generateObject) and the
      // model/client views diverged (#552 misattribution family).
      const droppedToolUseIds = new Set<string>()
      let sawDuplicateToolUse = false
      // Stable checkpoint tracking: observe the forwarded assistant tool turn
      // and every synthetic denial, but do NOT abort at that point. A live PTY
      // E2E proved those iterator messages can precede the CLI's durable JSONL
      // write; aborting there left only the initial user message on disk, so
      // resumeSessionAt failed with `missing-message`. We therefore drain the
      // hidden digest to a canonical SDK terminal result, suppress its content,
      // and store the earlier assistant UUID only after the drain completes.
      const earlyStopEnabled = passthrough && process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP !== "0"
      const earlyStop = createEarlyStopTracker()
      let earlyStopFired = false
      // Deny-hold: the CLI dispatches each tool's PreToolUse hook AS SOON AS
      // that block finishes streaming — while later parallel blocks are still
      // generating — and a deny landing mid-generation makes the CLI CANCEL
      // the in-flight API request (observed live via scripts/e2e-stream-parallel.mjs:
      // bash's deny arrived between glob's input deltas; glob's block never
      // received its stop and turn 2 regenerated it). That cancel is what
      // beheads trailing parallel calls (#552 red reads: `glob {}` aborted)
      // and re-loops the model. Fix: hold every deny response until turn-1
      // generation completes (message_delta observed), so the cancel can
      // never land mid-generation. Timeout is a deadlock backstop in case a
      // CLI version serializes hook-then-stream.
      // Envelope integrity: violations of the proxy's own output contract
      // (dangling blocks, undelivered captured calls, empty required tool
      // inputs). Logged loudly + counted on /telemetry so #552-family
      // regressions trip an alarm in OUR logs instead of user transcripts.
      const envelopeViolations: string[] = []
      const recordEnvelopeViolations = (violations: EnvelopeViolation[]): void => {
        for (const v of violations) {
          envelopeViolations.push(v.type)
          claudeLog("envelope.violation", { type: v.type, detail: v.detail })
          diagnosticLog.error(`${requestMeta.requestId} ENVELOPE VIOLATION [${v.type}] ${v.detail}`, requestMeta.requestId)
        }
      }
      const DENY_HOLD_TIMEOUT_MS = 8000
      const pendingDenyReleases: Array<() => void> = []
      // True while a model turn is actively generating (message_start seen,
      // no message_delta/message_stop yet). Hooks dispatched AFTER generation
      // completes (the CLI runs tool dispatch semi-sequentially, so later
      // hooks can fire post-turn) must NOT hold — there is no in-flight
      // request left to protect, and holding would only add dead time.
      let turnGenerating = false
      const releaseHeldDenies = (reason: string): void => {
        turnGenerating = false
        if (pendingDenyReleases.length === 0) return
        claudeLog("passthrough.deny_hold_released", { reason, count: pendingDenyReleases.length })
        for (const release of pendingDenyReleases.splice(0)) release()
      }
      const holdDenyUntilTurnEnd = (): Promise<void> =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            claudeLog("passthrough.deny_hold_timeout", { afterMs: DENY_HOLD_TIMEOUT_MS })
            resolve()
          }, DENY_HOLD_TIMEOUT_MS)
          pendingDenyReleases.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      // Forced structured output: a `tool_choice` of {type:"tool",...} (or an
      // explicit disable_parallel_tool_use) means the client — e.g. the AI
      // SDK's generateObject — wants EXACTLY ONE call to that tool. Claude
      // Code's nested loop, prodded by the forced choice, re-calls the tool
      // across internal turns with slightly different arguments; those are
      // distinct signatures, so signature-dedup alone wouldn't collapse them
      // and the response would concatenate multiple JSON objects (unparseable).
      // When the client forces a single tool, keep only the first capture.
      const toolChoice = body.tool_choice
      const forceSingleToolUse =
        !!toolChoice && (toolChoice.type === "tool" || toolChoice.disable_parallel_tool_use === true)
      const fileChanges: FileChange[] = []

      // In passthrough mode, register OpenCode's tools as MCP tools so Claude
      // can actually call them (not just see them as text descriptions).
      // Tool cache: if the client omits tools on a continuation request but
      // previously sent them, reuse the cached set to preserve prompt cache.
      let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
      let requestTools = Array.isArray(body.tools) ? body.tools : []
      // Extract advisor model from tools and strip advisor tool definitions
      // before passing to passthrough MCP — the SDK handles advisors natively
      // via the advisorModel query option.
      const advisorModel = extractAdvisorModel(requestTools)
      if (advisorModel) {
        requestTools = stripAdvisorTools(requestTools)
      }
      if (passthrough && requestTools.length === 0 && profileSessionId) {
        const cached = sessionToolCache.get(profileSessionId)
        if (cached && cached.length > 0) {
          requestTools = cached
          plog(`[PROXY] ${requestMeta.requestId} tools_restored: client sent 0 tools but session had ${cached.length} — reusing cached tools to preserve prompt cache`)
        }
      }
      if (passthrough && requestTools.length > 0) {
        const toolSetKey = computeToolSetKey(requestTools)
        const cachedMcp = profileSessionId ? sessionMcpCache.get(profileSessionId) : undefined
        if (cachedMcp && cachedMcp.key === toolSetKey) {
          passthroughMcp = cachedMcp.mcp
        } else {
          passthroughMcp = createPassthroughMcpServer(requestTools, pipelineCtx.coreToolNames ? [...pipelineCtx.coreToolNames] : undefined)
          if (profileSessionId) {
            sessionMcpCache.set(profileSessionId, { key: toolSetKey, mcp: passthroughMcp })
            if (cachedMcp) {
              plog(`[PROXY] ${requestMeta.requestId} tools_changed: MCP server recreated (prompt cache likely invalidates)`)
            }
          }
        }
        if (profileSessionId) sessionToolCache.set(profileSessionId, requestTools)
      }
      const hasDeferredTools = passthroughMcp?.hasDeferredTools ?? false
      // Count deferred tools: when auto-defer is active, non-core tools are deferred
      const coreNames = pipelineCtx.coreToolNames ? [...pipelineCtx.coreToolNames] : undefined
      const coreSet = coreNames ? new Set(coreNames.map(n => n.toLowerCase())) : undefined
      const deferredToolCount = hasDeferredTools && requestTools.length > 0
        ? requestTools.filter((t: any) => t.defer_loading === true || (coreSet && !coreSet.has(String(t.name).toLowerCase()))).length
        : 0
      if (hasDeferredTools) {
        plog(`[PROXY] ${requestMeta.requestId} deferred=${deferredToolCount}/${toolCount} tools (core: ${coreNames?.join(",") ?? "none"})`)
      }

      // In passthrough mode: block ALL tools, capture them for forwarding (agent-agnostic).
      // In normal mode: delegate hook construction to the adapter.
      // PostToolUse hook tracks file changes from MCP tools (internal mode only).
      // Catches write, edit, AND bash redirects (>, >>, tee, sed -i).
      const mcpPrefix = `mcp__${adapter.getMcpServerName()}__`
      const trackFileChanges = !(process.env.MERIDIAN_NO_FILE_CHANGES ?? process.env.CLAUDE_PROXY_NO_FILE_CHANGES)
        && pipelineCtx.shouldTrackFileChanges
      const fileChangeHook = trackFileChanges ? createFileChangeHook(fileChanges, mcpPrefix) : undefined

      // Track tools discovered via ToolSearch (deferred tools that get called)
      const discoveredTools = new Set<string>()

      const sdkHooks = passthrough
        ? {
            PreToolUse: [{
              matcher: "",  // Match ALL tools
              hooks: [async (input: any) => {
                // Let the SDK handle ToolSearch internally for deferred tool loading.
                // ToolSearch is filtered from the response stream below.
                // Return {} — NOT undefined. SDK validates hook returns with Zod and
                // rejects undefined ("expected object, received undefined"), which also
                // cascades into "Reached maximum number of turns (2)". {} is the no-op.
                if (input.tool_name === "ToolSearch") return {}
                // StructuredOutput is the SDK-internal tool that implements
                // native output_config.format — the CLI injects it whenever
                // outputFormat is set, and schema validation + retry live
                // inside the nested session. Denying it as a client
                // passthrough tool blocks the model from ever submitting its
                // result: the session burns to max_turns and the result
                // message arrives without structured_output (HTTP 500). Let
                // the SDK handle it internally, and never capture it as a
                // client tool_use.
                if (input.tool_name === "StructuredOutput") return {}
                // Track deferred tools that were discovered via ToolSearch
                const toolName = stripMcpPrefix(input.tool_name)
                if (hasDeferredTools && coreSet && !coreSet.has(toolName.toLowerCase())) {
                  discoveredTools.add(toolName)
                }
                // Normalize parameter names: the SDK system prompt references
                // built-in tools with snake_case params (file_path), but clients
                // may use camelCase (filePath). Remap when required fields are missing.
                const clientTool = requestTools.find((t: any) => t.name === toolName)
                // NOTE: agent-specific — normalize subagent_type for the client response.
                // Claude often sends PascalCase (e.g., "Explore") and aliases
                // (e.g., "general-purpose") that OpenCode rejects. We send the
                // canonical lowercase agent name that OpenCode's config declares.
                let toolInput = normalizeToolInput(input.tool_input, clientTool?.input_schema)
                if (toolName.toLowerCase() === "task" && toolInput?.subagent_type && typeof toolInput.subagent_type === "string") {
                  toolInput = { ...toolInput, subagent_type: resolveAgentAlias(toolInput.subagent_type, validAgentNames) }
                }
                // Decide whether to forward this captured tool_use, or drop it
                // as an artifact of the nested SDK's internal loop. In
                // passthrough the CLIENT executes tools and returns real
                // results, so the model should only emit ONE logical step of
                // tool calls per request — but Claude Code blocks each call and
                // lets the model keep going, so it fabricates results and loops.
                // Three cases collapse that loop back to the client-facing set:
                //   1. Exact re-emit (same name+input, fresh id): a blocked call
                //      re-surfaced on a later internal turn. Drop it, but keep
                //      collecting — a genuine parallel call to a DIFFERENT tool
                //      may still follow (robust to duplicate-before-distinct
                //      ordering). This is the #528 duplication.
                //   2. Same tool re-called with NEW args — LEGACY (kill switch
                //      only). #571 assumed genuine parallelism uses DISTINCT
                //      tool names, but "read three files" makes the model emit
                //      parallel same-tool calls in ONE assistant message; the
                //      drop + mid-hook SIGTERM cut the already-streamed second
                //      block (#552 "red reads": `read {}` aborted), skipped the
                //      session store, and pushed the follow-up onto a fresh
                //      replay full of "[your read ...]: Tool execution aborted"
                //      lines the model then disowned. With early stop, the
                //      fabricated-loop turns this rule guarded against never
                //      generate (the query stops the moment every deny is
                //      checkpointed), so same-tool-new-args calls are genuine
                //      parallelism and are captured. The drop remains only
                //      when the operator disables early stop.
                //   3. Forced single tool (tool_choice:{type:"tool"} / structured
                //      output): keep only the first call.
                // Cases 2 and 3 set sawDuplicateToolUse, the signal the non-
                // streaming loop uses to return the distinct set immediately
                // instead of draining the whole turn budget.
                const signature = toolUseSignature(toolName, toolInput)
                const isExactDuplicate = capturedSignatures.has(signature)
                // Once the real tool turn's checkpoint is complete, any later
                // call belongs to the hidden digest turn. Never add it to the
                // client-visible set, even when it uses a different tool/args.
                const isPostCheckpointCall = earlyStopFired
                const isSameToolRepeat = !earlyStopEnabled && !isExactDuplicate && capturedToolNames.has(toolName)
                const exceedsForcedSingle = forceSingleToolUse && capturedToolUses.length >= 1
                if (isExactDuplicate || isPostCheckpointCall) {
                  droppedToolUseIds.add(input.tool_use_id)
                  claudeLog("passthrough.duplicate_tool_use_dropped", {
                    name: toolName,
                    reason: isPostCheckpointCall ? "hidden_digest" : "exact_duplicate",
                  })
                } else if (isSameToolRepeat || exceedsForcedSingle) {
                  droppedToolUseIds.add(input.tool_use_id)
                  sawDuplicateToolUse = true
                  claudeLog("passthrough.extra_tool_use_dropped", {
                    name: toolName,
                    reason: exceedsForcedSingle ? "forced_single" : "same_tool_repeat",
                  })
                  // Every distinct tool_use for this exchange is captured and the
                  // model is now looping against blocked tools — kill the nested
                  // SDK session immediately instead of letting it generate denied
                  // retries until the turn budget runs out (#570). Hook-level
                  // `interrupt: true` / `continue: false` cannot do this: neither
                  // key exists in the CLI's hook-output schema, so both are
                  // stripped before the deny is processed (verified against the
                  // real SDK). Aborting the query's controller SIGTERMs the
                  // subprocess; the abort-shaped termination is converted into a
                  // clean stop_reason:"tool_use" response by the recovery paths.
                  requestAbort.abort("passthrough single-step complete")
                } else {
                  capturedSignatures.add(signature)
                  capturedToolNames.add(toolName)
                  capturedToolUses.push({
                    id: input.tool_use_id,
                    name: toolName,
                    input: toolInput,
                  })
                }
                // The reason text is read by the model as the "tool result" of
                // a denied call. With a vague reason ("Forwarding to client for
                // execution") modern Claude tends to retry with a different
                // tool, burning the maxTurns budget. Be explicit about what
                // actually happened and that the model should stop here — see
                // telemetry for the failure mode this addresses.
                //
                // The reason MUST match the call's fate (#552): dropped calls
                // (same-tool repeat / forced single) are NOT forwarded, and a
                // false "result will be delivered" promise persists in the
                // resumed session's history — next turn the model remembers a
                // pending call whose result never arrives and misattributes
                // the results it does receive ("the read tool is returning
                // the wrong file").
                // Hold the deny until turn-1 generation completes — BOTH
                // modes (see holdDenyUntilTurnEnd above). Returning it
                // immediately lets the CLI cancel the in-flight generation and
                // behead any parallel call still generating after this one
                // (#625 streaming; #592 proved non-stream identically). The
                // streaming path flags turnGenerating from message_start; the
                // non-stream path pre-sets it per attempt and releases when
                // the turn's assistant message arrives in the iterator.
                // Skip when the query is already aborted (forced-single fired
                // requestAbort above — the subprocess is dying; holding would
                // only delay until the timeout).
                if (earlyStopEnabled && turnGenerating && !requestAbort.controller.signal.aborted) {
                  await holdDenyUntilTurnEnd()
                }
                if (isExactDuplicate || isPostCheckpointCall) {
                  return {
                    decision: "block" as const,
                    reason:
                      "This tool call has already been handled by the client-facing turn — do not repeat it. " +
                      "Do not call additional tools and do not generate further text — end your turn now.",
                  }
                }
                if (isSameToolRepeat || exceedsForcedSingle) {
                  return {
                    decision: "block" as const,
                    reason:
                      "This tool call was NOT executed and was not forwarded. Your earlier tool call(s) " +
                      "are being returned to the client now; their results arrive next turn. Re-issue this " +
                      "call after that if it is still needed. Do not call additional tools and do not " +
                      "generate further text — end your turn now.",
                  }
                }
                return {
                  decision: "block" as const,
                  reason:
                    "This tool call has been forwarded to the client for execution. " +
                    "The result will be delivered in a future turn. " +
                    "Do not retry, do not call additional tools, and do not generate further text — end your turn now.",
                }
              }],
            }],
          }
        : {
            ...(pipelineCtx.sdkHooks ?? {}),
            ...(fileChangeHook ? { PostToolUse: [fileChangeHook] } : {}),
          }

        // Capture subprocess stderr for all paths — used to surface the real
        // failure message when the Claude subprocess exits with a non-zero code.
        const stderrLines: string[] = []
        const onStderr = (data: string) => {
          stderrLines.push(data.trimEnd())
          claudeLog("subprocess.stderr", { line: data.trimEnd() })
        }

        if (!stream) {
          const contentBlocks: Array<Record<string, unknown>> = []
          let assistantMessages = 0
          let hasStructuredOutput = false
          let structuredOutput: unknown
          const upstreamStartAt = Date.now()
          let firstChunkAt: number | undefined
          let currentSessionId: string | undefined

          // Build SDK UUID map: start with previously stored UUIDs (if resuming),
          // then capture new ones from the response. Declared outside try so
          // storeSession (in the finally/after block) can access it.
          // Start empty when there's no cached session — the while-loop below
          // pads to allMessages.length. Previously initialized as
          // `new Array(allMessages.length - 1).fill(null)` which threw
          // RangeError when allMessages.length was 0. Cold-start requests
          // are now also rejected at the entrypoint (#450) but the defensive
          // initializer keeps any future reentry safe.
          let sdkUuidMap: Array<string | null> = (isResume || isUndo) && cachedSession?.sdkMessageUuids
            ? [...cachedSession.sdkMessageUuids]
            : []
          // Pad to current message count (the last user message has no UUID yet)
          while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

          claudeLog("upstream.start", { mode: "non_stream", model })
          let lastUsage: TokenUsage | undefined
          let lastStopReason: string | undefined
          let nextPassthroughToolCallAssistantUuid: string | undefined
          let nextPassthroughToolCallIds: string[] | undefined
          let sawCanonicalResult = false

          try {
            // Lazy-resolve executable if not already set (e.g. when using createProxyServer directly)
            if (!claudeExecutable) {
              claudeExecutable = await resolveClaudeExecutableAsync()
            }

            // Wrap SDK call with transparent retry for recoverable errors.
            // Both stale-UUID and rate-limit retries happen inside the generator,
            // so the message-processing loop doesn't need any retry logic.
            //
            // Rate-limit retry strategy:
            //   1. Strip [1m] context (immediate, different model tier)
            //   2. Backoff retries on base model (1s, 2s — exponential)
            const MAX_RATE_LIMIT_RETRIES = 2
            const RATE_LIMIT_BASE_DELAY_MS = 1000

            const response = (async function* () {
              let rateLimitRetries = 0

              // Proactive: refresh the access token if it's within the buffer
              // of expiry. Best-effort — the reactive 401 path below picks up
              // anything this misses. Saves a round-trip on the common case
              // where the previous request left the token close to expiry.
              if (profileCredentialStore) {
                await ensureFreshToken(profileCredentialStore).catch(() => { /* reactive path handles */ })
              }

              let tokenRefreshed = false
              let didFreshBaseRetry = false
              let resumeRefusalRetries = 0
              let busySessionFork = false
              let sawUnresumableRefusal = false
              while (true) {
                // Track whether response content was yielded.
                // The SDK emits metadata (session_id etc.) before the API call;
                // only "assistant" messages represent actual response content.
                let didYieldContent = false
                // stderr emitted by THIS attempt's subprocess only — retries
                // must not re-match a previous attempt's refusal text.
                const attemptStderrStart = stderrLines.length
                // #592: non-stream has no message_start signal — turn 1 is by
                // definition generating from query start until its assistant
                // message arrives (release sites: assistant arrival in the
                // consumer loop, attempt error, loop exit).
                turnGenerating = true
                try {
                  for await (const event of runSdkQueryAttempt(buildQueryOptions({
                    prompt: makePrompt(), model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                    resumeSessionId, isUndo, resumeSessionAtUuid: undoRollbackUuid ?? passthroughToolCallAssistantUuid, forkSession: busySessionFork || undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                    effort, thinking, taskBudget, outputFormat, betas, settingSources,
                    codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    webFetchPreflight: sdkFeatures.webFetchPreflight,
                    claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                    maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                    sdkDebug: sdkFeatures.sdkDebug,
                    additionalDirectories: sdkFeatures.additionalDirectories
                      ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                      : undefined,
                    advisorModel,
                  }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "non_stream")) {
                    // Capture Claude Max subscription quota updates emitted by
                    // the SDK as rate_limit_event. We snapshot them in this
                    // profile's slot of the (per-profile-scoped) rate limit
                    // store so /v1/usage/quota can return the latest live state.
                    if ((event as any).type === "rate_limit_event") {
                      rateLimitStore.record(profile.id, (event as any).rate_limit_info)
                    }
                    // Only count real assistant content — not SDK error messages
                    // (which arrive as type:"assistant" with an error field set).
                    // Counting error assistants as content would prevent retries.
                    if ((event as any).type === "assistant" && !(event as any).error) {
                      didYieldContent = true
                    }
                    yield event
                  }
                  return
                } catch (error) {
                  const errMsg = error instanceof Error ? error.message : String(error)

                  // #592: the attempt's subprocess is gone — release any deny
                  // still held for it so retries don't inherit dead holds.
                  releaseHeldDenies("non_stream_attempt_error")

                  // Never retry after response content was yielded — response is committed
                  if (didYieldContent) throw error

                  // Retry: the resume was refused, not answered. Both refusals
                  // that mean "not right now" — the session is busy, or it could
                  // not be opened at all — are produced in the exit window of
                  // this session's previous subprocess (early-stop drain or slow
                  // exit), with the session itself intact. Surfacing that would
                  // be a deterministic failure (the client's identical retry
                  // hits the same window) and evicting would destroy a live
                  // session, so wait for the stale process to exit and retry the
                  // SAME resume. A busy session can then be forked (full
                  // history, fresh id); an unresumable one offers nothing to
                  // branch and falls through to the replay below. The busy
                  // wording only ever arrives on stderr, and only matters where
                  // a resume was attempted, so the capture is read there alone.
                  const refusal = classifyResumeRefusal(error, resumeSessionId ? stderrLines.slice(attemptStderrStart).join("\n") : undefined)
                  if (refusal === "unresumable") sawUnresumableRefusal = true
                  if (resumeSessionId && (refusal === "busy" || refusal === "unresumable")) {
                    if (resumeRefusalRetries < RESUME_REFUSAL_MAX_RETRIES) {
                      resumeRefusalRetries++
                      claudeLog("session.resume_retry", { mode: "non_stream", refusal, attempt: resumeRefusalRetries, resumeSessionId })
                      plog(`[PROXY] ${requestMeta.requestId} resume refused (${refusal}), retrying ${resumeRefusalRetries}/${RESUME_REFUSAL_MAX_RETRIES}`)
                      await new Promise((resolve) => setTimeout(resolve, RESUME_REFUSAL_RETRY_DELAY_MS * resumeRefusalRetries))
                      continue
                    }
                    if (refusal === "busy" && !busySessionFork) {
                      busySessionFork = true
                      claudeLog("session.busy_fork", { mode: "non_stream", resumeSessionId })
                      plog(`[PROXY] ${requestMeta.requestId} session still busy after ${RESUME_REFUSAL_MAX_RETRIES} retries — forking session`)
                      continue
                    }
                  }

                  // The session cannot serve this turn: a message it must hold
                  // is gone, or it refused to open and has now spent every
                  // retry. Reaching here after such a refusal means the budget
                  // is gone whatever the last attempt was refused with, so a
                  // wording that alternates cannot escape to the client. Evict
                  // and replay the history as a fresh session (one-shot).
                  if (refusal === "missing-message" || sawUnresumableRefusal) {
                    claudeLog("session.resume_replay", {
                      mode: "non_stream",
                      refusal,
                      rollbackUuid: undoRollbackUuid,
                      resumeSessionId,
                    })
                    plog(`[PROXY] ${requestMeta.requestId} session unusable (${refusal}), evicting and replaying as fresh session`)
                    evictSession(profileSessionId, profileScopedCwd, allMessages)
                    sdkUuidMap.length = 0
                    for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                    yield* runSdkQueryAttempt(buildQueryOptions({
                      prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                      model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                      resumeSessionId: undefined, isUndo: false, resumeSessionAtUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, outputFormat, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    webFetchPreflight: sdkFeatures.webFetchPreflight,
                    claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "non_stream_fresh")
                    return
                  }

                  // Extra Usage required: strip [1m] and record 1-hour cooldown.
                  // mapModelToClaudeModel will skip [1m] for the next hour so
                  // subsequent requests don't each make one extra failed attempt.
                  // After the hour expires a single probe fires; if the user has
                  // enabled Extra Usage in the meantime it succeeds and the flag clears.
                  if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(model)) {
                    const from = model
                    model = stripExtendedContext(model)
                    recordExtendedContextUnavailable()
                    claudeLog("upstream.context_fallback", {
                      mode: "non_stream",
                      from,
                      to: model,
                      reason: "extra_usage_required",
                    })
                    plog(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${model} (skipping [1m] for 1h)`)
                    continue
                  }

                  if (isExtraUsageRequiredError(errMsg) && resumeSessionId && !didFreshBaseRetry) {
                    didFreshBaseRetry = true
                    claudeLog("upstream.session_fallback", {
                      mode: "non_stream",
                      model,
                      reason: "extra_usage_required_resume",
                    })
                    plog(`[PROXY] ${requestMeta.requestId} extra usage persisted on resumed ${model}, retrying as fresh session`)
                    evictSession(profileSessionId, profileScopedCwd, allMessages)
                    sdkUuidMap.length = 0
                    for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                    yield* runSdkQueryAttempt(buildQueryOptions({
                      prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                      model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                      resumeSessionId: undefined, isUndo: false, resumeSessionAtUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, outputFormat, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                      memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    webFetchPreflight: sdkFeatures.webFetchPreflight,
                    claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "non_stream_fresh")
                    return
                  }

                  // Expired OAuth token: refresh once and retry
                  if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
                    tokenRefreshed = true
                    const refreshed = profileCredentialStore
                      ? await refreshOAuthToken(profileCredentialStore)
                      : false
                    if (refreshed) {
                      claudeLog("token_refresh.retrying", { mode: "non_stream" })
                      plog(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
                      continue
                    }
                    // Refresh failed — fall through and surface the error
                  }

                  // Rate-limit retry: first strip [1m] (free, different tier), then backoff
                  if (isRateLimitError(errMsg)) {
                    if (hasExtendedContext(model)) {
                      const from = model
                      model = stripExtendedContext(model)
                      claudeLog("upstream.context_fallback", {
                        mode: "non_stream",
                        from,
                        to: model,
                        reason: "rate_limit",
                      })
                      plog(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                      continue
                    }
                    if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                      rateLimitRetries++
                      const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
                      claudeLog("upstream.rate_limit_backoff", {
                        mode: "non_stream",
                        model,
                        attempt: rateLimitRetries,
                        maxAttempts: MAX_RATE_LIMIT_RETRIES,
                        delayMs: delay,
                      })
                      plog(`[PROXY] ${requestMeta.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
                      await new Promise(r => setTimeout(r, delay))
                      continue
                    }
                  }

                  throw error
                }
              }
            })()

            for await (const message of response) {
              // Capture session ID from SDK messages
              if ((message as any).session_id) {
                currentSessionId = (message as any).session_id
              }
              // Passthrough single-turn guard: once the model re-emits a call it
              // already made (detected in the PreToolUse hook between turns), it
              // has stopped making progress and is looping against the blocked
              // tool. Every distinct tool_use for this exchange is already in
              // capturedToolUses, so stop draining the SDK's internal loop —
              // this returns the full parallel set while avoiding the maxTurns
              // exhaustion that otherwise 500s a client-driven tool loop.
              if (passthrough && sawDuplicateToolUse) {
                claudeLog("passthrough.loop_break", { mode: "non_stream", assistantMessages, captured: capturedToolUses.length })
                break
              }
              // Checkpoint settlement: the deny tool_results identify when all
              // visible calls have been handled. Freeze that assistant boundary,
              // then keep draining; iterator observation alone is not durable.
              let assistantAddedForwardedCall = false
              if (
                passthrough &&
                message.type === "assistant" &&
                !earlyStopFired &&
                earlyStop.resolved.size === 0
              ) {
                // Non-stream can expose a parallel tool turn as several
                // assistant fragments. They all precede the first synthetic deny;
                // later assistants are the hidden digest. Stop extending the
                // checkpoint once any deny is consumed, and do not use the hook
                // set as an oracle because a producer-side digest hook can race
                // ahead of iterator consumption.
                const expectedBefore = earlyStop.expected.size
                noteAssistantMessage(earlyStop, message)
                assistantAddedForwardedCall = earlyStop.expected.size > expectedBefore
              } else if (passthrough && message.type === "user" && !earlyStopFired) {
                noteUserContent(earlyStop, (message as any).message?.content)
                if (earlyStopEnabled && shouldEarlyStop(earlyStop)) {
                  nextPassthroughToolCallAssistantUuid = settledToolCallAssistantUuid(earlyStop)
                  nextPassthroughToolCallIds = [...earlyStop.expected]
                  earlyStopFired = true
                  // A digest hook can race just ahead of iterator consumption.
                  // Retain only calls proven to belong to the visible assistant
                  // checkpoint; later hooks see earlyStopFired and are dropped.
                  for (let i = capturedToolUses.length - 1; i >= 0; i--) {
                    if (!earlyStop.expected.has(capturedToolUses[i]!.id)) capturedToolUses.splice(i, 1)
                  }
                  // The iterator boundary is not a durability acknowledgement.
                  // Keep consuming through the hidden digest and canonical SDK
                  // result before storing this assistant checkpoint.
                  claudeLog("passthrough.checkpoint_ready", {
                    mode: "non_stream",
                    captured: capturedToolUses.length,
                    toolCallAssistantUuid: nextPassthroughToolCallAssistantUuid,
                  })
                }
              }
              if (message.type === "assistant") {
                // #592: the turn's generation is complete — held denies can
                // return without the CLI cancelling anything in flight.
                releaseHeldDenies("assistant_message")
                assistantMessages += 1
                // One Anthropic assistant response may combine several SDK
                // assistant fragments (for example parallel tool calls).
                if (!passthrough || earlyStop.expected.size === 0 || assistantAddedForwardedCall) {
                  sdkUuidMap = withClientAssistantUuid(
                    sdkUuidMap,
                    allMessages.length,
                    (message as any).uuid
                  )
                }
                if (!firstChunkAt) {
                  firstChunkAt = Date.now()
                  // Anchored on the attempt that produced this chunk, not on
                  // the handler's start: a request that replayed or failed
                  // over would otherwise report the abandoned attempts as TTFB.
                  requestMeta.ttfbMs ??= firstChunkAt - (requestMeta.currentSdkStartedAt ?? firstChunkAt)
                  claudeLog("upstream.first_chunk", {
                    mode: "non_stream",
                    model,
                    ttfbMs: requestMeta.ttfbMs
                  })
                }

                // Preserve content blocks, with two passthrough-specific guards:
                //
                // 1. Stop-after-tool-use: in passthrough mode the SDK runs 2 turns
                //    (maxTurns:2 is required to avoid SDK crash). Turn 1 is the real
                //    response containing the client's tool_use blocks. Turn 2 is an
                //    SDK artefact — Claude receives a blank tool result and generates
                //    a prose summary ("The edit has been forwarded..."). That Turn 2
                //    content must NOT be forwarded; it confuses the client into
                //    showing prose instead of executing + diff-rendering the tool_use.
                //
                // 2. Strip thinking blocks: type:"thinking" / type:"redacted_thinking"
                //    contain an encrypted signature that is only valid inside Claude's
                //    native context. Non-native clients (OpenCode, GPT-compat) have no
                //    renderer for them and may misinterpret or choke on the signature.
                const isPassthroughTurn2 =
                  passthrough &&
                  assistantMessages > 1 &&
                  contentBlocks.some((b) => b.type === "tool_use")

                if (isPassthroughTurn2) {
                  // Skip all content from Turn 2 onwards in passthrough mode
                  claudeLog("passthrough.turn2_skipped", { mode: "non_stream", assistantMessages })
                } else {
                  for (const block of message.message.content) {
                    const b = block as unknown as Record<string, unknown>
                    // Filter ToolSearch from non-streaming passthrough responses
                    if (b.type === "tool_use" && (b as any).name === "ToolSearch") {
                      claudeLog("passthrough.toolsearch_filtered", { mode: "non_stream" })
                      continue
                    }
                    // Internal chat clients (Cherry Studio): the SDK executed
                    // WebSearch/WebFetch itself. Hide the internal tool_use (the
                    // client can't run it and would loop) and strip thinking the
                    // client can't render — leave only the final grounded answer.
                    if (pipelineCtx.hidesInternalTools) {
                      if (b.type === "tool_use") {
                        claudeLog("internal_tool.hidden", { mode: "non_stream", name: (b as any).name })
                        continue
                      }
                      if ((b.type === "thinking" || b.type === "redacted_thinking") && !sdkFeatures.thinkingPassthrough) {
                        claudeLog("internal_tool.thinking_stripped", { mode: "non_stream", type: b.type })
                        continue
                      }
                    }
                    // Strip thinking blocks — meaningless to non-native clients
                    if (passthrough && !pipelineCtx.supportsThinking && !sdkFeatures.thinkingPassthrough && (b.type === "thinking" || b.type === "redacted_thinking")) {
                      claudeLog("passthrough.thinking_stripped", { mode: "non_stream", type: b.type })
                      continue
                    }
                    // In passthrough mode, strip MCP prefix from tool names
                    if (passthrough && b.type === "tool_use" && typeof b.name === "string") {
                      b.name = stripMcpPrefix(b.name as string)
                    }
                    contentBlocks.push(b)
                  }
                }
                // Capture token usage from the assistant message
                const msgUsage = message.message.usage as TokenUsage | undefined
                if (msgUsage) lastUsage = { ...lastUsage, ...msgUsage }
                if (!isPassthroughTurn2 && typeof message.message.stop_reason === "string") {
                  // Hidden digest turns are consumed only for durability; they
                  // must not replace the client-visible tool_use stop reason.
                  lastStopReason = message.message.stop_reason
                }
              }
              // The SDK emits a `result` message at the end of every non-streaming
              // request with the authoritative aggregate usage across all internal
              // iterations (top-level output_tokens is the sum, plus an
              // iterations[] breakdown). The per-assistant-message usage only
              // reports the LAST iteration's snapshot — which produces visibly
              // wrong output_tokens (typically 1) for any non-trivial response.
              // Prefer the result usage when present. See issue #449.
              if (message.type === "result") {
                sawCanonicalResult = true
                const resultUsage = (message as { usage?: unknown }).usage as TokenUsage | undefined
                if (resultUsage) {
                  lastUsage = { ...lastUsage, ...resultUsage }
                }
                if (outputFormat && "structured_output" in message) {
                  hasStructuredOutput = true
                  structuredOutput = message.structured_output
                }
              }
            }

            // #592: safety net — any deny still held at loop exit belongs to
            // a turn that is no longer generating.
            releaseHeldDenies("non_stream_loop_exit")

            claudeLog("upstream.completed", {
              mode: "non_stream",
              model,
              assistantMessages,
              durationMs: Date.now() - upstreamStartAt
            })
            if (lastUsage) logUsage(requestMeta.requestId, lastUsage)
            // Accumulate discovered tools into the session-level set
            const sessId = currentSessionId || resumeSessionId
            if (sessId && discoveredTools.size > 0) {
              if (!sessionDiscoveredTools.has(sessId)) sessionDiscoveredTools.set(sessId, new Set())
              for (const t of discoveredTools) sessionDiscoveredTools.get(sessId)!.add(t)
              const newNames = [...discoveredTools].join(", ")
              const allNames = [...sessionDiscoveredTools.get(sessId)!]
              plog(`[PROXY] ${requestMeta.requestId} discovered=${discoveredTools.size} (${newNames}) session_total=${allNames.length}`)
            }
          } catch (error) {
            // #592: mirror the loop-exit release on the failure path.
            releaseHeldDenies("non_stream_error")
            if (passthrough && capturedToolUses.length > 0 && !sawCanonicalResult) {
              // A failed durability drain must not leave either a newly cached
              // checkpoint or an older mapping behind for the advanced client.
              evictSession(profileSessionId, profileScopedCwd, body.messages || [])
              claudeLog("passthrough.noncanonical_session_evicted", { mode: "non_stream", reason: "drain_error" })
            }
            const stderrOutput = stderrLines.join("\n").trim()
            if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
              error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
            }
            // Graceful recovery — the non-streaming counterpart of the streaming
            // path's canRecoverAsToolUse branch. If the SDK hit its turn cap (or
            // was aborted) but the PreToolUse hook already captured tool_use
            // blocks, the client has everything it needs to run the tools and
            // drive the next turn. Fall through to the merge + normal response
            // build below instead of surfacing a 500. Distinct-only captures
            // that never triggered the loop-break (e.g. wide parallel exceeding
            // the turn budget) land here.
            const sdkTerm = extractSdkTermination(error instanceof Error ? error.message : String(error))
            const canRecoverAsToolUse = canRecoverCapturedToolUses({
              reason: sdkTerm.reason,
              passthrough,
              capturedToolUses: capturedToolUses.length,
              // No client-disconnect abort reaches this path.
              abortIsOurs: true,
            })
            if (canRecoverAsToolUse) {
              diagnosticLog.session(
                `${requestMeta.requestId} sdk_termination_recovered ${formatSdkTermination(sdkTerm, {
                  model, requestSource, isResume, hasDeferredTools, sdkSessionId: resumeSessionId,
                })} captured=${capturedToolUses.length}`,
                requestMeta.requestId,
              )
              claudeLog("passthrough.max_turns_recovered", {
                mode: "non_stream",
                reason: sdkTerm.reason,
                captured: capturedToolUses.length,
              })
              // Do not rethrow — execution continues into the merge block, which
              // backfills contentBlocks from capturedToolUses and builds a clean
              // stop_reason:"tool_use" response.
            } else {
              claudeLog("upstream.failed", {
                mode: "non_stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                error: error instanceof Error ? error.message : String(error),
                ...(stderrOutput ? { stderr: stderrOutput } : {})
              })
              throw error
            }
          }

          if (outputFormat) {
            if (!hasStructuredOutput) {
              throw new Error("Structured output was requested but the SDK returned no structured_output result")
            }
            contentBlocks.splice(0, contentBlocks.length, {
              type: "text",
              text: structuredOutputText(structuredOutput),
            })
          }

          // In passthrough mode, merge captured tool_use blocks from the hook.
          // The PreToolUse hook normalizes tool input (e.g., subagent_type casing,
          // parameter name mapping). If the SDK already included the tool_use in
          // its content blocks, replace the input with the normalized version.
          // If the SDK omitted it (blocked tools may not appear), add it.
          if (passthrough && capturedToolUses.length > 0) {
            // Strip calls the hook dropped — the model was told they were NOT
            // forwarded ("do not repeat" / forced-single overflow), so
            // delivering them anyway diverges the client's view from the
            // session history (#552) and hands generateObject multiple
            // structured calls where it requires exactly one.
            if (droppedToolUseIds.size > 0) {
              for (let i = contentBlocks.length - 1; i >= 0; i--) {
                const b = contentBlocks[i]!
                if (b.type === "tool_use" && droppedToolUseIds.has((b as any).id)) {
                  contentBlocks.splice(i, 1)
                }
              }
            }
            const capturedById = new Map(capturedToolUses.map(tu => [tu.id, tu]))
            for (const block of contentBlocks) {
              if (block.type === "tool_use" && capturedById.has((block as any).id)) {
                const captured = capturedById.get((block as any).id)!
                ;(block as any).name = captured.name
                ;(block as any).input = captured.input
                capturedById.delete((block as any).id)
              }
            }
            // Add any remaining captured tool_use blocks not in content
            for (const tu of capturedById.values()) {
              contentBlocks.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: tu.input,
              })
            }
          }

          // Determine stop_reason: use content-based heuristic for standard cases,
          // but preserve non-standard upstream values like pause_turn (advisor flows)
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const heuristicStopReason = hasToolUse ? "tool_use" : "end_turn"
          const stopReason = lastStopReason && lastStopReason !== "end_turn" && lastStopReason !== "tool_use"
            ? lastStopReason
            : heuristicStopReason

          // Append file change summary:
          // - Internal mode: fileChanges populated by PostToolUse hook
          // - Passthrough mode: scan body.messages for executed tool_use blocks
          if (trackFileChanges) {
            if (passthrough && stopReason === "end_turn" && pipelineCtx.extractFileChangesFromToolUse) {
              const passthroughChanges = extractFileChangesFromMessages(
                body.messages || [],
                pipelineCtx.extractFileChangesFromToolUse
              )
              fileChanges.push(...passthroughChanges)
            }
            const fileChangeSummary = formatFileChangeSummary(fileChanges)
            if (fileChangeSummary) {
              const lastTextBlock = [...contentBlocks].reverse().find((b) => b.type === "text")
              if (lastTextBlock) {
                lastTextBlock.text = (lastTextBlock.text as string) + fileChangeSummary
              } else {
                contentBlocks.push({ type: "text", text: fileChangeSummary.trimStart() })
              }
              claudeLog("response.file_changes", { mode: "non_stream", count: fileChanges.length })
            }
          }

          // If no content at all, add a fallback text block
          if (contentBlocks.length === 0) {
            contentBlocks.push({
              type: "text",
              text: "I can help with that. Could you provide more details about what you'd like me to do?"
            })
            claudeLog("response.fallback_used", { mode: "non_stream", reason: "no_content_blocks" })
          }

          const totalDurationMs = Date.now() - requestStartAt

          claudeLog("response.completed", {
            mode: "non_stream",
            model,
            durationMs: totalDurationMs,
            contentBlocks: contentBlocks.length,
            hasToolUse
          })

          const nonStreamQueueWaitMs = totalQueueWaitMs(requestMeta)
          checkTokenHealth(
            requestMeta.requestId,
            currentSessionId || resumeSessionId,
            lastUsage,
            allMessages.length,
            isResume,
            passthrough
          )
          telemetryStore.record({
            requestId: requestMeta.requestId,
            timestamp: Date.now(),
            adapter: adapter.name,
            profileId: profile.id,
            requestSource,
            model,
            requestModel: body.model || undefined,
            mode: "non-stream",
            isResume,
            isPassthrough: passthrough,
            hasDeferredTools,
            deferredToolCount: hasDeferredTools ? deferredToolCount : undefined,
            toolCount,
            discoveredTools: discoveredTools.size > 0 ? [...discoveredTools] : undefined,
            sessionDiscoveredCount: sessionDiscoveredTools.get(currentSessionId || resumeSessionId || "")?.size,
            lineageType,
            messageCount: allMessages.length,
            sdkSessionId: currentSessionId || resumeSessionId,
            status: 200,
            queueWaitMs: nonStreamQueueWaitMs,
            sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
            sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
            proxyOverheadMs: Math.max(0, totalDurationMs - nonStreamQueueWaitMs - requestMeta.sdkActiveDurationMs),
            ttfbMs: requestMeta.ttfbMs ?? null,
            upstreamDurationMs: requestMeta.sdkActiveDurationMs,
            totalDurationMs,
            contentBlocks: contentBlocks.length,
            textEvents: 0,
            error: null,
            inputTokens: lastUsage?.input_tokens,
            outputTokens: lastUsage?.output_tokens,
            cacheReadInputTokens: lastUsage?.cache_read_input_tokens,
            cacheCreationInputTokens: lastUsage?.cache_creation_input_tokens,
            cacheHitRate: computeCacheHitRate(lastUsage),
            ...(envelopeViolations.length > 0 ? { envelopeViolations: [...envelopeViolations] } : {}),
          })

          // Envelope integrity (non-stream): the response must not contain
          // beheaded calls (empty required inputs) or silently drop captured
          // calls the model was told were forwarded.
          if (passthrough) {
            const deliveredIds = new Set<string>(
              contentBlocks.filter((b) => b.type === "tool_use" && typeof (b as any).id === "string").map((b) => (b as any).id as string)
            )
            recordEnvelopeViolations([
              ...checkEmptyToolInputs(contentBlocks, requestTools),
              ...checkUndeliveredToolUses(capturedToolUses, deliveredIds),
            ])
          }

          // Store session for future resume.
          // Fork/subagent requests don't write to the cache — see lookupSession
          // block above for rationale (avoids polluting the parent's key).
          // Duplicate-aborted sessions (sawDuplicateToolUse) are never offered
          // for resume: that SIGTERM lands before the dropped call's deny is
          // durably persisted, so the SDK-side history can diverge from the
          // client's view (#552). Checkpoint-ready sessions, by contrast, reach
          // this store only after the iterator drains to its canonical terminal
          // result, which gives the CLI time to persist the assistant boundary.
              if (currentSessionId && !isIndependentSession && !sawDuplicateToolUse) {
                const checkpointTurn = passthrough && contentBlocks.some((b) => b.type === "tool_use")
                if (checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {
                  // Iterator visibility is not durability. Never publish a
                  // resumeSessionAt UUID unless the CLI reached its terminal
                  // result and had a chance to commit the transcript.
                  evictSession(profileSessionId, profileScopedCwd, body.messages || [])
                  claudeLog("passthrough.noncanonical_session_evicted", { mode: "non_stream" })
                } else {
                  storeSession(
                    profileSessionId,
                    body.messages || [],
                    currentSessionId,
                    profileScopedCwd,
                    sdkUuidMap,
                    lastUsage,
                    earlyStopFired ? nextPassthroughToolCallAssistantUuid : null,
                    earlyStopFired ? nextPassthroughToolCallIds : null
                  )
                  commitSessionTurn()
                }
              }

              const responseSessionId = currentSessionId || resumeSessionId || `session_${Date.now()}`

              return new Response(JSON.stringify({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: body.model,
            stop_reason: stopReason,
            // Forward the usage accumulated from SDK assistant messages so
            // clients calling `messages.create()` can track cost and rate limits.
            usage: {
              input_tokens: lastUsage?.input_tokens ?? 0,
              output_tokens: lastUsage?.output_tokens ?? 0,
              cache_read_input_tokens: lastUsage?.cache_read_input_tokens,
              cache_creation_input_tokens: lastUsage?.cache_creation_input_tokens,
            },
          }), {
            headers: {
              "Content-Type": "application/json",
              "X-Claude-Session-ID": responseSessionId,
            }
          })
        }

        const encoder = new TextEncoder()
        let resolveStreamCompletion = () => {}
        const streamCompletion = new Promise<void>((resolve) => {
          resolveStreamCompletion = resolve
        })
        const readable = new ReadableStream({
          start(controller) {
            return (async () => {
            const upstreamStartAt = Date.now()
            let firstChunkAt: number | undefined
            let heartbeatCount = 0
            let streamEventsSeen = 0
            let eventsForwarded = 0
            let textEventsForwarded = 0
            // Characters of forwarded text — the announce classification is a
            // length test (see turnOutcome.ts).
            let textCharsForwarded = 0
            let bytesSent = 0
            let streamClosed = false
            // Canonical drain: after the client stream closes at turn 1's
            // stop_reason:"tool_use", keep consuming SDK messages (nothing is
            // forwarded once streamClosed) through the hidden digest and final
            // result. SDK iterator visibility is not a persistence barrier;
            // only the canonical result made the assistant UUID durable in a
            // live PTY E2E.
            let awaitingEarlyStopDrain = false
            let exitedBeforeCanonicalTerminal = false

            claudeLog("upstream.start", { mode: "stream", model })

            const safeEnqueue = (payload: Uint8Array, source: string): boolean => {
              if (streamClosed) return false
              try {
                controller.enqueue(payload)
                bytesSent += payload.byteLength
                return true
              } catch (error) {
                if (isClosedControllerError(error)) {
                  streamClosed = true
                  claudeLog("stream.client_closed", { source, streamEventsSeen, eventsForwarded })
                  return false
                }

                claudeLog("stream.enqueue_failed", {
                  source,
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            }

            // Build SDK UUID map for the streaming path (declared before try for storeSession access).
            // Defensive: start empty so allMessages.length === 0 doesn't crash the
            // ReadableStream's start() with `RangeError: Invalid array length`.
            // Cold-start requests with no messages are also rejected upstream now (#450).
            let sdkUuidMap: Array<string | null> = (isResume || isUndo) && cachedSession?.sdkMessageUuids
              ? [...cachedSession.sdkMessageUuids]
              : []
            while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

            let messageStartEmitted = false
            let lastUsage: TokenUsage | undefined
            let hasStructuredOutput = false
            let structuredOutput: unknown
            let nextPassthroughToolCallAssistantUuid: string | undefined
            let nextPassthroughToolCallIds: string[] | undefined
            let sawCanonicalResult = false
            // Silent-turn recovery state (see turnOutcome.ts). Kill switch:
            // MERIDIAN_SILENT_TURN_RECOVERY=0 leaves the detection and the
            // telemetry in place and skips only the extra model turn — so an
            // operator who does not want the spend still keeps the visibility.
            const silentTurnRecoveryEnabled = env("SILENT_TURN_RECOVERY") !== "0"
            let silentTurnRecoveryAttempted = false
            let silentTurnRecovered = false
            // Hoisted out of the inner streaming loop so the outer catch can
            // dedupe captured tool_uses against what was already forwarded
            // when recovering gracefully from max_turns (see catch below).
            const streamedToolUseIds = new Set<string>()
            // The turn's terminal message_delta, withheld rather than forwarded
            // inline. `message_delta` is the frame stock Anthropic clients
            // finalize a message on, so anything appended after it — recovered
            // text, late tool_use blocks — is discarded by a correct client.
            // Observed on the wire: a recovered answer arrived at index 9, two
            // frames behind the end_turn delta at index 8, and was dropped.
            //
            // `message_stop` was already deferred to the end of the turn for
            // the same reason; this makes the pair consistent. Exactly one
            // terminal delta leaves the proxy, and it leaves last, once the
            // turn's real stop_reason is known.
            let pendingTerminalDelta: Uint8Array | null = null
            let terminalDeltaSent = false
            const sendTerminalDelta = (stopReasonOverride?: string): void => {
              if (terminalDeltaSent) return
              const payload = stopReasonOverride
                ? encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: stopReasonOverride, stop_sequence: null },
                    usage: { output_tokens: lastUsage?.output_tokens ?? 0 },
                  })}\n\n`)
                : pendingTerminalDelta
              if (!payload) return
              terminalDeltaSent = true
              if (safeEnqueue(payload, "terminal_message_delta")) eventsForwarded += 1
            }
            // Client block indices whose content_block_start was forwarded but
            // whose content_block_stop hasn't been yet. The single-step abort
            // (#575) can SIGTERM the subprocess mid-block, leaving the client
            // with an unterminated tool_use block that renders as an
            // argument-less aborted call (#552 "red reads") — the recovery
            // path closes these explicitly before its final frames.
            const openClientBlocks = new Set<number>()

            // Envelope integrity: every path that ends the client stream must
            // first terminate any content block whose start was forwarded but
            // whose stop hasn't been — an unterminated block renders
            // client-side as an argument-less aborted ("red") tool call
            // (#552). The error-recovery path already does this; this helper
            // extends the guarantee to ALL close paths (early stop, turn-2
            // suppression, drain-close). With the deny-hold in place blocks
            // normally complete before any close — this is the backstop.
            // #742: never close a client turn merely because deny messages
            // settled while a later parallel block is still streaming. The
            // client closes only on the canonical turn-1 tool_use delta below,
            // after its blocks are complete; the SDK then drains invisibly.

            const flushOpenClientBlocks = (source: string): void => {
              if (openClientBlocks.size === 0) return
              recordEnvelopeViolations([...openClientBlocks].map((idx) => ({
                type: "dangling_block" as const,
                detail: `content block ${idx} still open at ${source} close`,
              })))
              claudeLog("stream.dangling_blocks_closed", { source, count: openClientBlocks.size })
              for (const idx of openClientBlocks) {
                safeEnqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`
                ), `${source}_close_dangling`)
              }
              openClientBlocks.clear()
            }

            // Hoisted out of the try so the client-abort branch of the catch
            // below can settle this session (see clientAbortDisposition).
            let currentSessionId: string | undefined
            try {
              // Same transparent retry wrapper as the non-streaming path.
              // Rate-limit retry strategy:
              //   1. Strip [1m] context (immediate, different model tier)
              //   2. Backoff retries on base model (1s, 2s — exponential)
              const MAX_RATE_LIMIT_RETRIES = 2
              const RATE_LIMIT_BASE_DELAY_MS = 1000

              const response = (async function* () {
                let rateLimitRetries = 0

                // Proactive token refresh — see non-stream path above.
                if (profileCredentialStore) {
                  await ensureFreshToken(profileCredentialStore).catch(() => { /* reactive path handles */ })
                }

                let tokenRefreshed = false
                let didFreshBaseRetry = false
                let resumeRefusalRetries = 0
                let busySessionFork = false
                let sawUnresumableRefusal = false

                while (true) {
                  // Track whether client-visible SSE events were yielded.
                  // The SDK emits metadata events (session_id, internal routing)
                  // before the API call — those are NOT client-visible and must
                  // not prevent retry. Only stream_event types become SSE output.
                  let didYieldClientEvent = false
                  // stderr emitted by THIS attempt's subprocess only — retries
                  // must not re-match a previous attempt's refusal text.
                  const attemptStderrStart = stderrLines.length
                  try {
                    for await (const event of runSdkQueryAttempt(buildQueryOptions({
                      prompt: makePrompt(), model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                      resumeSessionId, isUndo, resumeSessionAtUuid: undoRollbackUuid ?? passthroughToolCallAssistantUuid, forkSession: busySessionFork || undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, outputFormat, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    webFetchPreflight: sdkFeatures.webFetchPreflight,
                    claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "stream")) {
                      // Same SDK rate-limit capture as the non-stream path.
                      if ((event as any).type === "rate_limit_event") {
                        rateLimitStore.record(profile.id, (event as any).rate_limit_info)
                      }
                      if ((event as any).type === "stream_event") {
                        didYieldClientEvent = true
                      }
                      yield event
                    }
                    return
                  } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error)

                    // Never retry after client-visible SSE events — response is committed
                    if (didYieldClientEvent) throw error

                    // Retry: the resume was refused, not answered — see the
                    // non-stream branch above for the full rationale. The busy
                    // wording only ever arrives on stderr, and only matters
                    // where a resume was attempted, so the capture is read there
                    // alone.
                    const refusal = classifyResumeRefusal(error, resumeSessionId ? stderrLines.slice(attemptStderrStart).join("\n") : undefined)
                    if (refusal === "unresumable") sawUnresumableRefusal = true
                    if (resumeSessionId && (refusal === "busy" || refusal === "unresumable")) {
                      if (resumeRefusalRetries < RESUME_REFUSAL_MAX_RETRIES) {
                        resumeRefusalRetries++
                        claudeLog("session.resume_retry", { mode: "stream", refusal, attempt: resumeRefusalRetries, resumeSessionId })
                        plog(`[PROXY] ${requestMeta.requestId} resume refused (${refusal}), retrying ${resumeRefusalRetries}/${RESUME_REFUSAL_MAX_RETRIES}`)
                        await new Promise((resolve) => setTimeout(resolve, RESUME_REFUSAL_RETRY_DELAY_MS * resumeRefusalRetries))
                        continue
                      }
                      if (refusal === "busy" && !busySessionFork) {
                        busySessionFork = true
                        claudeLog("session.busy_fork", { mode: "stream", resumeSessionId })
                        plog(`[PROXY] ${requestMeta.requestId} session still busy after ${RESUME_REFUSAL_MAX_RETRIES} retries — forking session`)
                        continue
                      }
                    }

                    // The session cannot serve this turn — evict and replay
                    // the history as a fresh session (one-shot). See the
                    // non-stream branch above for the full rationale.
                    if (refusal === "missing-message" || sawUnresumableRefusal) {
                      claudeLog("session.resume_replay", {
                        mode: "stream",
                        refusal,
                        rollbackUuid: undoRollbackUuid,
                        resumeSessionId,
                      })
                      plog(`[PROXY] ${requestMeta.requestId} session unusable (${refusal}), evicting and replaying as fresh session`)
                      evictSession(profileSessionId, profileScopedCwd, allMessages)
                      sdkUuidMap.length = 0
                      for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                      yield* runSdkQueryAttempt(buildQueryOptions({
                        prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                        model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                        passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                        resumeSessionId: undefined, isUndo: false, resumeSessionAtUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                        effort, thinking, taskBudget, outputFormat, betas, settingSources,
                        codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    webFetchPreflight: sdkFeatures.webFetchPreflight,
                    claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                        maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                        sdkDebug: sdkFeatures.sdkDebug,
                        additionalDirectories: sdkFeatures.additionalDirectories
                          ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                          : undefined,
                        advisorModel,
                      }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "stream_fresh")
                      return
                    }

                    // Extra Usage required: strip [1m] and record 1-hour cooldown.
                    if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(model)) {
                      const from = model
                      model = stripExtendedContext(model)
                      recordExtendedContextUnavailable()
                      claudeLog("upstream.context_fallback", {
                        mode: "stream",
                        from,
                        to: model,
                        reason: "extra_usage_required",
                      })
                      plog(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${model} (skipping [1m] for 1h)`)
                      continue
                    }

                    if (isExtraUsageRequiredError(errMsg) && resumeSessionId && !didFreshBaseRetry) {
                      didFreshBaseRetry = true
                      claudeLog("upstream.session_fallback", {
                        mode: "stream",
                        model,
                        reason: "extra_usage_required_resume",
                      })
                      plog(`[PROXY] ${requestMeta.requestId} extra usage persisted on resumed ${model}, retrying as fresh session`)
                      evictSession(profileSessionId, profileScopedCwd, allMessages)
                      sdkUuidMap.length = 0
                      for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                      yield* runSdkQueryAttempt(buildQueryOptions({
                        prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                        model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                        passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                        resumeSessionId: undefined, isUndo: false, resumeSessionAtUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                        effort, thinking, taskBudget, outputFormat, betas, settingSources,
                        codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                        memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                        webFetchPreflight: sdkFeatures.webFetchPreflight,
                        claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                        maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                        sdkDebug: sdkFeatures.sdkDebug,
                        additionalDirectories: sdkFeatures.additionalDirectories
                          ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                          : undefined,
                        advisorModel,
                      }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "stream_fresh")
                      return
                    }

                    // Expired OAuth token: refresh once and retry
                    if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
                      tokenRefreshed = true
                      const refreshed = profileCredentialStore
                        ? await refreshOAuthToken(profileCredentialStore)
                        : false
                      if (refreshed) {
                        claudeLog("token_refresh.retrying", { mode: "stream" })
                        plog(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
                        continue
                      }
                      // Refresh failed — fall through and surface the error
                    }

                    // Rate-limit retry: first strip [1m] (free, different tier), then backoff
                    if (isRateLimitError(errMsg)) {
                      if (hasExtendedContext(model)) {
                        const from = model
                        model = stripExtendedContext(model)
                        claudeLog("upstream.context_fallback", {
                          mode: "stream",
                          from,
                          to: model,
                          reason: "rate_limit",
                        })
                        plog(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                        continue
                      }
                      if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries++
                        const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
                        claudeLog("upstream.rate_limit_backoff", {
                          mode: "stream",
                          model,
                          attempt: rateLimitRetries,
                          maxAttempts: MAX_RATE_LIMIT_RETRIES,
                          delayMs: delay,
                        })
                        plog(`[PROXY] ${requestMeta.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
                        await new Promise(r => setTimeout(r, delay))
                        continue
                      }
                    }

                    throw error
                  }
                }
              })()

              const heartbeat = setInterval(() => {
                heartbeatCount += 1
                try {
                  const payload = encoder.encode(`: ping\n\n`)
                  if (!safeEnqueue(payload, "heartbeat")) {
                    clearInterval(heartbeat)
                    return
                  }
                  if (heartbeatCount % 5 === 0) {
                    claudeLog("stream.heartbeat", { count: heartbeatCount })
                  }
                } catch (error) {
                  claudeLog("stream.heartbeat_failed", {
                    count: heartbeatCount,
                    error: error instanceof Error ? error.message : String(error)
                  })
                  clearInterval(heartbeat)
                }
              }, 15_000)

              const skipBlockIndices = new Set<number>()
              // NOTE: agent-specific — track block indices for "task" tool_use blocks
              // so we can normalize subagent_type in streamed input_json_delta events.
              // Deltas are buffered because input_json_delta sends JSON in chunks —
              // the key-value pair may span multiple deltas, preventing regex match.
              const taskToolBlockIndices = new Set<number>()
              const taskToolJsonBuffer = new Map<number, string>()

              // Block index remapping: the SDK resets indices on each turn, but
              // we skip intermediate message_start/stop so the client sees one
              // message. Without remapping, turn 2's index=0 collides with turn 1's.
              let nextClientBlockIndex = 0
              const sdkToClientIndex = new Map<number, number>()

              const guardedResponse = guardUpstreamIdle(response, UPSTREAM_IDLE_MS, (sinceLastMs) =>
                claudeLog("upstream.stalled", {
                  mode: "stream",
                  model,
                  sinceLastMs,
                  streamEventsSeen,
                  firstChunkAt: firstChunkAt ?? null,
                }),
              )
              try {
                for await (const message of guardedResponse) {
                  if (streamClosed && !awaitingEarlyStopDrain) {
                    exitedBeforeCanonicalTerminal = true
                    break
                  }

                  // Capture session ID and only client-visible assistant
                  // UUIDs. Hidden digest assistants share the same client slot
                  // and must not replace its stable tool checkpoint.
                  if ((message as any).session_id) {
                    currentSessionId = (message as any).session_id
                  }
                  let assistantAddedForwardedCall = false
                  if (earlyStopEnabled && message.type === "assistant" && !earlyStopFired) {
                    const expectedBefore = earlyStop.expected.size
                    noteAssistantMessage(earlyStop, message)
                    assistantAddedForwardedCall = earlyStop.expected.size > expectedBefore
                  } else if (earlyStopEnabled && message.type === "user" && !earlyStopFired) {
                    noteUserContent(earlyStop, (message as any).message?.content)
                  }
                  if (earlyStopEnabled && !earlyStopFired) {
                    // A deny may precede the last per-block assistant metadata.
                    // The client-visible stream is the completeness oracle: wait
                    // until generation ended, every block closed, and metadata
                    // names exactly the full forwarded ID set. Recheck on both
                    // assistant and user messages so either ordering can settle.
                    const hasCompleteStreamedSet =
                      streamedToolUseIds.size > 0 &&
                      earlyStop.expected.size === streamedToolUseIds.size &&
                      [...streamedToolUseIds].every((id) => earlyStop.expected.has(id))
                    if (
                      !turnGenerating &&
                      openClientBlocks.size === 0 &&
                      hasCompleteStreamedSet &&
                      shouldEarlyStop(earlyStop)
                    ) {
                      nextPassthroughToolCallAssistantUuid = settledToolCallAssistantUuid(earlyStop)
                      nextPassthroughToolCallIds = [...earlyStop.expected]
                      earlyStopFired = true
                      for (let i = capturedToolUses.length - 1; i >= 0; i--) {
                        if (!earlyStop.expected.has(capturedToolUses[i]!.id)) capturedToolUses.splice(i, 1)
                      }
                      claudeLog("passthrough.checkpoint_ready", {
                        mode: "stream",
                        captured: capturedToolUses.length,
                        toolCallAssistantUuid: nextPassthroughToolCallAssistantUuid,
                      })
                    }
                  }
                  if (
                    message.type === "assistant" &&
                    (!passthrough || earlyStop.expected.size === 0 || assistantAddedForwardedCall)
                  ) {
                    sdkUuidMap = withClientAssistantUuid(
                      sdkUuidMap,
                      allMessages.length,
                      (message as any).uuid
                    )
                  }
                  if (message.type === "result") {
                    sawCanonicalResult = true
                    const resultUsage = (message as { usage?: unknown }).usage as TokenUsage | undefined
                    if (resultUsage) lastUsage = { ...lastUsage, ...resultUsage }
                    if (outputFormat && "structured_output" in message) {
                      hasStructuredOutput = true
                      structuredOutput = message.structured_output
                    }
                  }

                  if (message.type === "stream_event") {
                    // Once turn 1 is closed to the client, all later wire events
                    // belong to the hidden digest. Ignore them wholesale so a
                    // closed-controller enqueue cannot break the durability
                    // drain before the canonical result arrives.
                    if (streamClosed && awaitingEarlyStopDrain) continue
                    streamEventsSeen += 1
                    if (!firstChunkAt) {
                      firstChunkAt = Date.now()
                      // See the non-stream site: TTFB belongs to the attempt
                      // that actually delivered, not to the first one tried.
                      requestMeta.ttfbMs ??= firstChunkAt - (requestMeta.currentSdkStartedAt ?? firstChunkAt)
                      claudeLog("upstream.first_chunk", {
                        mode: "stream",
                        model,
                        ttfbMs: requestMeta.ttfbMs
                      })
                    }

                    const event = message.event
                    const eventType = (event as any).type
                    const eventIndex = (event as any).index as number | undefined

                    // Turn-generation boundary: release held deny responses.
                    // message_delta/message_stop = the turn finished cleanly;
                    // a SECOND message_start = the turn ended some other way
                    // (belt-and-suspenders so holds can't leak across turns).
                    if (
                      eventType === "message_delta" ||
                      eventType === "message_stop" ||
                      (eventType === "message_start" && messageStartEmitted)
                    ) {
                      releaseHeldDenies(eventType)
                    }
                    if (eventType === "message_start") {
                      turnGenerating = true
                    }

                    // Native structured output is validated only on the SDK's
                    // final result message. Buffer its partial wire events and
                    // emit one valid Anthropic SSE message after validation.
                    if (outputFormat) {
                      if (eventType === "message_start") {
                        const startUsage = (event as unknown as { message?: { usage?: TokenUsage } }).message?.usage
                        if (startUsage) lastUsage = { ...lastUsage, ...startUsage }
                      } else if (eventType === "message_delta") {
                        const deltaUsage = (event as unknown as { usage?: TokenUsage }).usage
                        if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }
                      }
                      continue
                    }

                    // Track MCP tool blocks (mcp__opencode__*) — these are internal tools
                    // that the SDK executes. Don't forward them to OpenCode.
                    if (eventType === "message_start") {
                      skipBlockIndices.clear()
                      sdkToClientIndex.clear()
                      const startUsage = (event as unknown as { message?: { usage?: TokenUsage } }).message?.usage
                      if (startUsage) lastUsage = { ...lastUsage, ...startUsage }
                      // Only emit the first message_start — subsequent ones are internal SDK turns.
                      // In passthrough mode, the second message_start marks Turn 2 beginning
                      // (SDK processed the blocked tool call and Claude is now summarising).
                      // Close the stream immediately — before ANY Turn 2 content blocks reach
                      // the client — and inject a clean message_delta + message_stop so the
                      // client sees stop_reason:"tool_use" and executes the tool itself.
                      if (messageStartEmitted) {
                        if (passthrough && streamedToolUseIds.size > 0) {
                          if (!streamClosed) {
                            flushOpenClientBlocks("turn2_suppression")
                            sendTerminalDelta("tool_use")
                            safeEnqueue(encoder.encode(
                              `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
                            ), "passthrough_turn2_stop")
                            streamClosed = true
                            controller.close()
                          }
                          // Suppress the entire hidden digest turn, but drain it
                          // through the canonical result so the transcript is durable.
                          awaitingEarlyStopDrain = true
                          claudeLog("passthrough.turn2_suppressed", { mode: "stream", toolUses: streamedToolUseIds.size })
                          continue
                        }
                        continue
                      }
                      messageStartEmitted = true
                    }

                    // Skip intermediate message_stop events (SDK will start another turn)
                    // Only emit message_stop when the final message ends
                    if (eventType === "message_stop") {
                      // Peek: if there are more events coming, skip this message_stop
                      // We handle this by only emitting message_stop at the very end (after the loop)
                      continue
                    }

                    if (eventType === "content_block_start") {
                      const block = (event as any).content_block
                      // Internal chat clients (Cherry Studio): the SDK executes
                      // WebSearch/WebFetch itself. Skip the internal tool_use
                      // block (client can't run it) and the thinking blocks it
                      // can't render, so the stream carries only the final answer.
                      if (
                        pipelineCtx.hidesInternalTools &&
                        (block?.type === "tool_use" ||
                          ((block?.type === "thinking" || block?.type === "redacted_thinking") && !sdkFeatures.thinkingPassthrough))
                      ) {
                        if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                        claudeLog("internal_tool.hidden", { mode: "stream", type: block?.type, name: block?.name, index: eventIndex })
                        continue
                      }
                      // Strip thinking blocks in passthrough mode — non-native clients
                      // have no renderer for type:"thinking" and may choke on the
                      // encrypted signature field.
                      if (
                        passthrough &&
                        !pipelineCtx.supportsThinking && !sdkFeatures.thinkingPassthrough &&
                        (block?.type === "thinking" || block?.type === "redacted_thinking")
                      ) {
                        if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                        claudeLog("passthrough.thinking_stripped", { mode: "stream", type: block.type, index: eventIndex })
                        continue
                      }
                      if (block?.type === "tool_use" && typeof block.name === "string") {
                        // Filter out ToolSearch — handled internally by the SDK
                        // for deferred tool loading, not visible to the client.
                        if (block.name === "ToolSearch") {
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        }
                        if (passthrough && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
                          // Passthrough mode: SDK sent the name WITH the mcp__oc__ prefix.
                          // Strip it so OpenCode sees the bare tool name.
                          block.name = stripMcpPrefix(block.name)
                          if (block.id) streamedToolUseIds.add(block.id)
                        } else if (block.name.startsWith("mcp__")) {
                          // Internal MCP tool (mcp__opencode__* etc.) — skip, SDK handles it
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        } else if (passthrough && block.id) {
                          // Passthrough mode: SDK already stripped the mcp__oc__ prefix before
                          // emitting the stream_event (observed in practice — the SDK normalises
                          // tool names in stream events). Track the ID so the early-break
                          // condition fires correctly.
                          streamedToolUseIds.add(block.id)
                        }
                        // NOTE: agent-specific — track "task" tool blocks so we can
                        // normalize subagent_type in their streamed input_json_delta.
                        if (passthrough && eventIndex !== undefined && block.name.toLowerCase() === "task") {
                          taskToolBlockIndices.add(eventIndex)
                        }
                      }
                      // Assign a monotonic client index for this forwarded block
                      if (eventIndex !== undefined) {
                        sdkToClientIndex.set(eventIndex, nextClientBlockIndex++)
                      }
                    }

                    // Skip deltas and stops for MCP tool blocks
                    if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) {
                      continue
                    }

                    // Remap block index to monotonic client index
                    if (eventIndex !== undefined && sdkToClientIndex.has(eventIndex)) {
                      (event as any).index = sdkToClientIndex.get(eventIndex)
                    }

                    // Skip intermediate message_delta with stop_reason: tool_use
                    // (SDK is about to execute MCP tools and continue)
                    if (eventType === "message_delta") {
                      const deltaUsage = (event as unknown as { usage?: TokenUsage }).usage
                      if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }
                      const stopReason = (event as any).delta?.stop_reason
                      if (stopReason === "tool_use" && skipBlockIndices.size > 0) {
                        // All tool_use blocks in this turn were MCP — skip this delta
                        continue
                      }
                    }

                    // NOTE: agent-specific — buffer input_json_delta for Task tool blocks.
                    // Claude sends PascalCase subagent_type (e.g., "Explore") and aliases
                    // like "general-purpose" that OpenCode rejects. input_json_delta sends
                    // JSON in chunks so we can't normalize individual deltas — buffer
                    // all chunks, parse the complete JSON, and emit the fixed version
                    // at content_block_stop.
                    if (
                      passthrough &&
                      eventIndex !== undefined &&
                      taskToolBlockIndices.has(eventIndex)
                    ) {
                      if (eventType === "content_block_delta") {
                        const delta = (event as any).delta
                        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                          const prev = taskToolJsonBuffer.get(eventIndex) ?? ""
                          taskToolJsonBuffer.set(eventIndex, prev + delta.partial_json)
                          continue // Don't forward — emit complete JSON at block_stop
                        }
                      }
                      if (eventType === "content_block_stop") {
                        const buffered = taskToolJsonBuffer.get(eventIndex)
                        if (buffered) {
                          let fixed = buffered
                          try {
                            const parsed = JSON.parse(buffered) as Record<string, unknown>
                            if (typeof parsed.subagent_type === "string") {
                              parsed.subagent_type = resolveAgentAlias(parsed.subagent_type, validAgentNames)
                            }
                            fixed = JSON.stringify(parsed)
                          } catch {
                            // Malformed JSON — forward buffer unchanged rather than drop the block
                          }
                          const clientIdx = sdkToClientIndex.get(eventIndex) ?? eventIndex
                          safeEnqueue(encoder.encode(
                            `event: content_block_delta\ndata: ${JSON.stringify({
                              type: "content_block_delta",
                              index: clientIdx,
                              delta: { type: "input_json_delta", partial_json: fixed }
                            })}\n\n`
                          ), "task_tool_fixed_delta")
                          taskToolJsonBuffer.delete(eventIndex)
                        }
                        // Fall through to forward content_block_stop normally
                      }
                    }

                    // Debug fault injection: swallow this turn's text so the
                    // silent-turn guard can be exercised on demand instead of
                    // waiting for a ~3-in-500 live occurrence (see
                    // shouldInjectSilentTurn). Drops only text deltas — the
                    // block start and stop still go out, which is precisely the
                    // production shape: an empty text block.
                    if (
                      eventType === "content_block_delta" &&
                      (event as any).delta?.type === "text_delta" &&
                      shouldInjectSilentTurn({
                        raw: env("DEBUG_FORCE_SILENT_TURN"),
                        sessionId: agentSessionId,
                      })
                    ) {
                      claudeLog("debug.silent_turn_injected", { sessionId: agentSessionId })
                      continue
                    }

                    // Forward all other events (text, non-MCP tool_use like Task, message events).
                    // Strip SDK-only fields (context_management on message_delta) that stock
                    // Anthropic clients crash on — the real API never returns them (#525).
                    stripNonStandardStreamFields(event)
                    const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                    if (eventType === "message_delta") {
                      // Withheld, not dropped — see sendTerminalDelta. Every
                      // path that ends the turn flushes it, so the client still
                      // gets exactly one, after any recovered content.
                      pendingTerminalDelta = payload
                    } else {
                      if (!safeEnqueue(payload, `stream_event:${eventType}`)) {
                        break
                      }
                      eventsForwarded += 1
                    }

                    // Track envelope integrity: which forwarded blocks are open.
                    if (eventType === "content_block_start") {
                      const idx = (event as any).index
                      if (typeof idx === "number") openClientBlocks.add(idx)
                    } else if (eventType === "content_block_stop") {
                      const idx = (event as any).index
                      if (typeof idx === "number") openClientBlocks.delete(idx)
                    }

                    // NOTE: agent-specific (passthrough mode) — close the client stream
                    // immediately when the model stops for tool_use so the client can
                    // execute the tools and send results back. Without this the SDK
                    // executes the passthrough MCP no-op (→ "passthrough"), feeds that
                    // back to the model, and the model produces an incorrect fallback
                    // response which gets forwarded.
                    //
                    // With checkpoint draining enabled, don't break — keep
                    // consuming invisibly through every deny, the digest, and the
                    // canonical result that makes the assistant UUID durable.
                    // Without it (kill switch), preserve the old wire
                    // behavior by breaking here, then evict the noncanonical
                    // session mapping because closing the query interrupts its tail.
                    if (
                      passthrough &&
                      eventType === "message_delta" &&
                      (event as any).delta?.stop_reason === "tool_use" &&
                      streamedToolUseIds.size > 0
                    ) {
                      flushOpenClientBlocks("drain_close")
                      // This path used to rely on the delta having gone out
                      // inline above; it is now withheld, so send it here.
                      sendTerminalDelta()
                      safeEnqueue(
                        encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
                        "passthrough_tool_stream_stop"
                      )
                      streamClosed = true
                      controller.close()
                      if (earlyStopEnabled) {
                        awaitingEarlyStopDrain = true
                        continue
                      }
                      exitedBeforeCanonicalTerminal = true
                      break
                    }

                    if (eventType === "content_block_delta") {
                      const delta = (event as any).delta
                      if (delta?.type === "text_delta") {
                        textEventsForwarded += 1
                        if (typeof delta.text === "string") textCharsForwarded += delta.text.length
                      }
                    }
                  }
                }
              } finally {
                clearInterval(heartbeat)
                // Never leak a held deny: if the loop exits for any reason
                // (abort, error, natural end), unblock pending hook responses.
                releaseHeldDenies("stream_loop_exit")
              }

              if (outputFormat) {
                if (!hasStructuredOutput) {
                  throw new Error("Structured output was requested but the SDK returned no structured_output result")
                }
                const text = structuredOutputText(structuredOutput)
                const messageId = `msg_${Date.now()}`
                safeEnqueue(encoder.encode(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      content: [],
                      model: body.model,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: lastUsage?.input_tokens ?? 0, output_tokens: 0 },
                    },
                  })}\n\n`
                ), "structured_message_start")
                safeEnqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  })}\n\n`
                ), "structured_block_start")
                safeEnqueue(encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text },
                  })}\n\n`
                ), "structured_text_delta")
                safeEnqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`
                ), "structured_block_stop")
                safeEnqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: lastUsage?.output_tokens ?? 0 },
                  })}\n\n`
                ), "structured_message_delta")
                messageStartEmitted = true
                eventsForwarded += 5
                textEventsForwarded += 1
                textCharsForwarded += text.length
              }

              if (passthrough) {
                recordEnvelopeViolations(checkUndeliveredToolUses(capturedToolUses, streamedToolUseIds))
              }
              claudeLog("upstream.completed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                eventsForwarded,
                textEventsForwarded
              })
              if (lastUsage) logUsage(requestMeta.requestId, lastUsage)
              // Accumulate discovered tools into the session-level set
              const sessId = currentSessionId || resumeSessionId
              if (sessId && discoveredTools.size > 0) {
                if (!sessionDiscoveredTools.has(sessId)) sessionDiscoveredTools.set(sessId, new Set())
                for (const t of discoveredTools) sessionDiscoveredTools.get(sessId)!.add(t)
                const newNames = [...discoveredTools].join(", ")
                const allNames = [...sessionDiscoveredTools.get(sessId)!]
                plog(`[PROXY] ${requestMeta.requestId} discovered=${discoveredTools.size} (${newNames}) session_total=${allNames.length}`)
              }

              // Store only canonical, durable checkpoint turns. Fork/subagent
              // requests and duplicate-aborted sessions never write the cache.
              // A live PTY E2E proved assistant/deny iterator messages may be
              // yielded before their JSONL records are committed, so a tool turn
              // also requires both a valid assistant checkpoint and SDK result.
              if (currentSessionId && !isIndependentSession && !sawDuplicateToolUse) {
                const checkpointTurn = passthrough && streamedToolUseIds.size > 0
                if (
                  exitedBeforeCanonicalTerminal ||
                  (checkpointTurn && (!earlyStopFired || !sawCanonicalResult))
                ) {
                  evictSession(profileSessionId, profileScopedCwd, body.messages || [])
                  claudeLog("passthrough.noncanonical_session_evicted", { mode: "stream" })
                } else {
                  storeSession(
                    profileSessionId,
                    body.messages || [],
                    currentSessionId,
                    profileScopedCwd,
                    sdkUuidMap,
                    lastUsage,
                    earlyStopFired ? nextPassthroughToolCallAssistantUuid : null,
                    earlyStopFired ? nextPassthroughToolCallIds : null
                  )
                  commitSessionTurn()
                }
              }

              // Last chance to save a silent turn. The three known causes are
              // fixed; this catches the class — including causes not yet found —
              // one turn before the client is told the request succeeded.
              //
              // Runs only where recovery is still possible: the stream is open,
              // so the recovered answer can actually be forwarded. A turn that
              // already closed for a passthrough tool turn carries tool
              // calls by construction and is never silent.
              //
              // One classification, read twice: here, to decide whether a
              // recovery spend is warranted, and again for the final envelope's
              // telemetry. The counters mutate in between — a closure, not a
              // snapshot.
              const classifyNow = () => classifyTurnOutcome({
                textEvents: textEventsForwarded,
                toolUses: streamedToolUseIds.size,
                blocksForwarded: eventsForwarded,
              })
              const preRecoveryOutcome = classifyNow()
              //
              // `messageStartEmitted` is a hard precondition, not a heuristic:
              // recovery works by appending a text block to the message already
              // open on the wire. With no message_start there is nothing to
              // append to, and emitting blocks would be malformed SSE. That case
              // — the SDK yielding nothing client-visible at all — is already
              // covered by the retry wrapper's didYieldClientEvent check.
              if (
                !streamClosed &&
                messageStartEmitted &&
                shouldAttemptRecovery({
                  outcome: preRecoveryOutcome,
                  alreadyAttempted: silentTurnRecoveryAttempted,
                  clientGone: streamClosed,
                  sessionId: currentSessionId || resumeSessionId,
                  enabled: silentTurnRecoveryEnabled,
                })
              ) {
                silentTurnRecoveryAttempted = true
                const capturedBeforeRecovery = capturedToolUses.length
                claudeLog("response.silent_turn_recovery", {
                  mode: "stream",
                  kind: preRecoveryOutcome.kind,
                  reason: preRecoveryOutcome.kind === "silent" ? preRecoveryOutcome.reason : undefined,
                  sdkSessionId: currentSessionId || resumeSessionId,
                })
                const recoveryLifter = createRecoveryLifter(() => nextClientBlockIndex++)
                // The fork's identity. Without capturing it the recovered answer
                // lives only in a session nothing points at: storeSession has
                // already run against the pre-fork id, whose tail is the silent
                // turn, so the next continuation resumes the silence and a tool
                // call made here comes back as a tool_result for a tool_use the
                // resumable session never saw.
                let recoverySessionId: string | undefined
                let recoveryToolCallAssistantUuid: string | undefined
                const recoveryEarlyStop = createEarlyStopTracker()
                try {
                  // Bounded by the same idle limit as the main stream. Iterating
                  // the recovery query directly left a stalled recovery holding
                  // an open SSE response and its concurrency slot with nothing
                  // to time it out — the client waits forever on a request that
                  // had already produced a deliverable turn.
                  for await (const event of runSdkQueryAttempt(buildQueryOptions({
                    prompt: SILENT_TURN_NUDGE,
                    model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                    // The nudge asks for prose, but a tool call is an equally
                    // valid answer — so the tool surface has to stay identical.
                    passthrough, stream: true, sdkAgents, passthroughMcp,
                    cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                    resumeSessionId: currentSessionId || resumeSessionId,
                    isUndo: false,
                    // Fork rather than extend: the silent turn is now this
                    // session's tail, and appending to it is what compounds an
                    // empty turn into an empty session (#768 client-abort).
                    resumeSessionAtUuid: nextPassthroughToolCallAssistantUuid,
                    forkSession: true,
                    sdkHooks, blockedTools: pipelineCtx.blockedTools,
                    incompatibleTools: pipelineCtx.incompatibleTools,
                    mcpServerName: adapter.getMcpServerName(),
                    allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                    effort, thinking, taskBudget, outputFormat, betas, settingSources,
                    codeSystemPrompt: sdkFeatures.codeSystemPrompt,
                    clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming,
                    sharedMemory: sdkFeatures.sharedMemory,
                    webFetchPreflight: sdkFeatures.webFetchPreflight,
                    claudeAiConnectors: sdkFeatures.claudeAiConnectors,
                    maxBudgetUsd: sdkFeatures.maxBudgetUsd,
                    fallbackModel: sdkFeatures.fallbackModel,
                    sdkDebug: sdkFeatures.sdkDebug,
                    additionalDirectories: sdkFeatures.additionalDirectories
                      ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                      : undefined,
                    advisorModel,
                  }, requestAbort.controller), requestAbort.controller.signal, requestMeta, "silent_recovery")) {
                    const recoveryMessage = event as any
                    if (recoveryMessage.session_id) recoverySessionId = recoveryMessage.session_id
                    if (recoveryMessage.type === "assistant") {
                      noteAssistantMessage(recoveryEarlyStop, recoveryMessage)
                    } else if (recoveryMessage.type === "user") {
                      noteUserContent(recoveryEarlyStop, recoveryMessage.message?.content)
                      recoveryToolCallAssistantUuid = settledToolCallAssistantUuid(recoveryEarlyStop)
                    }
                    if (recoveryMessage.type !== "stream_event") continue
                    // Only text is lifted into the already-open message; the
                    // re-indexing handshake lives in createRecoveryLifter. A
                    // tool call arriving here still counts as a productive
                    // recovery, through the shared PreToolUse capture below.
                    const lifted = recoveryLifter.lift((event as any).event)
                    if (!lifted) continue
                    safeEnqueue(encoder.encode(
                      `event: ${lifted.frame.type}\ndata: ${JSON.stringify(lifted.frame)}\n\n`
                    ), `silent_recovery_${lifted.kind}`)
                    if (lifted.kind === "block_start") {
                      eventsForwarded += 1
                    } else if (lifted.kind === "text_delta") {
                      textEventsForwarded += 1
                      textCharsForwarded += lifted.textChars
                      silentTurnRecovered = true
                    }
                  }
                } catch (recoveryError) {
                  // A failed recovery must never turn a delivered turn into a
                  // failed request: the client still gets the original envelope,
                  // and the attempt is recorded for the operator.
                  claudeLog("response.silent_turn_recovery_failed", {
                    mode: "stream",
                    error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                  })
                }
                // Tool calls made in the recovery turn are captured by the
                // shared PreToolUse hook and delivered through the unseen-
                // capture emission below — an equally valid recovery, and for
                // an announce stall the expected one.
                if (capturedToolUses.length > capturedBeforeRecovery) {
                  silentTurnRecovered = true
                }
                // Point the client's session at the fork, so the turn that
                // actually answered is the one the next request resumes. The
                // uuid map is reset rather than carried: those uuids belong to
                // the pre-fork session and would not resolve against the fork,
                // so undo falls back to a full replay — correct, just less
                // efficient, where keeping them would be neither.
                if (
                  silentTurnRecovered && recoverySessionId &&
                  !isIndependentSession && !sawDuplicateToolUse
                ) {
                  currentSessionId = recoverySessionId
                  nextPassthroughToolCallAssistantUuid = recoveryToolCallAssistantUuid
                  nextPassthroughToolCallIds = recoveryToolCallAssistantUuid
                    ? [...recoveryEarlyStop.expected]
                    : undefined
                  sdkUuidMap.length = 0
                  for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                  storeSession(
                    profileSessionId,
                    body.messages || [],
                    recoverySessionId,
                    profileScopedCwd,
                    sdkUuidMap,
                    lastUsage,
                    recoveryToolCallAssistantUuid ?? null,
                    recoveryToolCallAssistantUuid ? [...recoveryEarlyStop.expected] : null
                  )
                  commitSessionTurn()
                }
                claudeLog("response.silent_turn_recovery_result", {
                  mode: "stream",
                  recovered: silentTurnRecovered,
                  textEvents: textEventsForwarded,
                  forkedSession: recoverySessionId ?? null,
                })
                // A repaired turn ends the request looking productive, so the
                // end-of-turn classification below says nothing about it — the
                // one event meaning "the loop nearly lost a turn" would leave
                // no trace at session level. Report the PRE-recovery verdict,
                // which is the truth about what upstream actually produced.
                if (silentTurnRecovered && preRecoveryOutcome.kind === "silent") {
                  diagnosticLog.session(
                    `${requestMeta.requestId} silent_turn reason=${preRecoveryOutcome.reason} ` +
                    `blocks=${eventsForwarded} out=${lastUsage?.output_tokens ?? 0} ` +
                    `recovery=succeeded`,
                    requestMeta.requestId,
                  )
                }
              }

              if (!streamClosed) {
                // In passthrough mode, emit captured tool_use blocks as stream events
                // Skip any that were already forwarded during the stream (dedup by ID)
                const unseenToolUses = capturedToolUses.filter(tu => !streamedToolUseIds.has(tu.id))
                if (passthrough && unseenToolUses.length > 0 && messageStartEmitted) {
                  for (let i = 0; i < unseenToolUses.length; i++) {
                    const tu = unseenToolUses[i]!
                    const blockIndex = eventsForwarded + i
                    streamedToolUseIds.add(tu.id)

                    // content_block_start
                    safeEnqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} }
                      })}\n\n`
                    ), "passthrough_tool_block_start")

                    // input_json_delta with the full input
                    safeEnqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) }
                      })}\n\n`
                    ), "passthrough_tool_input")

                    // content_block_stop
                    safeEnqueue(encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: blockIndex
                      })}\n\n`
                    ), "passthrough_tool_block_stop")
                  }

                  // The turn really did end in tool calls, so the withheld
                  // delta's stop_reason is wrong — override it. Emitting a
                  // second delta here is what gave one message two conflicting
                  // terminal frames once recovery started appending blocks.
                  sendTerminalDelta("tool_use")
                }

                // Passthrough mode: scan body.messages for file changes on end_turn
                if (trackFileChanges && passthrough && pipelineCtx.extractFileChangesFromToolUse) {
                  const passthroughChanges = extractFileChangesFromMessages(
                    body.messages || [],
                    pipelineCtx.extractFileChangesFromToolUse
                  )
                  fileChanges.push(...passthroughChanges)
                }

                // Emit file change summary as a text block before closing
                if (trackFileChanges) {
                  const streamFileChangeSummary = formatFileChangeSummary(fileChanges)
                  if (streamFileChangeSummary && messageStartEmitted) {
                    const fcBlockIndex = nextClientBlockIndex++
                    safeEnqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: fcBlockIndex,
                        content_block: { type: "text", text: "" },
                      })}\n\n`
                    ), "file_changes_block_start")
                    safeEnqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: fcBlockIndex,
                        delta: { type: "text_delta", text: streamFileChangeSummary },
                      })}\n\n`
                    ), "file_changes_text_delta")
                    safeEnqueue(encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: fcBlockIndex,
                      })}\n\n`
                    ), "file_changes_block_stop")
                    claudeLog("response.file_changes", { mode: "stream", count: fileChanges.length })
                  }
                }

                // Emit the terminal pair (both were withheld through the turn
                // so recovered content lands ahead of them, where clients can
                // still see it).
                if (messageStartEmitted) {
                  sendTerminalDelta()
                  safeEnqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`), "final_message_stop")
                }

                try { controller.close() } catch {}
                streamClosed = true

                claudeLog("stream.ended", {
                  model,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  bytesSent,
                  durationMs: Date.now() - requestStartAt
                })
              }

              // Record telemetry for ALL completed streams (including early-close from
              // passthrough tool_use break and client disconnect during enqueue).
              // Must be outside the if(!streamClosed) block.
              {
                const streamTotalDurationMs = Date.now() - requestStartAt

                claudeLog("response.completed", {
                  mode: "stream",
                  model,
                  durationMs: streamTotalDurationMs,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded
                })

                const streamQueueWaitMs = totalQueueWaitMs(requestMeta)
                checkTokenHealth(
                  requestMeta.requestId,
                  currentSessionId || resumeSessionId,
                  lastUsage,
                  allMessages.length,
                  isResume,
                  passthrough
                )
                telemetryStore.record({
                  requestId: requestMeta.requestId,
                  timestamp: Date.now(),
                  adapter: adapter.name,
            profileId: profile.id,
            requestSource,
                  model,
                  requestModel: body.model || undefined,
                  mode: "stream",
                  isResume,
                  isPassthrough: passthrough,
                  hasDeferredTools,
                  deferredToolCount: hasDeferredTools ? deferredToolCount : undefined,
                  toolCount,
                  discoveredTools: discoveredTools.size > 0 ? [...discoveredTools] : undefined,
            sessionDiscoveredCount: sessionDiscoveredTools.get(currentSessionId || resumeSessionId || "")?.size,
                  lineageType,
                  messageCount: allMessages.length,
                  sdkSessionId: currentSessionId || resumeSessionId,
                  status: 200,
                  queueWaitMs: streamQueueWaitMs,
                  sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
                  sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
                  proxyOverheadMs: Math.max(0, streamTotalDurationMs - streamQueueWaitMs - requestMeta.sdkActiveDurationMs),
                  ttfbMs: requestMeta.ttfbMs ?? null,
                  upstreamDurationMs: requestMeta.sdkActiveDurationMs,
                  totalDurationMs: streamTotalDurationMs,
                  contentBlocks: eventsForwarded,
                  textEvents: textEventsForwarded,
                  error: null,
                  inputTokens: lastUsage?.input_tokens,
                  outputTokens: lastUsage?.output_tokens,
                  cacheReadInputTokens: lastUsage?.cache_read_input_tokens,
                  cacheCreationInputTokens: lastUsage?.cache_creation_input_tokens,
                  cacheHitRate: computeCacheHitRate(lastUsage),
                  ...(envelopeViolations.length > 0 ? { envelopeViolations: [...envelopeViolations] } : {}),
                })

                // The silent-turn invariant (see turnOutcome.ts): a terminal
                // envelope must carry text or a tool call. The old check only
                // logged missing text, which said nothing about whether the
                // client got anything actionable — a tool-only turn tripped it
                // while being perfectly healthy, and a thinking-only turn
                // looked identical to one.
                const turnOutcome = classifyNow()
                if (turnOutcome.kind === "silent") {
                  claudeLog("response.silent_turn", {
                    model,
                    reason: turnOutcome.reason,
                    streamEventsSeen,
                    eventsForwarded,
                    outputTokens: lastUsage?.output_tokens,
                    recovered: silentTurnRecovered,
                    recoveryAttempted: silentTurnRecoveryAttempted,
                  })
                  // Named at session level too: an autonomous run has nobody to
                  // notice a quiet telemetry row, and this is the one event that
                  // means "the loop just lost a turn".
                  diagnosticLog.session(
                    `${requestMeta.requestId} silent_turn reason=${turnOutcome.reason} ` +
                    `blocks=${eventsForwarded} out=${lastUsage?.output_tokens ?? 0} ` +
                    `recovery=${silentTurnRecoveryAttempted ? (silentTurnRecovered ? "succeeded" : "failed") : "off"}`,
                    requestMeta.requestId,
                  )
                }
              }
            } catch (error) {
              if (isClosedControllerError(error)) {
                streamClosed = true
                claudeLog("stream.client_closed", {
                  source: "stream_catch",
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  durationMs: Date.now() - requestStartAt
                })
                // This was the only terminal path that returned without
                // settling the session: the mapping stayed pointed at the
                // interrupted tail (every following turn then came back empty)
                // and follow-ups waited on a promise nobody resolved. Both
                // obligations are met before returning.
                const disposition = clientAbortDisposition({
                  isIndependentSession,
                  profileSessionId,
                  currentSessionId,
                  sawDuplicateToolUse,
                  toolCallAssistantUuid: nextPassthroughToolCallAssistantUuid,
                  passthrough,
                })
                if (disposition.action === "evict") {
                  evictSession(profileSessionId, profileScopedCwd, body.messages || [])
                }
                claudeLog("passthrough.client_abort_settled", { action: disposition.action })
                return
              }

              if (passthrough && streamedToolUseIds.size > 0 && !sawCanonicalResult) {
                // The client may already have advanced past this tool turn, so
                // a failed hidden drain invalidates even an older cached mapping.
                evictSession(profileSessionId, profileScopedCwd, body.messages || [])
                claudeLog("passthrough.noncanonical_session_evicted", { mode: "stream", reason: "drain_error" })
              }

              const stderrOutput = stderrLines.join("\n").trim()
              if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
                error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
              }
              const errMsg = error instanceof Error ? error.message : String(error)
              claudeLog("upstream.failed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                textEventsForwarded,
                error: errMsg,
                ...(stderrOutput ? { stderr: stderrOutput } : {})
              })
              const streamErr = error instanceof UpstreamIdleError
                ? {
                    status: 504,
                    type: "upstream_timeout",
                    message: `Upstream stalled: no data for ${error.sinceLastMs}ms`,
                  }
                : classifyError(errMsg, model)
              claudeLog("proxy.anthropic.error", { error: errMsg, classified: streamErr.type })

              // Surface the SDK termination reason (max_turns / process_exit / aborted)
              // and stderr tail to /telemetry/logs?category=error so failures are
              // visible without trawling raw log files.
              const sdkTerm = extractSdkTermination(errMsg)

              // Graceful recovery: when max_turns hits in passthrough mode but
              // we already captured tool_use blocks, the client has actionable
              // content — they received the tool_use blocks via SSE before the
              // budget was exhausted. Convert the failure into a clean
              // stop_reason="tool_use" response so the client executes the
              // tools and drives the next turn (the same outcome as a normal
              // tool-use cycle). Without this, the client sees a 500 even
              // though we already streamed everything it needs.
              // "aborted" is accepted only for the proxy's own remaining
              // single-step duplicate abort. Checkpoint settlement no longer
              // aborts, and a client-disconnect abort must not be recovered.
              // "upstream_idle" joins them for the same reason (#770): the guard
              // killed a stalled stream, but the tool calls were already
              // captured and are exactly what the client needs to make progress.
              // Discarding them turns a recoverable stall into a turn the model
              // later reports having "forgotten", because the next resume shows
              // its promise to act with no matching call.
              const canRecoverAsToolUse = canRecoverCapturedToolUses({
                reason: sdkTerm.reason,
                passthrough,
                capturedToolUses: capturedToolUses.length,
                abortIsOurs: sawDuplicateToolUse,
              }) && messageStartEmitted

              if (canRecoverAsToolUse) {
                // Log the recovery at session level (not error) — it's a
                // notable flow control event but not a failure for the client.
                diagnosticLog.session(
                  `${requestMeta.requestId} sdk_termination_recovered ${formatSdkTermination(sdkTerm, {
                    model,
                    requestSource,
                    isResume,
                    hasDeferredTools,
                    sdkSessionId: resumeSessionId,
                  })} captured=${capturedToolUses.length}`,
                  requestMeta.requestId,
                )

                // Close any content block whose start was forwarded but whose
                // stop was lost to the abort (SIGTERM can cut the stream after
                // a tool_use block's input deltas but before its stop) — an
                // unterminated block renders client-side as an argument-less
                // aborted call (#552 "red reads").
                flushOpenClientBlocks("recovery")

                // Mirror the success-path emission: send any unseen tool_uses
                // (dedup against streamedToolUseIds), then a clean
                // message_delta with stop_reason="tool_use" + message_stop.
                const unseenToolUses = capturedToolUses.filter(tu => !streamedToolUseIds.has(tu.id))
                for (let i = 0; i < unseenToolUses.length; i++) {
                  const tu = unseenToolUses[i]!
                  const blockIndex = eventsForwarded + i
                  streamedToolUseIds.add(tu.id)
                  safeEnqueue(encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} }
                    })}\n\n`
                  ), "recover_tool_block_start")
                  safeEnqueue(encoder.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: blockIndex,
                      delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) }
                    })}\n\n`
                  ), "recover_tool_input")
                  safeEnqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: blockIndex
                    })}\n\n`
                  ), "recover_tool_block_stop")
                }
                safeEnqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "tool_use", stop_sequence: null },
                    usage: { output_tokens: 0 }
                  })}\n\n`
                ), "recover_message_delta")
                safeEnqueue(encoder.encode(
                  `event: message_stop\ndata: {"type":"message_stop"}\n\n`
                ), "recover_message_stop")

                recordEnvelopeViolations(checkUndeliveredToolUses(capturedToolUses, streamedToolUseIds))
                // Record as success — the client got a usable response.
                const recoverTotalMs = Date.now() - requestStartAt
                const recoverQueueWaitMs = totalQueueWaitMs(requestMeta)
                telemetryStore.record({
                  requestId: requestMeta.requestId,
                  timestamp: Date.now(),
                  adapter: adapter.name,
                  profileId: profile.id,
                  requestSource,
                  model,
                  requestModel: body.model || undefined,
                  mode: "stream",
                  isResume,
                  isPassthrough: passthrough,
                  hasDeferredTools,
                  deferredToolCount: hasDeferredTools ? deferredToolCount : undefined,
                  toolCount,
                  lineageType,
                  messageCount: allMessages.length,
                  sdkSessionId: resumeSessionId,
                  status: 200,
                  queueWaitMs: recoverQueueWaitMs,
                  sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
                  sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
                  proxyOverheadMs: Math.max(0, recoverTotalMs - recoverQueueWaitMs - requestMeta.sdkActiveDurationMs),
                  ttfbMs: requestMeta.ttfbMs ?? null,
                  upstreamDurationMs: requestMeta.sdkActiveDurationMs,
                  totalDurationMs: recoverTotalMs,
                  contentBlocks: eventsForwarded + unseenToolUses.length,
                  textEvents: textEventsForwarded,
                  error: null,
                  ...(envelopeViolations.length > 0 ? { envelopeViolations: [...envelopeViolations] } : {}),
                })

                if (!streamClosed) {
                  try { controller.close() } catch {}
                  streamClosed = true
                }
                return
              }

              diagnosticLog.error(
                `${requestMeta.requestId} ${formatSdkTermination(sdkTerm, {
                  model,
                  requestSource,
                  isResume,
                  hasDeferredTools,
                  sdkSessionId: resumeSessionId,
                })}`,
                requestMeta.requestId,
              )

              // Record the failed request in the telemetry store. Without this,
              // streaming errors would not appear in /telemetry/requests at all
              // (the success path's record call never runs when this catch fires).
              const streamErrTotalMs = Date.now() - requestStartAt
              const streamErrQueueWaitMs = totalQueueWaitMs(requestMeta)
              telemetryStore.record({
                requestId: requestMeta.requestId,
                timestamp: Date.now(),
                adapter: adapter.name,
                profileId: profile.id,
                requestSource,
                model,
                requestModel: body.model || undefined,
                mode: "stream",
                isResume,
                isPassthrough: passthrough,
                hasDeferredTools,
                deferredToolCount: hasDeferredTools ? deferredToolCount : undefined,
                toolCount,
                lineageType,
                messageCount: allMessages.length,
                sdkSessionId: resumeSessionId,
                status: streamErr.status,
                queueWaitMs: streamErrQueueWaitMs,
                sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
                sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
                proxyOverheadMs: Math.max(0, streamErrTotalMs - streamErrQueueWaitMs - requestMeta.sdkActiveDurationMs),
                ttfbMs: requestMeta.ttfbMs ?? null,
                upstreamDurationMs: requestMeta.sdkActiveDurationMs,
                totalDurationMs: streamErrTotalMs,
                contentBlocks: eventsForwarded,
                textEvents: textEventsForwarded,
                error: streamErr.type,
              })

              // If we already emitted message_start, close the message cleanly so
              // clients that access usage.input_tokens don't crash on the incomplete response.
              //
              // The stop_reason here is load-bearing. This path runs when the
              // turn FAILED, and it used to send "end_turn" — the wire's word
              // for "the model finished and had nothing more to say". A client
              // cannot distinguish that from success, so it does not retry, and
              // an autonomous loop treats a crashed turn as a completed one.
              // The error event that follows arrives AFTER message_stop, which
              // most clients have already stopped reading.
              //
              // A turn cut off mid-generation is exactly what "max_tokens"
              // describes on the wire — truncated, not finished — and every
              // Anthropic-compatible client already handles it.
              //
              // Unconditional, including when text was already forwarded (#770).
              // The earlier carve-out reserved "end_turn" for "the model really
              // did produce a complete answer before the failure", but nothing
              // here can know that: reaching this branch means the turn raised
              // instead of completing, and a partial answer followed by a crash
              // is still a truncation. Emitting "end_turn" there was the one
              // value that actively lies, and it lies in the direction that
              // makes an autonomous loop stop.
              if (messageStartEmitted) {
                const errorStopReason = "max_tokens"
                claudeLog("response.error_envelope", {
                  mode: "stream",
                  stopReason: errorStopReason,
                  textEvents: textEventsForwarded,
                  classified: streamErr.type,
                })
                safeEnqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: errorStopReason, stop_sequence: null },
                    usage: { output_tokens: 0 }
                  })}\n\n`
                ), "error_message_delta")
                // The error goes out BEFORE message_stop, not after.
                //
                // message_stop is the wire's end-of-message marker: clients stop
                // reading the body at it, so an error event queued afterwards was
                // written into a stream nobody was still consuming. That is how a
                // failed turn arrived looking like a successful one — the
                // incompleteness existed in the SSE, one frame too late to be
                // seen. Ordering it first is what makes the failure reach the
                // client at all.
                safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                  type: "error",
                  error: { type: streamErr.type, message: streamErr.message }
                })}\n\n`), "error_event_before_stop")
                safeEnqueue(encoder.encode(
                  `event: message_stop\ndata: {"type":"message_stop"}\n\n`
                ), "error_message_stop")
              } else {
                // No message_start was ever emitted, so there is no message to
                // close — the error event is the whole response.
                safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                  type: "error",
                  error: { type: streamErr.type, message: streamErr.message }
                })}\n\n`), "error_event")
              }
              if (!streamClosed) {
                try { controller.close() } catch {}
                streamClosed = true
              }
            } finally {
              requestAbort.detach()
            }
            })().finally(() => {
              resolveStreamCompletion()
            })
          },
          cancel(reason) {
            requestAbort.abort(reason)
            requestAbort.detach()
            if (!isIndependentSession) {
              // Cancellation can terminate the iterator without producing the
              // closed-controller error handled above. Evict synchronously so
              // no interrupted tail remains resumable even if the SDK never yields.
              evictSession(profileSessionId, profileScopedCwd, body.messages || [])
              claudeLog("passthrough.client_abort_settled", { action: "evict", source: "stream_cancel" })
            }
          },
        })

        const streamSessionId = resumeSessionId || `session_${Date.now()}`
        streamOwnsAbortLink = true
        const streamResponse = new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Claude-Session-ID": streamSessionId
          }
        })
        responseCompletions.set(streamResponse, streamCompletion)
        return streamResponse
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: errMsg
        })

        // Detect specific error types and return helpful messages
        const classified = requestAbort.controller.signal.aborted
          ? { status: 499, type: "request_cancelled", message: "The request was cancelled" }
          : classifyError(errMsg)

        claudeLog("proxy.error", { error: errMsg, classified: classified.type })

        // Surface the SDK termination reason. Outer-catch context is limited —
        // model/isResume/etc. may not be assigned yet if the error fired early —
        // so include only the request-source header (resolved before any work).
        const sdkTerm = extractSdkTermination(errMsg)
        diagnosticLog.error(
          `${requestMeta.requestId} ${formatSdkTermination(sdkTerm, {
            requestSource: c.req.header("x-meridian-source")?.slice(0, 64) || undefined,
          })}`,
          requestMeta.requestId,
        )

        const errorQueueWaitMs = totalQueueWaitMs(requestMeta)
        const errorTotalMs = Date.now() - requestStartAt
        telemetryStore.record({
          requestId: requestMeta.requestId,
          timestamp: Date.now(),
          adapter: adapter.name,
          model: "unknown",
          requestModel: undefined,
          mode: "non-stream",
          isResume: false,
          isPassthrough: envBool("PASSTHROUGH"),
          hasDeferredTools: undefined,
          deferredToolCount: undefined,
          toolCount: undefined,
          lineageType: undefined,
          messageCount: undefined,
          sdkSessionId: undefined,
          status: classified.status,
          queueWaitMs: errorQueueWaitMs,
          sessionQueueWaitMs: requestMeta.sessionQueueWaitMs,
          sdkQueueWaitMs: requestMeta.sdkQueueWaitMs,
          proxyOverheadMs: Math.max(0, errorTotalMs - errorQueueWaitMs - requestMeta.sdkActiveDurationMs),
          ttfbMs: null,
          upstreamDurationMs: requestMeta.sdkActiveDurationMs,
          totalDurationMs: errorTotalMs,
          contentBlocks: 0,
          textEvents: 0,
          error: classified.type,
        })

        return new Response(
          JSON.stringify({ type: "error", error: { type: classified.type, message: classified.message } }),
          { status: classified.status, headers: { "Content-Type": "application/json" } }
        )
      } finally {
        if (!streamOwnsAbortLink) requestAbort.detach()
      }
    })
  }

  const handleWithQueue = async (c: Context, endpoint: string) => {
    // An internal hop carries a request the public route already admitted;
    // re-checking the gate here would refuse work that is legitimately in
    // flight. Everything arriving from the wire is gated normally.
    if (draining && c.req.header("x-meridian-internal-hop") !== internalHopToken) {
      return drainingResponse()
    }
    const requestId = c.req.header("x-request-id") || randomUUID()
    const queueEnteredAt = Date.now()
    claudeLog("request.enter", { requestId, endpoint })
    let sessionTurnLease: SessionTurnLease | undefined
    let finished = false
    let leaseReleased = false
    let leaseWatchdog: ReturnType<typeof setTimeout> | undefined
    inFlightRequests++
    // Releasing the lease is deliberately separate from finishing the request:
    // the watchdog must be able to unblock the session without also corrupting
    // the in-flight count that the shutdown drain reads.
    const releaseSessionTurn = (forced: boolean) => {
      if (leaseReleased || !sessionTurnLease) return
      leaseReleased = true
      if (leaseWatchdog) clearTimeout(leaseWatchdog)
      if (forced) {
        claudeLog("session.turn_lease_forced", { requestId, heldMs: SESSION_TURN_MAX_HOLD_MS })
        plog(`[PROXY] ${requestId} session turn lease force-released after ${SESSION_TURN_MAX_HOLD_MS}ms`)
      }
      sessionTurnLease.release()
    }
    const finishRequest = () => {
      if (finished) return
      finished = true
      releaseSessionTurn(false)
      inFlightRequests--
    }

    let body: any
    try {
      try {
        body = await c.req.json()
      } catch (error) {
        if (c.req.raw.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          finishRequest()
          return new Response(JSON.stringify({
            type: "error",
            error: { type: "request_cancelled", message: "The request was cancelled" },
          }), { status: 499, headers: { "Content-Type": "application/json" } })
        }
        finishRequest()
        return new Response(JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Request body must be valid JSON" },
        }), { status: 400, headers: { "Content-Type": "application/json" } })
      }

      // Fingerprints are intentionally excluded here: they only hash the first
      // user message + cwd and cannot distinguish independent headerless chats.
      // Strict serialization is safe only when the adapter supplies a reliable
      // client-session identity.
      if (Array.isArray(body?.messages)) {
        const adapter = detectAdapter(c)
        const agentSessionId = adapter.getSessionId(c, body)
        if (agentSessionId) {
          try {
            sessionTurnLease = await processSessionTurns.acquire(
              `session:${agentSessionId}`,
              c.req.raw.signal,
            )
            leaseWatchdog = setTimeout(() => releaseSessionTurn(true), SESSION_TURN_MAX_HOLD_MS)
            leaseWatchdog.unref?.()
          } catch (error) {
            if (c.req.raw.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
              // This return happens before RequestMeta exists, so no other
              // telemetry path can see it — without a row here, every request
              // cancelled while queued behind another turn is invisible, and
              // "clients give up waiting on the session lock" is exactly the
              // symptom this whole feature can cause.
              const cancelledWaitMs = Date.now() - queueEnteredAt
              telemetryStore.record({
                requestId,
                timestamp: Date.now(),
                adapter: adapter.name,
                model: "unknown",
                requestModel: undefined,
                mode: "non-stream",
                isResume: false,
                isPassthrough: envBool("PASSTHROUGH"),
                hasDeferredTools: undefined,
                deferredToolCount: undefined,
                toolCount: undefined,
                lineageType: undefined,
                messageCount: Array.isArray(body?.messages) ? body.messages.length : undefined,
                sdkSessionId: undefined,
                status: 499,
                queueWaitMs: cancelledWaitMs,
                sessionQueueWaitMs: cancelledWaitMs,
                sdkQueueWaitMs: 0,
                proxyOverheadMs: 0,
                ttfbMs: null,
                upstreamDurationMs: 0,
                totalDurationMs: cancelledWaitMs,
                contentBlocks: 0,
                textEvents: 0,
                error: "request_cancelled",
              })
              finishRequest()
              return new Response(JSON.stringify({
                type: "error",
                error: { type: "request_cancelled", message: "The request was cancelled" },
              }), { status: 499, headers: { "Content-Type": "application/json" } })
            }
            throw error
          }
        }
      }

      const requestMeta: RequestMeta = {
        requestId,
        endpoint,
        queueEnteredAt,
        sessionQueueWaitMs: sessionTurnLease?.waitedMs ?? 0,
        sdkQueueWaitMs: 0,
        sdkActiveDurationMs: 0,
        sessionTurnLease,
      }
      const response = await handleMessages(c, requestMeta, { body })
      const completion = responseCompletions.get(response)
      if (completion) {
        // .finally() re-throws whatever it settled with, so the catch is what
        // keeps a future rejecting completion from surfacing as an unhandled
        // rejection. It runs after finishRequest, which fires either way.
        void completion.finally(finishRequest).catch(() => {})
      } else {
        finishRequest()
      }
      return response
    } catch (error) {
      finishRequest()
      throw error
    }
  }

  app.post("/v1/messages", (c) => handleWithQueue(c, "/v1/messages"))
  app.post("/messages", (c) => handleWithQueue(c, "/messages"))

  // Telemetry dashboard and API
  app.route("/telemetry", createTelemetryRoutes())

  // SDK Features settings page and API
  app.get("/settings", (c) => {
    const { settingsPageHtml } = require("../telemetry/settingsPage") as typeof import("../telemetry/settingsPage")
    return c.html(settingsPageHtml)
  })
  app.get("/settings/api/features", (c) => {
    const { getAllFeatureConfigs } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    return c.json(getAllFeatureConfigs())
  })
  app.patch("/settings/api/features/:adapter", async (c) => {
    const { validateFeatureUpdate, updateAdapterFeatures } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    const adapter = c.req.param("adapter")
    const body = await c.req.json()
    let validated: ReturnType<typeof validateFeatureUpdate>
    try {
      validated = validateFeatureUpdate(body)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    updateAdapterFeatures(adapter, validated)
    return c.json({ ok: true })
  })
  app.delete("/settings/api/features/:adapter", (c) => {
    const { resetAdapterFeatures } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    const adapter = c.req.param("adapter")
    resetAdapterFeatures(adapter)
    return c.json({ ok: true })
  })

  // Model pricing for the telemetry cost estimate: built-in table + user overrides
  // Routing configuration (priority spec): mode + pool order, editable from
  // the /settings UI. MERIDIAN_ROUTING / MERIDIAN_PROFILE_ORDER env vars
  // still take precedence when set (reported so the UI can say so).
  app.get("/settings/api/routing", (c) => {
    const profiles = listProfiles(finalConfig.profiles, finalConfig.defaultProfile)
    return c.json({
      routing: getRoutingMode(process.env.MERIDIAN_ROUTING ?? getSetting("routing")),
      profileOrder: resolvePriorityOrder(profiles.map(p => p.id), priorityProfileOrderSetting()).order,
      profiles: profiles.map(p => p.id),
      envOverride: {
        routing: Boolean(process.env.MERIDIAN_ROUTING),
        profileOrder: Boolean(process.env.MERIDIAN_PROFILE_ORDER),
      },
    })
  })
  app.put("/settings/api/routing", async (c) => {
    let body: { routing?: unknown; profileOrder?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: "Invalid JSON" }, 400) }
    if (body.routing !== undefined) {
      if (typeof body.routing !== "string" || !["active", "sticky", "priority"].includes(body.routing)) {
        return c.json({ error: 'routing must be "active", "sticky", or "priority"' }, 400)
      }
      setSetting("routing", body.routing)
    }
    if (body.profileOrder !== undefined) {
      if (!Array.isArray(body.profileOrder) || body.profileOrder.some(x => typeof x !== "string")) {
        return c.json({ error: "profileOrder must be an array of profile ids" }, 400)
      }
      const known = new Set(listProfiles(finalConfig.profiles, finalConfig.defaultProfile).map(p => p.id))
      const unknown = (body.profileOrder as string[]).filter(id => !known.has(id))
      if (unknown.length > 0) return c.json({ error: `Unknown profiles: ${unknown.join(", ")}` }, 400)
      setSetting("profileOrder", body.profileOrder as string[])
    }
    plog(`[PROXY] Routing settings updated: routing=${getSetting("routing") ?? "active"} order=${(getSetting("profileOrder") ?? []).join(",") || "(config order)"}`)
    return c.json({ success: true })
  })

  app.get("/settings/api/pricing", (c) => {
    const { BUILTIN_MODEL_PRICING } = require("../telemetry/pricing") as typeof import("../telemetry/pricing")
    const { getPricingOverrides } = require("../telemetry/pricingStore") as typeof import("../telemetry/pricingStore")
    return c.json({ builtin: BUILTIN_MODEL_PRICING, overrides: getPricingOverrides() })
  })
  app.put("/settings/api/pricing/:model", async (c) => {
    const { validatePricingUpdate, setPricingOverride } = require("../telemetry/pricingStore") as typeof import("../telemetry/pricingStore")
    const model = c.req.param("model")
    try {
      // json() throws on malformed bodies — keep it inside the try so the
      // client gets a 400, not a 500 (house pattern: /profiles/active).
      const body = await c.req.json()
      setPricingOverride(model, validatePricingUpdate(body))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    return c.json({ ok: true })
  })
  app.delete("/settings/api/pricing/:model", (c) => {
    const { deletePricingOverride } = require("../telemetry/pricingStore") as typeof import("../telemetry/pricingStore")
    try {
      deletePricingOverride(c.req.param("model"))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    return c.json({ ok: true })
  })

  // Prometheus metrics endpoint
  app.get("/metrics", (c) => {
    const body = renderPrometheusMetrics(telemetryStore)
    return c.body(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    })
  })

  // Health check endpoint — verifies auth status
  app.get("/health", async (c) => {
    // Checked first and unconditionally: a fleet manager routing on this
    // endpoint (e.g. a gateway's account-pool scheduler) needs to learn
    // "stop sending here" as fast as possible during shutdown, without
    // waiting on an auth-status round trip.
    if (draining) {
      return c.json({
        status: "draining",
        version: serverVersion,
        message: "Meridian is shutting down; route new requests to another instance.",
      }, 503)
    }
    try {
      // Use active profile's auth context for health check
      const healthProfile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile)
      const profileEnvOverrides = Object.keys(healthProfile.env).length > 0 ? healthProfile.env : undefined
      const auth = await getClaudeAuthStatusAsync(
          healthProfile.id !== "default" ? healthProfile.id : undefined,
          profileEnvOverrides
        )
      if (!auth) {
        return c.json({
          status: "degraded",
          version: serverVersion,
          error: "Could not verify auth status",
          mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
        })
      }
      if (!auth.loggedIn) {
        return c.json({
          status: "unhealthy",
          version: serverVersion,
          error: "Not logged in. Run: claude login",
          auth: { loggedIn: false }
        }, 503)
      }
      // Resolved Claude executable + which step produced it. Diagnostic
      // surface for "the SDK is spawning the wrong claude" issues (#478).
      // Null when /health is hit before the first SDK call (resolution is
      // lazy in createProxyServer); startProxyServer eagerly populates it.
      const claudeExecutableInfo = getResolvedClaudeExecutableInfo()

      // How long the login itself has left. Surfaced here because it is the
      // one auth failure the proxy cannot recover from on its own, and it is
      // knowable days in advance — external monitors alert on
      // `renewalRequiredSoon`. Best-effort: a credential-store hiccup must not
      // turn a healthy proxy into a degraded one.
      const warnDays = resolveRenewalWarnDays(process.env.MERIDIAN_AUTH_RENEWAL_WARN_DAYS)
      // Read the *profile's* credential store, not the default one — profiles
      // are separate auth contexts keyed by CLAUDE_CONFIG_DIR, so the default
      // store would report an unrelated account's expiry.
      const renewalConfigDir = profileEnvOverrides?.CLAUDE_CONFIG_DIR
      const renewal = await getAuthRenewalStatus(
        renewalConfigDir ? createPlatformCredentialStore({ claudeConfigDir: renewalConfigDir }) : undefined,
        warnDays,
      ).catch(() => ({ renewalRequiredSoon: false }))

      return c.json({
        status: "healthy",
        version: serverVersion,
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
          ...renewal,
        },
        mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
        ...(claudeExecutableInfo ? { claudeExecutable: claudeExecutableInfo } : {}),
        plugin: { opencode: checkPluginConfigured() ? "configured" : "not-configured" },
      })
    } catch {
      return c.json({
        status: "degraded",
        version: serverVersion,
        error: "Could not verify auth status",
        mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
      })
    }
  })

  // --- Profile management routes ---

  app.get("/profiles/list", async (c) => {
    const profiles = listProfiles(finalConfig.profiles, finalConfig.defaultProfile)
    // Enrich with live auth status
    const enriched = await Promise.all(profiles.map(async (p) => {
      const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, p.id)
      const envOverrides = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
      const auth = await getClaudeAuthStatusAsync(
        p.id !== "default" ? p.id : undefined,
        envOverrides
      )
      const cacheInfo = getAuthCacheInfo(p.id !== "default" ? p.id : undefined)
      return {
        ...p,
        email: auth?.email || null,
        subscriptionType: auth?.subscriptionType || null,
        loggedIn: auth?.loggedIn ?? false,
        lastCheckedAt: cacheInfo.lastCheckedAt || null,
        lastSuccessAt: cacheInfo.lastSuccessAt || null,
      }
    }))
    const routingModeNow = getRoutingMode(process.env.MERIDIAN_ROUTING ?? getSetting("routing"))
    // Additive (priority spec): pool order + live exhaustion state so UIs
    // (meridian home, pylon's switcher) can render the pool.
    const priorityInfo = routingModeNow === "priority"
      ? {
          profileOrder: resolvePriorityOrder(profiles.map(p => p.id), priorityProfileOrderSetting()).order,
          exhausted: priorityExhaustion.snapshot(),
        }
      : {}
    return c.json({
      profiles: enriched,
      activeProfile: getActiveProfileId() || finalConfig.defaultProfile || profiles[0]?.id || "default",
      // Additive (#383): current routing mode so UIs can surface it.
      routing: routingModeNow,
      ...priorityInfo,
    })
  })

  app.get("/profiles", async (c) => {
    const { profilePageHtml } = await import("../telemetry/profilePage")
    return c.html(profilePageHtml)
  })

  app.post("/profiles/active", async (c) => {
    let body: { profile?: string }
    try {
      body = await c.req.json() as { profile?: string }
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400)
    }
    if (!body.profile) {
      return c.json({ error: "Missing 'profile' in request body" }, 400)
    }
    const effective = getEffectiveProfiles(finalConfig.profiles)
    if (effective.length === 0) {
      return c.json({ error: "No profiles configured" }, 400)
    }
    if (!effective.find(p => p.id === body.profile)) {
      return c.json({ error: `Unknown profile: ${body.profile}. Available: ${effective.map(p => p.id).join(", ")}` }, 400)
    }
    const previousProfile = getActiveProfileId() ?? null
    setActiveProfile(body.profile!)
    // Evict all cached SDK sessions — they were started under the old profile's
    // credentials and cannot be reused with different auth. The rate-limit
    // store is NOT cleared: entries are profile-scoped, so the new profile
    // can no longer read the old one's quotas, and other profiles' snapshots
    // stay valid (consumers judge staleness from `observedAt`).
    clearSessionCache()
    // Attribute the switch: multiple surfaces can POST here (the meridian UI,
    // the CLI, pylon's provider switcher, the iOS companion) and the active
    // profile is GLOBAL state — an unexplained flip should be answerable from
    // the logs, not an investigation.
    claudeLog("profile.switched", {
      from: previousProfile,
      to: body.profile,
      userAgent: c.req.header("user-agent")?.slice(0, 120) ?? null,
      origin: c.req.header("origin") ?? c.req.header("referer")?.slice(0, 120) ?? null,
    })
    plog(`[PROXY] Active profile switched to: ${body.profile} (from ${previousProfile ?? "unset"}, ua: ${(c.req.header("user-agent") || "unknown").slice(0, 60)}) (session + rate-limit caches cleared)`)
    return c.json({ success: true, activeProfile: body.profile })
  })

  // --- Plugin management routes ---

  app.get("/plugins/list", async (c) => {
    const { getPluginStats } = await import("./plugins/stats")
    return c.json({
      plugins: loadedPlugins.map(p => ({
        name: p.name,
        description: p.description,
        version: p.version,
        adapters: p.adapters,
        hooks: p.hooks,
        status: p.status,
        path: p.path,
        ...(p.error ? { error: p.error } : {}),
        ...(p.status === "active" ? { stats: getPluginStats(p.name) } : {}),
      })),
    })
  })

  app.post("/plugins/reload", async (c) => {
    try {
      loadedPlugins = await loadPlugins(pluginDir, pluginConfigPath)
      pluginTransforms = getActiveTransforms(loadedPlugins)
      const active = loadedPlugins.filter(p => p.status === "active").length
      plog(`[PROXY] Plugins reloaded: ${active} active`)
      return c.json({
        success: true,
        plugins: loadedPlugins.map(p => ({
          name: p.name,
          status: p.status,
          hooks: p.hooks,
          ...(p.error ? { error: p.error } : {}),
        })),
      })
    } catch (err) {
      return c.json({ success: false, error: String(err) }, 500)
    }
  })

  app.get("/plugins", async (c) => {
    const { pluginPageHtml } = await import("./plugins/pluginPage")
    return c.html(pluginPageHtml)
  })

  app.post("/auth/refresh", async (c) => {
    const profile = resolveProfile(
      finalConfig.profiles,
      finalConfig.defaultProfile,
      c.req.header("x-meridian-profile") || undefined
    )
    const store = credentialStoreForProfile(profile)
    const success = store ? await refreshOAuthToken(store) : false
    if (success) {
      // Drop this profile's rate-limit snapshot — its quotas were observed
      // under the previous credential. Scoped to the profile actually
      // refreshed; other accounts' snapshots are untouched. The next SDK
      // call repopulates.
      rateLimitStore.clear(profile.id)
      return c.json({ success: true, message: "OAuth token refreshed successfully", profile: profile.id })
    }
    return c.json(
      { success: false, message: "Token refresh failed. If the problem persists, run 'claude login'." },
      500
    )
  })

  // --- OpenAI Chat Completions Compatibility ---
  // Translates OpenAI /v1/chat/completions requests to Anthropic format and
  // routes them through the internal /v1/messages handler via app.fetch().
  // No network roundtrip — Hono resolves the route in-process.
  // See src/proxy/openai.ts for the translation logic and design rationale.
  app.post("/v1/chat/completions", async (c) => {
    if (draining) return drainingResponse()
    const rawBody = await c.req.json() as Record<string, unknown>
    const userAgent = c.req.header("user-agent") ?? ""
    const jcodeSessionId = userAgent.startsWith("jcode/")
      ? normalizeJcodeSessionId(c.req.header("x-jcode-session"))
      : undefined
    const isJcode = jcodeSessionId !== undefined
    const adapterName = isJcode ? "jcode" : "openai"
    const anthropicBody = translateOpenAiToAnthropic(rawBody, {
      preserveConversationHistory: isJcode,
    })

    if (!anthropicBody) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
        400
      )
    }

    // Route internally via app.fetch() — no network roundtrip.
    // Hono resolves the path in-process; the URL scheme/host are ignored.
    // Forward the caller's auth headers so requireAuth on /v1/messages accepts
    // the inner hop when MERIDIAN_API_KEY is set (issue #415).
    // Tag the inner hop as generic OpenAI unless a verified Jcode request
    // supplied its durable local session ID. Both adapters keep the Claude Code
    // preset off, while Jcode additionally preserves append-only history.
    const internalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-meridian-agent": adapterName,
    }
    if (jcodeSessionId) internalHeaders["x-jcode-session"] = jcodeSessionId
    const requestedProfile = c.req.header("x-meridian-profile")
    if (requestedProfile) internalHeaders["x-meridian-profile"] = requestedProfile
    const xApiKey = c.req.header("x-api-key")
    if (xApiKey) internalHeaders["x-api-key"] = xApiKey
    const authz = c.req.header("authorization")
    if (authz) internalHeaders["authorization"] = authz
    internalHeaders["x-meridian-internal-hop"] = internalHopToken
    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(anthropicBody),
      signal: c.req.raw.signal,
    })
    const internalRes = await app.fetch(internalReq)

    if (!internalRes.ok) return relayInnerError(internalRes, "anthropic")

    const completionId = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = (typeof rawBody.model === "string" && rawBody.model) ? rawBody.model : CANONICAL_SONNET_MODEL

    // Resolve SDK features for the same adapter selected on the internal hop.
    const { getFeaturesForAdapter } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    const sdkFeatures = getFeaturesForAdapter(adapterName)

    if (!anthropicBody.stream) {
      const anthropicRes = await internalRes.json() as Record<string, unknown>
      return c.json(translateAnthropicToOpenAi(anthropicRes, completionId, model, created, {
        thinkingPassthrough: sdkFeatures.thinkingPassthrough
      }))
    }

    // Streaming: translate Anthropic SSE events to OpenAI SSE chunks
    const encoder = new TextEncoder()
    let internalReader: { cancel(reason?: unknown): Promise<void> } | undefined
    const readable = new ReadableStream({
      async start(controller) {
        const reader = internalRes.body?.getReader()
        if (!reader) { controller.close(); return }
        internalReader = reader

        const decoder = new TextDecoder()
        let buffer = ""
        let streamError: Error | null = null

        const streamOptions = rawBody.stream_options as { include_usage?: boolean } | undefined
        const includeUsage = streamOptions?.include_usage === true

        const translate = createSseTranslator({ completionId, model, created, thinkingPassthrough: sdkFeatures.thinkingPassthrough, includeUsage })

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const dataStr = line.slice(6).trim()
              if (!dataStr) continue

              let event: Record<string, unknown>
              try { event = JSON.parse(dataStr) as Record<string, unknown> }
              catch { continue }
              if (typeof event.type !== "string") continue

              const chunk = translate(event as unknown as AnthropicSseEvent)
              if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
          }
        } catch (err) {
          streamError = err instanceof Error ? err : new Error(String(err))
        } finally {
          if (!streamError) {
            const usageChunk = translate.buildUsageChunk()
            if (usageChunk) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`))
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          }
          controller.close()
        }
      },
      cancel(reason) {
        return internalReader?.cancel(reason)
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  })

  // --- OpenAI Responses API endpoint (#475) ---
  // Serves the Codex CLI (>= 0.96), which dropped wire_api="chat" and speaks
  // only /v1/responses. Translates Responses <-> Anthropic and forwards
  // in-process to /v1/messages via app.fetch() (no network roundtrip),
  // reusing auth, model mapping, session handling, and the passthrough tool
  // loop — mirroring /v1/chat/completions. Tagged x-meridian-agent: codex so
  // the codex adapter is selected (forces passthrough; preset OFF).
  // See src/proxy/openaiResponses.ts for the translation logic.
  app.post("/v1/responses", async (c) => {
    if (draining) return drainingResponse("openai")
    const rawBody = await c.req.json() as ResponsesRequest
    const anthropicBody = translateResponsesToAnthropic(rawBody)

    if (!anthropicBody) {
      return c.json(
        { error: { type: "invalid_request_error", message: "input: Field required", code: null } },
        400
      )
    }
    if (!anthropicBody.model) {
      return c.json(
        { error: { type: "invalid_request_error", message: "model: Field required", code: null } },
        400
      )
    }

    const internalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-meridian-agent": "codex",
    }
    // NOTE: agent-specific (Codex) — prompt_cache_key is Codex's stable
    // per-conversation id (mirrored as session_id in its client_metadata).
    // Forward it as the codex adapter's session header so consecutive turns
    // resume the same SDK session: Claude's signed thinking then persists
    // across turns natively and the prompt cache stays warm (#655).
    const promptCacheKey = (rawBody as { prompt_cache_key?: unknown }).prompt_cache_key
    if (typeof promptCacheKey === "string" && promptCacheKey.length > 0) {
      internalHeaders["x-codex-session"] = promptCacheKey
    }
    const xApiKey = c.req.header("x-api-key")
    if (xApiKey) internalHeaders["x-api-key"] = xApiKey
    const authz = c.req.header("authorization")
    if (authz) internalHeaders["authorization"] = authz
    const xProfile = c.req.header("x-meridian-profile")
    if (xProfile) internalHeaders["x-meridian-profile"] = xProfile

    internalHeaders["x-meridian-internal-hop"] = internalHopToken
    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(anthropicBody),
      signal: c.req.raw.signal,
    })
    const internalRes = await app.fetch(internalReq)

    if (!internalRes.ok) return relayInnerError(internalRes, "openai")

    const responseId = `resp_${randomUUID().replace(/-/g, "")}`
    const created = Math.floor(Date.now() / 1000)
    const model = (typeof rawBody.model === "string" && rawBody.model) ? rawBody.model : CANONICAL_SONNET_MODEL
    const ctx = { responseId, model, created, reasoningRequested: reasoningRequested(rawBody) }

    if (!anthropicBody.stream) {
      const anthropicRes = await internalRes.json() as Record<string, unknown>
      return c.json(translateAnthropicToResponses(anthropicRes, ctx))
    }

    // Streaming: translate Anthropic SSE → Responses SSE.
    const encoder = new TextEncoder()
    let internalReader: { cancel(reason?: unknown): Promise<void> } | undefined
    const readable = new ReadableStream({
      async start(controller) {
        const reader = internalRes.body?.getReader()
        if (!reader) { controller.close(); return }
        internalReader = reader

        const decoder = new TextDecoder()
        let buffer = ""
        const translate = createResponsesSseTranslator(ctx)

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const dataStr = line.slice(6).trim()
              if (!dataStr) continue
              let event: Record<string, unknown>
              try { event = JSON.parse(dataStr) as Record<string, unknown> }
              catch { continue }
              if (typeof event.type !== "string") continue
              for (const emission of translate(event as unknown as ResponsesAnthropicSseEvent)) {
                controller.enqueue(encoder.encode(`event: ${emission.event}\ndata: ${JSON.stringify(emission.data)}\n\n`))
              }
            }
          }
        } catch (err) {
          // Emit a Responses-shaped failure so Codex doesn't hang.
          const message = err instanceof Error ? err.message : String(err)
          controller.enqueue(encoder.encode(
            `event: response.failed\ndata: ${JSON.stringify({ response: { id: responseId, status: "failed", error: { message } } })}\n\n`
          ))
        } finally {
          controller.close()
        }
      },
      cancel(reason) {
        return internalReader?.cancel(reason)
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  })

  // --- Model Discovery ---
  // Returns available Claude models in OpenAI-compatible format.
  // Context window reflects the subscription tier: Max/Team/Enterprise get 1M
  // on the Opus/Fable tiers, everything else 200k. The tier check is shared
  // with models.ts (subscriptionIncludesExtendedContext) — an "=== max"
  // comparison here used to advertise 200k to Team accounts that Meridian was
  // already routing to opus[1m] (#826).
  app.get("/v1/models", async (c) => {
    const authStatus = await getClaudeAuthStatusAsync()
    const extendedContext = subscriptionIncludesExtendedContext(authStatus?.subscriptionType)
    return c.json({ object: "list", data: buildModelList(extendedContext) })
  })

  // --- Subscription Quota ---
  // Returns the most recent SDK-reported quota state for the Claude Max
  // subscription, broken down by rate-limit bucket (five_hour, seven_day,
  // seven_day_opus, seven_day_sonnet, overage).
  //
  // Source: `rate_limit_event` events emitted by `@anthropic-ai/claude-agent-sdk`'s
  // `query()` stream. We snapshot them as they arrive and serve the cache here.
  // The `utilization` field is a 0..1 fraction directly from Anthropic; `resetsAt`
  // is an epoch-ms timestamp.
  //
  // Returns 200 with `buckets: []` if no events have been observed yet (first
  // call after proxy restart).
  app.get("/v1/usage/quota", async (c) => {
    // Two data sources, merged:
    //   - OAuth usage API (continuous % via Anthropic's private endpoint,
    //     profile-scoped — reads credentials from the active profile's
    //     CLAUDE_CONFIG_DIR so multi-account setups don't cross-contaminate).
    //   - SDK rate_limit_event store (overage info, threshold-gated %).
    //
    // Strategy: build a bucket per known type. OAuth-sourced fields
    // (`utilization`, `resetsAt`) win when present — they're always
    // populated. SDK fields fill in overage details and any bucket types
    // OAuth doesn't expose.

    // Determine which profile we're querying:
    //   1. Explicit ?profile=<id> query param
    //   2. Active profile (set via UI / POST /profiles/active)
    //   3. First configured profile
    //   4. Default OAuth account (no claudeConfigDir override)
    const requestedProfile = c.req.query("profile")
    const profilesList = getEffectiveProfiles(finalConfig.profiles)
    const targetProfileId = requestedProfile
      || getActiveProfileId()
      || finalConfig.defaultProfile
      || profilesList[0]?.id
      || null
    const targetProfile = targetProfileId ? profilesList.find(p => p.id === targetProfileId) : undefined

    // Filter out the internal "default" bucket — it's a Meridian-side
    // fallback for SDK events missing `rateLimitType`, not a real Anthropic
    // bucket that consumers can render.
    // Entries are read for the resolved target profile only — a multi-account
    // setup must never render one account's SDK buckets under another's
    // identity.
    const sdkEntries = rateLimitStore.getAll(targetProfileId ?? "default")
      .filter(entry => entry.rateLimitType !== undefined)

    const oauth = await fetchOAuthUsage({
      profileId: targetProfileId ?? undefined,
      claudeConfigDir: targetProfile?.claudeConfigDir,
    })

    type Bucket = {
      type: string
      status: "allowed" | "allowed_warning" | "rejected"
      utilization: number | null
      resetsAt: number | null
      isUsingOverage: boolean
      overageStatus: string | null
      overageResetsAt: number | null
      overageDisabledReason: string | null
      surpassedThreshold: number | null
      observedAt: number
    }

    const byType = new Map<string, Bucket>()

    // Seed with SDK-sourced buckets (provides overage details).
    for (const entry of sdkEntries) {
      const type = entry.rateLimitType as string
      byType.set(type, {
        type,
        status: entry.status,
        utilization: entry.utilization ?? null,
        resetsAt: entry.resetsAt ?? null,
        isUsingOverage: entry.isUsingOverage ?? false,
        overageStatus: entry.overageStatus ?? null,
        overageResetsAt: entry.overageResetsAt ?? null,
        overageDisabledReason: entry.overageDisabledReason ?? null,
        surpassedThreshold: entry.surpassedThreshold ?? null,
        observedAt: entry.observedAt,
      })
    }

    // Overlay OAuth-sourced buckets — these always have current % when
    // available. Keep SDK overage fields if we already have them.
    if (oauth) {
      for (const w of oauth.windows) {
        const existing = byType.get(w.type)
        const status: Bucket["status"] =
          (w.utilization ?? 0) >= 1 ? "rejected" :
          (w.utilization ?? 0) >= 0.8 ? "allowed_warning" :
          "allowed"
        byType.set(w.type, {
          type: w.type,
          status: existing?.status === "rejected" ? "rejected" : status,
          utilization: w.utilization ?? existing?.utilization ?? null,
          resetsAt: w.resetsAt ?? existing?.resetsAt ?? null,
          isUsingOverage: existing?.isUsingOverage ?? false,
          overageStatus: existing?.overageStatus ?? null,
          overageResetsAt: existing?.overageResetsAt ?? null,
          overageDisabledReason: existing?.overageDisabledReason ?? null,
          surpassedThreshold: existing?.surpassedThreshold ?? null,
          observedAt: oauth.fetchedAt,
        })
      }
    }

    return c.json({
      profile: targetProfileId ?? null,
      buckets: Array.from(byType.values()),
      extraUsage: oauth?.extraUsage ?? null,
      sources: {
        oauth: oauth ? { fetchedAt: oauth.fetchedAt } : null,
        sdk: { entryCount: sdkEntries.length },
      },
      asOf: Date.now(),
    })
  })

  // All-profiles aggregate — returns OAuth usage for every configured profile
  // in parallel, each with its own per-profile cache. Used by the Meridian
  // settings UI to render a multi-account usage panel.
  //
  // Pylon and other single-profile clients should keep using `/v1/usage/quota`
  // (which returns only the active profile's data).
  //
  // Each profile entry includes the same shape as `/v1/usage/quota`'s top
  // level (windows + extraUsage), or an `error` when the fetch failed for that
  // profile: `"no_token" | "upstream_error" | "not_oauth" | "rate_limited"`.
  //
  // Only `no_token` asks anything of the operator (`claude login`). The other
  // two are transient and want waiting, not action: `rate_limited` is a 429
  // with no last-good snapshot left to serve, and `upstream_error` covers 5xx
  // and a refusal to refresh (which a read-only instance does BY DESIGN, so
  // reporting it as a missing login would be actively wrong).
  //
  // The reason is threaded out of the fetch rather than inferred here — a null
  // snapshot alone can't tell these apart, which is exactly how every failure
  // came to be labelled `no_token`. Older consumers that only switch on
  // `no_token` fall through to their default branch, which is why these are new
  // values rather than reuses.
  app.get("/v1/usage/quota/all", async (c) => {
    const profilesList = getEffectiveProfiles(finalConfig.profiles)
    const activeId = getActiveProfileId() || finalConfig.defaultProfile || profilesList[0]?.id || null

    if (profilesList.length === 0) {
      // Single-account mode — just return the default OAuth account's data.
      const { snapshot: oauth, error } = await fetchOAuthUsageResult({})
      return c.json({
        profiles: [{
          id: "default",
          isActive: true,
          windows: oauth?.windows ?? [],
          extraUsage: oauth?.extraUsage ?? null,
          fetchedAt: oauth?.fetchedAt ?? null,
          error,
        }],
        activeProfile: "default",
        asOf: Date.now(),
      })
    }

    const results = await Promise.all(profilesList.map(async (p) => {
      // Skip API-key profiles — OAuth usage endpoint only applies to Claude Max OAuth.
      const type = p.type ?? "claude-max"
      if (type !== "claude-max") {
        return {
          id: p.id,
          isActive: p.id === activeId,
          type,
          windows: [] as any[],
          extraUsage: null,
          fetchedAt: null,
          error: "not_oauth" as const,
        }
      }
      const { snapshot: oauth, error } = await fetchOAuthUsageResult({
        profileId: p.id,
        claudeConfigDir: p.claudeConfigDir,
      })
      return {
        id: p.id,
        isActive: p.id === activeId,
        type,
        windows: oauth?.windows ?? [],
        extraUsage: oauth?.extraUsage ?? null,
        fetchedAt: oauth?.fetchedAt ?? null,
        error,
      }
    }))

    return c.json({
      profiles: results,
      activeProfile: activeId,
      asOf: Date.now(),
    })
  })

  // Returns the last observed token usage for a session, looked up by the Claude
  // session ID that was returned in a prior /v1/messages response body.
  app.get("/v1/sessions/:claudeSessionId/context-usage", (c) => {
    const claudeSessionId = c.req.param("claudeSessionId")
    const session = getSessionByClaudeId(claudeSessionId)
    if (!session) {
      return c.json({ error: "Session not found" }, 404)
    }
    if (!session.contextUsage) {
      return c.json({ error: "No usage data available for this session" }, 404)
    }
    return c.json({ session_id: claudeSessionId, context_usage: normalizeContextUsage(session.contextUsage) })
  })

  // --- Session Recovery ---
  // Returns recovery information for a session, including CLI commands and file paths
  // to locate the conversation if context was lost due to compaction/restart bugs.
  app.get("/v1/sessions/recover", (c) => {
    const sessions = listStoredSessions()
    if (sessions.length === 0) {
      return c.json({ error: "No sessions found in store" }, 404)
    }
    return c.json({
      sessions: sessions.map(s => ({
        key: s.key,
        claudeSessionId: s.claudeSessionId,
        previousClaudeSessionId: s.previousClaudeSessionId,
        createdAt: new Date(s.createdAt).toISOString(),
        lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        messageCount: s.messageCount,
        recoverCommand: `claude --resume ${s.claudeSessionId}`,
        ...(s.previousClaudeSessionId ? {
          recoverPreviousCommand: `claude --resume ${s.previousClaudeSessionId}`,
        } : {}),
      })),
    })
  })

  app.get("/v1/sessions/:key/recover", (c) => {
    const key = c.req.param("key")
    const recovery = lookupSessionRecovery(key)
    if (!recovery) {
      return c.json({ error: "Session not found", key }, 404)
    }
    return c.json({
      key,
      claudeSessionId: recovery.claudeSessionId,
      previousClaudeSessionId: recovery.previousClaudeSessionId,
      createdAt: new Date(recovery.createdAt).toISOString(),
      lastUsedAt: new Date(recovery.lastUsedAt).toISOString(),
      messageCount: recovery.messageCount,
      recoverCommand: `claude --resume ${recovery.claudeSessionId}`,
      ...(recovery.previousClaudeSessionId ? {
        recoverPreviousCommand: `claude --resume ${recovery.previousClaudeSessionId}`,
        note: "Previous session was replaced — if your current session has lost context, try the previous session ID.",
      } : {}),
    })
  })

  // --- Claude Design MCP Proxy (#543) ---
  // All logic lives in ./design; these routes only wire HTTP.
  const designTokenStore = createFileDesignTokenStore()
  const designLogin = createDesignLogin({ store: designTokenStore })

  app.get("/design-login", (c) => c.json(designLogin.start()))

  app.post("/design-login", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ type: "error", error: { type: "invalid_request", message: "Request body must be JSON with a 'code' field." } }, 400)
    }
    const result = await designLogin.exchange(body)
    if (result.status === 200) plog(`[PROXY] Design token stored via /design-login`)
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    })
  })

  // GET requests to the design MCP are SSE streams for server-initiated
  // events. Anthropic's Design API pushes nothing over them, so proxying the
  // GET upstream leaves the MCP client hanging with zero bytes. Serve a
  // lightweight local keep-alive stream instead.
  app.get("/v1/design/*", (c) => {
    c.status(200)
    c.header("content-type", "text/event-stream")
    c.header("cache-control", "no-cache")
    return stream(c, async (s) => {
      while (!s.aborted) {
        await s.write(": keepalive\n\n")
        await s.sleep(15_000)
      }
    })
  })

  // POST requests proxy the MCP JSON-RPC to Anthropic's Design API with
  // auth resolved by the design module (design token first, then profile
  // credentials).
  app.post("/v1/design/*", async (c) => {
    const profile = resolveProfile(
      finalConfig.profiles,
      finalConfig.defaultProfile,
      c.req.header("x-meridian-profile") || undefined
    )
    const url = new URL(c.req.url)
    const upstreamUrl = `${DESIGN_UPSTREAM_ORIGIN}${url.pathname}${url.search}`

    const designToken = await getDesignAccessToken({ store: designTokenStore })
    const authHeaders = await resolveDesignAuthHeaders({
      designToken,
      profile,
      credentialStore: credentialStoreForProfile(profile),
      ensureFresh: ensureFreshToken,
    })

    const body = await c.req.arrayBuffer()
    const forwardHeaders = buildDesignForwardHeaders((name) => c.req.header(name), authHeaders)

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(upstreamUrl, { method: "POST", headers: forwardHeaders, body })
    } catch (err) {
      return c.json(
        { type: "error", error: { type: "upstream_error", message: err instanceof Error ? err.message : String(err) } },
        502
      )
    }

    if (isDesignAuthFailure(upstreamRes.status)) {
      return c.json(
        { type: "error", error: { type: "auth_error", message: "Unauthorized. Run /design-login to authorize Claude Design (adds user:design:read/write scopes)." } },
        401
      )
    }

    plog(`[PROXY] DESIGN upstream=${upstreamRes.status}`)
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: filterUpstreamResponseHeaders(upstreamRes.headers.entries()),
    })
  })

  // Catch-all: log unhandled requests
  app.all("*", (c) => {
    plog(`[PROXY] UNHANDLED ${c.req.method} ${c.req.url}`)
    return c.json({ error: { type: "not_found", message: `Endpoint not supported: ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404)
  })

  async function initPluginsAsync(): Promise<void> {
    try {
      loadedPlugins = await loadPlugins(pluginDir, pluginConfigPath)
      pluginTransforms = getActiveTransforms(loadedPlugins)
      if (loadedPlugins.length > 0) {
        const active = loadedPlugins.filter(p => p.status === "active").length
        const disabled = loadedPlugins.filter(p => p.status === "disabled").length
        const errored = loadedPlugins.filter(p => p.status === "error").length
        plog(`[PROXY] Plugins loaded: ${active} active, ${disabled} disabled, ${errored} errors`)
      }
    } catch (err) {
      plog(`[PROXY] Plugin loading failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    app,
    config: finalConfig,
    initPlugins: initPluginsAsync,
    beginDrain: () => { draining = true },
    getInFlightCount: () => inFlightRequests,
  }
}

/**
 * Install process-level handlers that log and swallow uncaught exceptions
 * and unhandled promise rejections instead of crashing the host process.
 *
 * Idempotent: safe to call multiple times; only the first invocation attaches
 * listeners. Exported so library consumers can opt in explicitly without
 * having to set `installProcessErrorHandlers: true` in `startProxyServer`.
 */
let processErrorHandlersInstalled = false
export function installProxyProcessErrorHandlers(): void {
  if (processErrorHandlersInstalled) return
  processErrorHandlersInstalled = true
  // Prevent SDK subprocess crashes (and downstream socket EPIPE / ECONNRESET
  // from aborted streaming responses) from killing the proxy. Mirrors the
  // long-standing behavior of `bin/cli.ts`; lifted here so library consumers
  // (e.g. era-code's in-process startProxyServer) get the same safety net.
  process.on("uncaughtException", (err) => {
    console.error(`[PROXY] Uncaught exception (recovered): ${err.message}`)
  })
  process.on("unhandledRejection", (reason) => {
    console.error(`[PROXY] Unhandled rejection (recovered): ${reason instanceof Error ? reason.message : reason}`)
  })
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}): Promise<ProxyInstance> {
  claudeExecutable = await resolveClaudeExecutableAsync()
  const { app, config: finalConfig, initPlugins, beginDrain, getInFlightCount } = createProxyServer(config)
  if (initPlugins) await initPlugins()

  if (finalConfig.installProcessErrorHandlers) {
    installProxyProcessErrorHandlers()
  }

  const server = serve({
    fetch: app.fetch,
    port: finalConfig.port,
    hostname: finalConfig.host,
    overrideGlobalObjects: false,
  }, (info) => {
    if (!finalConfig.silent) {
      console.log(`Meridian running at http://${finalConfig.host}:${info.port}`)
      console.log(`Telemetry dashboard: http://${finalConfig.host}:${info.port}/telemetry`)
      const pins = resolveSdkModelDefaults()
      console.log(`Model pins: fable=${pins.ANTHROPIC_DEFAULT_FABLE_MODEL} opus=${pins.ANTHROPIC_DEFAULT_OPUS_MODEL} sonnet=${pins.ANTHROPIC_DEFAULT_SONNET_MODEL} haiku=${pins.ANTHROPIC_DEFAULT_HAIKU_MODEL}`)
      // Surface the resolved Claude executable + which step picked it.
      // When users hit "wrong claude got picked" failure modes (e.g. a
      // bun-shimmed `claude` on PATH, see #478), this single line is what
      // turns a 30-message debugging thread into a one-look diagnosis.
      const claudeInfo = getResolvedClaudeExecutableInfo()
      if (claudeInfo) {
        console.log(`Claude executable: ${claudeInfo.path} (resolved via ${claudeInfo.source})`)
      }
      console.log(`\nPoint any Anthropic-compatible tool at this endpoint:`)
      console.log(`  ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://${finalConfig.host}:${info.port}`)
    }
  }) as Server

  const idleMs = finalConfig.idleTimeoutSeconds * 1000
  server.keepAliveTimeout = idleMs
  server.headersTimeout = idleMs + 1000
  const connectionTracker = trackServerConnections(server)

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !finalConfig.silent) {
      console.error(`\nError: Port ${finalConfig.port} is already in use.`)
      console.error(`\nIs another instance of the proxy already running?`)
      console.error(`  Check with: lsof -i :${finalConfig.port}`)
      console.error(`  Kill it with: kill $(lsof -ti :${finalConfig.port})`)
      console.error(`\nOr use a different port:`)
      console.error(`  MERIDIAN_PORT=4567 meridian`)
    }
  })

  // Background OAuth token refresh: keeps the refresh chain warm even when
  // the proxy sits idle. Without it, an unused refresh token can be
  // invalidated server-side after sitting unused for an extended period.
  // Idempotent — re-calling start() on a hot-reload is a no-op.
  startBackgroundRefresh()

  // Profile-scoped OAuth token refresh: the default scheduler above only
  // watches the default Claude credential store. Multi-profile credentials
  // live under each profile's CLAUDE_CONFIG_DIR, so poll the discovered
  // profile list and refresh any browser-login profile that is near expiry.
  const PROFILE_TOKEN_REFRESH_MS = 45_000
  void ensureFreshTokenForProfiles(finalConfig)
  const profileTokenRefreshInterval = setInterval(() => {
    void ensureFreshTokenForProfiles(finalConfig)
  }, PROFILE_TOKEN_REFRESH_MS)
  if (profileTokenRefreshInterval.unref) profileTokenRefreshInterval.unref()

  // Background auth keepalive: periodically refresh auth status for all
  // configured profiles so switching is instant (no stale token delay).
  let authKeepaliveInterval: ReturnType<typeof setInterval> | undefined
  const effectiveProfiles = getEffectiveProfiles(finalConfig.profiles)
  if (effectiveProfiles.length > 0) {
    const AUTH_KEEPALIVE_MS = 45_000 // 45s — well within the 60s TTL
    authKeepaliveInterval = setInterval(async () => {
      // Re-read effective profiles on each tick (picks up new profiles from disk)
      const currentProfiles = getEffectiveProfiles(finalConfig.profiles)
      for (const profile of currentProfiles) {
        const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, profile.id)
        if (Object.keys(resolved.env).length > 0) {
          getClaudeAuthStatusAsync(resolved.id, resolved.env).catch(() => {})
        }
      }
      // Also refresh the default (no-override) context
      getClaudeAuthStatusAsync().catch(() => {})
    }, AUTH_KEEPALIVE_MS)
    // Don't block process exit
    if (authKeepaliveInterval.unref) authKeepaliveInterval.unref()
  }

  let closePromise: Promise<void> | undefined
  return {
    server,
    config: finalConfig,
    close() {
      closePromise ??= (async () => {
        clearInterval(profileTokenRefreshInterval)
        if (authKeepaliveInterval) clearInterval(authKeepaliveInterval)
        stopBackgroundRefresh()

        // Stop admitting new requests, then give whatever is already in flight
        // up to SHUTDOWN_GRACE_MS to finish naturally before pulling the plug.
        // This makes existing "call close() on SIGTERM" plugin code (see the
        // Stable API Contract) graceful for free, with no signature change.
        beginDrain?.()
        try {
          await closeServerWithGracePeriod(server, {
            graceMs: SHUTDOWN_GRACE_MS,
            getInFlightCount: () => getInFlightCount?.() ?? 0,
            warn: finalConfig.silent ? undefined : (message) => console.warn(message),
            forceCloseConnections: () => connectionTracker.forceCloseAll(),
          })
        } finally {
          connectionTracker.dispose()
        }
      })()
      return closePromise
    },
  }
}
