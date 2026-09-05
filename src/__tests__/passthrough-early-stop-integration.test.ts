/**
 * Integration tests for the passthrough early stop — full HTTP layer, mocked SDK.
 *
 * The mock counts how many messages the proxy consumes from the SDK stream.
 * Tool turns must close to the client at turn 1 while the proxy invisibly drains
 * the hidden digest through a canonical result; only then is the assistant UUID
 * known durable enough for resumeSessionAt.
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage, messageStart, textBlockStart, textDelta, toolUseBlockStart, inputJsonDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId } from "./helpers"

interface LifecycleResourceSnapshot {
  locator: { sessionId: string }
  state: string
}

let mockMessages: any[] = []
let yieldedCount = 0
let capturedQueryParams: any = null
let capturedQueryParamsAll: any[] = []
let mockTerminalError: Error | undefined
let forkSessionSequence = 0
let mockBaseSessionId = "test-session"
let mockReturnedSessionIdOverride: string | undefined
let mockOmitReturnedSessionId = false
const initialManagedSessionId = () => capturedQueryParamsAll[0]?.options?.sessionId ?? mockBaseSessionId

installSdkMock(() => ({
  query: (params: any) => {
    capturedQueryParams = params
    capturedQueryParamsAll.push(params)
    const terminalError = mockTerminalError
    const preHook = params?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    const returnedSessionId = mockReturnedSessionIdOverride
      ?? resolveMockSdkSessionId(params?.options, mockBaseSessionId)
    return (async function* () {
      let sawSyntheticDeny = false
      let sawResult = false
      const explicitlyHookedIds = new Set<string>()
      for (const msg of mockMessages) {
        yieldedCount++
        if (msg?.type === "test_pre_tool_hook") {
          explicitlyHookedIds.add(msg.tool_use_id)
          if (preHook) {
            await preHook({
              tool_name: msg.tool_name,
              tool_use_id: msg.tool_use_id,
              tool_input: msg.tool_input,
            }, undefined, { signal: new AbortController().signal })
          }
          continue
        }
        const { session_id: _ignoredSessionId, ...messageWithoutSessionId } = msg
        const delivered = {
          ...messageWithoutSessionId,
          ...(mockOmitReturnedSessionId ? {} : { session_id: returnedSessionId }),
        }
        if (delivered?.type === "user" && delivered?.message?.content?.some((b: any) => b?.type === "tool_result")) {
          sawSyntheticDeny = true
        }
        if (delivered?.type === "result") sawResult = true
        yield delivered
        if (preHook && delivered?.type === "assistant" && Array.isArray(delivered?.message?.content)) {
          for (const block of delivered.message.content) {
            // Explicit timing fixtures already invoked this hook before metadata.
            if (block?.type !== "tool_use" || explicitlyHookedIds.has(block.id)) continue
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
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          ...(mockOmitReturnedSessionId ? {} : { session_id: returnedSessionId }),
        }
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}), "passthrough-early-stop-integration.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")
const { clearSessionCache } = await import("../proxy/session/cache")
const { evictSharedSession, lookupSharedSession, setSessionStoreDir } = await import("../proxy/sessionStore")
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
const TEST_SESSION_DIR = mkdtempSync(join(tmpdir(), "meridian-early-stop-"))

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
}

const usedSessionKeys = new Set<string>()

async function waitForLifecycleState(sessionId: string, state: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const sidecar = JSON.parse(readFileSync(join(TEST_SESSION_DIR, "session-gc.json"), "utf8"))
    const resource = Object.values(sidecar.resources as Record<string, LifecycleResourceSnapshot>)
      .find((candidate) => candidate.locator.sessionId === sessionId)
    if (resource?.state === state) return
    await Bun.sleep(10)
  }
  throw new Error(`lifecycle resource ${sessionId} did not reach ${state}`)
}

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

/** Live Claude Code request: session identity in metadata.user_id, claude-cli
 * UA, and no x-opencode-session header. */
async function postClaudeCode(app: any, body: any, sessionId: string, extraHeaders: Record<string, string> = {}) {
  usedSessionKeys.add(sessionId)
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "user-agent": "claude-cli/2.1.259",
      ...extraHeaders,
    },
    body: JSON.stringify({
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      ...body,
    }),
  }))
}

describe("Integration: passthrough early stop", () => {
  let app: any
  let savedPassthrough: string | undefined
  let savedEarlyStop: string | undefined

  beforeAll(() => {
    setSessionStoreDir(TEST_SESSION_DIR)
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1" })
    app = a
  })

  afterAll(() => {
    setSessionStoreDir(null)
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true })
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
    forkSessionSequence = 0
    mockBaseSessionId = `test-session-${crypto.randomUUID()}`
    mockReturnedSessionIdOverride = undefined
    mockOmitReturnedSessionId = false
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

  it("replays and replaces a legacy user-denial boundary without a false conflict", async () => {
    const sessionHeader = "es-legacy-upgrade"
    const sessionKey = `${sessionHeader}-${TEST_RUN_ID}`
    usedSessionKeys.add(sessionKey)
    const now = Date.now()
    writeFileSync(join(TEST_SESSION_DIR, "sessions.json"), JSON.stringify({
      [sessionKey]: {
        claudeSessionId: "legacy-sdk-session",
        revision: 1,
        createdAt: now,
        lastUsedAt: now,
        messageCount: 1,
        lineageHash: "legacy-lineage",
        passthroughResumeUuid: "legacy-user-denial-uuid",
      },
    }))
    mockMessages = [assistantMessage([{ type: "text", text: "fresh replay" }])]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      messages: [{ role: "user", content: "continue after upgrade" }],
    }, sessionHeader)
    expect(response.status).toBe(200)
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(lookupSharedSession(sessionKey)?.claudeSessionId).toBe(initialManagedSessionId())
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
    expect(capturedQueryParams.options.resume).toBe(initialManagedSessionId())
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
    expect(capturedQueryParams.options.resume).toBe(initialManagedSessionId())
    expect(capturedQueryParams.options.resumeSessionAt).toBe(assistantForkUuid)
    expect(capturedQueryParams.options.resumeSessionAt).not.toBe(syntheticDeny.uuid)
    // The fork makes this rewind durable, replacing the persisted synthetic
    // denial tail with the client's real result in the new transcript.
    expect(capturedQueryParams.options.forkSession).toBe(true)

    const promptMessages: any[] = []
    for await (const message of capturedQueryParams.prompt) promptMessages.push(message)
    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0].type).toBe("user")
    expect(promptMessages[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu1", content: "hi" },
    ])
  })

  it("non-stream: replays changed earlier history even when pending tool IDs match", async () => {
    const assistantToolTurn = assistantMessage([
      { type: "tool_use", id: "tu-envelope", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [assistantToolTurn, userDenyMessage("tu-envelope")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    }, "es-envelope-drift")).status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "done" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: [{ type: "text", text: "inserted volatile prefix" }] },
        { role: "user", content: [{ type: "text", text: "volatile envelope changed" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu-envelope", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-envelope", content: "hi" }] },
      ],
    }, "es-envelope-drift")
    expect(second.status).toBe(200)
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.options.resumeSessionAt).toBeUndefined()
    expect(typeof capturedQueryParams.prompt).toBe("string")
    expect(capturedQueryParams.prompt).toContain("inserted volatile prefix")
    expect(capturedQueryParams.prompt).toContain("volatile envelope changed")
    expect(capturedQueryParams.prompt).toContain("hi")
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
    expect(resumed.options.resume).toBe(initialManagedSessionId())
    expect(resumed.options.resumeSessionAt).toBe(toolTurn.uuid)
    const promptMessages: any[] = []
    for await (const message of resumed.prompt) promptMessages.push(message)
    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "queued-tool", content: "X" },
      { type: "text", text: "also summarize it" },
    ])
  })

  it("stream: keeps the checkpoint when queued user text follows tool results", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "queued-stream-tool", name: "read", input: { file_path: "x" } },
    ])
    mockMessages = [
      messageStart("msg_queued_stream"),
      toolUseBlockStart(0, "read", "queued-stream-tool"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("queued-stream-tool"),
    ]
    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read x" }],
    }, "es-queued-stream-user")
    expect(first.status).toBe(200)
    await first.text()

    mockMessages = [
      messageStart("msg_queued_stream_reply"),
      textBlockStart(0),
      textDelta(0, "the file says X"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
      assistantMessage([{ type: "text", text: "the file says X" }]),
    ]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "queued-stream-tool", content: "X" }] },
        { role: "user", content: "also summarize it" },
      ],
    }, "es-queued-stream-user")
    expect(second.status).toBe(200)
    await second.text()

    const resumed = capturedQueryParamsAll[1]
    expect(resumed.options.resume).toBe(initialManagedSessionId())
    expect(resumed.options.resumeSessionAt).toBe(toolTurn.uuid)
    const promptMessages: any[] = []
    for await (const message of resumed.prompt) promptMessages.push(message)
    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "queued-stream-tool", content: "X" },
      { type: "text", text: "also summarize it" },
    ])
  })

  it("non-stream: forks every repeated checkpoint resume so delivered results replace deny tails", async () => {
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
    expect(secondQuery.options.resume).toBe(initialManagedSessionId())
    expect(secondQuery.options.resumeSessionAt).toBe(firstToolTurn.uuid)
    // resumeSessionAt alone rewinds only for this query. The source transcript
    // still ends in the persisted PreToolUse denial, so a later resume from the
    // newly produced assistant UUID serializes that marker in place of result A.
    // Forking makes the rewind durable: the new transcript appends result A and
    // subsequent assistant turns descend from the real client result.
    expect(secondQuery.options.forkSession).toBe(true)
    expect(secondQuery.options.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    const storedSecond = lookupSharedSession(`es-repeated-boundary-${TEST_RUN_ID}`)
    expect(storedSecond?.claudeSessionId).toBe(secondQuery.options.sessionId)
    expect(storedSecond?.previousClaudeSessionId).toBe(initialManagedSessionId())
    expect(storedSecond?.currentTranscript?.sessionId).toBe(secondQuery.options.sessionId)
    expect(storedSecond?.previousTranscript?.sessionId).toBe(initialManagedSessionId())
    const secondSidecar = JSON.parse(readFileSync(join(TEST_SESSION_DIR, "session-gc.json"), "utf8"))
    const targetResource = Object.values(secondSidecar.resources as Record<string, any>)
      .find((resource) => resource.locator.sessionId === secondQuery.options.sessionId)
    expect(targetResource?.state).toBe("live")
    const secondPrompt: any[] = []
    for await (const message of secondQuery.prompt) secondPrompt.push(message)
    expect(secondPrompt[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu-round-1", content: "A" },
    ])

    const thirdToolTurn = assistantMessage([
      { type: "tool_use", id: "tu-round-3", name: "read", input: { file_path: "c" } },
    ])
    mockMessages = [thirdToolTurn, userDenyMessage("tu-round-3")]
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
    expect(thirdQuery.options.resume).toBe(secondQuery.options.sessionId)
    expect(thirdQuery.options.resumeSessionAt).toBe(secondToolTurn.uuid)
    // Every tool boundary has its own synthetic denial tail. Repeating the fork
    // is what keeps result B durable as the chain grows beyond three resumes.
    expect(thirdQuery.options.forkSession).toBe(true)
    expect(thirdQuery.options.sessionId).not.toBe(secondQuery.options.sessionId)
    const thirdPrompt: any[] = []
    for await (const message of thirdQuery.prompt) thirdPrompt.push(message)
    expect(thirdPrompt[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu-round-2", content: "B" },
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
        { role: "assistant", content: [{ type: "tool_use", id: "tu-round-3", name: "read", input: { file_path: "c" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-round-3", content: "C" }] },
      ],
    }, "es-repeated-boundary")).status).toBe(200)
    const fourthQuery = capturedQueryParamsAll[3]
    expect(fourthQuery.options.resume).toBe(thirdQuery.options.sessionId)
    expect(fourthQuery.options.resumeSessionAt).toBe(thirdToolTurn.uuid)
    expect(fourthQuery.options.forkSession).toBe(true)
    const fourthPrompt: any[] = []
    for await (const message of fourthQuery.prompt) fourthPrompt.push(message)
    expect(fourthPrompt[0].message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu-round-3", content: "C" },
    ])
  })


  it("non-stream: rejects a fresh SDK session ID contradiction and retires both identities", async () => {
    const wrongSessionId = `wrong-fresh-${crypto.randomUUID()}`
    mockReturnedSessionIdOverride = wrongSessionId
    mockMessages = [assistantMessage([{ type: "text", text: "must not publish" }])]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      messages: [{ role: "user", content: "fresh id mismatch" }],
    }, "es-fresh-id-mismatch")
    expect(response.status).toBe(500)
    expect(await response.text()).toContain("Managed SDK fork returned")

    const targetId = capturedQueryParamsAll[0]?.options?.sessionId
    expect(targetId).toMatch(/^[0-9a-f-]{36}$/)
    expect(lookupSharedSession(`es-fresh-id-mismatch-${TEST_RUN_ID}`)).toBeUndefined()
    const sidecar = JSON.parse(readFileSync(join(TEST_SESSION_DIR, "session-gc.json"), "utf8"))
    const resources = Object.values(sidecar.resources as Record<string, LifecycleResourceSnapshot>)
    expect(resources.find((resource) => resource.locator.sessionId === targetId)?.state).toBe("retired")
    expect(resources.find((resource) => resource.locator.sessionId === wrongSessionId)?.state).toBe("retired")
  })

  it("stream: rejects a fresh SDK session ID contradiction without publishing it", async () => {
    const wrongSessionId = `wrong-fresh-stream-${crypto.randomUUID()}`
    mockReturnedSessionIdOverride = wrongSessionId
    mockMessages = [assistantMessage([{ type: "text", text: "must not publish" }])]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      messages: [{ role: "user", content: "fresh stream id mismatch" }],
    }, "es-fresh-stream-id-mismatch")
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).not.toContain("must not publish")
    expect(lookupSharedSession(`es-fresh-stream-id-mismatch-${TEST_RUN_ID}`)).toBeUndefined()

    const targetId = capturedQueryParamsAll[0]?.options?.sessionId
    await waitForLifecycleState(targetId, "retired")
    const sidecar = JSON.parse(readFileSync(join(TEST_SESSION_DIR, "session-gc.json"), "utf8"))
    const resources = Object.values(sidecar.resources as Record<string, LifecycleResourceSnapshot>)
    expect(resources.find((resource) => resource.locator.sessionId === targetId)?.state).toBe("retired")
    expect(resources.find((resource) => resource.locator.sessionId === wrongSessionId)?.state).toBe("retired")
  })

  it("non-stream: rejects an SDK fork ID mismatch without advancing the shared mapping", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "tu-id-mismatch", name: "read", input: { file_path: "a" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("tu-id-mismatch")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read for mismatch" }],
    }, "es-managed-id-mismatch")).status).toBe(200)

    // Keep 503 inside the opaque ID so this also proves error classification
    // does not mistake random UUID digits for an HTTP overload response.
    const wrongSessionId = "wrong-00000000-0000-4503-8000-000000000000"
    mockReturnedSessionIdOverride = wrongSessionId
    mockMessages = [assistantMessage([{ type: "text", text: "must not publish" }])]
    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read for mismatch" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu-id-mismatch", content: "A" },
        ] },
      ],
    }, "es-managed-id-mismatch")
    expect(response.status).toBe(500)
    expect(await response.text()).toContain("Managed SDK fork returned")

    const managedQuery = capturedQueryParamsAll[1]
    const targetId = managedQuery.options.sessionId
    expect(targetId).toMatch(/^[0-9a-f-]{36}$/)
    const stored = lookupSharedSession(`es-managed-id-mismatch-${TEST_RUN_ID}`)
    expect(stored?.claudeSessionId).toBe(initialManagedSessionId())
    expect(stored?.previousClaudeSessionId).toBeUndefined()
    const sidecar = JSON.parse(readFileSync(join(TEST_SESSION_DIR, "session-gc.json"), "utf8"))
    const resources = Object.values(sidecar.resources as Record<string, LifecycleResourceSnapshot>)
    const target = resources.find((resource) => resource.locator.sessionId === targetId)
    const unexpected = resources.find((resource) => resource.locator.sessionId === wrongSessionId)
    expect(target?.state).toBe("retired")
    expect(unexpected?.state).toBe("retired")
  })

  it("non-stream: rejects a managed fork that completes without a session ID", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "tu-id-missing", name: "read", input: { file_path: "a" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("tu-id-missing")]
    expect((await post(app, {
      model: "claude-sonnet-4-5", max_tokens: 400, stream: false, tools: [READ_TOOL],
      messages: [{ role: "user", content: "read without returned id" }],
    }, "es-managed-id-missing")).status).toBe(200)

    mockOmitReturnedSessionId = true
    mockMessages = [assistantMessage([{ type: "text", text: "must not publish" }])]
    const response = await post(app, {
      model: "claude-sonnet-4-5", max_tokens: 400, stream: false, tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read without returned id" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-id-missing", content: "A" }] },
      ],
    }, "es-managed-id-missing")
    expect(response.status).toBe(500)
    expect(await response.text()).toContain("no session ID")
    expect(lookupSharedSession(`es-managed-id-missing-${TEST_RUN_ID}`)?.claudeSessionId).toBe(initialManagedSessionId())
  })

  it("stream: rejects a managed fork that completes without a session ID", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "tu-stream-id-missing", name: "read", input: { file_path: "a" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("tu-stream-id-missing")]
    const first = await post(app, {
      model: "claude-sonnet-4-5", max_tokens: 400, stream: true, tools: [READ_TOOL],
      messages: [{ role: "user", content: "stream read without returned id" }],
    }, "es-stream-managed-id-missing")
    expect(first.status).toBe(200)
    await first.text()

    mockOmitReturnedSessionId = true
    mockMessages = [assistantMessage([{ type: "text", text: "must not publish" }])]
    const response = await post(app, {
      model: "claude-sonnet-4-5", max_tokens: 400, stream: true, tools: [READ_TOOL],
      messages: [
        { role: "user", content: "stream read without returned id" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-stream-id-missing", content: "A" }] },
      ],
    }, "es-stream-managed-id-missing")
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain("must not publish")
    expect(lookupSharedSession(`es-stream-managed-id-missing-${TEST_RUN_ID}`)?.claudeSessionId).toBe(initialManagedSessionId())
    const targetId = capturedQueryParamsAll[1].options.sessionId
    await waitForLifecycleState(targetId, "retired")
    const sidecar = JSON.parse(readFileSync(join(TEST_SESSION_DIR, "session-gc.json"), "utf8"))
    const target = Object.values(sidecar.resources as Record<string, any>)
      .find((resource) => resource.locator.sessionId === targetId)
    expect(target == null || target.state === "retired" || target.state === "tombstoned").toBe(true)
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

  it("non-stream: preserves queued user text when partial results force a fresh replay", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "partial-queued-1", name: "read", input: { file_path: "a" } },
      { type: "tool_use", id: "partial-queued-2", name: "read", input: { file_path: "b" } },
    ])
    mockMessages = [toolTurn, userDenyMessage("partial-queued-1"), userDenyMessage("partial-queued-2")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read both" }],
    }, "es-partial-queued-results")).status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "safe replay" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read both" },
        { role: "assistant", content: toolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "partial-queued-1", content: "A" }] },
        { role: "user", content: "keep this queued" },
      ],
    }, "es-partial-queued-results")).status).toBe(200)
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.options.resumeSessionAt).toBeUndefined()
    expect(typeof capturedQueryParams.prompt).toBe("string")
    expect(capturedQueryParams.prompt).toContain("keep this queued")
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

  it("non-stream: drops copied rollback UUIDs after a checkpoint fork", async () => {
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

    const forkOutput = assistantMessage([{ type: "text", text: "both read" }])
    mockMessages = [forkOutput]
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
    expect(capturedQueryParams.options.forkSession).toBe(true)
    const forkSessionId = capturedQueryParams.options.sessionId
    expect(forkSessionId).toMatch(/^[0-9a-f-]{36}$/)

    mockMessages = [assistantMessage([{ type: "text", text: "continued" }])]
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
        { role: "assistant", content: forkOutput.message.content },
        { role: "user", content: "continue after the fork" },
      ],
    }, "es-parallel-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resume).toBe(forkSessionId)
    expect(capturedQueryParams.options.resumeSessionAt).toBeUndefined()
    expect(capturedQueryParams.options.forkSession).toBe(true)

    const rewrittenBranch = [
      { role: "user", content: "read both for undo" },
      { role: "assistant", content: combinedToolTurn },
      { role: "user", content: "instead, take a different direction" },
      { role: "assistant", content: [{ type: "text", text: "branch draft" }] },
      { role: "user", content: "rewrite this branch" },
    ]
    mockMessages = [assistantMessage([{ type: "text", text: "changed direction" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: rewrittenBranch,
    }, "es-parallel-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.options.resumeSessionAt).toBeUndefined()
    expect(capturedQueryParams.options.forkSession).toBeUndefined()

    // The fresh replay above has the same message count as the cached fork
    // continuation. It must not inherit forkOutput.uuid from the older slot.
    mockMessages = [assistantMessage([{ type: "text", text: "changed again" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        ...rewrittenBranch.slice(0, 4),
        { role: "user", content: "rewrite this branch again" },
      ],
    }, "es-parallel-undo")).status).toBe(200)
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(capturedQueryParams.options.resumeSessionAt).toBeUndefined()
    expect(capturedQueryParams.options.forkSession).toBeUndefined()
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
    expect(capturedQueryParams.options.resume).toBe(initialManagedSessionId())
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
    expect(capturedQueryParamsAll[1].options.resume).toBe(initialManagedSessionId())
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
    expect(capturedQueryParams.options.forkSession).toBe(true)
  })

  // claude-cli with mid-conversation-system on ends a tool-result delta with a
  // trailing system reminder (assistant[tool_use] -> user[tool_result] ->
  // system[text]); the generic helpers reject role=system and forced a fresh
  // replay. The opt-in must resume and deliver the reminder as user text.
  const reminderCases = [false, true].flatMap(stream =>
    ["claude-code", "opencode"].flatMap(adapter =>
      ["unchanged", "revised", "inserted"].flatMap(historyChange =>
        [false, true].map(image => ({ stream, adapter, historyChange, image })))))
  for (const { stream, adapter, historyChange, image } of reminderCases) {
    it(`scopes trailing reminder checkpoint resume to Claude Code (adapter=${adapter}, stream=${stream}, historyChange=${historyChange}, image=${image})`, async () => {
      const sessionId = `cc-delta-${adapter}-${stream}-${historyChange}-${image}-${TEST_RUN_ID}`
      const resultContent = image
        ? [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "test-image" } }]
        : "hi"
      const headers = { "x-meridian-agent": adapter, "x-opencode-session": sessionId }
      const initialSystemText = "You are Claude Code, Anthropic's official CLI for Claude."
      const trailingSystemText = "<system-reminder>Total tokens: 4151</system-reminder>"
      const toolTurn = assistantMessage([
        { type: "tool_use", id: "cc-delta-tu1", name: "read", input: { file_path: "x" } },
      ])

      // Turn 1: initial user turn plus the system prompt as a text block with
      // cache_control — the captured request1 shape.
      mockMessages = [
        messageStart("msg_cc_delta_1"),
        toolUseBlockStart(0, "read", "cc-delta-tu1"),
        inputJsonDelta(0, '{"file_path":"x"}'),
        blockStop(0),
        messageDelta("tool_use"),
        toolTurn,
        userDenyMessage("cc-delta-tu1"),
        assistantMessage([{ type: "text", text: "CC_DELTA_GARBAGE_DIGEST" }]),
      ]
      const first = await postClaudeCode(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 400,
        stream,
        tools: [READ_TOOL],
        messages: [
          { role: "user", content: "read x" },
          { role: "system", content: [{ type: "text", text: initialSystemText, cache_control: { type: "ephemeral" } }] },
        ],
      }, sessionId, headers)
      expect(first.status).toBe(200)
      expect(await first.text()).not.toContain("CC_DELTA_GARBAGE_DIGEST")
      let stored: any
      for (let i = 0; i < 500 && !stored?.passthroughToolCallAssistantUuid; i++) {
        stored = lookupSharedSession(sessionId)
        if (!stored?.passthroughToolCallAssistantUuid) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(stored?.passthroughToolCallIds).toEqual(["cc-delta-tu1"])
      expect(stored?.passthroughToolCallAssistantUuid).toBe(toolTurn.uuid)

      // Turn 2: same prefix with the SAME system as an equivalent plain string
      // (the representation flip lineage canonicalizes), then the exact live
      // delta: echoed tool_use, real tool_result, trailing system reminder.
      mockMessages = [
        messageStart("msg_cc_delta_2"),
        textBlockStart(0),
        textDelta(0, "the file says hi"),
        blockStop(0),
        messageDelta("end_turn"),
        messageStop(),
        assistantMessage([{ type: "text", text: "the file says hi" }]),
      ]
      const requestId = `cc-delta-turn2-${TEST_RUN_ID}`
      const second = await postClaudeCode(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 400,
        stream,
        tools: [READ_TOOL],
        messages: [
          { role: "user", content: historyChange === "revised" ? "Read the fixture with revised earlier instructions." : "read x" },
          { role: "system", content: initialSystemText },
          ...(historyChange === "inserted" ? [{ role: "user", content: "Inserted instruction before the echoed call." }] : []),
          { role: "assistant", content: [{ type: "tool_use", id: "cc-delta-tu1", name: "read", input: { file_path: "x" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "cc-delta-tu1", content: resultContent }] },
          { role: "system", content: [{ type: "text", text: trailingSystemText, cache_control: { type: "ephemeral" } }] },
        ],
      }, sessionId, { ...headers, "x-request-id": requestId })
      expect(second.status).toBe(200)
      const secondBody = await second.text()
      expect(secondBody).toContain(stream ? "message_stop" : "end_turn")
      expect(secondBody).toContain("the file says hi")
      expect(secondBody).not.toContain("CC_DELTA_GARBAGE_DIGEST")

      if (adapter !== "claude-code" || historyChange !== "unchanged") {
        expect(capturedQueryParamsAll[1].options.resume).toBeUndefined()
        expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBeUndefined()
        const fresh = capturedQueryParamsAll[1]
        const inputs: unknown[] = []
        if (typeof fresh.prompt === "string") inputs.push(fresh.prompt)
        else for await (const message of fresh.prompt) inputs.push(message)
        const delivered = JSON.stringify(inputs)
        expect(delivered).toContain(trailingSystemText)
        expect(delivered).not.toContain(`[Assistant: ${trailingSystemText}]`)
        expect(delivered).toContain("</conversation_history>")
        if (historyChange === "revised") expect(delivered).toContain("revised earlier instructions")
        if (historyChange === "inserted") expect(delivered).toContain("Inserted instruction before the echoed call.")
        expect(JSON.stringify(fresh.options.systemPrompt)).not.toContain(trailingSystemText)
        return
      }

      // Resumed at the exact assistant checkpoint — not a fresh replay.
      const resumed = capturedQueryParamsAll[1]
      expect(resumed.options.resume).toBe(initialManagedSessionId())
      expect(resumed.options.resumeSessionAt).toBe(toolTurn.uuid)
      expect(resumed.options.forkSession).toBe(true)
      // No fresh-replay framing; the reminder never reaches the SDK system prompt.
      expect(secondBody).not.toContain("conversation_history")
      expect(JSON.stringify(resumed.options.systemPrompt ?? "")).not.toContain(trailingSystemText)
      // SDK prompt is exactly the native tool_result then the reminder as
      // ordinary user text, with cache_control stripped.
      expect(typeof resumed.prompt).not.toBe("string")
      const promptMessages: any[] = []
      for await (const message of resumed.prompt) promptMessages.push(message)
      expect(promptMessages).toHaveLength(1)
      expect(promptMessages[0].message.content).toEqual([
        { type: "tool_result", tool_use_id: "cc-delta-tu1", content: resultContent },
        { type: "text", text: trailingSystemText },
      ])

      let row: any
      for (let i = 0; i < 500 && !row; i++) {
        row = telemetryStore.getRecent({ limit: 200 }).find((m: any) => m.requestId === requestId)
        if (!row) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(row).toBeDefined()
      expect(row!.isResume).toBe(true)
    })
  }

  // Fail-closed twin: a second trailing system breaks the one-reminder
  // contract, so the continuation must fall back to a fresh replay.
  it("stream: two trailing system reminders fail closed to a fresh replay", async () => {
    const sessionId = `cc-delta-fc-${TEST_RUN_ID}`
    const initialSystemText = "You are Claude Code, Anthropic's official CLI for Claude."
    const firstReminder = "<system-reminder>Total tokens: 4151</system-reminder>"
    const secondReminder = "<system-reminder>Context low</system-reminder>"
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "cc-delta-fc-tu1", name: "read", input: { file_path: "x" } },
    ])

    // Turn 1 mirrors the accepted test: arm the checkpoint.
    mockMessages = [
      messageStart("msg_cc_delta_fc_1"),
      toolUseBlockStart(0, "read", "cc-delta-fc-tu1"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      toolTurn,
      userDenyMessage("cc-delta-fc-tu1"),
      assistantMessage([{ type: "text", text: "CC_DELTA_FC_GARBAGE_DIGEST" }]),
    ]
    const first = await postClaudeCode(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x" },
        { role: "system", content: [{ type: "text", text: initialSystemText, cache_control: { type: "ephemeral" } }] },
      ],
    }, sessionId)
    expect(first.status).toBe(200)
    await first.text()
    let stored: any
    for (let i = 0; i < 500 && !stored?.passthroughToolCallAssistantUuid; i++) {
      stored = lookupSharedSession(sessionId)
      if (!stored?.passthroughToolCallAssistantUuid) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(stored?.passthroughToolCallIds).toEqual(["cc-delta-fc-tu1"])

    // Turn 2: the accepted delta, but with TWO trailing system messages.
    mockMessages = [
      messageStart("msg_cc_delta_fc_2"),
      textBlockStart(0),
      textDelta(0, "fresh replay answer"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
      assistantMessage([{ type: "text", text: "fresh replay answer" }]),
    ]
    const requestId = `cc-delta-fc-turn2-${TEST_RUN_ID}`
    const second = await postClaudeCode(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read x" },
        { role: "system", content: initialSystemText },
        { role: "assistant", content: [{ type: "tool_use", id: "cc-delta-fc-tu1", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "cc-delta-fc-tu1", content: "hi" }] },
        { role: "system", content: [{ type: "text", text: firstReminder }] },
        { role: "system", content: [{ type: "text", text: secondReminder }] },
      ],
    }, sessionId, { "x-request-id": requestId })
    expect(second.status).toBe(200)
    expect(await second.text()).toContain("message_stop")

    // Rejected checkpoint: fresh replay, no resume options, reminders kept out of the system prompt.
    const replayed = capturedQueryParamsAll[1]
    expect(replayed.options.resume).toBeUndefined()
    expect(replayed.options.resumeSessionAt).toBeUndefined()
    expect(JSON.stringify(replayed.options.systemPrompt ?? "")).not.toContain(firstReminder)
    expect(JSON.stringify(replayed.options.systemPrompt ?? "")).not.toContain(secondReminder)

    let row: any
    for (let i = 0; i < 500 && !row; i++) {
      row = telemetryStore.getRecent({ limit: 200 }).find((m: any) => m.requestId === requestId)
      if (!row) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(row).toBeDefined()
    expect(row!.isResume).toBe(false)
  })

  // The gate is the adapter check in server.ts: the same wire shape on any
  // other adapter gets no opt-in and stays a fresh replay.
  it("stream: non-claude-code adapters never opt in — reminder shape stays a fresh replay", async () => {
    const toolTurn = assistantMessage([
      { type: "tool_use", id: "oc-gate-tu1", name: "read", input: { file_path: "x" } },
    ])

    // Turn 1 through the generic OpenCode adapter: arm the checkpoint.
    mockMessages = [toolTurn, userDenyMessage("oc-gate-tu1")]
    const first = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read gate x" }],
    }, "es-oc-gate")
    expect(first.status).toBe(200)
    await first.text()

    // Turn 2: the accepted shape, but this adapter carries no opt-in.
    mockMessages = [assistantMessage([{ type: "text", text: "continued" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read gate x" },
        { role: "assistant", content: [{ type: "tool_use", id: "oc-gate-tu1", name: "read", input: { file_path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "oc-gate-tu1", content: "hi" }] },
        { role: "system", content: [{ type: "text", text: "<system-reminder>Tokens: 4151</system-reminder>" }] },
      ],
    }, "es-oc-gate")
    expect(second.status).toBe(200)
    await second.text()
    expect(capturedQueryParamsAll[1].options.resume).toBeUndefined()
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBeUndefined()
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
    expect(capturedQueryParamsAll[1].options.resume).toBe(initialManagedSessionId())
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(finalFragment.uuid)
  })

  // The non-stream counterpart of the late-parallel-metadata case above.
  // Passthrough asks for partial messages on both paths, so non-stream has the
  // same turn boundary AND the same hazard: after message_delta the tracker
  // knows only the calls whose assistant fragments it has consumed, and a deny
  // arriving before the final fragment settles that partial set. Freezing there
  // hands the client a SUBSET of what the model called — the calls past the
  // checkpoint are dropped, not replayed, so nothing on the wire looks wrong.
  it("non-stream: waits for late parallel assistant metadata before freezing the checkpoint", async () => {
    const firstFragment = assistantMessage([
      { type: "tool_use", id: "ns-late-1", name: "read", input: { file_path: "a" } },
    ])
    const finalFragment = assistantMessage([
      { type: "tool_use", id: "ns-late-2", name: "read", input: { file_path: "b" } },
    ])
    mockMessages = [
      messageStart("msg_ns_late_parallel"),
      toolUseBlockStart(0, "read", "ns-late-1"),
      inputJsonDelta(0, '{"file_path":"a"}'),
      blockStop(0),
      toolUseBlockStart(1, "read", "ns-late-2"),
      inputJsonDelta(1, '{"file_path":"b"}'),
      blockStop(1),
      messageDelta("tool_use"),
      { type: "test_pre_tool_hook", tool_name: "read", tool_use_id: "ns-late-1", tool_input: { file_path: "a" } },
      { type: "test_pre_tool_hook", tool_name: "read", tool_use_id: "ns-late-2", tool_input: { file_path: "b" } },
      firstFragment,
      userDenyMessage("ns-late-1"),
      userDenyMessage("ns-late-2"),
      // Both results can arrive before the last assistant metadata fragment.
      // Settlement must recheck after this fragment extends the expected set.
      finalFragment,
    ]

    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read a and b" }],
    }, "es-ns-late-parallel")
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ type: string; id?: string }> }
    const toolUses = body.content.filter((block) => block.type === "tool_use")
    expect(toolUses.map((toolUse) => toolUse.id).sort()).toEqual(["ns-late-1", "ns-late-2"])

    mockMessages = [assistantMessage([{ type: "text", text: "both complete" }])]
    const second = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read a and b" },
        { role: "assistant", content: toolUses },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "ns-late-1", content: "A" },
          { type: "tool_result", tool_use_id: "ns-late-2", content: "B" },
        ] },
      ],
    }, "es-ns-late-parallel")
    expect(second.status).toBe(200)
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(finalFragment.uuid)
    expect(capturedQueryParamsAll[1].options.forkSession).toBe(true)
  })

  // The other half of the same gate. Above, the tracker lags the wire; here it
  // matches it exactly — but only because the turn has not finished emitting.
  // Settling on that agreement mid-generation freezes the checkpoint before the
  // remaining blocks exist, so the completeness oracle alone is not sufficient:
  // generation must also have ended.
  it("non-stream: does not freeze when the tracker matches the wire mid-generation", async () => {
    mockMessages = [
      messageStart("msg_ns_midgen"),
      toolUseBlockStart(0, "read", "ns-mid-1"),
      inputJsonDelta(0, '{"file_path":"a"}'),
      blockStop(0),
      // Armed and settled while the turn is still generating: at this point
      // expected and the streamed set agree on exactly {ns-mid-1}.
      assistantMessage([{ type: "tool_use", id: "ns-mid-1", name: "read", input: { file_path: "a" } }]),
      userDenyMessage("ns-mid-1"),
      // ...and only now does the second call reach the wire.
      toolUseBlockStart(1, "read", "ns-mid-2"),
      inputJsonDelta(1, '{"file_path":"b"}'),
      blockStop(1),
      messageDelta("tool_use"),
      assistantMessage([{ type: "tool_use", id: "ns-mid-2", name: "read", input: { file_path: "b" } }]),
      userDenyMessage("ns-mid-2"),
    ]

    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read a and b" }],
    }, "es-ns-midgen")
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ type: string; id?: string }> }
    const toolUses = body.content.filter((block) => block.type === "tool_use")
    expect(toolUses.map((toolUse) => toolUse.id).sort()).toEqual(["ns-mid-1", "ns-mid-2"])
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
    expect(capturedQueryParamsAll[1].options.resume).toBe(initialManagedSessionId())
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
    expect(capturedQueryParamsAll[1].options.resume).toBe(initialManagedSessionId())
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(toolTurn.uuid)
  })

  it("stream: a capped checkpoint fork does not store parent rollback UUIDs", async () => {
    const parentToolTurn = assistantMessage([
      { type: "tool_use", id: "capped-fork-parent", name: "read", input: { file_path: "parent" } },
    ])
    mockMessages = [parentToolTurn, userDenyMessage("capped-fork-parent")]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read parent then child" }],
    }, "es-capped-fork-map")).status).toBe(200)

    const forkToolTurn = assistantMessage([
      { type: "tool_use", id: "capped-fork-child", name: "read", input: { file_path: "child" } },
    ])
    mockMessages = [
      messageStart("msg_capped_fork_child"),
      toolUseBlockStart(0, "read", "capped-fork-child"),
      inputJsonDelta(0, '{"file_path":"child"}'),
      blockStop(0),
      messageDelta("tool_use"),
      forkToolTurn,
      userDenyMessage("capped-fork-child"),
      { type: "result", subtype: "error_max_turns", is_error: true },
    ]
    mockTerminalError = new Error("Claude Code returned an error result: Reached maximum number of turns (1)")
    const forkRequestId = `capped-fork-map-${TEST_RUN_ID}`
    const forked = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read parent then child" },
        { role: "assistant", content: parentToolTurn.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "capped-fork-parent", content: "P" }] },
      ],
    }, "es-capped-fork-map", { "x-request-id": forkRequestId })
    expect(forked.status).toBe(200)
    expect(await forked.text()).toContain('"type":"tool_use"')
    expect(capturedQueryParamsAll[1].options.resume).toBe(initialManagedSessionId())
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBe(parentToolTurn.uuid)
    expect(capturedQueryParamsAll[1].options.forkSession).toBe(true)
    let forkRow: any
    for (let i = 0; i < 500 && !forkRow; i++) {
      forkRow = telemetryStore.getRecent({ limit: 200 }).find((row: any) => row.requestId === forkRequestId)
      if (!forkRow) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(forkRow).toBeDefined()

    mockTerminalError = undefined
    mockMessages = [assistantMessage([{ type: "text", text: "fresh branch" }])]
    expect((await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read parent then child" },
        { role: "assistant", content: parentToolTurn.message.content },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "capped-fork-parent", content: "different parent result" },
        ] },
      ],
    }, "es-capped-fork-map")).status).toBe(200)
    expect(capturedQueryParamsAll[2].options.resume).toBeUndefined()
    expect(capturedQueryParamsAll[2].options.resumeSessionAt).toBeUndefined()
    expect(capturedQueryParamsAll[2].options.forkSession).toBeUndefined()
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
    expect(capturedQueryParamsAll[1].options.resume).toBe(initialManagedSessionId())
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
  // its no-visible-output nudge, and under
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

  it("stream: withholds the terminal tool checkpoint until the canonical drain is published", async () => {
    mockMessages = [
      messageStart("msg_es"),
      toolUseBlockStart(0, "read", "tu1"),
      inputJsonDelta(0, '{"file_path":"x"}'),
      blockStop(0),
      messageDelta("tool_use"),
      assistantMessage([{ type: "tool_use", id: "tu1", name: "read", input: { file_path: "x" } }]),
      userDenyMessage("tu1"),
      // Hidden digest wire events are consumed but never enqueued. The terminal
      // pair is withheld until the exact managed target is durable.
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

    const durable = lookupSharedSession(`es-session-${TEST_RUN_ID}`)
    expect(durable?.claudeSessionId).toBe(capturedQueryParams.options.sessionId)
    expect(durable?.passthroughToolCallIds).toEqual(["tu1"])

    // Receiving message_stop proves digest/result draining and target
    // publication already completed.
    const deadline = Date.now() + 2000
    while (yieldedCount < 15 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(capturedQueryParams.options.abortController?.signal?.aborted ?? false).toBe(false)
    expect(yieldedCount).toBe(15)
  })

  it("stream: alternate second-message_start invalidates the source before terminal", async () => {
    const sessionHeader = "es-alt-boundary"
    mockMessages = [assistantMessage([{ type: "text", text: "seed" }])]
    const seed = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: false,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "seed" }],
    }, sessionHeader)
    await seed.text()
    const sourceSessionId = lookupSharedSession(`${sessionHeader}-${TEST_RUN_ID}`)?.claudeSessionId
    expect(sourceSessionId).toBeDefined()

    mockMessages = [
      messageStart("msg_alt_1"),
      toolUseBlockStart(0, "read", "tu-alt"),
      inputJsonDelta(0, '{"file_path":"alt"}'),
      blockStop(0),
      // Some SDK versions surface assistant + deny before the first tool-use
      // message_delta. The second message_start is then the drain boundary.
      assistantMessage([{ type: "tool_use", id: "tu-alt", name: "read", input: { file_path: "alt" } }]),
      userDenyMessage("tu-alt"),
      messageStart("msg_alt_2"),
      textBlockStart(0),
      textDelta(0, "HIDDEN_ALT_DIGEST"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
      assistantMessage([{ type: "text", text: "HIDDEN_ALT_DIGEST" }]),
    ]

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      stream: true,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "seed" },
        { role: "assistant", content: "seed" },
        { role: "user", content: "read alt" },
      ],
    }, sessionHeader)
    const text = await response.text()
    expect(capturedQueryParams.options.resume).toBe(sourceSessionId)
    expect(text).toContain('"id":"tu-alt"')
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(text).toContain("message_stop")
    expect(text).not.toContain("HIDDEN_ALT_DIGEST")

    // No durable checkpoint UUID was observed in this alternate ordering.
    // The old source must therefore be absent before message_stop is received,
    // forcing the client's next tool-result request to replay in full.
    expect(lookupSharedSession(`${sessionHeader}-${TEST_RUN_ID}`)).toBeUndefined()
  })
})
