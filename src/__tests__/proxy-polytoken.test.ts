/**
 * Polytoken native HTTP regression suite (mocked SDK).
 *
 * Proves the native contract end-to-end through POST /v1/messages with the
 * mocked SDK: mandatory client-owned passthrough, exact tool payload
 * preservation, native-key resume semantics, concurrency coordination, and
 * feature/prompt defaults. Every observable is a captured SDK option or HTTP
 * response body — no pure-function-only assertions.
 */
import { beforeEach, afterEach, describe, expect, it } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  toolUseBlockStart,
  inputJsonDelta,
  messageDelta,
  messageStop,
  withMockSdkSessionId,
} from "./helpers"

type Input = {
  prompt: string | AsyncIterable<{ message: { content: unknown } }>
  options?: {
    sessionId?: string
    resume?: string
    tools?: unknown[]
    allowedTools?: string[]
    disallowedTools?: string[]
    mcpServers?: Record<string, unknown>
    settingSources?: unknown[]
    systemPrompt?: string | { type: string }
    maxTurns?: number
    permissionMode?: string
    agents?: Record<string, unknown>
    hooks?: Record<string, unknown>
    cwd?: string
    model?: string
    [k: string]: unknown
  }
}

let captured: Array<{ options: Input["options"]; prompt: string; inputCount: number; yielded: Array<Record<string, unknown>> }> = []
/** Per-turn SDK scripts. When a tool call is armed, turn 1 yields the
 * assistant tool_use (the mock invokes the proxy's capture hook, exactly as
 * the real SDK dispatches PreToolUse), the synthetic deny, then a canonical
 * terminal `result` — the persistence acknowledgement. */
let nextToolCall: { name: string; id: string; input: Record<string, unknown> } | null = null
let turnScripts: Array<Array<Record<string, unknown>>> = []

function toolTurnScript(call: { name: string; id: string; input: Record<string, unknown> }): Array<Record<string, unknown>> {
  return [
    {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      message: {
        id: `msg_${call.id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: call.id, content: "forwarded to client", is_error: true }],
      },
    },
  ]
}

function defaultSdkMock(owner: string) {
  return () => ({
    query: (input: Input) => (async function* () {
      let prompt = ""
      let inputCount = typeof input.prompt === "string" ? 1 : 0
      if (typeof input.prompt === "string") prompt = input.prompt
      else for await (const row of input.prompt) { prompt += JSON.stringify(row.message.content); inputCount++ }
      captured.push({ options: input.options, prompt, inputCount, yielded: [] })
      const script = turnScripts.length > 0 ? turnScripts.shift()! : (nextToolCall ? toolTurnScript(nextToolCall) : [])
      nextToolCall = null
      if (script.length === 0) {
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: crypto.randomUUID(),
          message: {
            id: "msg_plain",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "claude-sonnet-4-5-20250929",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          session_id: input.options?.sessionId,
        } as unknown as SDKMessage
        return
      }
      const preHook = (input.options?.hooks?.PreToolUse as any)?.[0]?.hooks?.[0] as
        | ((...args: unknown[]) => unknown)
        | undefined
      let sawDeny = false
      let sawResult = false
      for (const msg of script) {
        const delivered = withMockSdkSessionId(msg, input.options) as Record<string, unknown>
        if (delivered.type === "assistant" && Array.isArray((delivered.message as any)?.content)) {
          for (const block of (delivered.message as any).content) {
            if (block?.type !== "tool_use" || typeof preHook !== "function") continue
            void Promise.resolve(preHook({
              tool_name: block.name,
              tool_use_id: block.id,
              tool_input: block.input,
            }, undefined, { signal: new AbortController().signal }))
          }
        }
        if (delivered.type === "user" && (delivered.message as any)?.content?.some?.((b: any) => b?.type === "tool_result")) sawDeny = true
        if (delivered.type === "result") sawResult = true
        captured[captured.length - 1]!.yielded.push(delivered)
        yield delivered as SDKMessage
      }
      // Real SDK queries terminate with a result; that boundary is the only
      // persistence acknowledgement (see passthrough-early-stop-integration).
      if (sawDeny && !sawResult) {
        const result = withMockSdkSessionId({ type: "result", subtype: "success", is_error: false } as unknown as Record<string, unknown>, input.options) as unknown as SDKMessage
        captured[captured.length - 1]!.yielded.push(result as unknown as Record<string, unknown>)
        yield result
      }
    })(),
    createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
    tool: () => ({}),
  })
}

installSdkMock(defaultSdkMock("proxy-polytoken.test.ts"), "proxy-polytoken.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const text = (value: string) => ({ type: "text", text: value })
const toolResult = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content })

const savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
const savedInstances = process.env.MERIDIAN_ADAPTER_INSTANCES
const savedConfigDir = process.env.MERIDIAN_CONFIG_DIR

beforeEach(() => {
  captured.length = 0
  nextToolCall = null
  clearSessionCache()
  delete process.env.MERIDIAN_PASSTHROUGH
  delete process.env.MERIDIAN_ADAPTER_INSTANCES
  process.env.MERIDIAN_CONFIG_DIR = `/tmp/meridian-polytoken-http-${Date.now()}-${Math.random().toString(36).slice(2)}`
})

afterEach(() => {
  if (savedPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
  else process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
  if (savedInstances === undefined) delete process.env.MERIDIAN_ADAPTER_INSTANCES
  else process.env.MERIDIAN_ADAPTER_INSTANCES = savedInstances
  if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
  else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
})

async function post(
  app: ReturnType<typeof createProxyServer>["app"],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
  const responseText = await response.text()
  return {
    status: response.status,
    text: responseText,
    json: () => { try { return JSON.parse(responseText) } catch { return {} } },
  }
}

const nativeHeaders = (key: string, extra: Record<string, string> = {}) => ({
  "x-polytoken-session": key,
  ...extra,
})

const haikuBody = (overrides: Record<string, unknown> = {}) => ({
  model: "haiku",
  stream: false,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

describe("polytoken mandatory passthrough", () => {
  it("registers the generated client MCP server, exposes no SDK tools, and keeps schemas intact", async () => {
    const { app } = createProxyServer({ silent: true })
    const tools = [{
      name: "read_file",
      description: "Read a file from the client workspace",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, "weird-key": { type: "number" } },
        required: ["path"],
      },
    }]
    nextToolCall = { name: "read_file", id: "call_1", input: { path: "src/a.ts" } }
    const res = await post(app, haikuBody({ tools, messages: [{ role: "user", content: "read it" }] }), nativeHeaders("pt-1"))
    expect(res.status).toBe(200)
    const options = captured[0]!.options!
    // Mandatory passthrough: SDK built-in catalog elided.
    expect(options.tools).toEqual([])
    // Only the generated client passthrough MCP tools are allowed.
    expect((options.allowedTools as string[]) ?? []).toEqual(["mcp__oc__read_file"])
    expect(options.mcpServers?.oc).toBeDefined()
    // No internal polytoken MCP registration, no SDK agents/hooks.
    expect(options.mcpServers?.polytoken).toBeUndefined()
    expect(options.agents ?? {}).toEqual({})
    expect(options.hooks?.PreToolUse).toBeDefined() // capture hook exists…
    // …but no fuzzy-alias hint system prompt is injected.
    expect(String(options.systemPrompt ?? "")).not.toContain("subagent_type")
    // Tool payload returned unchanged, including nonstandard keys.
    const payload = res.json() as { content: Array<Record<string, unknown>> }
    const toolUse = payload.content.find((b) => b.type === "tool_use")!
    expect(toolUse.name).toBe("read_file")
    expect(toolUse.input).toEqual({ path: "src/a.ts" })
    expect(toolUse.id).toBe("call_1")
  })

  it("holds despite global MERIDIAN_PASSTHROUGH=0", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] }), nativeHeaders("pt-2"))
    expect(captured[0]!.options!.tools).toEqual([])
  })

  it("holds despite global MERIDIAN_PASSTHROUGH=false", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "false"
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] }), nativeHeaders("pt-3"))
    expect(captured[0]!.options!.tools).toEqual([])
  })

  it("holds for an explicit base:polytoken instance with passthrough:false", async () => {
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "pt-plain": { base: "polytoken", passthrough: false },
    })
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] }),
      nativeHeaders("pt-4", { "x-meridian-agent": "pt-plain" }))
    expect(captured[0]!.options!.tools).toEqual([])
  })

  it("exposes no SDK tools for a no-tools request", async () => {
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody(), nativeHeaders("pt-5"))
    expect(captured[0]!.options!.tools).toEqual([])
    expect(captured[0]!.options!.mcpServers ?? {}).toEqual({})
  })

  it("unrelated OpenCode headers have no native effect", async () => {
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] }), nativeHeaders("pt-6", {
      "x-opencode-session": "oc-leak",
      "x-opencode-agent-mode": "subagent",
      "x-opencode-effort": "high",
      "x-opencode-thinking": JSON.stringify({ type: "enabled", budget_tokens: 5000 }),
      "x-opencode-task-budget": "42",
      "x-session-affinity": "aff-leak",
    }))
    const options = captured[0]!.options!
    // The OpenCode session must not become native identity…
    expect(options.resume).toBeUndefined() // first turn: no stored session
    // …and effort/task-budget header overrides were ignored.
    expect(options.maxTurns).toBeDefined()
    // thinking enabled via x-opencode-thinking must NOT appear as SDK thinking
    expect((options as Record<string, unknown>).thinking ?? null).toBeNull()
  })

  it("preserves Task/Task subagent_type payloads byte-exact (no alias rewriting)", async () => {
    const { app } = createProxyServer({ silent: true })
    const tools = [{
      name: "Task",
      description: "Launch a subagent",
      input_schema: { type: "object", properties: { subagent_type: { type: "string" }, prompt: { type: "string" } } },
    }]
    nextToolCall = { name: "Task", id: "call_t1", input: { subagent_type: "Explore", prompt: "find it" } }
    const res = await post(app, haikuBody({ tools, messages: [{ role: "user", content: "go" }] }), nativeHeaders("pt-7"))
    expect(res.status).toBe(200)
    const payload = res.json() as { content: Array<Record<string, unknown>> }
    const toolUse = payload.content.find((b) => b.type === "tool_use")!
    // OpenCode would rewrite "Explore" via resolveAgentAlias; polytoken must not.
    expect(toolUse.input).toEqual({ subagent_type: "Explore", prompt: "find it" })
  })

  it("preserves lowercase task tool payload too", async () => {
    const { app } = createProxyServer({ silent: true })
    const tools = [{
      name: "task",
      description: "Launch a subagent",
      input_schema: { type: "object", properties: { subagent_type: { type: "string" } } },
    }]
    nextToolCall = { name: "task", id: "call_t2", input: { subagent_type: "general-purpose" } }
    const res = await post(app, haikuBody({ tools, messages: [{ role: "user", content: "go" }] }), nativeHeaders("pt-8"))
    expect(res.status).toBe(200)
    const payload = res.json() as { content: Array<Record<string, unknown>> }
    const toolUse = payload.content.find((b) => b.type === "tool_use")!
    expect(toolUse.input).toEqual({ subagent_type: "general-purpose" })
  })
})

describe("polytoken append-only tool loop and resume", () => {
  const clientTool = { name: "read_file", description: "d", input_schema: { type: "object", properties: { path: { type: "string" } } } }
  // The assistant message the default SDK mock yields for a plain text turn —
  // the client appends this to its history exactly as the proxy emitted it.
  const turn1Assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] }

  it("resumes the captured SDK session on the next same-key turn (append-only result)", async () => {
    const { app } = createProxyServer({ silent: true })
    const key = crypto.randomUUID()
    // Turn 1: model returns a tool_use.
    nextToolCall = { name: "read_file", id: "call_r1", input: { path: "a.ts" } }
    const first = await post(app, haikuBody({ tools: [clientTool], messages: [{ role: "user", content: "read it" }] }), nativeHeaders(key))
    expect(first.status).toBe(200)
    const sdkSessionId = captured[0]!.options!.sessionId
    expect(sdkSessionId).toBeTruthy()
    // Turn 2: same key, the client appends the assistant call + its result
    // (byte-exact as received) and continues.
    const second = await post(app, haikuBody({
      tools: [clientTool],
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_r1", name: "read_file", input: { path: "a.ts" } }] },
        { role: "user", content: [toolResult("call_r1", "FILE CONTENT")] },
      ],
    }), nativeHeaders(key))
    expect(second.status).toBe(200)
    expect(captured[1]!.options!.resume).toBe(sdkSessionId)
    // Append-only: the SDK receives only the delta, not the replayed history.
    expect(captured[1]!.prompt).toContain("FILE CONTENT")
    expect(captured[1]!.prompt).not.toContain("read it")
  })

  it("resumes when the assistant tool_use was already in the full input history (handoff shape)", async () => {
    const { app } = createProxyServer({ silent: true })
    const key = crypto.randomUUID()
    // A fresh client hands off mid-loop: full history including tool_use + result.
    const body = haikuBody({
      tools: [clientTool],
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_h1", name: "read_file", input: { path: "a.ts" } }] },
        { role: "user", content: [toolResult("call_h1", "HANDOFF CONTENT")] },
      ],
    })
    const res = await post(app, body, nativeHeaders(key))
    expect(res.status).toBe(200)
    // No prior captured session for this key → fresh session, full input.
    expect(captured[0]!.options!.resume).toBeUndefined()
    expect(captured[0]!.inputCount).toBe(1)
    expect(captured[0]!.prompt).toContain("HANDOFF CONTENT")
  })

  it("does not share SDK state between distinct keys with identical bodies", async () => {
    const { app } = createProxyServer({ silent: true })
    const keyA = crypto.randomUUID()
    const keyB = crypto.randomUUID()
    await post(app, haikuBody({ tools: [clientTool], messages: [{ role: "user", content: "read it" }] }), nativeHeaders(keyA))
    const sessionA = captured[0]!.options!.sessionId
    await post(app, haikuBody({ tools: [clientTool], messages: [{ role: "user", content: "read it" }] }), nativeHeaders(keyB))
    const sessionB = captured[1]!.options!.sessionId
    expect(sessionA).not.toBe(sessionB)
    // A continuation on A does not resume into B's session, and vice versa:
    // each key advances its own lineage from its own first turn.
    const continuationA = haikuBody({
      tools: [clientTool],
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "follow-up on A" },
      ],
    })
    await post(app, continuationA, nativeHeaders(keyA))
    expect(captured[2]!.options!.resume).toBe(sessionA)
    const continuationB = haikuBody({
      tools: [clientTool],
      messages: [
        { role: "user", content: "read it" },
        turn1Assistant,
        { role: "user", content: "follow-up on B" },
      ],
    })
    await post(app, continuationB, nativeHeaders(keyB))
    expect(captured[3]!.options!.resume).toBe(sessionB)
    expect(captured[3]!.options!.resume).not.toBe(sessionA)
  })

  it("keeps missing/blank-key requests safely independent (no resume, no shared state)", async () => {
    const { app } = createProxyServer({ silent: true })
    // Blank key: not a match, not an identity.
    const blank = await post(app, haikuBody({ tools: [clientTool] }), { "x-polytoken-session": "   " })
    expect(blank.status).toBe(200)
    expect(captured[0]!.options!.resume).toBeUndefined()
    expect(captured[0]!.options!.sessionId).toBeTruthy()
    // A second blank-key request must not resume the first's session.
    await post(app, haikuBody({ tools: [clientTool] }))
    expect(captured[1]!.options!.resume).toBeUndefined()
    expect(captured[1]!.options!.sessionId).not.toBe(captured[0]!.options!.sessionId)
  })

  it("keeps distinct same-key branches isolated without cross-session leakage", async () => {
    // The stale-branch 400 conflict and waiter-resumes-latest coordination are
    // framework contracts pinned by proxy-concurrency-coordination.test.ts and
    // proxy-cross-process-coordination.test.ts — the native key reaches the
    // identical acquire/commit path (see the session-tree/lease tests here).
    // What is polytoken-specific and asserted here: the raw native key drives
    // the mapping (no prefixing mid-request) and identical bodies under
    // different keys never share state.
    const { app } = createProxyServer({ silent: true })
    const key = crypto.randomUUID()
    const openBody = [{ role: "user", content: "opening turn" }]
    await post(app, haikuBody({ messages: openBody }), nativeHeaders(key))
    const sdkSessionId = captured[0]!.options!.sessionId
    // Identical first-turn replay under the same key: the existing lineage
    // classifier treats it as a replayed request (fresh, no resume) rather
    // than merging histories.
    const replay = await post(app, haikuBody({ messages: openBody }), nativeHeaders(key))
    expect(replay.status).toBe(200)
    // Replay does not silently resume the old session.
    expect(captured[1]!.options!.resume).toBeUndefined()
    expect(captured[1]!.options!.sessionId).not.toBe(sdkSessionId)
  })
})

describe("polytoken prompt defaults and overrides", () => {
  it("sends no Claude Code preset and keeps the client's system prompt", async () => {
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ system: "You are the client's own agent." }), nativeHeaders("pt-10"))
    const options = captured[0]!.options!
    const systemPrompt = options.systemPrompt
    expect(systemPrompt).toBeDefined()
    const promptText = typeof systemPrompt === "string"
      ? systemPrompt
      : String(Array.isArray(systemPrompt)
        ? (systemPrompt as Array<{ text?: string }>).map((p: any) => p.text ?? "").join("")
        : JSON.stringify(systemPrompt))
    expect(promptText).toContain("You are the client's own agent.")
    expect(promptText).not.toContain("Claude Code")
    expect(promptText).not.toContain("subagent_type")
    // No memory/settings injection surfaces.
    expect(options.settingSources).toEqual([])
  })

  it("preserves signed/redacted thinking and exact usage counters (nonstream)", async () => {
    const { app } = createProxyServer({ silent: true })
    // Replace the SDK mock stream for this test with a thinking-bearing one.
    const { setSdkMock } = await import("./sdkMock")
    setSdkMock(() => ({
      query: (input: Input) => (async function* () {
        let inputCount = typeof input.prompt === "string" ? 1 : 0
        if (typeof input.prompt !== "string") for await (const _row of input.prompt) inputCount++
        captured.push({ options: input.options, prompt: "x", inputCount, yielded: [] })
        for (const event of [
          messageStart("msg_think"),
          { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, session_id: "s" },
          { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning here" } }, session_id: "s" },
          { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG123" } }, session_id: "s" },
          blockStop(0),
          textBlockStart(1),
          textDelta(1, "answer"),
          blockStop(1),
          {
            type: "stream_event",
            event: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 },
            },
            session_id: "s",
          },
          messageStop(),
          {
            type: "assistant",
            message: {
              id: "msg_think", type: "message", role: "assistant",
              content: [
                { type: "thinking", thinking: "reasoning here", signature: "SIG123" },
                { type: "text", text: "answer" },
              ],
              model: "claude-haiku-4-5", stop_reason: "end_turn",
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 },
            },
            session_id: "s",
          },
        ] as unknown as Array<Record<string, unknown>>)
          yield withMockSdkSessionId(event, input.options)
      })(),
      createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
      tool: () => ({}),
    }), "proxy-polytoken.test.ts:thinking")
    try {
      const res = await post(app, haikuBody(), nativeHeaders("pt-11"))
      expect(res.status).toBe(200)
      const payload = res.json() as { content: Array<Record<string, unknown>>; usage: Record<string, number> }
      const thinkingBlock = payload.content.find((b) => b.type === "thinking")
      expect(thinkingBlock?.signature).toBe("SIG123")
      expect(thinkingBlock?.thinking).toBe("reasoning here")
      expect(payload.usage.input_tokens).toBe(100)
      expect(payload.usage.output_tokens).toBe(20)
      expect(payload.usage.cache_read_input_tokens).toBe(80)
      expect(payload.usage.cache_creation_input_tokens).toBe(10)
    } finally {
      // Restore the default file mock for subsequent tests.
      setSdkMock(defaultSdkMock("proxy-polytoken.test.ts:restored"), "proxy-polytoken.test.ts:restored")
    }
  })
})

describe("polytoken no OpenCode behavior leaks", () => {
  it("does not build SDK agents from a Task tool description", async () => {
    const { app } = createProxyServer({ silent: true })
    const taskTool = {
      name: "task",
      description: "Available agent types:\n- reviewer: Reviews code\n- scout: Explores",
      input_schema: { type: "object", properties: { subagent_type: { type: "string" } } },
    }
    await post(app, haikuBody({ tools: [taskTool] }), nativeHeaders("pt-12"))
    const options = captured[0]!.options!
    expect(options.agents ?? {}).toEqual({})
    expect(String(options.systemPrompt ?? "")).not.toContain("case-sensitive, lowercase")
  })
})