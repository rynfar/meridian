/**
 * Sessions sending the same tools share one built definition set.
 *
 * A built set is ~30 MB of Zod schemas for a real OpenCode tool list, and the
 * per-session MCP cache holds one per session, so a copy per session grew a
 * long-lived proxy by several GB. These tests pin the sharing at the server,
 * where the cache lives, and its content sensitivity at the builder.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

const builtToolLists: unknown[] = []

installSdkMock(() => ({
  query: (params: any) => (async function* () {
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
  })(),
  createSdkMcpServer: (options: { tools: unknown }) => {
    builtToolLists.push(options.tools)
    return { type: "sdk", name: "test", instance: {} }
  },
  tool: () => ({}),
}), "passthrough-shared-definitions.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { sharedPassthroughMcpServer } = await import("../proxy/passthroughTools")

function tools(description = "Read a file") {
  return ["read", "write", "bash"].map(name => ({
    name,
    description: `${description} (${name})`,
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }))
}

async function post(app: any, session: string) {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": session },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: `hello from ${session}` }],
      tools: tools(),
    }),
  }))
  expect(res.status).toBe(200)
  await res.text()
}

describe("passthrough definitions shared across sessions", () => {
  beforeEach(async () => {
    builtToolLists.length = 0
    await clearSessionCache()
  })

  it("serves two sessions with identical tools from one built set", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, "shared-a")
    await post(app, "shared-b")
    expect(builtToolLists.length).toBe(2)
    expect(builtToolLists[1]).toBe(builtToolLists[0])
  })

  it("builds a separate set for any input the build reads", () => {
    const base = sharedPassthroughMcpServer(tools(), ["read"], "oc", true)
    expect(sharedPassthroughMcpServer(tools(), ["read"], "oc", true)).toBe(base)
    expect(sharedPassthroughMcpServer(tools("Changed"), ["read"], "oc", true)).not.toBe(base)
    expect(sharedPassthroughMcpServer(tools(), ["write"], "oc", true)).not.toBe(base)
    expect(sharedPassthroughMcpServer(tools(), ["read"], "other", true)).not.toBe(base)
    expect(sharedPassthroughMcpServer(tools(), ["read"], "oc", false)).not.toBe(base)
    const deferred = tools().map(tool => ({ ...tool, defer_loading: true }))
    expect(sharedPassthroughMcpServer(deferred, ["read"], "oc", true)).not.toBe(base)
    const retyped = tools().map(tool => ({ ...tool, input_schema: { ...tool.input_schema, properties: { path: { type: "number" } } } }))
    expect(sharedPassthroughMcpServer(retyped, ["read"], "oc", true)).not.toBe(base)
  })
})
