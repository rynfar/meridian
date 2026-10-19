/**
 * MERIDIAN_SDK_PERMISSION_MODE=auto for an OpenCode client (#1390).
 *
 * The mode is the SDK subprocess's, not the client's. In passthrough the
 * PreToolUse hook still captures and denies every client tool, so the call
 * reaches OpenCode, which applies its own permissions; a rejection there comes
 * back as an ordinary tool_result for the model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { makeRequest, resolveMockSdkSessionId } from "./helpers"
import { setSessionStoreDir } from "../proxy/sessionStore"

const PREFIX = "mcp__oc__"
const BASH_INPUT = { command: "rm -rf build" }
const REJECTION = "The user rejected permission to use this specific tool call."

type PreToolUseHook = (
  input: { tool_name: string; tool_use_id: string; tool_input: unknown },
  toolUseId: undefined,
  context: { signal: AbortSignal },
) => unknown
interface MockQueryParams {
  prompt: unknown
  options: {
    permissionMode?: string
    allowDangerouslySkipPermissions?: boolean
    allowedTools?: string[]
    hooks?: { PreToolUse?: Array<{ hooks?: PreToolUseHook[] }> }
  }
}

let queries: MockQueryParams[] = []
let hookResults: unknown[] = []
let callTool = true

const streamEvent = (event: Record<string, unknown>, sessionId: string) => ({
  type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId,
})
const assistantMsg = (content: unknown[], sessionId: string, stopReason: string) => ({
  type: "assistant",
  message: { id: "m1", type: "message", role: "assistant", content, model: "claude-sonnet-4-5-20250929", stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 30 } },
  parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId,
})

installSdkMock(() => ({
  query: (params: MockQueryParams) => {
    queries.push(params)
    const sessionId = resolveMockSdkSessionId(params.options, "test-session")
    const hook = params.options.hooks?.PreToolUse?.[0]?.hooks?.[0]
    return (async function* () {
      if (!hook || !callTool) {
        yield assistantMsg([{ type: "text", text: "Understood, I will not delete it." }], sessionId, "end_turn")
        yield { type: "result", subtype: "success", is_error: false, session_id: sessionId }
        return
      }
      yield streamEvent({
        type: "message_start",
        message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      }, sessionId)
      yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tb1", name: `${PREFIX}bash`, input: {} } }, sessionId)
      yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(BASH_INPUT) } }, sessionId)
      yield assistantMsg([{ type: "tool_use", id: "tb1", name: `${PREFIX}bash`, input: BASH_INPUT }], sessionId, "tool_use")
      yield streamEvent({ type: "content_block_stop", index: 0 }, sessionId)
      const decision = Promise.resolve(hook(
        { tool_name: `${PREFIX}bash`, tool_use_id: "tb1", tool_input: BASH_INPUT },
        undefined,
        { signal: new AbortController().signal },
      ))
      yield streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } }, sessionId)
      hookResults.push(await decision)
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tb1", is_error: true, content: "denied" }] },
        parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId,
      }
      yield { type: "result", subtype: "success", is_error: false, session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-sdk-permission-mode.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
type App = ReturnType<typeof createProxyServer>["app"]

const bashTool = { name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }

function post(app: App, sid: string, messages: unknown[]) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sid },
    body: JSON.stringify(makeRequest({ stream: false, tools: [bashTool], messages })),
  }))
}

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt
  const items: unknown[] = []
  for await (const item of prompt as AsyncIterable<unknown>) items.push(item)
  return JSON.stringify(items)
}

describe("SDK permission mode for an OpenCode client", () => {
  const saved = { mode: process.env.MERIDIAN_SDK_PERMISSION_MODE, passthrough: process.env.MERIDIAN_PASSTHROUGH }
  let sessionDir = ""

  beforeEach(async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-permission-mode-test-"))
    setSessionStoreDir(sessionDir)
    process.env.MERIDIAN_SDK_PERMISSION_MODE = "auto"
    process.env.MERIDIAN_PASSTHROUGH = "1"
    queries = []
    hookResults = []
    callTool = true
    await clearSessionCache()
  })

  afterEach(async () => {
    for (const [key, value] of [["MERIDIAN_SDK_PERMISSION_MODE", saved.mode], ["MERIDIAN_PASSTHROUGH", saved.passthrough]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await Bun.sleep(25)
    rmSync(sessionDir, { recursive: true, force: true })
  })

  it("passthrough: forwards the tool call to OpenCode and relays its rejection", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const sid = crypto.randomUUID()
    const ask = { role: "user", content: "delete the build directory" }

    const first = await post(app, sid, [ask])
    const body = await first.json() as { stop_reason?: string; content?: Array<{ type: string; id?: string; name?: string; input?: unknown }> }

    expect(first.status).toBe(200)
    expect(queries[0]?.options.permissionMode).toBe("auto")
    expect(queries[0]?.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(queries[0]?.options.allowedTools).toContain(`${PREFIX}bash`)
    expect(hookResults).toEqual([expect.objectContaining({ decision: "block" })])
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content?.filter((block) => block.type === "tool_use")).toEqual([
      { type: "tool_use", id: "tb1", name: "bash", input: BASH_INPUT },
    ])

    callTool = false
    const second = await post(app, sid, [
      ask,
      { role: "assistant", content: [{ type: "tool_use", id: "tb1", name: "bash", input: BASH_INPUT }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tb1", is_error: true, content: REJECTION }] },
    ])
    const reply = await second.json() as { stop_reason?: string; content?: Array<{ type: string; text?: string }> }

    expect(second.status).toBe(200)
    expect(queries).toHaveLength(2)
    expect(queries[1]?.options.permissionMode).toBe("auto")
    expect(await promptText(queries[1]?.prompt)).toContain(REJECTION)
    expect(reply.stop_reason).toBe("end_turn")
    expect(reply.content?.[0]?.text).toContain("will not delete")
  })

  it("internal tools: keeps the OpenCode MCP allow list under auto", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    callTool = false
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

    const response = await post(app, crypto.randomUUID(), [{ role: "user", content: "hello" }])

    expect(response.status).toBe(200)
    expect(queries[0]?.options.permissionMode).toBe("auto")
    expect(queries[0]?.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(queries[0]?.options.allowedTools).toContain("mcp__opencode__bash")
  })

  it("keeps bypassPermissions when the variable is unset", async () => {
    delete process.env.MERIDIAN_SDK_PERMISSION_MODE
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

    await post(app, crypto.randomUUID(), [{ role: "user", content: "delete the build directory" }])

    expect(queries[0]?.options.permissionMode).toBe("bypassPermissions")
    expect(queries[0]?.options.allowDangerouslySkipPermissions).toBe(true)
    expect(hookResults).toEqual([expect.objectContaining({ decision: "block" })])
  })
})
