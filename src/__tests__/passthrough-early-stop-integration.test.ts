/**
 * Integration tests for the passthrough early stop — full HTTP layer, mocked SDK.
 *
 * The mock counts how many messages the proxy consumes from the SDK stream.
 * Tool turns must close to the client at turn 1 while the proxy invisibly drains
 * the hidden digest through a canonical result; only then is the assistant UUID
 * known durable enough for resumeSessionAt.
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"
import { assistantMessage, messageStart, textBlockStart, textDelta, toolUseBlockStart, inputJsonDelta, blockStop, messageDelta, messageStop } from "./helpers"

let mockMessages: any[] = []
let yieldedCount = 0
let capturedQueryParams: any = null
let capturedQueryParamsAll: any[] = []
let mockTerminalError: Error | undefined

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    capturedQueryParamsAll.push(params)
    const terminalError = mockTerminalError
    const preHook = params?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    return (async function* () {
      let sawSyntheticDeny = false
      let sawResult = false
      for (const msg of mockMessages) {
        yieldedCount++
        if (msg?.type === "test_pre_tool_hook") {
          if (preHook) {
            await preHook({
              tool_name: msg.tool_name,
              tool_use_id: msg.tool_use_id,
              tool_input: msg.tool_input,
            }, undefined, { signal: new AbortController().signal })
          }
          continue
        }
        if (msg?.type === "user" && msg?.message?.content?.some((b: any) => b?.type === "tool_result")) {
          sawSyntheticDeny = true
        }
        if (msg?.type === "result") sawResult = true
        yield msg
        if (preHook && msg?.type === "assistant" && Array.isArray(msg?.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type !== "tool_use") continue
            void Promise.resolve(preHook({
              tool_name: block.name,
              tool_use_id: block.id,
              tool_input: block.input,
            }, undefined, { signal: new AbortController().signal }))
          }
        }
      }
      if (terminalError) throw terminalError
      // Real SDK queries terminate with a result, and that boundary is the only
      // persistence acknowledgement the live PTY transport gave us. Most test
      // fixtures predate that distinction, so synthesize the canonical result
      // after tool-deny flows unless a fixture provided one explicitly.
      if (sawSyntheticDeny && !sawResult) {
        yieldedCount++
        yield { type: "result", subtype: "success", is_error: false, session_id: "test-session" }
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
const { clearSessionCache } = await import("../proxy/session/cache")
const { evictSharedSession } = await import("../proxy/sessionStore")
const { telemetryStore } = await import("../telemetry")

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

const TEST_RUN_ID = crypto.randomUUID()

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
}

const usedSessionKeys = new Set<string>()

async function post(app: any, body: any, sessionHeader = "es-session", extraHeaders: Record<string, string> = {}) {
  const sessionKey = `${sessionHeader}-${TEST_RUN_ID}`
  usedSessionKeys.add(sessionKey)
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": sessionKey,
      "user-agent": "opencode/1.0.0",
      ...extraHeaders,
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
    capturedQueryParamsAll = []
    mockTerminalError = undefined
  })

  afterEach(() => {
    for (const key of usedSessionKeys) evictSharedSession(key)
    usedSessionKeys.clear()
    clearSessionCache()
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedEarlyStop !== undefined) process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = savedEarlyStop
    else delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
  })

  it("non-stream: drains the hidden digest to a canonical result without leaking it", async () => {
    const hiddenDigest = assistantMessage([{ type: "text", text: "TURN2_GARBAGE_DIGEST" }])
    hiddenDigest.message.stop_reason = "end_turn"
    mockMessages = [
      assistantMessage([
        { type: "text", text: "Reading the file." },
        { type: "tool_use", id: "tu1", name: "read", input: { file_path: "/etc/hostname" } },
      ]),
      userDenyMessage("tu1"),
      hiddenDigest,
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
    // The hidden digest ends normally, but must not overwrite turn 1's wire contract.
    expect(body.stop_reason).toBe("tool_use")
    const types = body.content.map((b: any) => b.type)
    expect(types).toContain("tool_use")
    expect(JSON.stringify(body.content)).not.toContain("TURN2_GARBAGE_DIGEST")
    // Turn 1 + deny + hidden digest + canonical result were consumed.
    expect(yieldedCount).toBe(4)
    expect(capturedQueryParams.options.abortController?.signal?.aborted ?? false).toBe(false)
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

  it("non-stream: resumes at the assistant tool-use boundary with structured real results", async () => {
    const assistantToolTurn = assistantMessage([
      { type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } },
    ])
    const assistantForkUuid = assistantToolTurn.uuid
    const syntheticDeny = userDenyMessage("tu1")
    mockMessages = [assistantToolTurn, syntheticDeny]
    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    }, "es-assistant-boundary")
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
    }, "es-assistant-boundary")
    expect(second.status).toBe(200)

    // resumeSessionAt only accepts SDKAssistantMessage UUIDs. The synthetic
    // user denial is a discarded side branch, not the canonical checkpoint.
    expect(capturedQueryParams.options.resume).toBe("test-session")
    expect(capturedQueryParams.options.resumeSessionAt).toBe(assistantForkUuid)
    expect(capturedQueryParams.options.resumeSessionAt).not.toBe(syntheticDeny.uuid)
    // Normal passthrough continuation reuses the session ID. Forking is for
    // semantic branches (undo) or the bounded busy-session fallback only.
    expect(capturedQueryParams.options.forkSession).toBeUndefined()

    const promptMessages: any[] = []
    for await (const message of capturedQueryParams.prompt) promptMessages.push(message)
    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0].type).toBe("user")
    expect(promptMessages[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu1", content: "hi" },
    ])
  })

  it("non-stream: keeps the checkpoint when queued user text follows tool results", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "queued-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("queued-tool")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    }, "es-queued-user")).status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "the file says X" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "queued-tool", content: "X" }] },
        { role: "user", content: "also summarize it" },
      ],
    }, "es-queued-user")).status).toBe(200)

    const resumed = capturedQueryParamsAll[1]
    expect(resumed.options.resume).toBe("test-session")
    expect(resumed.options.resumeSessionAt).toBe(toolTurn.uuid)
    const promptMessages: any[] = []
    for await (const message of resumed.prompt) promptMessages.push(message)
    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "queued-tool", content: "X" },
      { type: "text", text: "also summarize it" },
    ])
  })

  it("non-stream: advances the assistant checkpoint across repeated tool rounds without forking", async () => {
    const firstToolTurn = assistantMessage([
      { type: "tool_use", id: "tu-round-1", name: "read", input: { file_path: "a" } },
    ])
    mockMessages = [firstToolTurn, userDenyMessage("tu-round-1")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read a" }],
    }, "es-repeated-boundary")).status).toBe(200)

    const secondToolTurn = assistantMessage([
      { type: "tool_use", id: "tu-round-2", name: "read", input: { file_path: "b" } },
    ])
    mockMessages = [secondToolTurn, userDenyMessage("tu-round-2")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read a" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu-round-1", name: "read", input: { file_path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-round-1", content: "A" }] },
      ],
    }, "es-repeated-boundary")).status).toBe(200)
    const secondQuery = capturedQueryParamsAll[1]
    expect(secondQuery.options.resume).toBe("test-session")
    expect(secondQuery.options.resumeSessionAt).toBe(firstToolTurn.uuid)
    expect(secondQuery.options.forkSession).toBeUndefined()
    const secondPrompt: any[] = []
    for await (const message of secondQuery.prompt) secondPrompt.push(message)
    expect(secondPrompt[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu-round-1", content: "A" },
    ])

    mockMessages = [assistantMessage([{ type: "text", text: "done" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read a" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu-round-1", name: "read", input: { file_path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-round-1", content: "A" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu-round-2", name: "read", input: { file_path: "b" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-round-2", content: "B" }] },
      ],
    }, "es-repeated-boundary")).status).toBe(200)
    const thirdQuery = capturedQueryParamsAll[2]
    expect(thirdQuery.options.resume).toBe("test-session")
    expect(thirdQuery.options.resumeSessionAt).toBe(secondToolTurn.uuid)
    expect(thirdQuery.options.forkSession).toBeUndefined()
    const thirdPrompt: any[] = []
    for await (const message of thirdQuery.prompt) thirdPrompt.push(message)
    expect(thirdPrompt[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu-round-2", content: "B" },
    ])
  })

  it("non-stream: falls back to a fresh replay for partial parallel results", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "partial-1", name: "read", input: { file_path: "a" } },
      { type: "tool_use", id: "partial-2", name: "read", input: { file_path: "b" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("partial-1"), userDenyMessage("partial-2")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read both" }],
    }, "es-partial-results")).status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "safe replay" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read both" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "partial-1", content: "A" }] },
      ],
    }, "es-partial-results")).status).toBe(200)
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.options.resumeSessionAt).toBeUndefined()
    expect(typeof capturedQueryParams.prompt).toBe("string")
  })

  it("non-stream: preserves a nested multimodal tool_result wrapper", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "image-result", name: "read", input: { file_path: "image.png" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("image-result")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read image" }],
    }, "es-image-result")).status).toBe(200)

    const nestedImage = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    }
    mockMessages = [assistantMessage([{ type: "text", text: "I see it" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read image" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "image-result", content: [nestedImage] }] },
      ],
    }, "es-image-result")).status).toBe(200)

    const promptMessages: any[] = []
    for await (const message of capturedQueryParams.prompt) promptMessages.push(message)
    expect(promptMessages[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "image-result", content: [nestedImage] },
    ])
  })

  it("non-stream: maps parallel SDK fragments to one final undo UUID", async () => {
    const firstFragment = assistantMessage([
      { type: "tool_use", id: "undo-parallel-1", name: "read", input: { file_path: "a" } },
    ])
    const finalFragment = assistantMessage([
      { type: "tool_use", id: "undo-parallel-2", name: "read", input: { file_path: "b" } },
    ])
    const combinedToolTurn = [...firstFragment.message.content, ...finalFragment.message.content]
    mockMessages = [
      firstFragment,
      finalFragment,
      userDenyMessage("undo-parallel-1"),
      userDenyMessage("undo-parallel-2"),
    ]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read both for undo" }],
    }, "es-parallel-undo")).status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "both read" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read both for undo" },
        { role: "assistant", content: combinedToolTurn },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "undo-parallel-1", content: "A" },
          { type: "tool_result", tool_use_id: "undo-parallel-2", content: "B" },
        ] },
      ],
    }, "es-parallel-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resumeSessionAt).toBe(finalFragment.uuid)
    expect(capturedQueryParams.options.forkSession).toBeUndefined()

    mockMessages = [assistantMessage([{ type: "text", text: "changed direction" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read both for undo" },
        { role: "assistant", content: combinedToolTurn },
        { role: "user", content: "instead, take a different direction" },
      ],
    }, "es-parallel-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resumeSessionAt).toBe(finalFragment.uuid)
    expect(capturedQueryParams.options.forkSession).toBe(true)

    // The first undo must retain UUIDs for the preserved prefix so another
    // branch from that prefix still rolls back to the final parallel fragment.
    mockMessages = [assistantMessage([{ type: "text", text: "changed again" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read both for undo" },
        { role: "assistant", content: combinedToolTurn },
        { role: "user", content: "take yet another direction" },
      ],
    }, "es-parallel-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resumeSessionAt).toBe(finalFragment.uuid)
    expect(capturedQueryParams.options.forkSession).toBe(true)
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
    expect(capturedQueryParams.prompt).toBe("and again")
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
    expect(yieldedCount).toBe(5) // turn1 + two denies + hidden digest + result
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

  it("kill switch restores the legacy full drain", async () => {
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
    expect(yieldedCount).toBe(4) // assistant + deny + digest + canonical result
  })

  it("non-stream: a producer-side digest hook queued before the visible deny is pruned", async () => {
    const visibleTurn = assistantMessage([
      { type: "tool_use", id: "visible-race-tool", name: "read", input: { file_path: "visible" } },
    ])
    const hiddenTurn = assistantMessage([
      { type: "tool_use", id: "hidden-race-tool", name: "read", input: { file_path: "hidden" } },
    ])
    mockMessages = [
      visibleTurn,
      // The producer can start the hidden turn and run its hook before the
      // consumer pulls the already-queued visible deny from the iterator.
      { type: "test_pre_tool_hook", tool_name: "read", tool_use_id: "hidden-race-tool", tool_input: { file_path: "hidden" } },
      userDenyMessage("visible-race-tool"),
      hiddenTurn,
      userDenyMessage("hidden-race-tool"),
    ]

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read visible only" }],
    }, "es-hidden-hook-race")
    const firstBody = await first.json() as any
    expect(first.status).toBe(200)
    expect(firstBody.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id)).toEqual([
      "visible-race-tool",
    ])

    mockMessages = [assistantMessage([{ type: "text", text: "visible result accepted" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read visible only" },
        { role: "assistant", content: firstBody.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "visible-race-tool", content: "VISIBLE" }] },
      ],
    }, "es-hidden-hook-race")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBe("test-session")
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(visibleTurn.uuid)
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).not.toBe(hiddenTurn.uuid)
  })

  it("hidden non-stream digest UUID does not replace the visible checkpoint", async () => {
    const visibleToolTurn = assistantMessage([
      { type: "tool_use", id: "kill-undo-tool", name: "read", input: { file_path: "x" } },
    ])
    const hiddenDigestTurn = assistantMessage([{ type: "text", text: "hidden digest" }])
    mockMessages = [visibleToolTurn, userDenyMessage("kill-undo-tool"), hiddenDigestTurn]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x for kill-switch undo" }],
    }, "es-kill-switch-undo")).status).toBe(200)

    // The hidden digest is drained internally and never belongs in the
    // client-echoed assistant message.
    const echoedAssistant = [...visibleToolTurn.message.content]
    mockMessages = [assistantMessage([{ type: "text", text: "continued" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x for kill-switch undo" },
        { role: "assistant", content: echoedAssistant },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "kill-undo-tool", content: "X" }] },
      ],
    }, "es-kill-switch-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resumeSessionAt).toBe(visibleToolTurn.uuid)
    expect(capturedQueryParams.options.resumeSessionAt).not.toBe(hiddenDigestTurn.uuid)
    expect(capturedQueryParams.options.forkSession).toBeUndefined()
  })

  it("stream: waits for late parallel assistant metadata before freezing the checkpoint", async () => {
    const firstFragment = assistantMessage([
      { type: "tool_use", id: "late-tu-1", name: "read", input: { file_path: "a" } },
    ])
    const finalFragment = assistantMessage([
      { type: "tool_use", id: "late-tu-2", name: "read", input: { file_path: "b" } },
    ])
    mockMessages = [
      messageStart("msg_late_parallel"),
      toolUseBlockStart(0, "read", "late-tu-1"),
      inputJsonDelta(0, '{"file_path":"a"}'),
      blockStop(0),
      toolUseBlockStart(1, "read", "late-tu-2"),
      inputJsonDelta(1, '{"file_path":"b"}'),
      blockStop(1),
      messageDelta("tool_use"),
      firstFragment,
      userDenyMessage("late-tu-1"),
      // The SDK can expose a deny before the final per-block assistant
      // metadata. This later fragment must extend, not follow, the checkpoint.
      finalFragment,
      userDenyMessage("late-tu-2"),
    ]

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read a and b" }],
    }, "es-late-parallel")
    expect(first.status).toBe(200)
    await first.text()

    mockMessages = [assistantMessage([{ type: "text", text: "both complete" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read a and b" },
        { role: "assistant", content: [
          { type: "tool_use", id: "late-tu-1", name: "read", input: { file_path: "a" } },
          { type: "tool_use", id: "late-tu-2", name: "read", input: { file_path: "b" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "late-tu-1", content: "A" },
          { type: "tool_result", tool_use_id: "late-tu-2", content: "B" },
        ] },
      ],
    }, "es-late-parallel")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBe("test-session")
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(finalFragment.uuid)
  })

  // #742: a deny can become iterator-visible while a later tool_use block is
  // still mid-input_json_delta. Freezing or closing solely from the tracker's
  // currently-known set can force-emit that block's content_block_stop, so the client
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
      // denied, while block 1 remains open and must continue streaming.
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

  it("stream: legacy early-stop kill switch evicts the consumer-broken tool tail", async () => {
    process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "kill-switch-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [
      messageStart("msg_kill_switch"),
      toolUseBlockStart(0, "read", "kill-switch-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("kill-switch-tool"),
      messageStart("msg_kill_switch_turn2"),
    ]

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x with early stop disabled" }],
    }, "es-stream-kill-switch")
    expect(first.status).toBe(200)
    await first.text()

    mockMessages = [assistantMessage([{ type: "text", text: "fresh after kill switch" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x with early stop disabled" },
        { role: "assistant", content: [{ type: "tool_use", id: "kill-switch-tool", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "kill-switch-tool", content: "X" }] },
      ],
    }, "es-stream-kill-switch")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBeUndefined()
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBeUndefined()
  })

  it("stream: evicts an UUID-less turn-2-suppressed tail instead of plain-resuming it", async () => {
    const assistantWithoutUuid = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "uuidless-tool", name: "read", input: { file_path: "x" } }],
      },
      session_id: "test-session",
    }
    mockMessages = [
      messageStart("msg_uuidless"),
      toolUseBlockStart(0, "read", "uuidless-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      assistantWithoutUuid,
      userDenyMessage("uuidless-tool"),
      messageStart("msg_uuidless_turn2"),
    ]

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x without a checkpoint" }],
    }, "es-uuidless-stream")
    expect(first.status).toBe(200)
    await first.text()

    mockMessages = [assistantMessage([{ type: "text", text: "fresh replay" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x without a checkpoint" },
        { role: "assistant", content: [{ type: "tool_use", id: "uuidless-tool", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "uuidless-tool", content: "X" }] },
      ],
    }, "es-uuidless-stream")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBeUndefined()
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBeUndefined()
  })

  it("stream: evicts the mapping when the hidden durability drain errors", async () => {
    mockMessages = [
      messageStart("msg_drain_error"),
      toolUseBlockStart(0, "read", "drain-error-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      assistantMessage([{ type: "tool_use", id: "drain-error-tool", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("drain-error-tool"),
    ]
    mockTerminalError = new Error("Claude Code process exited with code 1")

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x before a drain error" }],
    }, "es-stream-drain-error")
    expect(first.status).toBe(200)
    await first.text()

    mockTerminalError = undefined
    mockMessages = [assistantMessage([{ type: "text", text: "fresh replay" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x before a drain error" },
        { role: "assistant", content: [{ type: "tool_use", id: "drain-error-tool", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "drain-error-tool", content: "X" }] },
      ],
    }, "es-stream-drain-error")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBeUndefined()
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBeUndefined()
  })

  it("stream: preserves a settled checkpoint at the one-turn SDK boundary", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "single-turn-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [
      messageStart("msg_single_turn"),
      toolUseBlockStart(0, "read", "single-turn-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("single-turn-tool"),
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x once" }],
    }, "es-single-turn-boundary")
    expect(first.status).toBe(200)
    const firstBody = await first.text()
    expect(firstBody).toContain('"type":"tool_use"')

    mockTerminalError = undefined
    mockMessages = [assistantMessage([{ type: "text", text: "the file says X" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x once" },
        { role: "assistant", content: [{ type: "tool_use", id: "single-turn-tool", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "single-turn-tool", content: "X" }] },
      ],
    }, "es-single-turn-boundary")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBe("test-session")
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(toolTurn.uuid)
  })

  // The live SDK delivers its error result BEFORE the iterator throws — verified
  // against the real Agent SDK, which enqueues the result then replaces the exit
  // error with the result text. The fixture above omits that result, so it
  // exercises sawCanonicalResult=false; this one is the shape production
  // actually sees now that maxTurns is capped at 1.
  it("stream: stores the checkpoint when the capped stop delivers its result before throwing", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "capped-stream-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [
      messageStart("msg_capped_stream"),
      toolUseBlockStart(0, "read", "capped-stream-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("capped-stream-tool"),
      { type: "result", subtype: "error_max_turns", is_error: true, session_id: "test-session" },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x capped" }],
    }, "es-capped-stream")
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('"type":"tool_use"')
    expect(capturedQueryParamsAll[0].options.maxTurns).toBe(1)

    mockTerminalError = undefined
    mockMessages = [assistantMessage([{ type: "text", text: "the file says X" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x capped" },
        { role: "assistant", content: [{ type: "tool_use", id: "capped-stream-tool", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "capped-stream-tool", content: "X" }] },
      ],
    }, "es-capped-stream")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBe("test-session")
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(toolTurn.uuid)
  })

  it("non-stream: stores the checkpoint at the capped stop so the next turn resumes", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "capped-ns-tool", name: "read", input: { file_path: "y" } },
    ])
    mockMessages = [
      toolTurn,
      userDenyMessage("capped-ns-tool"),
      { type: "result", subtype: "error_max_turns", is_error: true, session_id: "test-session" },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read y capped" }],
    }, "es-capped-nonstream")
    expect(first.status).toBe(200)
    const firstJson = await first.json() as any
    expect(firstJson.stop_reason).toBe("tool_use")
    expect(firstJson.content.some((b: any) => b.type === "tool_use")).toBe(true)

    mockTerminalError = undefined
    mockMessages = [assistantMessage([{ type: "text", text: "the file says Y" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read y capped" },
        { role: "assistant", content: [{ type: "tool_use", id: "capped-ns-tool", name: "read", input: { file_path: "y" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "capped-ns-tool", content: "Y" }] },
      ],
    }, "es-capped-nonstream")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resume).toBe("test-session")
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(toolTurn.uuid)
  })

  // The capped stop routes every passthrough tool turn through the error
  // recovery path. That path must still report tokens: it is now the common
  // case, and a metric with null token columns would blind exactly the
  // dashboards used to watch passthrough spend.
  it("stream: records token usage for a capped tool turn", async () => {
    telemetryStore.clear()
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "capped-usage-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [
      messageStart("msg_capped_usage"),
      toolUseBlockStart(0, "read", "capped-usage-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("capped-usage-tool"),
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "test-session",
        usage: {
          input_tokens: 11,
          output_tokens: 66,
          cache_read_input_tokens: 4242,
          cache_creation_input_tokens: 7,
        },
      },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    // Correlate by request id. Ordering is NOT safe here: the capped turn drains
    // asynchronously after its stream closes, so an earlier test's drain can
    // land a row after this one starts — reading getRecent()[0] then picks up
    // the straggler and compares against the wrong turn's tokens.
    const requestId = `capped-usage-${TEST_RUN_ID}`
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x usage" }],
    }, "es-capped-usage", { "x-request-id": requestId })
    expect(res.status).toBe(200)
    await res.text()

    // The client stream closes at the tool boundary, so the response resolves
    // before the hidden drain reaches the capped stop and records the turn.
    // Wait for THIS turn's row rather than sampling the store too early.
    let row: any
    for (let i = 0; i < 500 && !row; i++) {
      row = telemetryStore.getRecent({ limit: 200 }).find((m: any) => m.requestId === requestId)
      if (!row) await new Promise((r) => setTimeout(r, 10))
    }
    expect(row).toBeDefined()
    expect(row!.outputTokens).toBe(66)
    expect(row!.cacheReadInputTokens).toBe(4242)
    expect(row!.cacheCreationInputTokens).toBe(7)
    expect(row!.inputTokens).toBe(11)
  })

  // The operator-facing usage line is how a capped tool turn's spend shows up
  // in `tail -f` on the proxy. It is emitted on the normal completion path
  // only, which the capped stop bypasses — so every tool turn would go quiet.
  it("stream: logs the usage line for a capped tool turn", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "capped-log-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [
      messageStart("msg_capped_log"),
      toolUseBlockStart(0, "read", "capped-log-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("capped-log-tool"),
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "test-session",
        usage: { input_tokens: 11, output_tokens: 66, cache_read_input_tokens: 4242 },
      },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    // Match on this turn's request id: a concurrently-draining turn from an
    // earlier test logs its own `usage:` line, and a bare substring search
    // would assert against whichever landed first.
    const requestId = `capped-logline-${TEST_RUN_ID}`
    const isMine = (l: string) => l.includes("usage:") && l.includes(requestId)
    const lines: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")) }
    try {
      const res = await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 400,
        stream: true,
        tools: [READ_TOOL],
        messages: [{ role: "user", content: "read x logline" }],
      }, "es-capped-logline", { "x-request-id": requestId })
      await res.text()
      for (let i = 0; i < 500 && !lines.some(isMine); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
    } finally {
      console.error = realError
    }

    const usageLine = lines.find(isMine)
    expect(usageLine).toBeDefined()
    expect(usageLine).toContain("output=66")
  })

  it("non-stream: logs the usage line for a capped tool turn", async () => {
    mockMessages = [
      assistantMessage([{ type: "tool_use", id: "capped-ns-log", name: "read", input: { file_path: "y" } }]),
      userDenyMessage("capped-ns-log"),
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "test-session",
        usage: { input_tokens: 9, output_tokens: 42, cache_read_input_tokens: 1234 },
      },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    const requestId = `capped-ns-logline-${TEST_RUN_ID}`
    const isMine = (l: string) => l.includes("usage:") && l.includes(requestId)
    const lines: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")) }
    let res: any
    try {
      res = await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 400,
        stream: false,
        tools: [READ_TOOL],
        messages: [{ role: "user", content: "read y logline" }],
      }, "es-capped-ns-logline", { "x-request-id": requestId })
      await res.json()
    } finally {
      console.error = realError
    }

    expect(res.status).toBe(200)
    const usageLine = lines.find(isMine)
    expect(usageLine).toBeDefined()
    expect(usageLine).toContain("output=42")
  })

  // ADVERSARIAL: the cap makes max_turns the ordinary terminal state, so a turn
  // that trips it with NOTHING captured must still produce a usable envelope.
  // This is reachable: a thinking-only turn makes the CLI take another turn for
  // its no-visible-output nudge (audit-token-spend.mjs counts these), and under
  // the cap that turn is refused. Before the cap it could not happen, because
  // the SDK had budget to finish. A 500 here is a hard user-visible regression.
  it("stream: a capped turn that captured no tool call does not fail the request", async () => {
    mockMessages = [
      messageStart("msg_capped_nothing"),
      assistantMessage([{ type: "thinking", thinking: "pondering", signature: "sig" }]),
      { type: "result", subtype: "error_max_turns", is_error: true, session_id: "test-session" },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "think only" }],
    }, "es-capped-nothing")
    expect(res.status).toBe(200)
    const body = await res.text()
    // The streaming path already degrades honestly (#768): the turn is reported
    // truncated, never as a clean finish. Pin that — a future change must not
    // quietly turn this into `end_turn`, which is the silent-turn shape.
    expect(body).toContain('"stop_reason":"max_tokens"')
    expect(body).not.toContain('"stop_reason":"end_turn"')
  })

  it("non-stream: a capped turn that captured no tool call does not fail the request", async () => {
    mockMessages = [
      assistantMessage([{ type: "thinking", thinking: "pondering", signature: "sig" }]),
      { type: "result", subtype: "error_max_turns", is_error: true, session_id: "test-session" },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")

    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "think only" }],
    }, "es-capped-nothing-ns")
    // Was a 500 before: a turn with content but no forwardable tool call is
    // answerable, so it must report truncation rather than dead-ending.
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.stop_reason).toBe("max_tokens")
    expect(json.stop_reason).not.toBe("end_turn")
  })

  // A turn that ends on its own never asks the SDK for a second turn, so the
  // cap is invisible to it. Verified against the live SDK: text-only at
  // maxTurns=1 returns subtype "success", not error_max_turns.
  it("passthrough: a text-only turn completes normally under the cap", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "no tools needed" }]),
      { type: "result", subtype: "success", is_error: false, session_id: "test-session" },
    ]

    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "just answer" }],
    }, "es-capped-text-only")
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.stop_reason).toBe("end_turn")
    expect(json.content[0].text).toBe("no tools needed")
    expect(capturedQueryParamsAll[0].options.maxTurns).toBe(1)
  })

  it("stream: closes at turn 1 while digest and canonical result drain invisibly", async () => {
    mockMessages = [
      messageStart("msg_es"),
      toolUseBlockStart(0, "read", "tu1"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("tu1"),
      // Hidden digest wire events are consumed but never enqueued after the
      // client controller closes. A closed enqueue must not break the drain.
      messageStart("msg_turn2"),
      textBlockStart(0),
      textDelta(0, "TURN2_GARBAGE_DIGEST"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
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

    // The client response completes at turn 1; digest/result draining continues
    // in the background and must not abort the SDK query.
    const deadline = Date.now() + 2000
    while (yieldedCount < 15 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(capturedQueryParams.options.abortController?.signal?.aborted ?? false).toBe(false)
    expect(yieldedCount).toBe(15)
  })
})
