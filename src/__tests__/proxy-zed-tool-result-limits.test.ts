/**
 * Oversized client tool results on the Zed path — full HTTP layer, mocked SDK.
 *
 * The regression: Zed's grep returned a 3.8 MB result (seven matches on a CSV
 * with multi-megabyte lines), the resumed SDK session received it verbatim and
 * every retry failed with "Prompt is too long". The proxy now replaces a
 * result above a fraction of the model's context window with a notice the
 * model reads as a failed call, on the structured resume continuation as well
 * as on a fresh text replay, and tells the person at the top of the answer.
 *
 * The SDK mock runs the PreToolUse hook for assistant tool_use blocks and
 * synthesizes the canonical result after a deny, which is what the passthrough
 * checkpoint store waits for before the next turn can resume.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParamsAll: any[] = []

installSdkMock(() => ({
  query: (params: any) => {
    capturedQueryParamsAll.push(params)
    const preHook = params?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    const sessionId = resolveMockSdkSessionId(params?.options, "zed-limits-session")
    return (async function* () {
      let sawDeny = false
      let sawResult = false
      for (const msg of mockMessages) {
        const delivered = { ...msg, session_id: sessionId }
        if (delivered.type === "user" && delivered.message?.content?.some((b: any) => b?.type === "tool_result")) sawDeny = true
        if (delivered.type === "result") sawResult = true
        yield delivered
        if (preHook && delivered.type === "assistant" && Array.isArray(delivered.message?.content)) {
          for (const block of delivered.message.content) {
            if (block?.type !== "tool_use") continue
            void Promise.resolve(preHook({
              tool_name: block.name,
              tool_use_id: block.id,
              tool_input: block.input,
            }, undefined, { signal: new AbortController().signal }))
          }
        }
      }
      // The canonical result is the persistence acknowledgement the checkpoint store waits for.
      if (sawDeny && !sawResult) yield { type: "result", subtype: "success", is_error: false, session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-zed-tool-result-limits.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")
const { clearSessionCache } = await import("../proxy/session/cache")
const { setSessionStoreDir } = await import("../proxy/sessionStore")

const TEST_SESSION_DIR = mkdtempSync(join(tmpdir(), "meridian-zed-limits-"))
const ZED_HEADERS = { "Content-Type": "application/json", "User-Agent": "Zed/1.25.3 (windows; x86_64)" }
const AGENT_SYSTEM = "You are the Zed agent.\n\nThe current project contains the following root directories:\n\n- `C:\\proj`"
const GREP_FUNCTION = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents",
    parameters: { type: "object", properties: { regex: { type: "string" } }, required: ["regex"] },
  },
}
const PAYLOAD = "PAYLOAD-START " + "0123456789abcdef".repeat(400) + " PAYLOAD-END" // ~6.4 KB
const NOTE_PREFIX = "[meridian] Withheld 1 tool result before they reached the model: grep 6 KB. Limit: 1 KB per result ("

function userDenyMessage(toolUseId: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "forwarded to client", is_error: true }] },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  }
}

const QUESTION = { role: "user", content: "find the duplicate ids" }
const TOOL_CALL = { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "grep", arguments: "{\"regex\":\"dup\"}" } }] }
const TOOL_RESULT = { role: "tool", tool_call_id: "toolu_1", content: PAYLOAD }

function zedRequest(app: any, threadId: string, messages: Array<Record<string, unknown>>, stream = false): Promise<Response> {
  return app.fetch(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: ZED_HEADERS,
    body: JSON.stringify({
      model: "claude-opus-5-5",
      stream,
      prompt_cache_key: threadId,
      messages: [{ role: "system", content: AGENT_SYSTEM }, ...messages],
      tools: [GREP_FUNCTION],
    }),
  }))
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

/** The assistant text an OpenAI stream carries, in order. */
function streamedText(sse: string): string {
  return sse.split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
    .join("")
}

/** The text of a tool_result block: the OpenAI translation carries a `tool`
 * message as a text-block array, a direct Anthropic client as a string. */
function resultText(block: { content: unknown }): string {
  if (typeof block.content === "string") return block.content
  return (block.content as Array<{ type?: string; text?: string }>)
    .map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n")
}

async function promptMessagesOf(params: any): Promise<any[]> {
  const prompt = params.prompt
  if (typeof prompt === "string") return [prompt]
  const messages: any[] = []
  for await (const message of prompt) messages.push(message)
  return messages
}

/** Turn 1: the model calls grep; the proxy forwards the call and stores the checkpoint. */
async function toolCallTurn(app: any, threadId: string): Promise<void> {
  mockMessages = [
    assistantMessage([{ type: "tool_use", id: "toolu_1", name: "grep", input: { regex: "dup" } }]),
    userDenyMessage("toolu_1"),
  ]
  const first = await zedRequest(app, threadId, [QUESTION])
  expect(first.status).toBe(200)
  const body = await first.json() as any
  expect(body.choices[0].finish_reason).toBe("tool_calls")
  expect(body.choices[0].message.tool_calls[0].function.name).toBe("grep")
}

describe("Zed: oversized client tool results", () => {
  let app: any
  let savedLimit: string | undefined
  let savedNote: string | undefined

  beforeAll(() => {
    setSessionStoreDir(TEST_SESSION_DIR)
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  afterAll(() => {
    setSessionStoreDir(null)
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    savedLimit = process.env.MERIDIAN_MAX_TOOL_RESULT_BYTES
    savedNote = process.env.MERIDIAN_NO_TOOL_RESULT_NOTE
    process.env.MERIDIAN_MAX_TOOL_RESULT_BYTES = "1000"
    delete process.env.MERIDIAN_NO_TOOL_RESULT_NOTE
    mockMessages = []
    capturedQueryParamsAll = []
  })

  afterEach(async () => {
    await clearSessionCache()
    if (savedLimit !== undefined) process.env.MERIDIAN_MAX_TOOL_RESULT_BYTES = savedLimit
    else delete process.env.MERIDIAN_MAX_TOOL_RESULT_BYTES
    if (savedNote !== undefined) process.env.MERIDIAN_NO_TOOL_RESULT_NOTE = savedNote
    else delete process.env.MERIDIAN_NO_TOOL_RESULT_NOTE
  })

  it("withholds an oversized result on the structured resume continuation and tells the person", async () => {
    const threadId = `thread-${randomUUID()}`
    await toolCallTurn(app, threadId)

    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const second = await zedRequest(app, threadId, [QUESTION, TOOL_CALL, TOOL_RESULT])
    expect(second.status).toBe(200)

    // Resume proof: the SDK was invoked with the stored session, and the
    // client's real tool_result block went through — with the notice instead
    // of the payload, marked as an error so the model narrows the call.
    const params = capturedQueryParamsAll[1]
    expect(typeof params.options.resume).toBe("string")
    const [prompt] = await promptMessagesOf(params)
    expect(prompt.type).toBe("user")
    const [result] = prompt.message.content
    expect(result.type).toBe("tool_result")
    expect(result.tool_use_id).toBe("toolu_1")
    expect(result.is_error).toBe(true)
    const text = resultText(result)
    expect(text).toContain("[Tool result withheld by the proxy] The `grep` result is 6 KB, above the 1 KB the proxy accepts for one result")
    expect(text).toContain("PAYLOAD-START") // a sample, bounded by the limit…
    expect(text).not.toContain("PAYLOAD-END") // …never the whole payload
    expect(text.length).toBeLessThan(2_000)

    const body = await second.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content.startsWith(NOTE_PREFIX)).toBe(true)
    expect(body.choices[0]!.message.content.endsWith("The model got a notice with a sample instead.\n\nok")).toBe(true)
  })

  it("puts the note first in a streamed answer", async () => {
    const threadId = `thread-${randomUUID()}`
    await toolCallTurn(app, threadId)

    mockMessages = [
      messageStart("msg_2"), textBlockStart(0), textDelta(0, "ok"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const second = await zedRequest(app, threadId, [QUESTION, TOOL_CALL, TOOL_RESULT], true)
    expect(second.status).toBe(200)
    const text = streamedText(await readAll(second))
    expect(text.startsWith(NOTE_PREFIX)).toBe(true)
    expect(text.endsWith("The model got a notice with a sample instead.\n\nok")).toBe(true)
    expect(text).not.toContain("PAYLOAD")
  })

  it("withholds an oversized result inside a fresh replay when no session is cached", async () => {
    // Zed sends the whole thread after a proxy restart: no cached session, so
    // the history is replayed as text into a fresh SDK session.
    mockMessages = [assistantMessage([{ type: "text", text: "done" }])]
    const res = await zedRequest(app, `thread-${randomUUID()}`, [QUESTION, TOOL_CALL, TOOL_RESULT, { role: "user", content: "e agora?" }])
    expect(res.status).toBe(200)

    expect(capturedQueryParamsAll).toHaveLength(1)
    expect(capturedQueryParamsAll[0].options.resume).toBeUndefined()
    const [prompt] = await promptMessagesOf(capturedQueryParamsAll[0])
    expect(typeof prompt).toBe("string")
    expect(prompt).toContain("[Tool result withheld by the proxy] The `grep` result is 6 KB")
    expect(prompt).toContain("e agora?")
    expect(prompt).toContain("PAYLOAD-START")
    expect(prompt).not.toContain("PAYLOAD-END")

    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content.startsWith(NOTE_PREFIX)).toBe(true)
    expect(body.choices[0]!.message.content.endsWith("done")).toBe(true)
  })

  it("stays silent when MERIDIAN_NO_TOOL_RESULT_NOTE is set, while the model still gets the notice", async () => {
    process.env.MERIDIAN_NO_TOOL_RESULT_NOTE = "1"
    mockMessages = [assistantMessage([{ type: "text", text: "quiet" }])]
    const res = await zedRequest(app, `thread-${randomUUID()}`, [QUESTION, TOOL_CALL, TOOL_RESULT, { role: "user", content: "e agora?" }])
    expect(res.status).toBe(200)
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe("quiet")
    const [prompt] = await promptMessagesOf(capturedQueryParamsAll[0])
    expect(prompt).toContain("[Tool result withheld by the proxy]")
  })

  it("passes a result under the limit through untouched, with no note", async () => {
    process.env.MERIDIAN_MAX_TOOL_RESULT_BYTES = "100000"
    const threadId = `thread-${randomUUID()}`
    await toolCallTurn(app, threadId)

    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const second = await zedRequest(app, threadId, [QUESTION, TOOL_CALL, TOOL_RESULT])
    expect(second.status).toBe(200)
    const [prompt] = await promptMessagesOf(capturedQueryParamsAll[1])
    expect(resultText(prompt.message.content[0])).toBe(PAYLOAD)
    expect(prompt.message.content[0].is_error).not.toBe(true)
    const body = await second.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe("ok")
  })
})
