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
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupSharedSession, setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"

let isolatedSessionDir = ""
beforeEach(() => {
  isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-http-test-"))
  setSessionStoreDir(isolatedSessionDir)
})
afterEach(async () => {
  // Request completion releases the cross-process lease asynchronously.
  await Bun.sleep(25)
  rmSync(isolatedSessionDir, { recursive: true, force: true })
})

let queryCalls: any[] = []
let scripted: any[][] = []
let mockBaseSessionId = "test-session"
let queryMutation: ((params: any) => void) | undefined
const initialManagedSessionId = () => queryCalls[0]?.options?.sessionId ?? mockBaseSessionId

import { resolveMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: any) => {
    queryCalls.push(params)
    queryMutation?.(params)
    const messages = scripted.shift() ?? []
    return (async function* () {
      const returnedSessionId = resolveMockSdkSessionId(params.options, mockBaseSessionId)
      const preHook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      const hookPromises: Promise<unknown>[] = []
      for (const m of messages) {
        if (m?.__preTool) {
          if (preHook) hookPromises.push(Promise.resolve(preHook({
            tool_name: m.name,
            tool_use_id: m.id,
            tool_input: m.input,
          }, undefined, { signal: new AbortController().signal })))
          continue
        }
        if (m?.__throw) {
          await Promise.allSettled(hookPromises)
          throw new Error("scripted recovery interruption")
        }
        yield { ...m, session_id: returnedSessionId }
      }
      await Promise.allSettled(hookPromises)
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk", name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}), "silent-turn-recovery.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
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
/** Same shape as `ev`, but stamped with the fork's session id — a recovery
 *  query runs with forkSession:true and the SDK answers under a NEW id. */
const forkEv = (event: any) => ({
  type: "stream_event", event, parent_tool_use_id: null,
  uuid: crypto.randomUUID(), session_id: "fork-session",
})
const forkTextBlock = (index: number, text: string) => [
  forkEv({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  forkEv({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
  forkEv({ type: "content_block_stop", index }),
]
const forkMsgEnd = () => [
  forkEv({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }),
  forkEv({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false },
]

const recoveryToolBlock = (index: number, id: string, path: string) => [
  forkEv({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "read", input: {} } }),
  forkEv({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: path }) } }),
  forkEv({ type: "content_block_stop", index }),
]
const recoveryAssistantTools = (ids: string[], uuid = crypto.randomUUID()) => ({
  type: "assistant",
  uuid,
  message: {
    role: "assistant",
    content: ids.map((id, index) => ({ type: "tool_use", id, name: "read", input: { file_path: `${index}.txt` } })),
  },
})
const recoveryDeny = (ids: string[]) => ({
  type: "user",
  message: {
    role: "user",
    content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "forwarded", is_error: true })),
  },
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
  tools: [{
    name: "read",
    description: "Read a file",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  }],
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
    queryMutation = undefined
    mockBaseSessionId = `test-session-${crypto.randomUUID()}`
  })

  afterEach(() => {
    if (savedSwitch !== undefined) process.env.MERIDIAN_SILENT_TURN_RECOVERY = savedSwitch
    else delete process.env.MERIDIAN_SILENT_TURN_RECOVERY
  })

  it("turns a thinking-only turn into a real answer the client receives", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [msgStart(), ...forkTextBlock(0, "Here is the summary."), ...forkMsgEnd()],
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

  it("does not publish a recovery fork that emitted text before throwing", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [forkEv({ type: "message_start", message: { id: "m2", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
       ...forkTextBlock(0, "partial answer"), { __throw: true }],
    ]
    const response = await post(app, REQUEST, "silent-partial-throw")
    const body = await read(response)
    expect(response.status).toBe(200)
    expect(body).not.toContain("partial answer")
    expect(lookupSharedSession("silent-partial-throw")?.claudeSessionId).toBe(initialManagedSessionId())
  })

  it("publishes and emits only a complete parallel recovery tool checkpoint", async () => {
    const toolIds = ["recovery-parallel-a", "recovery-parallel-b"]
    const assistantUuid = crypto.randomUUID()
    const terminal = forkMsgEnd()
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [forkEv({ type: "message_start", message: { id: "m2", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
       ...recoveryToolBlock(0, toolIds[0]!, "a.txt"),
       { __preTool: true, id: toolIds[0], name: "read", input: { file_path: "a.txt" } },
       ...recoveryToolBlock(1, toolIds[1]!, "b.txt"),
       { __preTool: true, id: toolIds[1], name: "read", input: { file_path: "b.txt" } },
       terminal[0], terminal[1], recoveryAssistantTools(toolIds, assistantUuid), recoveryDeny(toolIds), terminal[2]],
    ]
    const body = await read(await post(app, REQUEST, "silent-recovery-parallel"))
    expect(body).toContain(toolIds[0]!)
    expect(body).toContain(toolIds[1]!)
    const stored = lookupSharedSession("silent-recovery-parallel")
    expect(stored?.claudeSessionId).toBe(queryCalls[1].options.sessionId)
    expect(stored?.passthroughToolCallAssistantUuid).toBe(assistantUuid)
    expect(stored?.passthroughToolCallIds?.sort()).toEqual([...toolIds].sort())
  })

  it("does not emit or publish recovery tool calls when the recovery throws", async () => {
    const toolId = "recovery-tool-before-throw"
    const terminal = forkMsgEnd()
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [forkEv({ type: "message_start", message: { id: "m2", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
       ...recoveryToolBlock(0, toolId, "bad.txt"),
       { __preTool: true, id: toolId, name: "read", input: { file_path: "bad.txt" } },
       terminal[0], terminal[1], recoveryAssistantTools([toolId]), recoveryDeny([toolId]),
       { __throw: true }],
    ]
    const body = await read(await post(app, REQUEST, "silent-recovery-tool-throw"))
    expect(body).not.toContain(toolId)
    expect(lookupSharedSession("silent-recovery-tool-throw")?.claudeSessionId).toBe(initialManagedSessionId())
  })

  it("withholds recovery output when its durable publication loses the exact CAS", async () => {
    const sessionKey = `silent-recovery-cas-${crypto.randomUUID()}`
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [forkEv({ type: "message_start", message: { id: "m2", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
       ...forkTextBlock(0, "must stay unpublished"), ...forkMsgEnd()],
    ]
    queryMutation = () => {
      if (queryCalls.length !== 2) return
      queryMutation = undefined
      const current = lookupSharedSession(sessionKey)
      if (!current) throw new Error("missing mapping before recovery CAS race")
      // Another writer advances the exact durable generation after recovery
      // attached its source, but before the fork can publish.
      storeSharedSession(sessionKey, current.claudeSessionId)
    }

    const body = await read(await post(app, REQUEST, sessionKey))

    expect(queryCalls.length).toBe(2)
    expect(body).not.toContain("must stay unpublished")
    expect(lookupSharedSession(sessionKey)?.claudeSessionId).toBe(initialManagedSessionId())
  })

  // The recovery forks, so its answer lands in a NEW SDK session. storeSession
  // has already run against the pre-fork id by then, whose tail is the silent
  // turn — leaving the mapping there means the next request resumes the silence
  // and a tool call made during recovery comes back referencing a tool_use the
  // resumable session never saw.
  it("resumes the fork on the next turn, not the session that went silent", async () => {
    scripted = [
      [msgStart(), ...thinkingBlock(), ...emptyTextBlock(1), ...msgEnd()],
      [forkEv({ type: "message_start", message: { id: "m2", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
       ...forkTextBlock(0, "Recovered answer."), ...forkMsgEnd()],
      [msgStart(), ...textBlock(0, "Second turn."), ...msgEnd()],
    ]

    const first = await read(await post(app, REQUEST, "silent-fork-resume"))
    expect(first).toContain("Recovered answer.")

    // A follow-up on the same client session must resume the fork.
    await read(await post(app, {
      ...REQUEST,
      messages: [
        { role: "user", content: "summarise the tool output" },
        { role: "assistant", content: [{ type: "text", text: "Recovered answer." }] },
        { role: "user", content: "and the next one" },
      ],
    }, "silent-fork-resume"))

    expect(queryCalls.length).toBe(3)
    // The recovery itself forks off the silent session...
    expect(queryCalls[1].options.resume).toBe(initialManagedSessionId())
    expect(queryCalls[1].options.forkSession).toBe(true)
    // ...and the NEXT turn resumes the fork, which is where the answer lives.
    expect(queryCalls[2].options.resume).toBe(queryCalls[1].options.sessionId)
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
