/**
 * Integration tests for the passthrough early stop — full HTTP layer, mocked SDK.
 *
 * The mock counts how many messages the proxy actually CONSUMES from the SDK
 * stream. With early stop, consumption must halt at the deny tool_result —
 * the digest-turn message (turn 2) is never pulled, which in production means
 * the digest API call never generates (the billed waste this feature removes).
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"
import { assistantMessage, messageStart, toolUseBlockStart, inputJsonDelta, blockStop, messageDelta } from "./helpers"
import { PASSTHROUGH_CONTINUATION_LEAD_IN } from "../proxy/messages"

let mockMessages: any[] = []
let yieldedCount = 0
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yieldedCount++
        yield msg
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")

function userDenyMessage(toolUseId: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "forwarded to client", is_error: true }],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  }
}

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
}

async function post(app: any, body: any, sessionHeader = "es-session") {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": sessionHeader,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify(body),
  }))
}

describe("Integration: passthrough early stop", () => {
  let app: any
  let savedPassthrough: string | undefined
  let savedEarlyStop: string | undefined

  beforeAll(() => {
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1" })
    app = a
  })

  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    savedEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    process.env.MERIDIAN_PASSTHROUGH = "1"
    delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    mockMessages = []
    yieldedCount = 0
    capturedQueryParams = null
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedEarlyStop !== undefined) process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = savedEarlyStop
    else delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
  })

  it("non-stream: stops consuming at the deny — digest turn never pulled, abort fired", async () => {
    mockMessages = [
      assistantMessage([
        { type: "text", text: "Reading the file." },
        { type: "tool_use", id: "tu1", name: "read", input: { file_path: "/etc/hostname" } },
      ]),
      userDenyMessage("tu1"),
      assistantMessage([{ type: "text", text: "TURN2_GARBAGE_DIGEST" }]),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read /etc/hostname" }],
    })

    const body = await response.json() as any
    expect(response.status).toBe(200)
    expect(body.stop_reason).toBe("tool_use")
    const types = body.content.map((b: any) => b.type)
    expect(types).toContain("tool_use")
    expect(JSON.stringify(body.content)).not.toContain("TURN2_GARBAGE_DIGEST")
    // The money assertion: only turn 1 + the deny were consumed.
    expect(yieldedCount).toBe(2)
    // The proxy aborted the SDK query (kills the digest turn in production).
    expect(capturedQueryParams.options.abortController?.signal?.aborted).toBe(true)
  })

  it("non-stream: the early-stopped session is stored and the next turn resumes it", async () => {
    mockMessages = [
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("tu1"),
    ]
    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    }, "es-resume")
    expect(first.status).toBe(200)

    // Client executed the tool; extended conversation comes back.
    mockMessages = [assistantMessage([{ type: "text", text: "the file says hi" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "hi" }] },
      ],
    }, "es-resume")
    expect(second.status).toBe(200)
    // Resume proof: the SDK was invoked with the stored session id.
    expect(capturedQueryParams.options.resume).toBe("test-session")
  })

  it("non-stream: a deny-boundary continuation tells the model the end-turn deny is spent", async () => {
    // The fork puts the persisted deny — "do not generate further text, end
    // your turn now" — immediately before this delta, where it is the nearest
    // instruction in context. Live, the model obeyed it and returned an empty
    // text block with stop_reason end_turn, three times in 500 requests, each
    // on a session's second turn. The prompt has to say the deny is discharged.
    mockMessages = [
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("tu1"),
    ]
    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    }, "es-lead-in")
    expect(first.status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "the file says hi" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "hi" }] },
      ],
    }, "es-lead-in")
    expect(second.status).toBe(200)
    // Forked from the boundary, and the prompt carries the discharge.
    expect(capturedQueryParams.options.resumeSessionAt).toBeTruthy()
    const prompt = capturedQueryParams.prompt as string
    expect(prompt).toContain(PASSTHROUGH_CONTINUATION_LEAD_IN)
    // The tool result stays terminal — the lead-in is framing, not the answer.
    expect(prompt.indexOf(PASSTHROUGH_CONTINUATION_LEAD_IN)).toBeLessThan(prompt.indexOf("hi"))
  })

  it("non-stream: a plain resume with no deny boundary stays bare", async () => {
    // No forwarded tool call, so no deny is persisted and nothing needs
    // discharging — the delta must not grow a preamble on every ordinary turn.
    mockMessages = [assistantMessage([{ type: "text", text: "first answer" }])]
    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "just talk" }],
    }, "es-no-boundary")
    expect(first.status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "second answer" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "just talk" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "and again" },
      ],
    }, "es-no-boundary")
    expect(second.status).toBe(200)
    expect(capturedQueryParams.options.resume).toBe("test-session")
    expect(capturedQueryParams.prompt as string).not.toContain(PASSTHROUGH_CONTINUATION_LEAD_IN)
  })

  it("non-stream: waits for ALL parallel denies before stopping", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "tu1", name: "read", input: { file_path: "a" } },
        { type: "tool_use", id: "tu2", name: "grep", input: { pattern: "b" } },
      ]),
      userDenyMessage("tu1"),
      userDenyMessage("tu2"),
      assistantMessage([{ type: "text", text: "TURN2_GARBAGE_DIGEST" }]),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read a and grep b" }],
    })

    const body = await response.json() as any
    expect(response.status).toBe(200)
    // Both tool_use blocks reach the client — the first deny must not cut off tu2.
    const ids = body.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id)
    expect(ids).toContain("tu1")
    expect(ids).toContain("tu2")
    expect(yieldedCount).toBe(3) // turn1 + two denies; digest never pulled
  })

  it("non-stream: text-only answers are unaffected (no tool calls, no abort)", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "just an answer" }]),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "hi" }],
    })

    const body = await response.json() as any
    expect(response.status).toBe(200)
    expect(body.stop_reason).toBe("end_turn")
    expect(body.content[0].text).toBe("just an answer")
    expect(yieldedCount).toBe(1) // fully consumed (only 1 message)
    expect(capturedQueryParams.options.abortController?.signal?.aborted ?? false).toBe(false)
  })

  it("kill switch: MERIDIAN_PASSTHROUGH_EARLY_STOP=0 restores full drain", async () => {
    process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"
    mockMessages = [
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("tu1"),
      assistantMessage([{ type: "text", text: "digest" }]),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    })

    expect(response.status).toBe(200)
    expect(yieldedCount).toBe(3) // everything drained, old behavior
  })

  // #742: the early stop fires on deny-settlement alone. When the SDK surfaces a
  // wide parallel set as separate assistant turns, every deny the tracker KNOWS
  // about can settle while a LATER tool_use block is still mid-input_json_delta.
  // flushOpenClientBlocks then force-emits its content_block_stop, so the client
  // gets a well-formed envelope wrapped around TRUNCATED JSON — invisible as a
  // wire error, which is why the envelope audit (framing) never caught it.
  //
  // This asserts payload integrity, not framing: the property #675 missed when
  // it triaged the same race as "client impact: none".
  it("stream: does not truncate a still-streaming parallel tool_use when the deny settles first (#742)", async () => {
    const TAIL = "TAIL_OF_THE_PROMPT"
    mockMessages = [
      messageStart("msg_es"),
      // First tool: completes normally and is the only one the tracker sees.
      toolUseBlockStart(0, "read", "tu1"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      // Second parallel tool opens and is still mid-JSON...
      toolUseBlockStart(1, "read", "tu2"),
      inputJsonDelta(1, '{"file_path":"y","note":"HEAD_'),
      // ...when tu1's deny lands. Every tool the tracker knows about is now
      // denied, so the early stop fires with block 1 still open.
      userDenyMessage("tu1"),
      // The rest of tu2's JSON. Before the fix these are never forwarded.
      inputJsonDelta(1, TAIL + '"}'),
      blockStop(1),
      messageDelta("tool_use"),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x and y" }],
    })

    expect(response.status).toBe(200)
    const text = await response.text()

    // Reassemble each block's input the way a client does: accumulate
    // input_json_delta per block index, then parse.
    const perBlock = new Map<number, string>()
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue
      let evt: any
      try { evt = JSON.parse(line.slice(6)) } catch { continue }
      if (evt?.type !== "content_block_delta") continue
      if (evt.delta?.type !== "input_json_delta") continue
      perBlock.set(evt.index, (perBlock.get(evt.index) ?? "") + evt.delta.partial_json)
    }

    const blockOne = perBlock.get(1) ?? ""
    // The failure signature: the client sees the head but never the tail.
    expect(blockOne).toContain("HEAD_")
    expect(blockOne).toContain(TAIL)
    // And what it assembles must actually parse — the client-visible symptom
    // was InputValidationError on unparseable JSON.
    expect(() => JSON.parse(blockOne)).not.toThrow()
    expect(JSON.parse(blockOne).note).toBe("HEAD_" + TAIL)
  })

  it("stream: closes cleanly after the deny — digest events never consumed", async () => {
    mockMessages = [
      messageStart("msg_es"),
      toolUseBlockStart(0, "read", "tu1"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("tu1"),
      // digest turn events — must never be consumed:
      messageStart("msg_turn2"),
      assistantMessage([{ type: "text", text: "TURN2_GARBAGE_DIGEST" }]),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"type":"tool_use"')
    expect(text).toContain("message_stop")
    expect(text).not.toContain("TURN2_GARBAGE_DIGEST")

    // The client response completes at turn-1's stop_reason:"tool_use"; the
    // drain + abort continue in the background. Wait for the abort to land
    // before asserting consumption.
    const deadline = Date.now() + 2000
    while (
      !capturedQueryParams.options.abortController?.signal?.aborted &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(capturedQueryParams.options.abortController?.signal?.aborted).toBe(true)
    expect(yieldedCount).toBe(7) // up to and including the deny; turn-2 events never pulled
  })
})
