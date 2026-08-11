/**
 * Announce-turn recovery through the HTTP layer, mocked SDK.
 *
 * The unit tests pin the classification window; this pins the wiring the
 * window depends on and that no unit can reach: the deny boundary must be
 * ARMED from the session cache (stored by the early stop of the previous
 * request), the recovery must ask with the announce nudge — not the silent
 * one, whose "no visible output" would be false — and the recovered text must
 * reach the client as normal deltas.
 *
 * Request 1 forwards a tool call and observes its deny (early stop stores the
 * boundary). Request 2 is the continuation that answers the tool results with
 * one short announce-shaped text and no tool calls — the live a342c863 shape.
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"
import {
  messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop,
  toolUseBlockStart, inputJsonDelta, assistantMessage,
} from "./helpers"
import { ANNOUNCE_TURN_NUDGE } from "../proxy/turnOutcome"

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

const DENY_UUID = "deny-boundary-uuid-1"

function userDenyMessage(toolUseId: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "forwarded to client", is_error: true }],
    },
    parent_tool_use_id: null,
    uuid: DENY_UUID,
    session_id: "test-session",
  }
}

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
}

/** Request 1's script: one forwarded tool call, then its persisted deny. */
const toolTurnThenDeny = () => [
  messageStart("msg_t1"),
  toolUseBlockStart(0, "read", "tu1"),
  inputJsonDelta(0, '{"file_path":"x"}'),
  blockStop(0),
  messageDelta("tool_use"),
  assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
  userDenyMessage("tu1"),
]

/** The live announce shape: one short text, no tool calls, clean end_turn. */
const announceTurn = (text: string) => [
  messageStart("msg_a1"),
  textBlockStart(0),
  textDelta(0, text),
  blockStop(0),
  messageDelta("end_turn"),
  messageStop(),
]

const recoveryTurn = (text: string) => [
  messageStart("msg_r1"),
  textBlockStart(0),
  textDelta(0, text),
  blockStop(0),
  messageDelta("end_turn"),
  messageStop(),
]

async function post(app: any, body: any, session: string) {
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

/** Run the boundary-arming request and wait for its background drain+abort. */
async function armDenyBoundary(app: any, session: string) {
  const first = await post(app, {
    model: "claude-sonnet-4-5",
    max_tokens: 400,
    stream: true,
    tools: [READ_TOOL],
    messages: [{ role: "user", content: "read x" }],
  }, session)
  expect(first.status).toBe(200)
  await first.text()
  const armingCall = queryCalls[queryCalls.length - 1]
  const deadline = Date.now() + 2000
  while (!armingCall.options.abortController?.signal?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(armingCall.options.abortController?.signal?.aborted).toBe(true)
}

/** The continuation body: the client returns tu1's result — 3 messages, inside
 *  the announce risk window. */
const continuationBody = {
  model: "claude-sonnet-4-5",
  max_tokens: 400,
  stream: true,
  tools: [READ_TOOL],
  messages: [
    { role: "user", content: "read x" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }] },
  ],
}

describe("announce-turn recovery", () => {
  let app: any
  let savedPassthrough: string | undefined
  let savedEarlyStop: string | undefined
  let savedRecovery: string | undefined

  beforeAll(() => {
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1" })
    app = a
  })

  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    savedEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    savedRecovery = process.env.MERIDIAN_SILENT_TURN_RECOVERY
    process.env.MERIDIAN_PASSTHROUGH = "1"
    delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    delete process.env.MERIDIAN_SILENT_TURN_RECOVERY
    queryCalls = []
    scripted = []
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedEarlyStop !== undefined) process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = savedEarlyStop
    else delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    if (savedRecovery !== undefined) process.env.MERIDIAN_SILENT_TURN_RECOVERY = savedRecovery
    else delete process.env.MERIDIAN_SILENT_TURN_RECOVERY
  })

  it("recovers an announce-only continuation with the announce nudge", async () => {
    scripted = [
      toolTurnThenDeny(),
      announceTurn("I'll start by auditing the current state and read the configs in parallel."),
      recoveryTurn("ANNOUNCE_RECOVERY_TEXT"),
    ]

    await armDenyBoundary(app, "ann-recover")
    const second = await post(app, continuationBody, "ann-recover")
    expect(second.status).toBe(200)
    const body = await second.text()

    expect(queryCalls.length).toBe(3)
    // The window is armed by the boundary the previous request stored.
    expect(queryCalls[1].options.resumeSessionAt).toBe(DENY_UUID)
    // The announce stall gets its own words — "no visible output" would be
    // false, the client saw the announcement.
    expect(queryCalls[2].prompt).toBe(ANNOUNCE_TURN_NUDGE)
    // The recovered answer reaches the client as a normal text delta.
    expect(body).toContain("ANNOUNCE_RECOVERY_TEXT")
  })

  it("leaves a long answer on the same boundary alone", async () => {
    scripted = [
      toolTurnThenDeny(),
      announceTurn("The audit is complete. ".repeat(30)),
      recoveryTurn("MUST_NOT_BE_REQUESTED"),
    ]

    await armDenyBoundary(app, "ann-long")
    const second = await post(app, continuationBody, "ann-long")
    const body = await second.text()

    expect(queryCalls.length).toBe(2)
    expect(body).not.toContain("MUST_NOT_BE_REQUESTED")
  })

  it("leaves a short text alone when there is no deny boundary", async () => {
    scripted = [
      announceTurn("Short but a real answer."),
      recoveryTurn("MUST_NOT_BE_REQUESTED"),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      messages: [{ role: "user", content: "quick question" }],
    }, "ann-fresh")
    const body = await response.text()

    expect(queryCalls.length).toBe(1)
    expect(body).not.toContain("MUST_NOT_BE_REQUESTED")
  })
})
