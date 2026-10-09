import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { query } from "@anthropic-ai/claude-agent-sdk"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { resolveMockSdkSessionId } from "./helpers"

type Params = Parameters<typeof query>[0]
let calls: Params[] = [], interrupts = 0, completedHooks = 0, joined = 0
let terminalMode: "owned" | "unrelated" | "wrong-result" | "close-failure" | "normal" = "owned"
const qualifiedLogs: unknown[] = []

installSdkMock(() => ({
  query: (params: Params) => {
    calls.push(params)
    const sessionId = resolveMockSdkSessionId(params.options, "fixture-session")
    const prefix = "mcp__oc__"
    const generationId = crypto.randomUUID()
    const hooks = params.options?.hooks?.PreToolUse?.[0]?.hooks ?? []
    let interrupted = false
    const stream = (event: unknown) => ({ type: "stream_event", session_id: sessionId, event })
    const invokeHook = async (tool: string, file: string) => {
      for (const hook of hooks) await hook({
        hook_event_name: "PreToolUse", session_id: sessionId, cwd: tmpdir(),
        transcript_path: "unused-fixture-path", tool_use_id: tool,
        tool_name: `${prefix}read`, tool_input: { file_path: file },
      }, tool, { signal: new AbortController().signal })
      completedHooks++
    }
    const sdk = (async function* () {
      yield { type: "system", subtype: "init", session_id: sessionId }
      yield stream({ type: "message_start", message: {
        id: generationId, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 1, output_tokens: 1 },
      } })
      for (const [index, tool] of ["tool-a", "tool-b"].entries()) {
        const input = { file_path: `/fixture-${index}.txt` }
        yield stream({ type: "content_block_start", index, content_block: { type: "tool_use", id: tool, name: `${prefix}read`, input: {} } })
        yield stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })
        yield stream({ type: "content_block_stop", index })
        yield { type: "assistant", session_id: sessionId, uuid: `uuid-${index}`, message: {
          id: generationId, role: "assistant", model: "claude-sonnet-5-5",
          content: [{ type: "tool_use", id: tool, name: `${prefix}read`, input }], usage: { input_tokens: 1, output_tokens: 1 },
        } }
      }
      yield stream({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } })
      yield stream({ type: "message_stop" })
      // Match the native serial-hook behavior that falsified holding all denies.
      await invokeHook("tool-a", "/fixture-0.txt")
      yield { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool-a", is_error: true }] } }
      await invokeHook("tool-b", "/fixture-1.txt")
      yield { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool-b", is_error: true }] } }
      if (terminalMode === "normal" || !interrupted) {
        yield { type: "result", session_id: sessionId, subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }
        return
      }
      // Match the independently observed native cap-one terminal, rather
      // than inventing a counter equal to the configured API-generation cap.
      yield { type: "result", session_id: sessionId, subtype: "error_max_turns", is_error: true,
        terminal_reason: terminalMode === "wrong-result" ? "aborted_streaming" : "aborted_tools",
        num_turns: 2, errors: ["fixture owned interruption"], usage: { input_tokens: 1, output_tokens: 1 } }
      throw new Error(terminalMode === "unrelated" ? "fixture unrelated transport failure"
        : "Claude Code returned an error result: fixture owned interruption")
    })()
    return Object.assign(sdk, {
      interrupt: async () => { interrupts++; interrupted = true },
      close: () => { joined++; if (terminalMode === "close-failure") throw new Error("fixture close failure") },
    })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "passthrough-checkpoint-stop-http.test.ts")
installLoggerMock(() => ({
  claudeLog: (event: string, fields: unknown) => { if (event === "passthrough.checkpoint_interrupt_qualified") qualifiedLogs.push(fields) },
  withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }) }))

const { createProxyServer } = await import("../proxy/server")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const { clearSessionCache } = await import("../proxy/session/cache")
const directory = mkdtempSync(join(tmpdir(), "meridian-owned-stop-http-"))
let app: ReturnType<typeof createProxyServer>["app"]
let savedPassthrough: string | undefined, savedEarlyStop: string | undefined

function post(stream: boolean) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "dummy", "user-agent": "opencode/1.0.0", "x-opencode-agent": "build", "x-opencode-agent-mode": "primary", "x-opencode-session": crypto.randomUUID() },
    body: JSON.stringify({ model: "claude-sonnet-5-5", stream, max_tokens: 1024,
      messages: [{ role: "user", content: "Read the two fixture files." }],
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }],
    }),
  }))
}

describe("HTTP attempt-owned checkpoint interrupt", () => {
  beforeAll(() => { setSessionStoreDir(directory); app = createProxyServer({ port: 0, host: "127.0.0.1" }).app })
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH; savedEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    process.env.MERIDIAN_PASSTHROUGH = "1"; delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    calls = []; interrupts = 0; completedHooks = 0; joined = 0; qualifiedLogs.length = 0; terminalMode = "owned"
    clearSessionCache()
  })
  afterEach(() => {
    if (savedPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH; else process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    if (savedEarlyStop === undefined) delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP; else process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = savedEarlyStop
  })
  afterAll(() => { setSessionStoreDir(null); rmSync(directory, { recursive: true, force: true }) })

  for (const stream of [false, true]) {
    it(`qualifies only the owned interruption, stream=${stream}`, async () => {
      const response = await post(stream), text = await response.text()
      expect(response.status).toBe(200)
      expect(text).toContain('"stop_reason":"tool_use"')
      expect(text).toContain('"id":"tool-a"'); expect(text).toContain('"id":"tool-b"')
      expect(text).not.toContain('"type":"error"')
      expect(interrupts).toBe(1); expect(completedHooks).toBe(2); expect(joined).toBe(1)
      expect(qualifiedLogs).toHaveLength(1)
      expect(calls[0]?.options?.maxTurns).toBe(1)
    })
    for (const mode of ["unrelated", "wrong-result", "close-failure"] as const) {
      it(`refuses ${mode} after a visible checkpoint, stream=${stream}`, async () => {
        terminalMode = mode
        const response = await post(stream), text = await response.text()
        if (stream) expect(text).toContain('"type":"error"')
        else expect(response.status).toBeGreaterThanOrEqual(500)
        expect(interrupts).toBe(1); expect(joined).toBe(1); expect(qualifiedLogs).toHaveLength(0)
      })
    }
    it(`leaves the early-stop kill switch intact, stream=${stream}`, async () => {
      process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"; terminalMode = "normal"
      const response = await post(stream); await response.text()
      expect(response.status).toBe(200); expect(interrupts).toBe(0); expect(qualifiedLogs).toHaveLength(0)
      expect(calls[0]?.options?.maxTurns).toBe(3)
    })
  }
})
