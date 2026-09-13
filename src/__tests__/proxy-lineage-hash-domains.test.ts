import { beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"
import { normalizeContent } from "../proxy/messages"

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
}), "proxy-lineage-hash-domains.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const { storeSharedSession } = await import("../proxy/sessionStore")
const result = (is_error: boolean) => ({ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error })
const text = (value: string) => ({ type: "text", text: value })
const cases: { name: string; stored: Message[]; incoming: Message[]; expected: string }[] = [
  { name: "text reinterpreted as a tool result", stored: [{ role: "user", content: [text("tool_result:call-1:ok")] }],
    incoming: [{ role: "user", content: [result(false)] }], expected: '"tool_use_id":"call-1"' },
  { name: "changed result error status", stored: [{ role: "user", content: [result(false)] }],
    incoming: [{ role: "user", content: [result(true)] }], expected: '"is_error":true' },
  { name: "injected aggregate message boundaries", stored: [{ role: "user", content: "one\nassistant:two" }, { role: "assistant", content: "three" }],
    incoming: [{ role: "user", content: "one" }, { role: "assistant", content: "two\nassistant:three" }], expected: "two\nassistant:three" },
  { name: "assistant rewritten as a user during append", stored: [{ role: "assistant", content: [text("ORIGINAL_ASSISTANT")] }],
    incoming: [{ role: "user", content: [text("ORIGINAL_ASSISTANT"), result(false)] }], expected: "ORIGINAL_ASSISTANT" },
]

describe("lineage hash integrity through HTTP", () => {
  beforeEach(() => { captured = []; clearSessionCache() })
  for (const stream of [false, true]) {
    async function post(app: ReturnType<typeof createProxyServer>["app"], key: string, messages: Message[]) {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
        body: JSON.stringify({ model: "haiku", stream, messages }),
      }))
      const body = await response.text()
      expect(response.status, body).toBe(200)
      if (stream) { expect(body).toContain("event: message_stop"); expect(body).not.toContain("event: error") }
    }

    for (const item of cases) {
      it(`replays ${item.name} (stream=${stream})`, async () => {
        const key = crypto.randomUUID()
        expect(storeSession(key, item.stored, "mock-source")).not.toBe(false)
        const { app } = createProxyServer({ silent: true })
        await post(app, key, [...item.incoming, { role: "assistant", content: "prior reply" }, { role: "user", content: "Explain the revised history." }])
        expect(captured).toHaveLength(1)
        expect(captured[0]!.options?.resume).toBeUndefined()
        expect(captured[0]!.prompt).toContain(item.expected)
      })
    }

    it(`migrates a legacy mapping once, preserving tool history before resuming (stream=${stream})`, async () => {
      const key = crypto.randomUUID()
      const history: Message[] = [
        { role: "user", content: "Look up the fixture" },
        { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "lookup", input: { fixture: "violet" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "EXACT_LEGACY_RESULT" }] },
      ]
      const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32)
      const messageStrings = history.map(message => `${message.role}:${normalizeContent(message.content)}`)
      expect(storeSharedSession(key, "legacy-source", history.length, digest(messageStrings.join("\n")),
        messageStrings.map(digest), undefined, undefined,
        history.map(message => (Array.isArray(message.content) ? message.content : [message.content])
          .map(block => digest(normalizeContent([block])))))).not.toBe(false)
      const { app } = createProxyServer({ silent: true })
      const messages = [...history, { role: "assistant", content: "prior answer" }, { role: "user", content: "Explain that fixture." }]
      await post(app, key, messages)
      expect(captured[0]!.options?.resume).toBeUndefined()
      expect(captured[0]!.prompt).toContain('"fixture":"violet"')
      expect(captured[0]!.prompt).toContain("EXACT_LEGACY_RESULT")
      await post(app, key, [...messages, { role: "assistant", content: "ok" }, { role: "user", content: "Continue." }])
      expect(captured).toHaveLength(2)
      expect(captured[1]!.options?.resume).toBe(captured[0]!.options?.sessionId)
      expect(captured[1]!.prompt).toContain("Continue.")
      expect(captured[1]!.prompt).not.toContain("EXACT_LEGACY_RESULT")
    })
  }
})
