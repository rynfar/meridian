/**
 * The server commits a session's tool list through `sharedToolList`, so two
 * sessions that sent the same tools hold one list between them, and a
 * session that sent different tools keeps its own. Unit tests cover the
 * helper; this pins the server's commit path, where the per-session tool
 * cache lives.
 */

import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: any) => (async function* () {
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "passthrough-shared-tool-lists-http.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const passthroughTools = await import("../proxy/passthroughTools")
const committed: Array<{ input: object[]; output: object[] }> = []
const original = passthroughTools.sharedToolList
const spy = spyOn(passthroughTools, "sharedToolList").mockImplementation(<T extends object>(tools: T[]): T[] => {
  const output = original(tools)
  committed.push({ input: tools, output })
  return output
})

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function tools(description = "Read a file") {
  return ["read", "write", "bash"].map(name => ({
    name,
    description: `${description} (${name})`,
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }))
}

async function post(app: any, session: string, toolList: object[]) {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": session },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: `hello from ${session}` }],
      tools: toolList,
    }),
  }))
  expect(res.status).toBe(200)
  await res.json()
}

describe("sessions share committed tool lists", () => {
  afterAll(() => spy.mockRestore())

  beforeEach(async () => {
    committed.length = 0
    await clearSessionCache()
  })

  it("commits identical lists from two sessions as one list", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, "ses_list_a", tools())
    await post(app, "ses_list_b", tools())

    expect(committed).toHaveLength(2)
    const [first, second] = committed
    // Each request parsed its own copy; the second commit got the first's.
    expect(second!.input).not.toBe(first!.input)
    expect(second!.output).toBe(first!.output)
  })

  it("keeps a session that sent different tools on its own list", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, "ses_list_c", tools())
    await post(app, "ses_list_d", tools("Open a file"))

    expect(committed).toHaveLength(2)
    expect(committed[1]!.output).not.toBe(committed[0]!.output)
    expect(committed[1]!.output).toBe(committed[1]!.input)
  })
})
