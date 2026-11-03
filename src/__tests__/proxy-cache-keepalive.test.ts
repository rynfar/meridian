/**
 * Prompt-cache keepalive through the HTTP layer with a mocked SDK.
 *
 * With the operator switch on, a keyed passthrough session whose latest real
 * turn wrote the one-hour cache tier is kept warm: about 55 minutes into an
 * idle period the proxy resumes the published SDK session with a short
 * prompt, without persisting a transcript or changing the mapping the next
 * turn resumes, at most three times. Five-minute sessions, API-key accounts,
 * accounts on Extra Usage and busy SDK budgets are left alone; side calls do
 * not move the schedule; shutdown waits for a beat in flight; telemetry
 * totals beats apart from requests.
 */
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { makeRequest, resolveMockSdkSessionId, streamEvent } from "./helpers"
import { setSessionStoreDir, lookupSharedSession } from "../proxy/sessionStore"
import { rateLimitStore } from "../proxy/rateLimitStore"
import { telemetryStore } from "../telemetry"

const MIN = 60_000
const INTERVAL = 55 * MIN

let isolatedSessionDir = ""
beforeEach(() => {
  isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-keepalive-test-"))
  setSessionStoreDir(isolatedSessionDir)
})
afterEach(async () => {
  setSystemTime()
  delete process.env.MERIDIAN_CACHE_KEEPALIVE
  rateLimitStore.clear()
  // Request completion releases the cross-process lease asynchronously.
  await Bun.sleep(25)
  rmSync(isolatedSessionDir, { recursive: true, force: true })
})

let queryCalls: Array<{ prompt: unknown; options: Record<string, any> }> = []
let mcpServersCreated = 0
/** Cache tier the next real turns write. */
let turnTier: "1h" | "5m" = "1h"
/** When set, a beat waits for its abort and then this long before ending. */
let holdBeatsAfterAbortMs: number | undefined
/** When set, real turns end the way a capped tool-boundary turn does: the SDK throws max_turns. */
let endTurnsAtMaxTurns = false

const beatCalls = () => queryCalls.filter(call => call.options.persistSession === false)

function tierUsage(keepalive: boolean) {
  if (keepalive) {
    return {
      input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    }
  }
  return {
    input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000,
    cache_creation: turnTier === "1h"
      ? { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 }
      : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 20_000 },
  }
}

installSdkMock(() => ({
  query: (opts: any) => {
    queryCalls.push({ prompt: opts.prompt, options: opts.options ?? {} })
    const sessionId = resolveMockSdkSessionId(opts.options, `sdk-${queryCalls.length}`)
    const keepalive = opts.options?.persistSession === false
    const abort: AbortController | undefined = opts.options?.abortController
    const n = queryCalls.length
    return (async function* () {
      if (keepalive && holdBeatsAfterAbortMs !== undefined) {
        const delay = holdBeatsAfterAbortMs
        await new Promise<void>((resolve) => {
          if (abort?.signal.aborted) return resolve()
          abort?.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        await Bun.sleep(delay)
        throw new Error("aborted")
      }
      const usage = tierUsage(keepalive)
      yield {
        ...streamEvent({
          type: "message_start",
          message: {
            id: `msg-${n}`, type: "message", role: "assistant", content: [],
            model: "claude-sonnet-4-5", stop_reason: null, usage,
          },
        }),
        session_id: sessionId,
      }
      yield {
        type: "assistant",
        uuid: `uuid-${n}`,
        message: {
          id: `msg-${n}`, type: "message", role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-sonnet-4-5", stop_reason: "end_turn", usage,
        },
        session_id: sessionId,
      }
      if (!keepalive && endTurnsAtMaxTurns) {
        throw new Error("Claude Code returned an error result: Reached maximum number of turns (1)")
      }
      yield { type: "result", subtype: "success", result: "done", session_id: sessionId, usage }
    })()
  },
  createSdkMcpServer: () => {
    mcpServersCreated++
    return { type: "sdk", name: "oc", instance: { tool: () => {}, registerTool: () => ({}) } }
  },
  tool: () => ({}),
}), "proxy-cache-keepalive.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const tool = {
  name: "read",
  description: "read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

const FIRST = [{ role: "user", content: "Hello" }]
const SECOND = [...FIRST, { role: "assistant", content: "done" }, { role: "user", content: "And again" }]

async function turn(
  proxy: ReturnType<typeof createProxyServer>,
  headers: Record<string, string>,
  messages: unknown[] = FIRST,
  extra: Record<string, unknown> = {},
) {
  const response = await proxy.app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(makeRequest({ stream: false, tools: [tool], messages, ...extra })),
  }))
  expect(response.status).toBe(200)
  await response.json()
}

async function tickAt(proxy: ReturnType<typeof createProxyServer>, at: number): Promise<void> {
  setSystemTime(new Date(at))
  proxy.tickCacheKeepalive?.()
  await Bun.sleep(25)
}

async function idleTicks(proxy: ReturnType<typeof createProxyServer>, from: number, until: number, step = MIN) {
  for (let t = from; t <= until; t += step) await tickAt(proxy, t)
}

describe("cache keepalive", () => {
  beforeEach(() => {
    clearSessionCache()
    queryCalls = []
    mcpServersCreated = 0
    turnTier = "1h"
    holdBeatsAfterAbortMs = undefined
    endTurnsAtMaxTurns = false
    telemetryStore.clear()
  })

  it("is off unless the operator switches it on", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_off" })
    await idleTicks(proxy, start + 50 * MIN, start + 2 * 60 * MIN, 5 * MIN)
    expect(beatCalls()).toHaveLength(0)
  })

  it("ignores the contributor's former opt-in header", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_header", "x-meridian-cache-keepalive": "3600" })
    await idleTicks(proxy, start + 50 * MIN, start + 2 * 60 * MIN, 5 * MIN)
    expect(beatCalls()).toHaveLength(0)
  })

  it("resumes the published one-hour session 55 minutes into an idle period, read-only", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_keep" })
    const published = lookupSharedSession("ses_keep")
    expect(published).toBeDefined()
    const publishedJson = JSON.stringify(published)
    const serversAfterTurn = mcpServersCreated

    await tickAt(proxy, start + INTERVAL - MIN)
    expect(beatCalls()).toHaveLength(0)

    await tickAt(proxy, start + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)
    const beat = beatCalls()[0]!
    expect(beat.prompt).toBe("Reply with OK.")
    expect(beat.options.resume).toBe(published!.claudeSessionId)
    expect(beat.options.forkSession).toBe(true)
    expect(beat.options.persistSession).toBe(false)
    expect(beat.options.maxTurns).toBe(1)
    expect(beat.options.env.DISABLE_AUTO_COMPACT).toBe("1")
    // Same request shape as the turn, with a private MCP server instance.
    expect(beat.options.systemPrompt).toEqual(queryCalls[0]!.options.systemPrompt)
    expect(beat.options.model).toBe(queryCalls[0]!.options.model)
    expect(Object.keys(beat.options.mcpServers)).toEqual(Object.keys(queryCalls[0]!.options.mcpServers))
    expect(mcpServersCreated).toBe(serversAfterTurn + 1)
    expect(beat.options.hooks).toBeUndefined()

    // The mapping, its transcript and lineage are exactly what the turn published.
    expect(JSON.stringify(lookupSharedSession("ses_keep"))).toBe(publishedJson)
  })

  it("keeps a session warm after a turn that ended at its tool-boundary turn cap", async () => {
    // The single-turn cap makes max_turns the ordinary end of a passthrough
    // turn; upstream already wrote the one-hour tier when it got the request.
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    endTurnsAtMaxTurns = true
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_capped" })
    expect(lookupSharedSession("ses_capped")).toBeDefined()
    await tickAt(proxy, start + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)
  })

  it("keeps only the main conversation warm, not OpenCode's title one-shot", async () => {
    // Seen live (#1193 A/B): the title request gets its own key and carries
    // the full prefix, but OpenCode never resumes it.
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_titled", "x-opencode-agent-mode": "primary", "x-opencode-agent-name": "build" })
    await turn(proxy, { "x-opencode-session": "ses_titled", "x-opencode-agent-mode": "subagent", "x-opencode-agent-name": "title" })
    await tickAt(proxy, start + INTERVAL + 1_000)
    await tickAt(proxy, start + INTERVAL + 31_000)
    await tickAt(proxy, start + INTERVAL + 61_000)
    expect(beatCalls()).toHaveLength(1)
    expect(beatCalls()[0]!.options.resume).toBe(lookupSharedSession("ses_titled")!.claudeSessionId)
  })

  it("leaves the primary schedule alone when an older plugin sends compaction as a subagent source", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_oldv2", "x-opencode-agent-mode": "primary" })
    await turn(proxy, { "x-opencode-session": "ses_oldv2", "x-opencode-agent-mode": "primary", "x-meridian-source": "subagent-compaction" })
    await tickAt(proxy, start + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)
  })

  it("beats at most three times per idle period, then lets the cache expire", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_cap" })
    await idleTicks(proxy, start + MIN, start + 5 * 60 * MIN)
    expect(beatCalls()).toHaveLength(3)
  })

  it("never keeps a five-minute-tier session warm", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    turnTier = "5m"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_short" })
    await idleTicks(proxy, start + 50 * MIN, start + 2 * 60 * MIN, 5 * MIN)
    expect(beatCalls()).toHaveLength(0)
  })

  it("never beats an API-key profile", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({
      port: 0, host: "127.0.0.1",
      profiles: [{ id: "key", type: "api", apiKey: "fixture-no-live-credential" }],
      defaultProfile: "key",
    })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_api" })
    await idleTicks(proxy, start + 50 * MIN, start + 2 * 60 * MIN, 5 * MIN)
    expect(beatCalls()).toHaveLength(0)
  })

  it("skips while the account is on Extra Usage or rate-limited, and beats once it is not", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_overage" })
    rateLimitStore.record("default", {
      status: "allowed", rateLimitType: "five_hour", isUsingOverage: true, resetsAt: start + 10 * 60 * MIN,
    })
    await tickAt(proxy, start + INTERVAL)
    expect(beatCalls()).toHaveLength(0)
    rateLimitStore.clear()
    rateLimitStore.record("default", { status: "rejected", rateLimitType: "five_hour", resetsAt: start + 10 * 60 * MIN })
    await tickAt(proxy, start + INTERVAL + MIN)
    expect(beatCalls()).toHaveLength(0)
    rateLimitStore.clear()
    await tickAt(proxy, start + INTERVAL + 2 * MIN)
    expect(beatCalls()).toHaveLength(1)
  })

  it("beats only on the account the mapping was published under, never another", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({
      port: 0, host: "127.0.0.1",
      profiles: [
        { id: "work", type: "claude-max", claudeConfigDir: join(isolatedSessionDir, "work-claude") },
        { id: "spare", type: "claude-max", claudeConfigDir: join(isolatedSessionDir, "spare-claude") },
      ],
      defaultProfile: "work",
    })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_account" })
    const turnEnv = queryCalls[0]!.options.env
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", resetsAt: start + 10 * 60 * MIN })
    await idleTicks(proxy, start + INTERVAL, start + INTERVAL + 3 * MIN)
    // The healthy spare account is not used instead.
    expect(beatCalls()).toHaveLength(0)
    rateLimitStore.clear()
    await tickAt(proxy, start + INTERVAL + 4 * MIN)
    expect(beatCalls()).toHaveLength(1)
    expect(beatCalls()[0]!.options.env.CLAUDE_CONFIG_DIR).toBe(turnEnv.CLAUDE_CONFIG_DIR)
    expect(beatCalls()[0]!.options.env.CLAUDE_CONFIG_DIR).toBe(join(isolatedSessionDir, "work-claude"))
  })

  it("restarts the idle period on a real turn, but not on a side call", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    // Claude Code sends side calls (classifier, titles) on the
    // conversation's own session key; the adapter declares them auxiliary.
    const cli = { "user-agent": "claude-cli/2.1.286" }
    const cc = { metadata: { user_id: JSON.stringify({ session_id: "cc-keepalive-session" }) } }
    await turn(proxy, cli, FIRST, cc)
    setSystemTime(new Date(start + 20 * MIN))
    await turn(proxy, { ...cli, "x-claude-code-request-class": "auxiliary" }, [
      { role: "user", content: "<transcript>User: deploy</transcript>" },
      { role: "user", content: "Grade the action." },
    ], { ...cc, tools: [] })
    await tickAt(proxy, start + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)

    // The user comes back at 70 minutes.
    const back = start + 70 * MIN
    setSystemTime(new Date(back))
    await turn(proxy, cli, SECOND, cc)
    await idleTicks(proxy, back + MIN, back + INTERVAL - MIN)
    expect(beatCalls()).toHaveLength(1)
    await tickAt(proxy, back + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(2)
  })

  it("never takes the last free SDK permit", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1", maxConcurrent: 1 })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_budget" })
    await idleTicks(proxy, start + INTERVAL, start + INTERVAL + 4 * MIN)
    expect(beatCalls()).toHaveLength(0)

    const roomy = createProxyServer({ port: 0, host: "127.0.0.1", maxConcurrent: 2 })
    const later = Date.now()
    await turn(roomy, { "x-opencode-session": "ses_budget_roomy" })
    await tickAt(roomy, later + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)
  })

  it("counts a beat in flight for shutdown and joins it before the backend closes", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    holdBeatsAfterAbortMs = 150
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_drain" })
    await tickAt(proxy, start + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)
    expect(proxy.getInFlightCount?.()).toBe(1)

    let closed = false
    const closing = proxy.closeBackend!().then(() => { closed = true })
    await Bun.sleep(50)
    // Drain aborted the beat, but its query has not been joined yet.
    expect(beatCalls()[0]!.options.abortController.signal.aborted).toBe(true)
    expect(proxy.getInFlightCount?.()).toBe(1)
    expect(closed).toBe(false)
    await closing
    expect(proxy.getInFlightCount?.()).toBe(0)
  })

  it("totals beats apart from request, error, cache and cost figures", async () => {
    process.env.MERIDIAN_CACHE_KEEPALIVE = "1"
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_telemetry" })
    await tickAt(proxy, start + INTERVAL + 1_000)
    expect(beatCalls()).toHaveLength(1)

    const rows = telemetryStore.getRecent({ limit: 10 })
    expect(rows.map(row => row.requestSource ?? null)).toContain("cache-keepalive")
    const summary = telemetryStore.summarize(24 * 60 * MIN)
    expect(summary.totalRequests).toBe(1)
    expect(summary.errorCount).toBe(0)
    expect(summary.tokenUsage.totalCacheReadTokens).toBe(0)
    expect(summary.tokenUsage.totalCacheCreationTokens).toBe(20_000)
    expect(summary.cacheKeepalive.beats).toBe(1)
    expect(summary.cacheKeepalive.reached).toBe(1)
    expect(summary.cacheKeepalive.cacheReadTokens).toBe(20_000)
  })
})
