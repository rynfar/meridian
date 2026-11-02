/**
 * Deferred tool loading in passthrough mode.
 *
 * When tools have defer_loading: true, Meridian enables the SDK's ToolSearch
 * mechanism. Non-deferred tools are marked alwaysLoad. ToolSearch calls are
 * handled internally by the SDK and filtered from responses.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  messageStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
  assistantMessage,
  makeRequest,
  withMockSdkSessionId,
} from "./helpers"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ─── SDK mock ────────────────────────────────────────────────────────────────
let mockMessages: SDKMessage[] = []
let capturedQueryParams: any = {}
let capturedMcpRegistrations: Array<{ name: string; tools: Array<Record<string, unknown>> }> = []

installSdkMock(() => ({
  query: (opts: any) => {
    capturedQueryParams = opts
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, opts.options)
      }
    })()
  },
  createSdkMcpServer: (opts: { name: string; tools: Array<Record<string, unknown>> }) => {
    capturedMcpRegistrations.push(opts)
    return {
      type: "sdk",
      name: opts.name,
      instance: { tool: () => {}, registerTool: () => ({}) },
    }
  },
}), "deferred-tool-loading.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function app() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

const ALWAYS_LOADED_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

const DEFERRED_TOOL = {
  name: "custom_lint",
  description: "Run custom linter",
  input_schema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
  defer_loading: true,
}

// Generate N generic tools for threshold testing
function makeTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: `Tool ${i}`,
    input_schema: { type: "object", properties: { input: { type: "string" } } },
  }))
}

let savedPassthrough: string | undefined
let savedThreshold: string | undefined

beforeEach(async () => {
  await clearSessionCache()
  mockMessages = []
  capturedQueryParams = {}
  capturedMcpRegistrations = []
  savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
  savedThreshold = process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
  process.env.MERIDIAN_PASSTHROUGH = "1"
  delete process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
})

afterEach(() => {
  if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
  else delete process.env.MERIDIAN_PASSTHROUGH
  if (savedThreshold !== undefined) process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = savedThreshold
  else delete process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
})

describe("deferred tool loading — query options", () => {
  it("sets ENABLE_TOOL_SEARCH=true when tools have defer_loading", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("true")
  })

  it("sets ENABLE_TOOL_SEARCH=false when no tools have defer_loading", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL],
        messages: [{ role: "user", content: "Read a file" }],
      })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
  })
})

describe("deferred tool loading — ToolSearch filtering", () => {
  it("filters ToolSearch tool_use blocks from streaming responses", async () => {
    mockMessages = [
      messageStart(),
      // ToolSearch call (SDK internal — should be filtered)
      toolUseBlockStart(0, "ToolSearch", "tu_search_001"),
      inputJsonDelta(0, '{"query":"custom_lint"}'),
      blockStop(0),
      // Actual tool call (should pass through)
      toolUseBlockStart(1, "mcp__oc__custom_lint", "tu_lint_001"),
      inputJsonDelta(1, '{"file":"/tmp/app.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: true,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    const text = await res.text()
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const toolNames = blockStarts
      .filter((e) => (e.data as any).content_block?.type === "tool_use")
      .map((e) => (e.data as any).content_block?.name)

    expect(toolNames).not.toContain("ToolSearch")
    expect(toolNames).toContain("custom_lint")
  })

  it("filters ToolSearch from non-streaming responses", async () => {
    const PREFIX = "mcp__oc__"
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "tu_search_002", name: "ToolSearch", input: { query: "custom_lint" } },
      { type: "tool_use", id: "tu_lint_002", name: `${PREFIX}custom_lint`, input: { file: "/tmp/app.ts" } },
    ])]

    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>
    const toolNames = content.filter((b) => b.type === "tool_use").map((b) => b.name)

    expect(toolNames).not.toContain("ToolSearch")
    expect(toolNames).toContain("custom_lint")
  })
})

describe("auto-defer — threshold-based deferral via HTTP", () => {
  it("enables ENABLE_TOOL_SEARCH when tool count exceeds threshold", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "5"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    // 6 core tools + 4 generic = 10 tools, above threshold of 5
    const tools = [
      { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "edit", description: "Edit", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { name: "glob", description: "Glob", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
      { name: "grep", description: "Grep", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
      ...makeTools(4),
    ]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: false, tools, messages: [{ role: "user", content: "hi" }] })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("true")
  })

  it("does not enable ENABLE_TOOL_SEARCH when tool count is at or below threshold", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "10"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    // 6 tools, below threshold of 10
    const tools = [
      { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "edit", description: "Edit", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { name: "glob", description: "Glob", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
      { name: "grep", description: "Grep", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
    ]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: false, tools, messages: [{ role: "user", content: "hi" }] })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  it("sets maxTurns to 4 when deferred tools are present (+1 for the ToolSearch discovery turn, #547)", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    expect(capturedQueryParams.options.maxTurns).toBe(4)
  })

  it("caps maxTurns at 1 when no deferred tools — nothing needs a turn past the tool handoff", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL],
        messages: [{ role: "user", content: "Read a file" }],
      })),
    }))

    expect(capturedQueryParams.options.maxTurns).toBe(1)
  })

  it("disables auto-defer when threshold is 0", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "0"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    // 20 tools, but threshold is 0 (disabled)
    const tools = [
      ...makeTools(20),
    ]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: false, tools, messages: [{ role: "user", content: "hi" }] })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
  })
})

describe("deferred tool loading — ToolSearch exempted from PreToolUse block", () => {
  it("does not include ToolSearch in captured tool uses", async () => {
    // Simulate SDK calling ToolSearch (not blocked) then the actual tool (blocked)
    const PREFIX = "mcp__oc__"
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "tu_search_003", name: "ToolSearch", input: { query: "custom_lint" } },
      { type: "tool_use", id: "tu_lint_003", name: `${PREFIX}custom_lint`, input: { file: "/tmp/app.ts" } },
    ])]

    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>

    // ToolSearch should not appear in response (filtered + not captured by PreToolUse)
    const toolNames = content.filter((b) => b.type === "tool_use").map((b) => b.name)
    expect(toolNames).not.toContain("ToolSearch")

    // The actual tool should be captured and forwarded
    expect(toolNames).toContain("custom_lint")
    expect(body.stop_reason).toBe("tool_use")
  })
})

describe("defer pin — a client that defers its own tools (#861)", () => {
  it("does not pin auto-defer=true from a client-deferring request", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    // One server for both turns: the defer pin lives per server instance.
    const server = app()
    const metadata = { user_id: JSON.stringify({ session_id: "defer-pin-client-defer" }) }
    const post = (tools: Array<Record<string, unknown>>) => server.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "claude-cli/2.1.290 (external, cli)" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools,
        messages: [{ role: "user", content: "hi" }],
        metadata,
      })),
    }))

    await post([
      ...makeTools(12),
      {
        name: "DeferredToolPlaceholder",
        description: "t",
        input_schema: { type: "object", properties: {} },
        defer_loading: true,
      },
    ])
    await post(makeTools(20))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
    expect(capturedQueryParams.options.tools).toEqual([])
    const registration = capturedMcpRegistrations.at(-1)
    expect(registration?.name).toBe("oc")
    const definitions = registration?.tools ?? []
    expect(definitions).toHaveLength(20)
    const alwaysLoadCount = definitions.filter(definition =>
      (definition._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === true
    ).length
    expect(alwaysLoadCount).toBe(0)
  })
})

describe("client-owned tool search — one search path", () => {
  const placeholderTool = {
    name: "DeferredToolPlaceholder",
    description: "t",
    input_schema: { type: "object", properties: {} },
    defer_loading: true,
  }

  function clientSearchPost(server: Awaited<ReturnType<typeof app>>, tools: Array<Record<string, unknown>>, messages?: Array<Record<string, unknown>>) {
    const metadata = { user_id: JSON.stringify({ session_id: "client-search-single-path" }) }
    return server.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "claude-cli/2.1.290 (external, cli)" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools,
        messages: messages ?? [{ role: "user", content: "hi" }],
        metadata,
      })),
    }))
  }

  it("registers no client tool search deferred tools and adds no inner ToolSearch", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    const server = app()

    await clientSearchPost(server, [...makeTools(12), {
      name: "ToolSearch",
      description: "The client's own tool search",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    }, placeholderTool])

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
    expect(capturedQueryParams.options.tools).toEqual([])
    const registration = capturedMcpRegistrations.at(-1)
    expect(registration?.name).toBe("oc")
    const definitions = registration?.tools ?? []
    const names = definitions.map(definition => definition.name)
    expect(names).not.toContain("DeferredToolPlaceholder")
    expect(names).toContain("ToolSearch")
    const alwaysLoadCount = definitions.filter(definition =>
      (definition._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === true
    ).length
    expect(alwaysLoadCount).toBe(0)
  })

  it("registers a referenced deferred tool eagerly on the follow-up and renders the reference as text", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    const server = app()

    const loadedTools: Array<Record<string, unknown>> = [
      ...makeTools(12),
      {
        name: "ToolSearch",
        description: "The client's own tool search",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
      placeholderTool,
    ]
    await clientSearchPost(server, loadedTools)

    const history: Array<Record<string, unknown>> = [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_search_1", name: "ToolSearch", input: { query: "graph" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_search_1", is_error: false, content: [
          { type: "tool_reference", tool_name: "mcp__graph__graph_update" },
        ] },
      ] },
      { role: "user", content: "now use it" },
    ]
    await clientSearchPost(server, [
      ...loadedTools,
      {
        name: "mcp__graph__graph_update",
        description: "Update the graph",
        input_schema: { type: "object", properties: { id: { type: "string" } } },
        defer_loading: true,
      },
    ], history)

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
    expect(capturedQueryParams.options.tools).toEqual([])
    // No resumable session in the harness: the reference reaches the SDK as
    // replay text naming the registered tool, never the bare client name (#1107).
    const prompt = JSON.stringify(capturedQueryParams.prompt)
    expect(prompt).toContain("[Tool reference: mcp__oc__mcp__graph__graph_update]")
    expect(prompt).not.toContain("[Tool reference: mcp__graph__graph_update]")
    const registration = capturedMcpRegistrations.at(-1)
    const definitions = registration?.tools ?? []
    const names = definitions.map(definition => definition.name)
    expect(names).toContain("mcp__graph__graph_update")
    expect(names).not.toContain("DeferredToolPlaceholder")
    const graphTool = definitions.find(definition => definition.name === "mcp__graph__graph_update")
    expect(graphTool).toBeDefined()
    expect((graphTool!._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"]).toBeUndefined()
  })
})

describe("generic client deferral — inner search stays on", () => {
  it("registers the deferred tool without alwaysLoad and enables the inner ToolSearch", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    const server = app()
    const metadata = { user_id: JSON.stringify({ session_id: "generic-client-defer" }) }

    await server.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "claude-cli/2.1.290 (external, cli)" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [...makeTools(12), {
          name: "custom_lint",
          description: "Run custom linter",
          input_schema: { type: "object", properties: { file: { type: "string" } } },
          defer_loading: true,
        }],
        messages: [{ role: "user", content: "hi" }],
        metadata,
      })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("true")
    expect(capturedQueryParams.options.tools).toEqual(["ToolSearch"])
    const registration = capturedMcpRegistrations.at(-1)
    const definitions = registration?.tools ?? []
    const isAlwaysLoad = (definition: Record<string, unknown>) =>
      (definition._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === true
    const lint = definitions.find(definition => definition.name === "custom_lint")
    expect(lint).toBeDefined()
    expect(isAlwaysLoad(lint!)).toBe(false)
    expect(definitions.filter(isAlwaysLoad).length).toBe(12)
  })
})

describe("client ToolSearch stays a client tool across modes", () => {
  const clientSearchTools = (placeholder = false): Array<Record<string, unknown>> => [
    ...makeTools(16),
    {
      name: "ToolSearch",
      description: "The client's own tool search",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    },
    ...(placeholder ? [{
      name: "DeferredToolPlaceholder",
      description: "t",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    }] : []),
  ]

  function claudePost(server: Awaited<ReturnType<typeof app>>, body: Record<string, unknown>) {
    return server.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "claude-cli/2.1.290 (external, cli)" },
      body: JSON.stringify(body),
    }))
  }

  it("rebuilds the cached server when the deferral mode flips on unchanged definitions", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]
    const server = app()
    const metadata = { user_id: JSON.stringify({ session_id: "cache-mode-flip" }) }
    const post = (tools: Array<Record<string, unknown>>) => claudePost(server, makeRequest({
      stream: false, tools,
      messages: [{ role: "user", content: "hi" }],
      metadata,
    }))

    await post(clientSearchTools())
    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("true")
    expect(capturedQueryParams.options.tools).toEqual(["ToolSearch"])

    // Unreferenced placeholder: same registration set, flipped mode.
    await post(clientSearchTools(true))
    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
    expect(capturedQueryParams.options.tools).toEqual([])
    const names = (capturedMcpRegistrations.at(-1)?.tools ?? []).map(definition => definition.name)
    expect(names).not.toContain("DeferredToolPlaceholder")
  })

  it("forwards a bare ToolSearch call to the client in client-search mode (non-streaming)", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "tu_ts_1", name: "ToolSearch", input: { query: "graph" } },
    ])]
    const server = app()

    const res = await claudePost(server, makeRequest({
      stream: false,
      tools: clientSearchTools(true),
      messages: [{ role: "user", content: "find the graph tool" }],
      metadata: { user_id: JSON.stringify({ session_id: "bare-toolsearch-nonstream" }) },
    }))
    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>
    const toolNames = content.filter((b) => b.type === "tool_use").map((b) => b.name)
    expect(toolNames).toContain("ToolSearch")
    expect(body.stop_reason).toBe("tool_use")
  })

  it("forwards a prefixed ToolSearch call under the client's name (non-streaming)", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "tu_ts_2", name: "mcp__oc__ToolSearch", input: { query: "graph" } },
    ])]
    const server = app()

    const res = await claudePost(server, makeRequest({
      stream: false,
      tools: clientSearchTools(true),
      messages: [{ role: "user", content: "find the graph tool" }],
      metadata: { user_id: JSON.stringify({ session_id: "prefixed-toolsearch-nonstream" }) },
    }))
    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>
    const toolNames = content.filter((b) => b.type === "tool_use").map((b) => b.name)
    expect(toolNames).toContain("ToolSearch")
  })

  it("forwards a bare ToolSearch call to the client in client-search mode (streaming)", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "15"
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, "ToolSearch", "tu_ts_3"),
      inputJsonDelta(0, '{"query":"graph"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]
    const server = app()

    const res = await claudePost(server, makeRequest({
      stream: true,
      tools: clientSearchTools(true),
      messages: [{ role: "user", content: "find the graph tool" }],
      metadata: { user_id: JSON.stringify({ session_id: "bare-toolsearch-stream" }) },
    }))
    const events = parseSSE(await res.text())
    const toolNames = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => (e.data as Record<string, Record<string, unknown>>).content_block?.name)
    expect(toolNames).toContain("ToolSearch")
  })
})
