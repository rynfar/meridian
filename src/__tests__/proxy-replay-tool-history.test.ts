import { beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"

type Input = { prompt: string | AsyncIterable<{ message: { content: unknown } }>; options?: { sessionId?: string; resume?: string } }
let inputs: unknown[] = []
installSdkMock(() => ({
  query: (input: Input) => (async function* () {
    if (typeof input.prompt === "string") inputs.push(input.prompt)
    else for await (const row of input.prompt) inputs.push(row.message.content)
    for (const event of [messageStart(), textBlockStart(0), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop(), assistantMessage([{ type: "text", text: "ok" }])]) {
      yield withMockSdkSessionId(event, input.options)
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }), tool: () => ({}),
}), "proxy-replay-tool-history.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")

describe("fresh tool history through HTTP", () => {
  beforeEach(() => { inputs = []; clearSessionCache() })
  for (const stream of [false, true]) for (const image of [false, true]) {
    it(`preserves calls, arguments, result identity and errors (stream=${stream}, image=${image})`, async () => {
      const media = { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } }
      const call = { type: "tool_use", id: "call-preserved", name: "lookup", input: { room: "Deluxe", nested: { exact: "x".repeat(400) } } }
      const messages = [
        { role: "user", content: [{ type: "text", text: "Look this up" }, ...(image ? [media] : [])] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hidden", signature: "opaque" }, call] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: "EXACT_FAILURE_OUTPUT" }] },
      ]
      const { app } = createProxyServer({ silent: true })
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": crypto.randomUUID() },
        body: JSON.stringify({ model: "haiku", stream, messages }),
      }))
      expect(response.status).toBe(200)
      const body = await response.text()
      if (stream) expect(body).toContain("event: message_stop")
      const text = inputs.flatMap(input => typeof input === "string" ? [input] : Array.isArray(input)
        ? input.filter(block => block.type === "text").map(block => block.text) : []).join("\n")
      expect(text).toContain(call.id)
      expect(text).toContain(call.name)
      expect(text).toContain(JSON.stringify(call.input))
      expect(text).toContain('"is_error":true')
      expect(text).toContain("EXACT_FAILURE_OUTPUT")
      expect(text).not.toContain("hidden")
      expect(JSON.stringify(inputs)).not.toContain('"type":"tool_result"')
      if (image) expect(inputs.flat()).toContainEqual(media)
    })
  }
})
