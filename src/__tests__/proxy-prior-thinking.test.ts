import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, blockStop, messageDelta, messageStart, messageStop, parseSSE, streamEvent, textBlockStart, textDelta, withMockSdkSessionId } from "./helpers"

let root: string
let capturedOptions: Options
let capturedPrompt: unknown
let nextId = 0
let failure: "startup" | "after-result" | undefined
const thought = { type: "thinking", thinking: "current thought", signature: "current signature" }
const visible = { type: "text", text: "answer" }
let projectDirectory = ""
// The CLI's own layout: projects/<cwd with non-alphanumerics as "-">/<id>.jsonl.
function path(id: string) { return join(projectDirectory, `${id}.jsonl`) }
installSdkMock(() => ({
  query: (params: { prompt: string | AsyncIterable<unknown>; options: Options }) => (async function* () {
    capturedOptions = params.options
    projectDirectory = join(root, "projects", String(params.options.cwd).replace(/[^a-zA-Z0-9]/g, "-"))
    if (failure === "startup") throw new Error("fixture startup failure")
    capturedPrompt = typeof params.prompt === "string" ? params.prompt : []
    if (typeof params.prompt !== "string") {
      const messages: unknown[] = []
      for await (const message of params.prompt) messages.push(message)
      capturedPrompt = messages
    }
    const prior = params.options.resume ? readFileSync(path(params.options.resume), "utf8") : ""
    const id = `api_${++nextId}`
    const content = [thought, visible]
    const assistant = assistantMessage(content)
    assistant.message.id = id
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path(params.options.sessionId!), prior + JSON.stringify({
      ...assistant, sessionId: params.options.sessionId, parentUuid: "parent",
    }) + "\n", { mode: 0o600 })
    const events = [messageStart(id), streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought.thinking } }),
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thought.signature } }), blockStop(0),
      textBlockStart(1), textDelta(1, visible.text), blockStop(1), messageDelta(), messageStop(), assistant]
    for (const event of events) yield withMockSdkSessionId(event, params.options)
    if (failure === "after-result") {
      yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [], num_turns: 1,
        uuid: crypto.randomUUID(), session_id: params.options.sessionId, duration_ms: 1, duration_api_ms: 1,
        total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] }
      throw new Error("fixture failure after canonical result")
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-prior-thinking.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const keys = ["MERIDIAN_DROP_PRIOR_THINKING", "CLAUDE_PROXY_DROP_PRIOR_THINKING", "CLAUDE_CONFIG_DIR", "MERIDIAN_PASSTHROUGH"]
let previous: Array<string | undefined>
beforeEach(() => {
  previous = keys.map(key => process.env[key])
  for (const key of keys) delete process.env[key]
  root = mkdtempSync(join(tmpdir(), "meridian-thinking-test-"))
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.MERIDIAN_PASSTHROUGH = "1"
  nextId = 0
  failure = undefined
  clearSessionCache()
})
afterEach(() => {
  keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
  rmSync(root, { recursive: true, force: true })
})
async function send(app: ReturnType<typeof createProxyServer>["app"], messages: unknown[]) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi", "x-session-affinity": "prune-test" },
    body: JSON.stringify({ model: "claude-opus-5-5", stream: true, max_tokens: 2048, thinking: { type: "adaptive" }, messages }),
  }))
  expect(response.status).toBe(200)
  const events = parseSSE(await response.text())
  expect(events.some(event => event.data.type === "content_block_delta" && (event.data.delta as { type?: string })?.type === "thinking_delta")).toBe(true)
  expect(events.some(event => event.data.type === "content_block_delta" && (event.data.delta as { type?: string })?.type === "signature_delta")).toBe(true)
  return capturedOptions.sessionId!
}
describe("drop prior thinking at the mocked SDK boundary", () => {
  for (const flag of ["MERIDIAN_DROP_PRIOR_THINKING", "CLAUDE_PROXY_DROP_PRIOR_THINKING", "off"]) {
    it(`${flag}: resumes, leaves source immutable and still streams thinking`, async () => {
      if (flag !== "off") process.env[flag] = "1"
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const first = [{ role: "user", content: "first" }]
      const id = await send(app, first)
      const source = readFileSync(path(id), "utf8")
      const second = [...first, { role: "assistant", content: [thought, visible] }, { role: "user", content: "next" }]
      const target = await send(app, second)
      expect(capturedOptions.resume).toBe(id)
      expect(capturedOptions.forkSession).toBe(true)
      expect(capturedOptions.thinking).toEqual({ type: "adaptive" })
      expect(readFileSync(path(id), "utf8")).toBe(source)
      const rows = readFileSync(path(target), "utf8").trim().split("\n").map(line => JSON.parse(line))
      expect(rows[0].message.content).toEqual(flag === "off" ? [thought, visible] : [visible])
      expect(rows[1].message.content).toEqual(flag === "off" ? [thought, visible] : [visible])
      const third = [...second, { role: "assistant", content: [thought, visible] }, { role: "user", content: "third" }]
      const last = await send(app, third)
      expect(capturedOptions.resume).toBe(target)
      const finalRows = readFileSync(path(last), "utf8").trim().split("\n").map(line => JSON.parse(line))
      expect(finalRows[0].message.content).toEqual(flag === "off" ? [thought, visible] : [visible])
    })
  }
  it("MERIDIAN false overrides the legacy opt-in", async () => {
    process.env.CLAUDE_PROXY_DROP_PRIOR_THINKING = "1"
    process.env.MERIDIAN_DROP_PRIOR_THINKING = "0"
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const first = [{ role: "user", content: "first" }]
    await send(app, first)
    const id = await send(app, [...first, { role: "assistant", content: [thought, visible] }, { role: "user", content: "next" }])
    expect(JSON.parse(readFileSync(path(id), "utf8").split("\n")[0]!).message.content).toEqual([thought, visible])
  })
  it("does not mask a startup failure with a missing transcript cleanup error", async () => {
    process.env.MERIDIAN_DROP_PRIOR_THINKING = "1"
    failure = "startup"
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 2048, stream: false, messages: [{ role: "user", content: "first" }] }),
    }))
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toContain("fixture startup failure")
    expect(body).not.toContain("locate owned SDK transcript")
  })
  it("prunes a durably completed target even when SDK throws after its canonical result", async () => {
    process.env.MERIDIAN_DROP_PRIOR_THINKING = "1"
    failure = "after-result"
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const id = await send(app, [{ role: "user", content: "first" }])
    expect(JSON.parse(readFileSync(path(id), "utf8").split("\n")[0]!).message.content).toEqual([visible])
  })
  it("fresh structured replay never reintroduces client-echoed thinking", async () => {
    process.env.MERIDIAN_DROP_PRIOR_THINKING = "1"
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await send(app, [{ role: "user", content: "old" }, { role: "assistant", content: [thought, visible] },
      { role: "user", content: [{ type: "text", text: "new" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }])
    expect(capturedOptions.resume).toBeUndefined()
    expect(Array.isArray(capturedPrompt)).toBe(true)
    expect(JSON.stringify(capturedPrompt)).not.toContain(thought.signature)
    expect(JSON.stringify(capturedPrompt)).not.toContain(thought.thinking)
    expect(JSON.stringify(capturedPrompt)).toContain(visible.text)
  })
})
