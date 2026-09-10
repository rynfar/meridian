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
import { z } from "zod"
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
  parseSSE,
  withMockSdkSessionId,
} from "./helpers"

type HookInput = {
  tool_name?: unknown
  tool_use_id?: unknown
  tool_input?: unknown
}

type PreToolUseHook = (input: HookInput, toolUse?: unknown, context?: { signal: AbortSignal }) => unknown

type ContentBlock = {
  type?: unknown
  name?: unknown
  id?: unknown
  input?: unknown
  tool_use_id?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function contentBlocks(message: unknown): ContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

function resolvePreToolUseHook(value: unknown): PreToolUseHook | undefined {
  if (!isRecord(value)) return undefined
  const matchers = value.PreToolUse
  if (!Array.isArray(matchers) || !isRecord(matchers[0])) return undefined
  const hooks = matchers[0].hooks
  if (!Array.isArray(hooks) || typeof hooks[0] !== "function") return undefined
  return hooks[0] as PreToolUseHook
}

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

type RegisteredTool = {
  name: string
  description?: string
  inputSchema: Record<string, z.ZodTypeAny>
  handler: (...args: unknown[]) => unknown
  _meta?: Record<string, unknown>
}

type RegisteredMcpServer = {
  name: string
  tools: RegisteredTool[]
}

let captured: Array<{
  options: Input["options"]
  prompt: string
  inputCount: number
  yielded: Array<Record<string, unknown>>
  sdkToolNames: string[]
  hookToolNames: string[]
  capturedClientToolNames: string[]
  hookResults: Array<{ name: string; result: unknown }>
}> = []
let registeredMcpServers: RegisteredMcpServer[] = []
/** Per-turn SDK scripts. When a tool call is armed, turn 1 yields the
 * assistant tool_use (the mock invokes the proxy's capture hook, exactly as
 * the real SDK dispatches PreToolUse), the synthetic deny, then a canonical
 * terminal `result` — the persistence acknowledgement. */
let nextToolCall: { name?: string; clientName?: string; id: string; input: Record<string, unknown> } | null = null
let turnScripts: Array<Array<Record<string, unknown>>> = []

function toolTurnScript(call: { name?: string; clientName?: string; id: string; input: Record<string, unknown> }): Array<Record<string, unknown>> {
  const requestedName = call.name ?? call.clientName
  if (!requestedName) throw new Error("tool fixture must define name or clientName")
  const registered = registeredMcpServers
    .flatMap(server => server.tools)
    .find(tool => tool.name === requestedName || tool.name === requestedName.replace(/^mcp__oc__+/, ""))
  if (!registered) throw new Error(`tool fixture was not registered: ${requestedName}`)
  const sdkName = `mcp__oc__${registered.name}`
  return [
    {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      message: {
        id: `msg_${call.id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: call.id, name: sdkName, input: call.input }],
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
      captured.push({ options: input.options, prompt, inputCount, yielded: [], sdkToolNames: [], hookToolNames: [], capturedClientToolNames: [], hookResults: [] })
      const streamBlocks = new Map<number, { name: string; id: string; json: string }>()
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
      const preHook = resolvePreToolUseHook(input.options?.hooks)
      let sawDeny = false
      let sawResult = false
      for (const msg of script) {
        const delivered = withMockSdkSessionId(msg, input.options) as Record<string, unknown>
        const assistantBlocks = delivered.type === "assistant" ? contentBlocks(delivered.message) : []
        if (assistantBlocks.length > 0) {
          for (const block of assistantBlocks) {
            if (block.type !== "tool_use" || typeof preHook !== "function") continue
            const toolName = String(block.name)
            captured[captured.length - 1]!.hookToolNames.push(toolName)
            void Promise.resolve(preHook({
              tool_name: block.name,
              tool_use_id: block.id,
              tool_input: block.input,
            }, undefined, { signal: new AbortController().signal })).then(result => {
              if ((result as { decision?: unknown } | undefined)?.decision === "block") {
                captured[captured.length - 1]!.capturedClientToolNames.push(toolName)
              }
              captured[captured.length - 1]!.hookResults.push({ name: toolName, result })
            })
          }
        }
        if (delivered.type === "user" && contentBlocks(delivered.message).some(block => block.type === "tool_result")) sawDeny = true
        if (delivered.type === "result") sawResult = true
        if (delivered.type === "stream_event") {
          const event = delivered.event as Record<string, unknown>
          const block = event.content_block as Record<string, unknown> | undefined
          if (event.type === "content_block_start" && block?.type === "tool_use") {
            streamBlocks.set(Number(event.index), {
              name: String(block.name),
              id: String(block.id),
              json: "",
            })
          }
          if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined
            const pending = streamBlocks.get(Number(event.index))
            if (pending && delta?.type === "input_json_delta") pending.json += String(delta.partial_json ?? "")
          }
          if (event.type === "content_block_stop") {
            const pending = streamBlocks.get(Number(event.index))
            if (pending && typeof preHook === "function") {
              captured[captured.length - 1]!.hookToolNames.push(pending.name)
              void Promise.resolve(preHook({
                tool_name: pending.name,
                tool_use_id: pending.id,
                tool_input: pending.json ? JSON.parse(pending.json) : {},
              }, undefined, { signal: new AbortController().signal })).then(result => {
                if ((result as { decision?: unknown } | undefined)?.decision === "block") {
                  captured[captured.length - 1]!.capturedClientToolNames.push(pending.name)
                }
                captured[captured.length - 1]!.hookResults.push({ name: pending.name, result })
              })
            }
          }
        }
        const yieldedAssistantBlocks = delivered.type === "assistant" ? contentBlocks(delivered.message) : []
        for (const block of yieldedAssistantBlocks) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            captured[captured.length - 1]!.sdkToolNames.push(block.name)
          }
        }
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
    createSdkMcpServer: (options: { name: string; tools?: RegisteredTool[] }) => {
      registeredMcpServers.push({ name: options.name, tools: [...(options.tools ?? [])] })
      return { type: "sdk", name: options.name, instance: {} }
    },
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
  registeredMcpServers = []
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function post(
  app: ReturnType<typeof createProxyServer>["app"],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
 ): Promise<{ status: number; text: string; headers: Headers; json: () => Record<string, unknown> }> {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
  const responseText = await response.text()
  return {
    status: response.status,
    text: responseText,
    headers: response.headers,
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
    nextToolCall = { clientName: "read_file", id: "call_1", input: { path: "src/a.ts" } }
    const res = await post(app, haikuBody({ tools, messages: [{ role: "user", content: "read it" }] }), nativeHeaders("pt-1"))
    expect(res.status).toBe(200)
    const registration = registeredMcpServers.find(server => server.name === "oc")
    if (!registration) throw new Error("polytoken MCP registration was not captured")
    expect(registration.tools).toHaveLength(1)
    const registered = registration.tools[0]!
    expect(registered.name).toBe("read_file")
    expect(registered.description).toBe("Read a file from the client workspace")
    const advertised = z.toJSONSchema(z.object(registered.inputSchema), { io: "input" })
    expect(advertised.properties).toMatchObject({
      path: { type: "string" },
      "weird-key": { type: "number" },
    })
    expect(advertised.required).toEqual(["path"])
    expect(registered.name).toBe("read_file")
    expect(captured[0]!.sdkToolNames).toEqual([`mcp__oc__${registered.name}`])
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

  it("aliases a declared MCP namespace collision and restores its client name", async () => {
    const { app } = createProxyServer({ silent: true })
    const tools = [{
      name: "mcp__oc__read_file",
      description: "Read through an already-prefixed client tool",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    }]
    nextToolCall = { clientName: "mcp__oc__read_file", id: "call_collision", input: { path: "src/a.ts" } }
    const res = await post(app, haikuBody({ tools, messages: [{ role: "user", content: "read it" }] }), nativeHeaders("pt-collision"))
    expect(res.status).toBe(200)
    const registration = registeredMcpServers.find(server => server.name === "oc")
    if (!registration) throw new Error("polytoken MCP registration was not captured")
    expect(registration.tools).toHaveLength(1)
    expect(registration.tools[0]!.name).toBe("read_file")
    expect(captured[0]!.options!.allowedTools).toEqual(["mcp__oc__read_file"])
    const payload = res.json() as { content: Array<Record<string, unknown>> }
    expect(payload.content.find(block => block.type === "tool_use")).toEqual({
      type: "tool_use",
      id: "call_collision",
      name: "mcp__oc__read_file",
      input: { path: "src/a.ts" },
    })
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

  it("preserves Task/Task subagent_type payloads (no alias rewriting)", async () => {
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

  it("keeps blank-key requests safely independent (no polytoken selection, no resume)", async () => {
    const { app } = createProxyServer({ silent: true })
    // A whitespace-only native header is not a match: detection falls through,
    // so this request does not select polytoken at all — it exercises the
    // headerless default path the same way any other client would.
    const blank = await post(app, haikuBody({ tools: [clientTool] }), { "x-polytoken-session": "   " })
    expect(blank.status).toBe(200)
    expect(captured[0]!.options!.resume).toBeUndefined()
    expect(captured[0]!.options!.sessionId).toBeTruthy()
    // A second headerless request must not resume the first's session.
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

describe("polytoken native streaming boundaries", () => {
  const streamPost = async (
    app: ReturnType<typeof createProxyServer>["app"],
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ) => {
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }))
    const text = await response.text()
    return { response, events: parseSSE(text) }
  }

  it("streams a client tool call with one balanced envelope and resumes it by native key", async () => {
    const { app } = createProxyServer({ silent: true })
    const tool = {
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }
    const key = "pt-stream-tool"
    turnScripts = [[
      messageStart("msg_tool"),
      toolUseBlockStart(0, "mcp__oc__read_file", "toolu_stream"),
      inputJsonDelta(0, '{"path":"a.ts"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
      assistantMessage([{ type: "tool_use", id: "toolu_stream", name: "mcp__oc__read_file", input: { path: "a.ts" } }]),
      { type: "user", parent_tool_use_id: null, uuid: crypto.randomUUID(), message: {
        role: "user", content: [toolResult("toolu_stream", "forwarded to client")],
      } },
    ]]
    const first = await streamPost(app, haikuBody({ stream: true, tools: [tool], messages: [{ role: "user", content: "read it" }] }), nativeHeaders(key))
    expect(first.response.status).toBe(200)
    expect(first.response.headers.get("content-type")).toContain("text/event-stream")
    expect(first.events.map(event => event.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ])
    expect(first.events.map(event => event.data.index).filter(index => index !== undefined)).toEqual([0, 0, 0])
    expect(first.events.find(event => event.event === "message_delta")!.data).toMatchObject({
      type: "message_delta", delta: { stop_reason: "tool_use" },
    })
    expect(first.events.filter(event => event.event === "message_start")).toHaveLength(1)
    expect(first.events.filter(event => event.event === "message_stop")).toHaveLength(1)
    const blockStarts = first.events.filter(event => event.event === "content_block_start")
    const blockStops = first.events.filter(event => event.event === "content_block_stop")
    expect(blockStarts).toHaveLength(1)
    expect(blockStops).toHaveLength(1)
    expect((blockStarts[0]!.data.content_block as Record<string, unknown>).name).toBe("read_file")
    expect((blockStarts[0]!.data.content_block as Record<string, unknown>).id).toBe("toolu_stream")
    expect(first.events.find(event => event.event === "content_block_delta")!.data.delta).toEqual({
      type: "input_json_delta", partial_json: '{"path":"a.ts"}',
    })
    expect(captured[0]!.options!.sessionId).toBeTruthy()

    turnScripts = [[
      messageStart("msg_followup"),
      textBlockStart(0),
      textDelta(0, "done"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]]
    const second = await streamPost(app, haikuBody({
      stream: true,
      tools: [tool],
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_stream", name: "read_file", input: { path: "a.ts" } }] },
        { role: "user", content: [toolResult("toolu_stream", "FILE CONTENT")] },
      ],
    }), nativeHeaders(key))
    expect(second.response.status).toBe(200)
    expect(second.events.at(-1)?.event).toBe("message_stop")
    expect(second.events.find(event => event.event === "message_delta")!.data.delta).toMatchObject({ stop_reason: "end_turn" })
    expect(captured[1]!.options!.resume).toBe(captured[0]!.options!.sessionId)
    expect(captured[1]!.prompt).toContain("FILE CONTENT")
    expect(captured[1]!.prompt).not.toContain("read it")
  })

  it("preserves signed thinking and exact usage in parsed native SSE", async () => {
    const { app } = createProxyServer({ silent: true })
    turnScripts = [[
      messageStart("msg_stream_think"),
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG_STREAM" } } },
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "answer"),
      blockStop(1),
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 101, output_tokens: 21, cache_read_input_tokens: 81, cache_creation_input_tokens: 11 } } },
      messageStop(),
    ]]
    const result = await streamPost(app, haikuBody({ stream: true }), nativeHeaders("pt-stream-thinking"))
    expect(result.response.status).toBe(200)
    const events = result.events
    expect(events.map(event => event.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ])
    expect(events.map(event => event.data.index).filter(index => index !== undefined)).toEqual([0, 0, 0, 0, 1, 1, 1])
    expect(events.find(event => event.event === "content_block_start")!.data.content_block).toMatchObject({ type: "thinking" })
    expect(events.find(event => (event.data.delta as Record<string, unknown> | undefined)?.type === "thinking_delta")!.data).toEqual({
      type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" },
    })
    expect(events.find(event => (event.data.delta as Record<string, unknown> | undefined)?.type === "signature_delta")!.data).toEqual({
      type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG_STREAM" },
    })
    expect(events.filter(event => event.event === "content_block_start")).toHaveLength(2)
    expect(events.filter(event => event.event === "content_block_stop")).toHaveLength(2)
    expect(events.find(event => event.event === "message_delta")!.data.usage).toEqual({
      input_tokens: 101, output_tokens: 21, cache_read_input_tokens: 81, cache_creation_input_tokens: 11,
    })
    expect(events.at(-1)?.event).toBe("message_stop")
  })

  it("filters internal ToolSearch while forwarding the discovered client tool once", async () => {
    const { app } = createProxyServer({ silent: true })
    const tool = {
      name: "custom_lint",
      description: "Run custom linting",
      defer_loading: true,
      input_schema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    }
    turnScripts = [[
      messageStart("msg_deferred"),
      toolUseBlockStart(0, "ToolSearch", "toolu_search"),
      inputJsonDelta(0, '{"query":"custom_lint"}'),
      blockStop(0),
      toolUseBlockStart(1, "mcp__oc__custom_lint", "toolu_lint"),
      inputJsonDelta(1, '{"file":"a.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]]
    const result = await streamPost(app, haikuBody({ stream: true, tools: [tool] }), nativeHeaders("pt-stream-deferred"))
    expect(result.response.status).toBe(200)
    await flushMicrotasks()
    expect(result.events.some(event => (event.data.content_block as Record<string, unknown> | undefined)?.name === "ToolSearch")).toBe(false)
    expect(result.events.some(event => (event.data.content_block as Record<string, unknown> | undefined)?.name === "custom_lint")).toBe(true)
    expect(captured[0]!.hookToolNames).toEqual(["ToolSearch", "mcp__oc__custom_lint"])
    expect(captured[0]!.capturedClientToolNames).toEqual(["mcp__oc__custom_lint"])
    expect(captured[0]!.hookResults).toEqual([
      { name: "ToolSearch", result: {} },
      { name: "mcp__oc__custom_lint", result: expect.objectContaining({ decision: "block" }) },
    ])
    const registration = registeredMcpServers.find(server => server.name === "oc")
    if (!registration) throw new Error("deferred MCP registration was not captured")
    expect(registration.tools.map(toolDefinition => toolDefinition.name)).toEqual(["custom_lint"])
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

  it("preserves signed thinking and exact usage counters (nonstream)", async () => {
    const { app } = createProxyServer({ silent: true })
    // Replace the SDK mock stream for this test with a thinking-bearing one.
    const { setSdkMock } = await import("./sdkMock")
    setSdkMock(() => ({
      query: (input: Input) => (async function* () {
        let inputCount = typeof input.prompt === "string" ? 1 : 0
        if (typeof input.prompt !== "string") for await (const _row of input.prompt) inputCount++
        captured.push({ options: input.options, prompt: "x", inputCount, yielded: [], sdkToolNames: [], hookToolNames: [], capturedClientToolNames: [], hookResults: [] })
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

describe("polytoken catalog lifecycle characterization", () => {
  const readTool = (description = "Read a file", pathType = "string", defer_loading?: boolean) => ({
    name: "read_file",
    description,
    ...(defer_loading === undefined ? {} : { defer_loading }),
    input_schema: { type: "object", properties: { path: { type: pathType } }, required: ["path"] },
  })
  const writeTool = { name: "write_file", description: "Write a file", input_schema: {
    type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"],
  } }
  const continuation = (content: string) => [
    { role: "user", content: "catalog opening" },
    { role: "assistant", content: [{ type: "tool_use", id: "catalog-tool", name: "read_file", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "catalog-tool", content: "file" }] },
    { role: "user", content },
  ]

  async function sendCatalogTurn(
    app: ReturnType<typeof createProxyServer>["app"],
    sessionId: string,
    tools: Array<Record<string, unknown>> | undefined,
    content: string,
  ) {
    return post(app, haikuBody({ tools, messages: continuation(content) }), nativeHeaders(sessionId))
  }

  it("reuses the same MCP object for reorder and description-only changes", async () => {
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [readTool(), writeTool], messages: [{ role: "user", content: "catalog opening" }] }), nativeHeaders("pt-catalog"))
    const first = captured[0]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", [writeTool, readTool("Read from disk")], "description changed")
    const second = captured[1]!.options!.mcpServers?.oc
    expect(first).toBe(second)
    expect(registeredMcpServers).toHaveLength(1)
  })

  it("rebuilds the MCP object for schema, defer, growth, and shrink changes", async () => {
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [readTool()], messages: [{ role: "user", content: "catalog opening" }] }), nativeHeaders("pt-catalog"))
    const first = captured[0]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", [readTool("Read a file", "number")], "schema changed")
    const second = captured[1]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", [readTool("Read a file", "number", true)], "defer changed")
    const third = captured[2]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", [readTool("Read a file", "number", true), writeTool], "tool added")
    const fourth = captured[3]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", [readTool("Read a file", "number", true)], "tool removed")
    const fifth = captured[4]!.options!.mcpServers?.oc
    expect(new Set([first, second, third, fourth, fifth]).size).toBe(5)
    expect(registeredMcpServers).toHaveLength(5)
  })

  it("currently restores omitted tools but clears an explicit-empty continuation", async () => {
    const { app } = createProxyServer({ silent: true })
    await post(app, haikuBody({ tools: [readTool()], messages: [{ role: "user", content: "catalog opening" }] }), nativeHeaders("pt-catalog"))
    const first = captured[0]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", undefined, "tools omitted")
    const omitted = captured[1]!.options!.mcpServers?.oc
    await sendCatalogTurn(app, "pt-catalog", [], "tools explicitly empty")
    const explicitEmpty = captured[2]!.options!.mcpServers?.oc
    expect(omitted).toBe(first)
    expect(explicitEmpty).toBeUndefined()
    expect(registeredMcpServers).toHaveLength(1)
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