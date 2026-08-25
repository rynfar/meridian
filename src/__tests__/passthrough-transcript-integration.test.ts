/**
 * Transcript repair at the call site — full HTTP layer, mocked SDK, real file.
 *
 * The unit suite proves the rewrite; this proves server.ts invokes it on the
 * checkpoint resume (resumeSessionAt set), where the CLI's loader would
 * otherwise splice the stale denial back beside the real result on the
 * following resume.
 *
 * The repair is gated on a checkpoint because that is the only resume a
 * passthrough tool turn can have: a turn without one — early stop off, or its
 * checkpoint refused — is evicted, never stored, so the next turn starts a
 * fresh session and the denial sits in a file that is never loaded again. The
 * second test pins that invariant; if a no-checkpoint tool turn ever becomes
 * resumable, the repair's gate has to widen with it.
 *
 * The fixture transcript lives under a temp CLAUDE_CONFIG_DIR, which is what
 * transcriptConfigDirs reads first, so no real session file is touched.
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SDK_SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

let mockMessages: any[] = []
let capturedQueryParamsAll: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParamsAll.push(params)
    const preHook = params?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    return (async function* () {
      let sawDeny = false
      for (const msg of mockMessages) {
        if (msg?.type === "user" && msg?.message?.content?.some((b: any) => b?.type === "tool_result")) sawDeny = true
        yield msg
        if (preHook && msg?.type === "assistant" && Array.isArray(msg?.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type !== "tool_use") continue
            void Promise.resolve(preHook({ tool_name: block.name, tool_use_id: block.id, tool_input: block.input }, undefined, { signal: new AbortController().signal }))
          }
        }
      }
      if (sawDeny) yield { type: "result", subtype: "success", is_error: false, session_id: SDK_SESSION }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
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
const { PASSTHROUGH_DENY_REASON } = await import("../proxy/passthroughTranscript")

const TEST_RUN_ID = crypto.randomUUID()
const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
}

function sdkAssistant(content: any[]) {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    session_id: SDK_SESSION,
    parent_tool_use_id: null,
    message: { id: `msg_${crypto.randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
  }
}

function sdkDeny(toolUseId: string) {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    session_id: SDK_SESSION,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: PASSTHROUGH_DENY_REASON, is_error: true }] },
  }
}

/** The JSONL the CLI would have written for the turn above: A(tool_use) U(denial). */
function writeFixture(configDir: string, toolUseId: string): string {
  const project = join(configDir, "projects", "C--some-cwd")
  mkdirSync(project, { recursive: true })
  const file = join(project, `${SDK_SESSION}.jsonl`)
  const rows = [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "read a" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "msg_1", content: [{ type: "tool_use", id: toolUseId, name: "read", input: { file_path: "a" } }] } },
    { type: "user", uuid: "d1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: true, content: PASSTHROUGH_DENY_REASON }] } },
    { type: "last-prompt", leafUuid: "d1", explicit: true },
  ]
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
  return file
}

function storedResult(file: string, toolUseId: string) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    .flatMap((r: any) => (Array.isArray(r.message?.content) ? r.message.content : []))
    .find((b: any) => b.type === "tool_result" && b.tool_use_id === toolUseId)
}

const usedSessionKeys = new Set<string>()
async function post(app: any, body: any, sessionHeader: string) {
  const sessionKey = `${sessionHeader}-${TEST_RUN_ID}`
  usedSessionKeys.add(sessionKey)
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "dummy", "x-opencode-session": sessionKey, "user-agent": "opencode/1.0.0" },
    body: JSON.stringify(body),
  }))
}

/** Turn 1 (one forwarded call, denied) then turn 2 delivering its result. */
async function twoTurns(app: any, sessionHeader: string, toolUseId: string) {
  mockMessages = [
    sdkAssistant([{ type: "tool_use", id: toolUseId, name: "read", input: { file_path: "a" } }]),
    sdkDeny(toolUseId),
  ]
  const first = await post(app, { model: "claude-sonnet-4-5", max_tokens: 400, stream: false, tools: [READ_TOOL], messages: [{ role: "user", content: "read a" }] }, sessionHeader)
  expect(first.status).toBe(200)
  await first.text()

  mockMessages = [sdkAssistant([{ type: "text", text: "done" }])]
  const second = await post(app, {
    model: "claude-sonnet-4-5", max_tokens: 400, stream: false, tools: [READ_TOOL],
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "read", input: { file_path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "REAL[alpha]" }] },
    ],
  }, sessionHeader)
  expect(second.status).toBe(200)
  await second.text()
  return capturedQueryParamsAll[1]
}

describe("Integration: transcript repair on resume", () => {
  let app: any
  const saved: Record<string, string | undefined> = {}
  let configDir: string

  beforeAll(() => {
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  beforeEach(() => {
    for (const k of ["MERIDIAN_PASSTHROUGH", "MERIDIAN_PASSTHROUGH_EARLY_STOP", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k]
    process.env.MERIDIAN_PASSTHROUGH = "1"
    delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    configDir = mkdtempSync(join(tmpdir(), "meridian-repair-"))
    process.env.CLAUDE_CONFIG_DIR = configDir
    mockMessages = []
    capturedQueryParamsAll = []
  })

  afterEach(() => {
    for (const key of usedSessionKeys) evictSharedSession(key)
    usedSessionKeys.clear()
    clearSessionCache()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
  })

  it("checkpoint resume: the stored denial is rewritten before the structured resume", async () => {
    const file = writeFixture(configDir, "cp-1")
    const resumed = await twoTurns(app, "repair-checkpoint", "cp-1")
    expect(resumed.options.resume).toBe(SDK_SESSION)
    expect(resumed.options.resumeSessionAt).toBeDefined()
    expect(storedResult(file, "cp-1")).toEqual({ type: "tool_result", tool_use_id: "cp-1", content: "REAL[alpha]" })
  })

  it("no checkpoint (early stop off): the tool turn is not resumed at all, so its denial is dead, not stale", async () => {
    process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"
    const file = writeFixture(configDir, "nc-1")
    const next = await twoTurns(app, "repair-nocheckpoint", "nc-1")
    expect(next.options.resume).toBeUndefined()
    expect(next.options.resumeSessionAt).toBeUndefined()
    // Nothing loads this transcript again; the repair has no reason to run.
    expect(storedResult(file, "nc-1")?.is_error).toBe(true)
  })
})
