import { beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"

type QueryInput = { prompt: unknown; options?: { sessionId?: string; resume?: string; resumeSessionAt?: string } }
let captured: QueryInput[] = []
installSdkMock(() => ({
  query: (input: QueryInput) => {
    captured.push(input)
    return (async function* () {
      for (const message of [messageStart(), textBlockStart(0), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop(), assistantMessage([{ type: "text", text: "ok" }])]) {
        yield withMockSdkSessionId(message, input.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-undo-gap.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const { diagnosticLog } = await import("../telemetry")
const original = Array.from({ length: 9 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant", content: `original ${index}`,
}))

describe("undo gap delivery over HTTP (#817)", () => {
  beforeEach(() => { captured = []; clearSessionCache(); diagnosticLog.clear() })
  for (const stream of [false, true]) {
    for (const gap of [false, true]) {
      it(`${gap ? "replays the edited intermediate turns" : "keeps ordinary rollback tail-only"} (stream=${stream})`, async () => {
        const key = `undo-gap-${crypto.randomUUID()}`
        storeSession(key, original, "sdk-source", undefined,
          original.map((message, index) => message.role === "assistant" ? `uuid-${index}` : null))
        const tail = { role: "user", content: "What is the marker?" }
        const messages = gap
          ? [...original.slice(0, 4), { role: "user", content: "The new marker is INDIGO_817" },
            { role: "assistant", content: "Acknowledged the replacement" }, tail]
          : [...original.slice(0, 4), tail]
        const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
        const response = await app.fetch(new Request("http://localhost/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json", "x-opencode-session": key },
          body: JSON.stringify({ model: "haiku", stream, messages }),
        }))
        expect(response.status).toBe(200)
        const body = await response.text()
        if (stream) {
          expect(body).toContain("event: message_stop")
          expect(body).not.toContain("event: error")
        }
        expect(captured).toHaveLength(1)
        expect(typeof captured[0]!.prompt).toBe("string")
        if (gap) {
          expect(captured[0]!.options?.resume).toBeUndefined()
          expect(captured[0]!.options?.resumeSessionAt).toBeUndefined()
          expect(captured[0]!.prompt).toContain("INDIGO_817")
          expect(captured[0]!.prompt).toContain("Acknowledged the replacement")
          expect(captured[0]!.prompt).toContain("original 0")
          const diagnostics = diagnosticLog.getRecent().map(entry => entry.message).join("\n")
          expect(diagnostics).toContain("reason=undo-gap")
          expect(diagnostics).not.toContain("INDIGO_817")
        } else {
          expect(captured[0]!.options?.resume).toBe("sdk-source")
          expect(captured[0]!.options?.resumeSessionAt).toBe("uuid-3")
          expect(captured[0]!.prompt).toBe(tail.content)
        }
      })
    }
  }
})
