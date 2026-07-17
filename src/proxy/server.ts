import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { rateLimitStore } from "./rateLimitStore"
import { guardUpstreamIdle, UpstreamIdleError } from "./streamIdleGuard"
import { linkRequestAbort } from "./requestAbort"
import { fetchOAuthUsage } from "./oauthUsage"
import { resolveSdkWorkingDirectory } from "./cwd"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { envBool } from "../env"
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
import { createEarlyStopTracker, noteAssistantContent, noteUserContent, shouldEarlyStop } from "./passthroughEarlyStop"
import { checkEmptyToolInputs, checkUndeliveredToolUses, type EnvelopeViolation } from "./envelopeIntegrity"
import { resolveAgentAlias } from "./agentMatch"
import { LRUMap } from "../utils/lruMap"

import { telemetryStore, diagnosticLog, createTelemetryRoutes, landingHtml, renderPrometheusMetrics } from "../telemetry"
import type { RequestMetric } from "../telemetry"
import { classifyError, extractSdkTermination, formatSdkTermination, isStaleSessionError, isBusySessionError, isRateLimitError, isExtraUsageRequiredError, isExpiredTokenError } from "./errors"
import { refreshOAuthToken, ensureFreshToken, startBackgroundRefresh, stopBackgroundRefresh, createPlatformCredentialStore, type CredentialStore } from "./tokenRefresh"
import { checkPluginConfigured } from "./setup"
import { mapModelToClaudeModel, resolveClaudeExecutableAsync, resolveSdkModelDefaults, explicitModelPin, CANONICAL_SONNET_MODEL, isClosedControllerError, getClaudeAuthStatusAsync, getAuthCacheInfo, getResolvedClaudeExecutableInfo, hasExtendedContext, stripExtendedContext, recordExtendedContextUnavailable } from "./models"
import type { AnthropicSseEvent } from "./openai"
import { translateOpenAiToAnthropic, translateAnthropicToOpenAi, buildModelList, createSseTranslator } from "./openai"
import { extractAdvisorModel, getLastUserMessage, stripAdvisorTools, stripNonStandardStreamFields, consolidateMultimodalOntoLastUser, MULTIMODAL_TYPES, buildToolUseIndex, describeToolCall, frameReplayTurns } from "./messages"
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
import { getRoutingMode } from "./routing"
import { getSetting } from "./settings"
import { filterBetasForProfile, getBetaPolicyFromEnv } from "./betas"
import { createFileChangeHook, extractFileChangesFromMessages, formatFileChangeSummary, type FileChange } from "./fileChanges"
import { detectTokenAnomalies, formatAnomalyAlerts, type TokenSnapshot } from "./tokenHealth"
import { computeCacheHitRate, formatUsageSummary } from "./tokenUsage"
import { sanitizeTextContent } from "./sanitize"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  normalizeContextUsage,
  type LineageResult,
  type TokenUsageIteration,
  type TokenUsage,
} from "./session/lineage"
// Re-export for backwards compatibility (existing tests import from here)

import { lookupSession, storeSession, clearSessionCache, getMaxSessionsLimit, evictSession, getSessionByClaudeId } from "./session/cache"
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
const UPSTREAM_IDLE_MS = 90_000

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

function normalizeStructuredUserContent(content: any): any {
  if (!Array.isArray(content)) return content
  const normalized: any[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (block.type === "tool_result" && Array.isArray(block.content) && hasMultimodalContent(block.content)) {
      normalized.push(...normalizeStructuredUserContent(block.content))
      continue
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      normalized.push({
        ...block,
        content: normalizeStructuredUserContent(block.content),
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
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((b: any) => (b?.type === "text" && b.text ? b.text : ""))
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

  // In-flight session stores. The streaming drain design ends the client's
  // response at the turn boundary (fast), while deny persistence + the early
  // stop + storeSession continue in the background for ~a second. A client
  // that executes its tools quickly (small file reads) can send the follow-up
  // BEFORE the store lands — its lookup misses and the conversation falls to
  // a fresh replay. Follow-ups briefly await their session's pending store.
  const PENDING_STORE_WAIT_MS = 3000
  const PENDING_STORE_AUTO_RESOLVE_MS = 10000

  // #630: a --resume spawned while the session's previous subprocess is
  // still exiting is refused ("currently running as a background agent",
  // a consequence of #628's CLAUDE_CODE_SESSION_KIND=bg). The stale
  // process exits within ~a second — retry the same resume with linear
  // backoff, then fork the session as a last resort. Delay is overridable
  // so tests don't sleep for real.
  const BUSY_SESSION_MAX_RETRIES = 3
  const BUSY_SESSION_RETRY_DELAY_MS = parseInt(process.env.MERIDIAN_BUSY_RETRY_DELAY_MS ?? "500", 10)
  const pendingSessionStores = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  const registerPendingStore = (key: string): (() => void) => {
    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PENDING_STORE_AUTO_RESOLVE_MS)
      resolveFn = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    const entry = { promise, resolve: resolveFn }
    pendingSessionStores.set(key, entry)
    return () => {
      entry.resolve()
      if (pendingSessionStores.get(key) === entry) pendingSessionStores.delete(key)
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
  app.use("/auth/*", requireAuth)

  app.get("/", (c) => {
    // API clients get JSON, browsers get the landing page
    const accept = c.req.header("accept") || ""
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        status: "ok",
        service: "meridian",
        format: "anthropic",
        endpoints: ["/v1/messages", "/messages", "/v1/chat/completions", "/v1/models", "/telemetry", "/metrics", "/health"]
      })
    }
    return c.html(landingHtml)
  })

  // --- Concurrency Control ---
  // Each request spawns an SDK subprocess (cli.js, ~11MB). Spawning multiple
  // simultaneously can crash the process. Serialize SDK queries with a queue.
  const MAX_CONCURRENT_SESSIONS = parseInt((process.env.MERIDIAN_MAX_CONCURRENT ?? process.env.CLAUDE_PROXY_MAX_CONCURRENT) || "10", 10)
  let activeSessions = 0
  const sessionQueue: Array<{ resolve: () => void }> = []

  async function acquireSession(): Promise<void> {
    if (activeSessions < MAX_CONCURRENT_SESSIONS) {
      activeSessions++
      return
    }
    return new Promise<void>((resolve) => {
      sessionQueue.push({ resolve })
    })
  }

  function releaseSession(): void {
    activeSessions--
    const next = sessionQueue.shift()
    if (next) {
      activeSessions++
      next.resolve()
    }
  }

  const handleMessages = async (
    c: Context,
    requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number }
  ) => {
    const requestStartAt = Date.now()
    const requestAbort = linkRequestAbort(c.req.raw.signal)
    let streamOwnsAbortLink = false

    return withClaudeLogContext({ requestId: requestMeta.requestId, endpoint: requestMeta.endpoint }, async () => {
      // Hoist adapter detection before try so it's available in the catch block for telemetry
      const adapter = detectAdapter(c)
      try {
        const body = await c.req.json()

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
        const profile = resolveProfile(
          finalConfig.profiles,
          finalConfig.defaultProfile,
          c.req.header("x-meridian-profile") || undefined,
          routingMode === "sticky"
            ? { routingMode, stickySessionKey: adapter.getSessionId(c, body) }
            : undefined
        )

        const authStatus = await getClaudeAuthStatusAsync(
          profile.id !== "default" ? profile.id : undefined,
          Object.keys(profile.env).length > 0 ? profile.env : undefined
        )
        const agentMode = c.req.header("x-opencode-agent-mode") ?? null
        // Opaque tag clients can send to distinguish concurrent request flows
        // from the same conversation (e.g., pylon's main chat vs. memory-extract fork vs. subagent).
        // Logged for observability; fork-*/subagent-* values also skip fingerprint cache (see below).
        // Examples: "main", "fork-memory-extract", "subagent-scout".
        const requestSource = c.req.header("x-meridian-source")?.slice(0, 64) || undefined
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
          adapterCwd: adapter.extractWorkingDirectory(body),
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

        let systemContext = ""
        if (body.system) {
          if (typeof body.system === "string") {
            systemContext = body.system
          } else if (Array.isArray(body.system)) {
            systemContext = body.system
              .filter((b: any) => b.type === "text" && b.text)
              .map((b: any) => b.text)
              .join("\n")
          }
        }

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
        // Scope session keys by profile to isolate resume state across accounts.
        // For agents with session IDs (OpenCode): prefix the key.
        // For agents without (Pi): pass profile-scoped workingDirectory to fingerprint lookup.
        const profileSessionId = profile.id !== "default" && agentSessionId
          ? `${profile.id}:${agentSessionId}` : agentSessionId
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
        // subagent, skip fingerprint lookup (no reclassification) and skip the
        // write at end of turn (no cache pollution). The main conversation
        // keeps its cache entry intact across forks.
        //
        // Opt-in via header value: clients that don't set the header are
        // unaffected — behavior is byte-identical to today.
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
        const isIndependentSession =
          requestSource?.startsWith("fork-") || requestSource?.startsWith("subagent-") || isClientDrivenLoop || false
        // If the previous turn's background drain is still persisting this
        // session (streaming early stop), wait briefly so the lookup below
        // sees the stored session instead of falling to a fresh replay.
        if (!isIndependentSession && profileSessionId) {
          const pendingStore = pendingSessionStores.get(profileSessionId)
          if (pendingStore) {
            const waitStart = Date.now()
            await Promise.race([
              pendingStore.promise,
              new Promise((resolve) => setTimeout(resolve, PENDING_STORE_WAIT_MS)),
            ])
            claudeLog("session.pending_store_awaited", { waitedMs: Date.now() - waitStart })
          }
        }
        let lineageResult = isIndependentSession
          ? { type: "diverged" as const }
          : lookupSession(profileSessionId, body.messages || [], profileScopedCwd)
        // NOTE: agent-specific (opencode) — when OpenCode's chat.headers plugin
        // hook doesn't fire (category-dispatched or title-generation requests),
        // the request has no session header and falls through to fingerprint
        // lookup. A new 1-message session can collide with a stored N-message
        // session and be classified as "undo." Downgrade to "diverged" to
        // prevent leaking the old session's conversation history.
        if (lineageResult.type === "undo" && adapterBase === "opencode" && !agentSessionId) {
          lineageResult = { type: "diverged" }
        }
        const isResume = lineageResult.type === "continuation" || lineageResult.type === "compaction"
        const isUndo = lineageResult.type === "undo"
        const cachedSession = lineageResult.type !== "diverged" ? lineageResult.session : undefined
        const resumeSessionId = cachedSession?.claudeSessionId
        // For undo: fork the session at the rollback point
        const undoRollbackUuid = isUndo && lineageResult.type === "undo" ? lineageResult.rollbackUuid : undefined

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
        const requestLogLine = `${requestMeta.requestId} adapter=${adapter.name}${requestSource ? ` source=${requestSource}` : ""}${profile.id !== "default" ? ` profile=${profile.id}${routingMode === "sticky" ? "(sticky)" : ""}` : ""} model=${model} stream=${stream} tools=${toolCount} lineage=${lineageType} session=${resumeSessionId?.slice(0, 8) || "new"}${isUndo && undoRollbackUuid ? ` rollback=${undoRollbackUuid.slice(0, 8)}` : ""}${agentMode ? ` agent=${agentMode}` : ""} active=${activeSessions}/${MAX_CONCURRENT_SESSIONS} msgCount=${msgCount}`
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
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
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
          const knownCount = cachedSession.messageCount || 0
          if (knownCount > 0 && knownCount < allMessages.length) {
            messagesToConvert = allMessages.slice(knownCount)
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

      // Check if any messages contain multimodal content (images, documents, files)
      const hasMultimodal = messagesToConvert?.some((m: any) => hasMultimodalContent(m.content))

      // Build the prompt — either structured (multimodal) or text.
      // Structured prompts are stored as arrays so they can be replayed on retry.
      let structuredMessages: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> | undefined
      let textPrompt: string | undefined

      if (hasMultimodal) {
        // Structured messages preserve image/document/file blocks for Claude to see.
        // On resume, only send user messages (SDK has assistant context already).
        // On first request, include everything.
        structuredMessages = []

        if (isResume) {
          // Resume: only send user messages from the delta (SDK has the rest)
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structuredMessages.push({
                type: "user" as const,
                message: { role: "user" as const, content: normalizeStructuredUserContent(stripCacheControlDeep(m.content)) },
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
                message: { role: "user" as const, content: normalizeStructuredUserContent(stripCacheControlDeep(m.content)) },
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
        textPrompt = isResume
          ? promptTurns.map((t: { text: string }) => t.text).filter(Boolean).join("\n\n") || ""
          : frameReplayTurns(promptTurns)
      }

      // Create a fresh prompt value — can be called multiple times for retry
      function makePrompt(): string | AsyncIterable<any> {
        if (structuredMessages) {
          const msgs = structuredMessages
          return (async function* () { for (const msg of msgs) yield msg })()
        }
        return textPrompt!
      }

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
      // Early stop: the moment every forwarded tool call's deny is persisted
      // (observed as a `user` tool_result in the stream), abort the query so
      // the SDK's digest turn — a fully-billed, discarded model invocation
      // (a whole thinking pass per tool step on always-thinking models) —
      // never generates. Unlike the duplicate-abort above, the session history
      // is coherent at that point (deny recorded), so the session is stored
      // and resumed normally. Kill switch: MERIDIAN_PASSTHROUGH_EARLY_STOP=0.
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
                  toolInput = { ...toolInput, subagent_type: resolveAgentAlias(toolInput.subagent_type) }
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
                //      persisted), so same-tool-new-args calls are genuine
                //      parallelism and are captured. The drop remains only
                //      when the operator disables early stop.
                //   3. Forced single tool (tool_choice:{type:"tool"} / structured
                //      output): keep only the first call.
                // Cases 2 and 3 set sawDuplicateToolUse, the signal the non-
                // streaming loop uses to return the distinct set immediately
                // instead of draining the whole turn budget.
                const signature = toolUseSignature(toolName, toolInput)
                const isExactDuplicate = capturedSignatures.has(signature)
                const isSameToolRepeat = !earlyStopEnabled && !isExactDuplicate && capturedToolNames.has(toolName)
                const exceedsForcedSingle = forceSingleToolUse && capturedToolUses.length >= 1
                if (isExactDuplicate) {
                  droppedToolUseIds.add(input.tool_use_id)
                  claudeLog("passthrough.duplicate_tool_use_dropped", { name: toolName })
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
                // Hold the deny until turn-1 generation completes (streaming
                // only — see holdDenyUntilTurnEnd above). Returning it
                // immediately lets the CLI cancel the in-flight generation and
                // behead any parallel call still streaming after this one.
                // Skip when the query is already aborted (forced-single fired
                // requestAbort above — the subprocess is dying; holding would
                // only delay until the timeout).
                if (stream && earlyStopEnabled && turnGenerating && !requestAbort.controller.signal.aborted) {
                  await holdDenyUntilTurnEnd()
                }
                if (isExactDuplicate) {
                  return {
                    decision: "block" as const,
                    reason:
                      "This exact tool call has already been forwarded to the client — do not repeat it. " +
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
          const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
            ? [...cachedSession.sdkMessageUuids]
            : []
          // Pad to current message count (the last user message has no UUID yet)
          while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

          claudeLog("upstream.start", { mode: "non_stream", model })
          let lastUsage: TokenUsage | undefined
          let lastStopReason: string | undefined

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
              let busySessionRetries = 0
              let busySessionFork = false
              while (true) {
                // Track whether response content was yielded.
                // The SDK emits metadata (session_id etc.) before the API call;
                // only "assistant" messages represent actual response content.
                let didYieldContent = false
                // stderr emitted by THIS attempt's subprocess only — retries
                // must not re-match a previous attempt's refusal text.
                const attemptStderrStart = stderrLines.length
                try {
                  for await (const event of query(buildQueryOptions({
                    prompt: makePrompt(), model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                    resumeSessionId, isUndo, undoRollbackUuid, forkSession: busySessionFork || undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                    effort, thinking, taskBudget, outputFormat, betas, settingSources,
                    codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                    sdkDebug: sdkFeatures.sdkDebug,
                    additionalDirectories: sdkFeatures.additionalDirectories
                      ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                      : undefined,
                    advisorModel,
                  }, requestAbort.controller))) {
                    // Capture Claude Max subscription quota updates emitted by
                    // the SDK as rate_limit_event. We snapshot them in a process-wide
                    // store so /v1/usage/quota can return the latest live state.
                    if ((event as any).type === "rate_limit_event") {
                      rateLimitStore.record((event as any).rate_limit_info)
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

                  // Never retry after response content was yielded — response is committed
                  if (didYieldContent) throw error

                  // Retry: session still registered as a running bg agent (#630).
                  // The previous subprocess for this session (early-stop drain or
                  // slow exit) hasn't finished dying, so the CLI refused --resume
                  // with exit 1. Surfacing that would be a deterministic failure —
                  // the client's identical retry hits the same window. Wait for
                  // the stale process to exit and retry the SAME resume; if the
                  // session stays busy, fork it (full history, fresh id).
                  if (resumeSessionId && isBusySessionError(error, stderrLines.slice(attemptStderrStart).join("\n"))) {
                    if (busySessionRetries < BUSY_SESSION_MAX_RETRIES) {
                      busySessionRetries++
                      claudeLog("session.busy_retry", { mode: "non_stream", attempt: busySessionRetries, resumeSessionId })
                      plog(`[PROXY] ${requestMeta.requestId} session busy (bg agent), retrying resume ${busySessionRetries}/${BUSY_SESSION_MAX_RETRIES}`)
                      await new Promise((resolve) => setTimeout(resolve, BUSY_SESSION_RETRY_DELAY_MS * busySessionRetries))
                      continue
                    }
                    if (!busySessionFork) {
                      busySessionFork = true
                      claudeLog("session.busy_fork", { mode: "non_stream", resumeSessionId })
                      plog(`[PROXY] ${requestMeta.requestId} session still busy after ${BUSY_SESSION_MAX_RETRIES} retries — forking session`)
                      continue
                    }
                  }

                  // Retry: stale undo UUID — evict session and start fresh (one-shot)
                  if (isStaleSessionError(error)) {
                    claudeLog("session.stale_uuid_retry", {
                      mode: "non_stream",
                      rollbackUuid: undoRollbackUuid,
                      resumeSessionId,
                    })
                    plog(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                    evictSession(profileSessionId, profileScopedCwd, allMessages)
                    sdkUuidMap.length = 0
                    for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                    yield* query(buildQueryOptions({
                      prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                      model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                      resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, outputFormat, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }, requestAbort.controller))
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
                    yield* query(buildQueryOptions({
                      prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                      model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                      resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, outputFormat, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                      memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }, requestAbort.controller))
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
              // Early stop: abort before the digest turn generates (see the
              // earlyStop declaration above). The deny tool_results arrive as
              // `user` messages; when every forwarded call's deny is persisted,
              // the SDK-side history is coherent and turn 2 hasn't fired yet.
              if (earlyStopEnabled) {
                if (message.type === "assistant") {
                  noteAssistantContent(earlyStop, (message as any).message?.content)
                } else if (message.type === "user") {
                  noteUserContent(earlyStop, (message as any).message?.content)
                  if (shouldEarlyStop(earlyStop)) {
                    earlyStopFired = true
                    claudeLog("passthrough.early_stop", { mode: "non_stream", captured: capturedToolUses.length })
                    requestAbort.abort("passthrough turn complete")
                    break
                  }
                }
              }
              if (message.type === "assistant") {
                assistantMessages += 1
                // Capture SDK assistant UUID for undo rollback
                if ((message as any).uuid) {
                  sdkUuidMap.push((message as any).uuid)
                }
                if (!firstChunkAt) {
                  firstChunkAt = Date.now()
                  claudeLog("upstream.first_chunk", {
                    mode: "non_stream",
                    model,
                    ttfbMs: firstChunkAt - upstreamStartAt
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
                if (typeof message.message.stop_reason === "string") {
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
            const canRecoverAsToolUse =
              passthrough &&
              capturedToolUses.length > 0 &&
              (sdkTerm.reason === "max_turns" || sdkTerm.reason === "aborted")
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

          const nonStreamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
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
            proxyOverheadMs: upstreamStartAt - requestStartAt - nonStreamQueueWaitMs,
            ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
            upstreamDurationMs: Date.now() - upstreamStartAt,
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
          // persisted, so the SDK-side history holds a dangling tool_use
          // ("Stream closed") that diverges from the client's view — resuming
          // it hands the model memory of a call whose result never arrives
          // (#552). A fresh session rebuilt from client history is coherent by
          // construction. Early-stop aborts (earlyStopFired) are different:
          // they fire only AFTER every forwarded call's deny was observed in
          // the stream (already persisted), so the history is coherent and the
          // session is safe to store and resume.
              if (currentSessionId && !isIndependentSession && !sawDuplicateToolUse) {
                storeSession(profileSessionId, body.messages || [], currentSessionId, profileScopedCwd, sdkUuidMap, lastUsage)
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
        const readable = new ReadableStream({
          async start(controller) {
            const upstreamStartAt = Date.now()
            let firstChunkAt: number | undefined
            let heartbeatCount = 0
            let streamEventsSeen = 0
            let eventsForwarded = 0
            let textEventsForwarded = 0
            let bytesSent = 0
            let streamClosed = false
            // Early-stop drain: after the client stream closes at turn-1's
            // stop_reason:"tool_use", keep consuming SDK messages (nothing is
            // forwarded — safeEnqueue no-ops once streamClosed) until every
            // forwarded call's deny is persisted, then abort the query so the
            // digest turn never generates. Without this the subprocess keeps
            // running in the background and turn 2 is fully billed, invisibly.
            let awaitingEarlyStopDrain = false

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
            const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
              ? [...cachedSession.sdkMessageUuids]
              : []
            while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

            let messageStartEmitted = false
            let lastUsage: TokenUsage | undefined
            let hasStructuredOutput = false
            let structuredOutput: unknown
            // Hoisted out of the inner streaming loop so the outer catch can
            // dedupe captured tool_uses against what was already forwarded
            // when recovering gracefully from max_turns (see catch below).
            const streamedToolUseIds = new Set<string>()
            // Client block indices whose content_block_start was forwarded but
            // whose content_block_stop hasn't been yet. The single-step abort
            // (#575) can SIGTERM the subprocess mid-block, leaving the client
            // with an unterminated tool_use block that renders as an
            // argument-less aborted call (#552 "red reads") — the recovery
            // path closes these explicitly before its final frames.
            const openClientBlocks = new Set<number>()

            // Announce this request's eventual storeSession to follow-ups: the
            // drain design ends the client response before the store lands, so
            // a fast follow-up must await it (see pendingSessionStores).
            const resolvePendingStore = passthrough && earlyStopEnabled && !isIndependentSession && profileSessionId
              ? registerPendingStore(profileSessionId)
              : () => {}

            // Envelope integrity: every path that ends the client stream must
            // first terminate any content block whose start was forwarded but
            // whose stop hasn't been — an unterminated block renders
            // client-side as an argument-less aborted ("red") tool call
            // (#552). The error-recovery path already does this; this helper
            // extends the guarantee to ALL close paths (early stop, turn-2
            // suppression, drain-close). With the deny-hold in place blocks
            // normally complete before any close — this is the backstop.
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

            try {
              let currentSessionId: string | undefined
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
                let busySessionRetries = 0
                let busySessionFork = false

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
                    for await (const event of query(buildQueryOptions({
                      prompt: makePrompt(), model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                      resumeSessionId, isUndo, undoRollbackUuid, forkSession: busySessionFork || undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, outputFormat, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }, requestAbort.controller))) {
                      // Same SDK rate-limit capture as the non-stream path.
                      if ((event as any).type === "rate_limit_event") {
                        rateLimitStore.record((event as any).rate_limit_info)
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

                    // Retry: session still registered as a running bg agent (#630)
                    // — see the non-stream branch above for the full rationale.
                    if (resumeSessionId && isBusySessionError(error, stderrLines.slice(attemptStderrStart).join("\n"))) {
                      if (busySessionRetries < BUSY_SESSION_MAX_RETRIES) {
                        busySessionRetries++
                        claudeLog("session.busy_retry", { mode: "stream", attempt: busySessionRetries, resumeSessionId })
                        plog(`[PROXY] ${requestMeta.requestId} session busy (bg agent), retrying resume ${busySessionRetries}/${BUSY_SESSION_MAX_RETRIES}`)
                        await new Promise((resolve) => setTimeout(resolve, BUSY_SESSION_RETRY_DELAY_MS * busySessionRetries))
                        continue
                      }
                      if (!busySessionFork) {
                        busySessionFork = true
                        claudeLog("session.busy_fork", { mode: "stream", resumeSessionId })
                        plog(`[PROXY] ${requestMeta.requestId} session still busy after ${BUSY_SESSION_MAX_RETRIES} retries — forking session`)
                        continue
                      }
                    }

                    // Retry: stale undo UUID — evict and start fresh (one-shot)
                    if (isStaleSessionError(error)) {
                      claudeLog("session.stale_uuid_retry", {
                        mode: "stream",
                        rollbackUuid: undoRollbackUuid,
                        resumeSessionId,
                      })
                      plog(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                      evictSession(profileSessionId, profileScopedCwd, allMessages)
                      sdkUuidMap.length = 0
                      for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                      yield* query(buildQueryOptions({
                        prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                        model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                        passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                        resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                        effort, thinking, taskBudget, outputFormat, betas, settingSources,
                        codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                        maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                        sdkDebug: sdkFeatures.sdkDebug,
                        additionalDirectories: sdkFeatures.additionalDirectories
                          ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                          : undefined,
                        advisorModel,
                      }, requestAbort.controller))
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
                      yield* query(buildQueryOptions({
                        prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                        model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                        passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, envOverrides, hasDeferredTools,
                        resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                        effort, thinking, taskBudget, outputFormat, betas, settingSources,
                        codeSystemPrompt: sdkFeatures.codeSystemPrompt, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                        memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                        maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                        sdkDebug: sdkFeatures.sdkDebug,
                        additionalDirectories: sdkFeatures.additionalDirectories
                          ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                          : undefined,
                        advisorModel,
                      }, requestAbort.controller))
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
                    break
                  }

                  // Capture session ID and assistant UUID from any SDK message
                  if ((message as any).session_id) {
                    currentSessionId = (message as any).session_id
                  }
                  if (message.type === "assistant" && (message as any).uuid) {
                    sdkUuidMap.push((message as any).uuid)
                  }
                  // Early stop: abort before the digest turn generates (see the
                  // earlyStop declaration above). By deny time the client has
                  // already received all turn-1 blocks and the stop_reason
                  // message_delta, so mirror the turn-2 suppression path's
                  // clean close (message_delta + message_stop) and abort.
                  if (earlyStopEnabled) {
                    if (message.type === "assistant") {
                      noteAssistantContent(earlyStop, (message as any).message?.content)
                    } else if (message.type === "user") {
                      noteUserContent(earlyStop, (message as any).message?.content)
                      // streamedToolUseIds ≥ 1 guarantees the client actually
                      // received a tool_use block before we stop the query.
                      // Normally the client stream is already closed by the
                      // stop_reason:"tool_use" close above (drain mode) — the
                      // emissions below only fire in the unusual case where the
                      // denies arrive first (safeEnqueue no-ops when closed).
                      if (shouldEarlyStop(earlyStop) && streamedToolUseIds.size > 0) {
                        earlyStopFired = true
                        claudeLog("passthrough.early_stop", { mode: "stream", captured: capturedToolUses.length, drained: awaitingEarlyStopDrain })
                        flushOpenClientBlocks("early_stop")
                        safeEnqueue(encoder.encode(
                          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: lastUsage?.output_tokens ?? 0 } })}\n\n`
                        ), "early_stop")
                        safeEnqueue(encoder.encode(
                          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
                        ), "early_stop")
                        requestAbort.abort("passthrough turn complete")
                        awaitingEarlyStopDrain = false
                        if (!streamClosed) {
                          streamClosed = true
                          try { controller.close() } catch {}
                        }
                        break
                      }
                    }
                  }
                  if (message.type === "result") {
                    const resultUsage = (message as { usage?: unknown }).usage as TokenUsage | undefined
                    if (resultUsage) lastUsage = { ...lastUsage, ...resultUsage }
                    if (outputFormat && "structured_output" in message) {
                      hasStructuredOutput = true
                      structuredOutput = message.structured_output
                    }
                  }

                  if (message.type === "stream_event") {
                    streamEventsSeen += 1
                    if (!firstChunkAt) {
                      firstChunkAt = Date.now()
                      claudeLog("upstream.first_chunk", {
                        mode: "stream",
                        model,
                        ttfbMs: firstChunkAt - upstreamStartAt
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
                          flushOpenClientBlocks("turn2_suppression")
                          safeEnqueue(encoder.encode(
                            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: lastUsage?.output_tokens ?? 0 } })}\n\n`
                          ), "passthrough_turn2_stop")
                          safeEnqueue(encoder.encode(
                            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
                          ), "passthrough_turn2_stop")
                          claudeLog("passthrough.turn2_suppressed", { mode: "stream", toolUses: streamedToolUseIds.size })
                          streamClosed = true
                          controller.close()
                          break
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
                              parsed.subagent_type = resolveAgentAlias(parsed.subagent_type)
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

                    // Forward all other events (text, non-MCP tool_use like Task, message events).
                    // Strip SDK-only fields (context_management on message_delta) that stock
                    // Anthropic clients crash on — the real API never returns them (#525).
                    stripNonStandardStreamFields(event)
                    const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                    if (!safeEnqueue(payload, `stream_event:${eventType}`)) {
                      break
                    }
                    eventsForwarded += 1

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
                    // With early stop enabled, don't break — keep DRAINING the SDK
                    // stream (nothing forwards after close) until every deny is
                    // persisted, then abort so the digest turn never generates.
                    // Without early stop (kill switch), break as before: the
                    // subprocess finishes turn 2 in the background (billed).
                    if (
                      passthrough &&
                      eventType === "message_delta" &&
                      (event as any).delta?.stop_reason === "tool_use" &&
                      streamedToolUseIds.size > 0
                    ) {
                      flushOpenClientBlocks("drain_close")
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
                      break
                    }

                    if (eventType === "content_block_delta") {
                      const delta = (event as any).delta
                      if (delta?.type === "text_delta") {
                        textEventsForwarded += 1
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

              // Store session for future resume.
              // Fork/subagent requests don't write to the cache (see lookupSession
              // block for rationale). Duplicate-aborted sessions are never
              // offered for resume — their history holds a dangling dropped
              // call that diverges from the client's view (#552). Early-stop
              // aborts are safe to store: every deny was persisted before the
              // abort. See the non-stream store above.
              if (currentSessionId && !isIndependentSession && !sawDuplicateToolUse) {
                storeSession(profileSessionId, body.messages || [], currentSessionId, profileScopedCwd, sdkUuidMap, lastUsage)
              }
              resolvePendingStore()

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

                  // Emit message_delta with stop_reason: "tool_use"
                  safeEnqueue(encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: { stop_reason: "tool_use", stop_sequence: null },
                      usage: { output_tokens: 0 }
                    })}\n\n`
                  ), "passthrough_message_delta")
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

                // Emit the final message_stop (we skipped all intermediate ones)
                if (messageStartEmitted) {
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

                const streamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
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
                  proxyOverheadMs: upstreamStartAt - requestStartAt - streamQueueWaitMs,
                  ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
                  upstreamDurationMs: Date.now() - upstreamStartAt,
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

                if (textEventsForwarded === 0) {
                  claudeLog("response.empty_stream", {
                    model,
                    streamEventsSeen,
                    eventsForwarded,
                    reason: "no_text_deltas_forwarded"
                  })
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
                return
              }

              resolvePendingStore()
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
                : classifyError(errMsg)
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
              // "aborted" is accepted only for the proxy's own aborts — the
              // single-step duplicate abort (sawDuplicateToolUse) or the
              // early stop (earlyStopFired) — a client-disconnect abort must
              // not be recorded as a recovered success.
              const canRecoverAsToolUse =
                (sdkTerm.reason === "max_turns" ||
                  (sdkTerm.reason === "aborted" && (sawDuplicateToolUse || earlyStopFired))) &&
                passthrough &&
                capturedToolUses.length > 0 &&
                messageStartEmitted

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
                const recoverQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
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
                  proxyOverheadMs: upstreamStartAt - requestStartAt - recoverQueueWaitMs,
                  ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
                  upstreamDurationMs: Date.now() - upstreamStartAt,
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
              const streamErrQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
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
                proxyOverheadMs: upstreamStartAt - requestStartAt - streamErrQueueWaitMs,
                ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
                upstreamDurationMs: Date.now() - upstreamStartAt,
                totalDurationMs: streamErrTotalMs,
                contentBlocks: eventsForwarded,
                textEvents: textEventsForwarded,
                error: streamErr.type,
              })

              // If we already emitted message_start, close the message cleanly so
              // clients that access usage.input_tokens don't crash on the incomplete response.
              if (messageStartEmitted) {
                safeEnqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 0 }
                  })}\n\n`
                ), "error_message_delta")
                safeEnqueue(encoder.encode(
                  `event: message_stop\ndata: {"type":"message_stop"}\n\n`
                ), "error_message_stop")
              }

              safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: streamErr.type, message: streamErr.message }
              })}\n\n`), "error_event")
              if (!streamClosed) {
                try { controller.close() } catch {}
                streamClosed = true
              }
            } finally {
              requestAbort.detach()
            }
          },
          cancel(reason) {
            requestAbort.abort(reason)
            requestAbort.detach()
          },
        })

        const streamSessionId = resumeSessionId || `session_${Date.now()}`
        streamOwnsAbortLink = true
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Claude-Session-ID": streamSessionId
          }
        })
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: errMsg
        })

        // Detect specific error types and return helpful messages
        const classified = classifyError(errMsg)

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

        const errorQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
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
          proxyOverheadMs: Date.now() - requestStartAt - errorQueueWaitMs,
          ttfbMs: null,
          upstreamDurationMs: Date.now() - requestStartAt,
          totalDurationMs: Date.now() - requestStartAt,
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
    const requestId = c.req.header("x-request-id") || randomUUID()
    const queueEnteredAt = Date.now()
    claudeLog("request.enter", { requestId, endpoint })
    await acquireSession()
    const queueStartedAt = Date.now()
    try {
      return await handleMessages(c, { requestId, endpoint, queueEnteredAt, queueStartedAt })
    } finally {
      releaseSession()
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

      return c.json({
        status: "healthy",
        version: serverVersion,
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
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
    return c.json({
      profiles: enriched,
      activeProfile: getActiveProfileId() || finalConfig.defaultProfile || profiles[0]?.id || "default",
      // Additive (#383): current routing mode so UIs can surface it.
      routing: getRoutingMode(process.env.MERIDIAN_ROUTING ?? getSetting("routing")),
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
    setActiveProfile(body.profile!)
    // Evict all cached SDK sessions — they were started under the old profile's
    // credentials and cannot be reused with different auth. Also drop the
    // rate-limit snapshot so /v1/usage/quota doesn't return the previous
    // profile's quotas under the new profile's identity.
    clearSessionCache()
    rateLimitStore.clear()
    plog(`[PROXY] Active profile switched to: ${body.profile} (session + rate-limit caches cleared)`)
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
      // Drop the rate-limit snapshot — old quotas were observed under the
      // previous credential and may belong to a different account if the
      // refresh swapped profiles. The next SDK call repopulates.
      rateLimitStore.clear()
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
    const rawBody = await c.req.json() as Record<string, unknown>
    const anthropicBody = translateOpenAiToAnthropic(rawBody)

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
    // Tag the inner hop as the generic OpenAI endpoint. Without this the
    // header-less internal request falls through detectAdapter to the default
    // `opencode` adapter, whose claude_code preset defaults ON — hijacking the
    // client's own system prompt with the Claude Code persona (#526). The
    // `openai` adapter mirrors opencode but defaults the preset OFF.
    const internalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-meridian-agent": "openai",
    }
    const xApiKey = c.req.header("x-api-key")
    if (xApiKey) internalHeaders["x-api-key"] = xApiKey
    const authz = c.req.header("authorization")
    if (authz) internalHeaders["authorization"] = authz
    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(anthropicBody),
    })
    const internalRes = await app.fetch(internalReq)

    if (!internalRes.ok) {
      const errBody = await internalRes.text()
      return c.json(
        { type: "error", error: { type: "upstream_error", message: errBody } },
        internalRes.status as 400 | 401 | 429 | 500
      )
    }

    const completionId = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = (typeof rawBody.model === "string" && rawBody.model) ? rawBody.model : CANONICAL_SONNET_MODEL

    // Resolve SDK features for this request (thinking passthrough setting).
    // The OpenAI endpoint is unambiguously the `openai` adapter — matching the
    // x-meridian-agent tag set on the internal hop above — so resolve directly
    // rather than re-detecting from the (generic) client User-Agent.
    const { getFeaturesForAdapter } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    const sdkFeatures = getFeaturesForAdapter("openai")

    if (!anthropicBody.stream) {
      const anthropicRes = await internalRes.json() as Record<string, unknown>
      return c.json(translateAnthropicToOpenAi(anthropicRes, completionId, model, created, {
        thinkingPassthrough: sdkFeatures.thinkingPassthrough
      }))
    }

    // Streaming: translate Anthropic SSE events to OpenAI SSE chunks
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        const reader = internalRes.body?.getReader()
        if (!reader) { controller.close(); return }

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
  // Context window reflects the subscription tier (Max = 1M, others = 200k).
  app.get("/v1/models", async (c) => {
    const authStatus = await getClaudeAuthStatusAsync()
    const isMax = authStatus?.subscriptionType === "max"
    return c.json({ object: "list", data: buildModelList(isMax) })
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
    //
    // Filter out the internal "default" bucket — it's a Meridian-side
    // fallback for SDK events missing `rateLimitType`, not a real Anthropic
    // bucket that consumers can render.
    const sdkEntries = rateLimitStore.getAll().filter(entry => entry.rateLimitType !== undefined)

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
  // level (windows + extraUsage), or `error: "no_token" | "upstream_error"`
  // when the fetch failed for that profile.
  app.get("/v1/usage/quota/all", async (c) => {
    const profilesList = getEffectiveProfiles(finalConfig.profiles)
    const activeId = getActiveProfileId() || finalConfig.defaultProfile || profilesList[0]?.id || null

    if (profilesList.length === 0) {
      // Single-account mode — just return the default OAuth account's data.
      const oauth = await fetchOAuthUsage({})
      return c.json({
        profiles: [{
          id: "default",
          isActive: true,
          windows: oauth?.windows ?? [],
          extraUsage: oauth?.extraUsage ?? null,
          fetchedAt: oauth?.fetchedAt ?? null,
          error: oauth ? null : "no_token",
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
      const oauth = await fetchOAuthUsage({
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
        error: oauth ? null : "no_token",
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

  return { app, config: finalConfig, initPlugins: initPluginsAsync }
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
  const { app, config: finalConfig, initPlugins } = createProxyServer(config)
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

  return {
    server,
    config: finalConfig,
    async close() {
      clearInterval(profileTokenRefreshInterval)
      if (authKeepaliveInterval) clearInterval(authKeepaliveInterval)
      stopBackgroundRefresh()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
