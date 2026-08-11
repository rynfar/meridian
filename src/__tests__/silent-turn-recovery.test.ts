/**
 * Silent-turn recovery through the HTTP layer, mocked SDK.
 *
 * The unit tests pin the decision; this pins the wiring, which is where the
 * value is. A recovery that decides correctly and forwards nothing is worth
 * exactly nothing to the autonomous run it exists for.
 *
 * The mock's first query answers the way all three production incidents did —
 * thinking, then a text block with no delta in it — and its second query is the
 * recovery turn.
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"

let queryCalls: any[] = []
let scripted: any[][] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    queryCalls.push(params)
    const messages = scripted.shift() ?? []
    return (async function* () {
      for (const m of messages) yield m
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk", name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({
    type: "sdk", name: "opencode",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
}))

const { createProxyServer } = await import("../proxy/server")

const ev = (event: any) => ({
  type: "stream_event", event, parent_tool_use_id: null,
  uuid: crypto.randomUUID(), session_id: "test-session",
})
const msgStart = () => ev({
  type: "message_start",
  message: {
    id: "m1", type: "message", role: "assistant", content: [],
    model: "claude-sonnet-4-5-20250929", stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
})
const thinkingBlock = () => [
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deliberating" } }),
  ev({ type: "content_block_stop", index: 0 }),
]
/** A text block that never emits a delta — the exact production signature. */
const emptyTextBlock = (index: number) => [
  ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  ev({ type: "content_block_stop", index }),
]
const textBlock = (index: number, text: string) => [
  ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  ev({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
  ev({ type: "content_block_stop", index }),
]
const msgEnd = () => [
  ev({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }),
  ev({ type: "message_stop" }),
]

async function post(app: any, body: any, session = "silent-session") {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": session,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify(body),
  }))
}

const read = async (response: Response) => await response.text()

const REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 400,
  stream: true,
  messages: [{ role: "user", content: "summarise the tool output" }],
}

describe("silent-turn recovery", () => {
  let app: any
  let savedSwitch: string | undefined

  beforeAll(() => {
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1" })
    app = a
  })

  beforeEach(() => {
    savedSwitch = process.env.MERIDIAN_SILENT_TURN_RECOVERY
    delete process.env.MERIDIAN_SILENT_TURN_RECOVERY
    queryCalls = []
    scripted = []
  })

  afterEach(() => {
    if (savedSwitch !== undefined) process.env.MERIDIAN_SILENT_TURN_RECOVERY = savedSwitch
    else delete process.env.MERIDIAN_SILENT_TURN_RECOVERY
  })

  it("turns a thinking-only turn into a real answer the client receives", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [msgStart(), ...textBlock(0, "Here is the summary."), ...msgEnd()],
    ]

    const body = await read(await post(app, REQUEST, "silent-recovered"))

    expect(queryCalls.length).toBe(2)
    expect(body).toContain("Here is the summary.")
    // Recovery text must arrive as a normal text delta, or the client will not
    // render it however correct the recovery was.
    expect(body).toContain("text_delta")
  })

  it("asks the model in a way that discharges the instruction that silenced it", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [msgStart(), ...textBlock(0, "recovered"), ...msgEnd()],
    ]

    await read(await post(app, REQUEST, "silent-prompt"))

    const nudge = queryCalls[1].prompt as string
    expect(nudge.toLowerCase()).toContain("no visible output")
    expect(nudge.toLowerCase()).toContain("discharged")
  })

  it("forks instead of extending — an empty tail must not become the session", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [msgStart(), ...textBlock(0, "recovered"), ...msgEnd()],
    ]

    await read(await post(app, REQUEST, "silent-fork"))

    expect(queryCalls[1].options.forkSession).toBe(true)
    expect(queryCalls[1].options.resume).toBeTruthy()
  })

  it("leaves a productive turn alone — no second query, no extra spend", async () => {
    scripted = [[msgStart(), ...textBlock(0, "a normal answer"), ...msgEnd()]]

    const body = await read(await post(app, REQUEST, "silent-productive"))

    expect(queryCalls.length).toBe(1)
    expect(body).toContain("a normal answer")
  })

  it("gives up after one attempt rather than looping", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [msgStart(), ...emptyTextBlock(0), ...msgEnd()],
    ]

    await read(await post(app, REQUEST, "silent-once"))

    expect(queryCalls.length).toBe(2)
  })

  it("still answers the client when the recovery turn itself throws", async () => {
    scripted = [[msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()]]
    // No second script entry: the mock yields nothing, standing in for a
    // recovery that produced no content. The client must still get its
    // envelope rather than a 500.
    const response = await post(app, REQUEST, "silent-throws")
    const body = await read(response)

    expect(response.status).toBe(200)
    expect(body).toContain("message_stop")
  })

  it("kill switch keeps detection but skips the extra turn", async () => {
    process.env.MERIDIAN_SILENT_TURN_RECOVERY = "0"
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [msgStart(), ...textBlock(0, "must not be requested"), ...msgEnd()],
    ]

    const body = await read(await post(app, REQUEST, "silent-killswitch"))

    expect(queryCalls.length).toBe(1)
    expect(body).not.toContain("must not be requested")
  })
})
