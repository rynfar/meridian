/**
 * Over HTTP, in Oh My Pi's shape (pi adapter, `x-session-affinity`): a
 * reminder-only user message that disappeared from the client's history
 * resumes the stored SDK session instead of replaying the whole history.
 * See lineage-regroup.test.ts for the incident this reproduces.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, withMockSdkSessionId } from "./helpers"

type QueryInput = { prompt: unknown; options?: { resume?: string; resumeSessionAt?: string } }
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
}), "proxy-lineage-regroup.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
// Loaded after the mocks above are installed, which static imports would precede.

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const { diagnosticLog } = await import("../telemetry")

const text = (value: string) => ({ type: "text", text: value })
const user = (...blocks: string[]) => ({ role: "user", content: blocks.map(text) })
const assistant = (value: string) => ({ role: "assistant", content: [text(value)] })
const reminder = (body: string) => `<system-reminder>\n${body}\n</system-reminder>`

const head = [user("HEAD_MARKER start the work"), assistant("first part done"), user("continue"), assistant("second part done")]
const evalStateNote = user(reminder("eval kernel state: x = 1"))
const prompt = user(reminder("Today: 2026-11-07"), "polish, fix and create PR")
const stretchNote = user("Reply in stretchtext.")
const work = [assistant("checked the diff"), user("go on"), assistant("PR opened")]
const nextPrompt = user(reminder("Today: 2026-11-07"), "NEXT_MARKER update the changelog")

describe("regrouped user messages over HTTP (pi adapter)", () => {
  beforeEach(async () => { captured = []; await clearSessionCache(); diagnosticLog.clear() })

  for (const stream of [false, true]) {
    it(`resumes after a reminder-only message disappeared (stream=${stream})`, async () => {
      const key = `regroup-${crypto.randomUUID()}`
      // Stored before the client restart: the live history held the eval note.
      const stored = [...head, evalStateNote, prompt, stretchNote, ...work.slice(0, 2)]
      await storeSession(key, stored, "sdk-source", undefined,
        [...stored.map((message, index) => message.role === "assistant" ? `uuid-${index}` : null), "uuid-reply"])
      // After the restart: the note is gone, the stored turn's reply and a new prompt follow.
      const messages = [...head, prompt, stretchNote, ...work, nextPrompt]

      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-meridian-agent": "pi", "x-session-affinity": key },
        body: JSON.stringify({ model: "haiku", stream, max_tokens: 64, messages }),
      }))
      expect(response.status).toBe(200)
      const body = await response.text()
      if (stream) expect(body).not.toContain("event: error")

      // Before the fix: no resume, and the prompt replayed HEAD_MARKER onward.
      expect(captured).toHaveLength(1)
      expect(captured[0]!.options?.resume).toBe("sdk-source")
      expect(captured[0]!.options?.resumeSessionAt).toBeUndefined()
      const delivered = JSON.stringify(captured[0]!.prompt)
      expect(delivered).toContain("NEXT_MARKER")
      expect(delivered).not.toContain("HEAD_MARKER")
      const diagnostics = diagnosticLog.getRecent().map(entry => entry.message).join("\n")
      expect(diagnostics).toContain(`Regrouped user messages (key=${key.slice(0, 8)}…): 1 run, stored 9 -> incoming 8; resuming.`)
    })
  }
})
