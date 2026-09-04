import { beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"

type Message = { role: string; content: unknown }
type Input = { prompt: string | AsyncIterable<{ message: { content: unknown } }>; options?: { sessionId?: string; resume?: string } }
let captured: { prompt: string; options: Input["options"] }[] = []
installSdkMock(() => ({
  query: (input: Input) => (async function* () {
    let prompt = ""
    if (typeof input.prompt === "string") prompt = input.prompt
    else for await (const row of input.prompt) prompt += JSON.stringify(row.message.content)
    captured.push({ prompt, options: input.options })
    for (const event of [messageStart(), textBlockStart(0), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop(), assistantMessage([{ type: "text", text: "ok" }])]) {
      yield withMockSdkSessionId(event, input.options)
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }), tool: () => ({}),
}), "proxy-block-continuations.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const text = (value: string) => ({ type: "text", text: value })
const hook = (value: unknown) => text(`<user-prompt-submit-hook>${JSON.stringify(value)}</user-prompt-submit-hook>`)
const result = { type: "tool_result", tool_use_id: "read-1", content: "ALREADY_DELIVERED" }

describe("block continuations through HTTP", () => {
  beforeEach(() => { captured = []; clearSessionCache() })
  for (const stream of [false, true]) {
    async function post(app: ReturnType<typeof createProxyServer>["app"], key: string, messages: Message[], agent = "opencode") {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key,
          "x-session-affinity": key, "x-meridian-agent": agent },
        body: JSON.stringify({ model: "haiku", stream, messages }),
      }))
      const body = await response.text()
      expect(response.status, body).toBe(200)
      if (stream) { expect(body).toContain("event: message_stop"); expect(body).not.toContain("event: error") }
    }

    for (const image of [false, true]) {
      it(`sends only appended content despite an intervening hook (stream=${stream}, image=${image})`, async () => {
        const key = crypto.randomUUID()
        expect(storeSession(key, [{ role: "user", content: [result] }], "source")).not.toBe(false)
        const media = { type: "image", source: { type: "base64", media_type: "image/png", data: "NEW_IMAGE" } }
        const { app } = createProxyServer({ silent: true })
        await post(app, key, [{ role: "user", content: [result, hook({ continue: true }), text("APPENDED_TEXT"), ...(image ? [media] : [])] }])
        expect(captured[0]!.options?.resume).toBe("source")
        expect(captured[0]!.prompt).toContain("APPENDED_TEXT")
        expect(captured[0]!.prompt).not.toContain("ALREADY_DELIVERED")
        expect(captured[0]!.prompt).not.toContain("user-prompt-submit-hook")
        if (image) expect(captured[0]!.prompt).toContain("NEW_IMAGE")
      })
    }

    it(`replays a repeated result even after appended text (stream=${stream})`, async () => {
      const key = crypto.randomUUID()
      storeSession(key, [{ role: "user", content: [result] }], "source")
      const { app } = createProxyServer({ silent: true })
      await post(app, key, [{ role: "user", content: [result, text("APPENDED_TEXT"), { ...result, content: "DUPLICATED_RESULT" }] }])
      expect(captured[0]!.options?.resume).toBeUndefined()
      expect(captured[0]!.prompt).toContain("DUPLICATED_RESULT")
    })

    it(`replays an ordinary user message edit (stream=${stream})`, async () => {
      const key = crypto.randomUUID()
      storeSession(key, [{ role: "user", content: [text("ORIGINAL_TEXT")] }], "source")
      const { app } = createProxyServer({ silent: true })
      await post(app, key, [{ role: "user", content: [text("ORIGINAL_TEXT"), text("APPENDED_TEXT")] }])
      expect(captured[0]!.options?.resume).toBeUndefined()
      expect(captured[0]!.prompt).toContain("ORIGINAL_TEXT")
      expect(captured[0]!.prompt).toContain("APPENDED_TEXT")
    })

    it(`removes revoked meaningful content from the replayed input (stream=${stream})`, async () => {
      const key = crypto.randomUUID()
      storeSession(key, [{ role: "user", content: [text("ALPHA"), text("REMOVED_OVERRIDE")] }], "source")
      const { app } = createProxyServer({ silent: true })
      await post(app, key, [{ role: "user", content: [text("ALPHA")] }, { role: "assistant", content: "ok" }, { role: "user", content: "Explain." }])
      expect(captured[0]!.options?.resume).toBeUndefined()
      expect(captured[0]!.prompt).toContain("ALPHA")
      expect(captured[0]!.prompt).not.toContain("REMOVED_OVERRIDE")
    })

    for (const kind of ["recognized", "unknown", "other-adapter"] as const) {
      it(`handles ${kind} hook history with adapter-scoped rules (stream=${stream})`, async () => {
        const key = crypto.randomUUID()
        const block = hook(kind === "unknown" ? { continue: true, fixtureOverride: "BETA" } : { continue: true })
        const agent = kind === "other-adapter" ? "pi" : "opencode"
        const { app } = createProxyServer({ silent: true })
        await post(app, key, [{ role: "user", content: [block, text("ALPHA")] }], agent)
        expect(captured[0]!.prompt).toContain("user-prompt-submit-hook")
        await post(app, key, [{ role: "user", content: [text("ALPHA")] }, { role: "assistant", content: "ok" }, { role: "user", content: "CONTINUE" }], agent)
        if (kind === "recognized") {
          expect(captured[1]!.options?.resume).toBe(captured[0]!.options?.sessionId)
          expect(captured[1]!.prompt).not.toContain("ALPHA")
        } else {
          expect(captured[1]!.options?.resume).toBeUndefined()
          expect(captured[1]!.prompt).toContain("ALPHA")
        }
      })
    }
  }
})
