import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { resolveMockSdkSessionId } from "./helpers"
import { installSdkMock } from "./sdkMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import type { RequestMetric } from "../telemetry/types"

installSdkMock(() => ({
  query: ({ options }: { options: Record<string, unknown> }) => (async function* () {
    yield {
      type: "assistant",
      session_id: resolveMockSdkSessionId(options),
      uuid: randomUUID(),
      message: {
        id: "msg-ok", type: "message", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-client-attribution.test.ts")
installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

const messages = { max_tokens: 10, messages: [{ role: "user", content: "Say ok" }] }
test.each([
  ["/v1/messages", messages, "opencode"],
  ["/messages", messages, "opencode"],
  ["/v1/chat/completions", messages, "openai"],
  ["/v1/responses", { input: "Say ok" }, "codex"],
] as const)("records client attribution for %s without changing adapter selection", async (endpoint, body, adapter) => {
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  const installation = randomUUID()
  const expected = { adapter, client: { name: "voice-ai", version: "0.9.3", installation, device: "m4max" }, purpose: "test", status: 200 }
  try {
    const response = await proxy.app.fetch(new Request(`http://localhost${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meridian-client": "voice-ai/0.9.3",
        "x-meridian-installation": installation,
        "x-meridian-device": "m4max",
        "x-meridian-purpose": "test",
        "x-opencode-session": `ses_${installation}`,
      },
      body: JSON.stringify({ model: "claude-sonnet-5", stream: false, ...body }),
    }))
    expect(response.status).toBe(200)
    await response.json()
    const metric = telemetryStore.getRecent({ limit: 50 }).find(row => row.client?.installation === installation)
    expect(metric).toMatchObject(expected)

    const history = await proxy.app.fetch(new Request("http://localhost/telemetry/requests"))
    expect(history.status).toBe(200)
    const rows = await history.json() as RequestMetric[]
    expect(rows.find(row => row.requestId === metric?.requestId)).toMatchObject(expected)
  } finally {
    await proxy.closeBackend?.()
  }
})
