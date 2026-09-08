/**
 * Passthrough delivery for client tools already named mcp__oc__* (#967).
 *
 * A client that aggregates its own MCP servers declares tools like
 * `mcp__oc__read`. Those names collide with the namespace Meridian nests
 * client tools under, and the reverse translation was a blind
 * `stripMcpPrefix`, so the forwarded tool_use reached the client renamed to
 * `read` — a tool it never declared and cannot execute. The result the proxy
 * promised the model "in a future turn" then never arrived.
 *
 * Live on SDK 0.2.141 / CLI 2.1.263 the same collision also cost the model its
 * dispatch (HTTP 500 non-streaming, `stop_reason: max_tokens` streaming); that
 * half needs the real CLI and is covered by the E43 gate. What is asserted here
 * is the wire contract these paths own: whatever shape the SDK emits, the name
 * delivered to the client is the name the client declared.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
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

let mockMessages: any[] = []

installSdkMock(() => ({
  query: (params: any) =>
    (async function* () {
      for (const msg of mockMessages) yield withMockSdkSessionId(msg, params.options)
    })(),
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
}), "proxy-passthrough-oc-prefixed-tools.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

/** A client whose own tool name already carries the passthrough namespace. */
const OC_PREFIXED_TOOL = {
  name: "mcp__oc__read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
}

const PLAIN_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
}

function app() {
  return createProxyServer({ port: 0, host: "127.0.0.1" }).app
}

async function postStream(tools: any[]): Promise<Array<{ name: string; input: unknown }>> {
  const res = await app().fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeRequest({
      stream: true,
      tools,
      messages: [{ role: "user", content: "Read /tmp/a.txt" }],
    })),
  }))
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let raw = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += dec.decode(value, { stream: true })
  }
  return parseSSE(raw)
    .filter(e => e.event === "content_block_start"
      && (e.data as any).content_block?.type === "tool_use")
    .map(e => ({
      name: (e.data as any).content_block.name,
      input: (e.data as any).content_block.input,
    }))
}

async function postNonStream(tools: any[]): Promise<Array<{ name: string; input: unknown }>> {
  const res = await app().fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeRequest({
      stream: false,
      tools,
      messages: [{ role: "user", content: "Read /tmp/a.txt" }],
    })),
  }))
  expect(res.status).toBe(200)
  const body: any = await res.json()
  return (body.content ?? [])
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ name: b.name, input: b.input }))
}

describe("passthrough delivery of mcp__oc__-named client tools (#967)", () => {
  let orig: string | undefined

  beforeEach(() => {
    mockMessages = []
    orig = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    clearSessionCache()
  })

  afterEach(() => {
    if (orig !== undefined) process.env.MERIDIAN_PASSTHROUGH = orig
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  // The SDK emits the canonical prefixed name in some paths and the bare
  // registered name in others. Both must land on the declared name.
  for (const [shape, sdkName] of [
    ["canonical prefixed name", "mcp__oc__read"],
    ["bare registered name", "read"],
  ] as const) {
    it(`STREAM delivers the declared name from the SDK's ${shape}`, async () => {
      mockMessages = [
        messageStart(),
        toolUseBlockStart(0, sdkName, "toolu_1"),
        inputJsonDelta(0, '{"file_path":"/tmp/a.txt"}'),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]
      const calls = await postStream([OC_PREFIXED_TOOL])
      expect(calls.map(c => c.name)).toEqual(["mcp__oc__read"])
    })

    it(`NON-STREAM delivers the declared name from the SDK's ${shape}`, async () => {
      mockMessages = [
        assistantMessage([
          { type: "tool_use", id: "toolu_2", name: sdkName, input: { file_path: "/tmp/a.txt" } },
        ]),
      ]
      const calls = await postNonStream([OC_PREFIXED_TOOL])
      expect(calls.map(c => c.name)).toEqual(["mcp__oc__read"])
    })
  }

  it("keeps the tool arguments intact alongside the corrected name", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_3", name: "mcp__oc__read", input: { file_path: "/tmp/a.txt" } },
      ]),
    ]
    const calls = await postNonStream([OC_PREFIXED_TOOL])
    expect(calls).toEqual([{ name: "mcp__oc__read", input: { file_path: "/tmp/a.txt" } }])
  })

  it("still delivers a plain tool name unchanged (no regression)", async () => {
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, "mcp__oc__read", "toolu_4"),
      inputJsonDelta(0, '{"file_path":"/tmp/a.txt"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]
    const calls = await postStream([PLAIN_TOOL])
    expect(calls.map(c => c.name)).toEqual(["read"])
  })

  it("keeps a plain and a colliding tool distinguishable in one request", async () => {
    // `read` keeps its identity; `mcp__oc__read` is registered as `read_2`.
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_5", name: "mcp__oc__read", input: { file_path: "/tmp/a.txt" } },
        { type: "tool_use", id: "toolu_6", name: "mcp__oc__read_2", input: { file_path: "/tmp/b.txt" } },
      ]),
    ]
    const calls = await postNonStream([PLAIN_TOOL, OC_PREFIXED_TOOL])
    expect(calls.map(c => c.name)).toEqual(["read", "mcp__oc__read"])
  })

  it("leaves a foreign mcp__ namespace untouched", async () => {
    const foreign = { ...OC_PREFIXED_TOOL, name: "mcp__zed__read" }
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_7", name: "mcp__oc__mcp__zed__read", input: { file_path: "/tmp/a.txt" } },
      ]),
    ]
    const calls = await postNonStream([foreign])
    expect(calls.map(c => c.name)).toEqual(["mcp__zed__read"])
  })
})
