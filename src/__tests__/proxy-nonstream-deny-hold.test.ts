/**
 * Non-stream deny-hold — #592.
 *
 * The CLI dispatches PreToolUse hooks per-block MID-GENERATION and cancels
 * the in-flight turn when a deny lands (#625). The streaming path holds
 * deny responses until turn generation completes; the non-stream path
 * returned them immediately, so of N parallel calls in one assistant turn
 * only the first survived — live A/B showed stream=2 calls, non-stream=1.
 *
 * This mock is CLI-faithful in the way the older non-stream mocks are NOT:
 * the block-1 hook fires while block 2 is still "generating", and if the
 * deny settles before generation ends, the assistant message is emitted
 * truncated (cancel-on-deny). Holding the deny lets both blocks complete.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
let hook1SettledBeforeTurnEnd: boolean | undefined

const tu = (id: string, path: string) => ({
  type: "tool_use", id, name: "read", input: { filePath: path },
})
const denyMsg = (ids: string[]) => ({
  type: "user",
  message: {
    role: "user",
    content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "forwarded" })),
  },
})

const boundary = (type: string, sessionId = "sdk-ns-1") => ({
  type: "stream_event", session_id: sessionId, event: { type },
})

import { resolveMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (opts: any) => {
    return (async function* () {
      const preHook = opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      const sessionId = resolveMockSdkSessionId(opts.options, "sdk-ns-1")
      yield { type: "system", subtype: "init", session_id: sessionId }
      if (!preHook) {
        // No passthrough hooks — nothing to hold, so answer and stop.
        yield {
          type: "assistant", uuid: "u1",
          message: { id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
          session_id: sessionId,
        }
        return
      }

      // Turn 1 generation begins. `message_start`/`message_delta` bracket it on
      // both paths — passthrough asks for partial messages regardless of whether
      // the client streams, because they are the only turn-boundary signal and
      // the deny-hold and the checkpoint both key off it.
      yield boundary("message_start", sessionId)

      // The CLI dispatches block 1's hook while block 2 is still generating.
      let settled = false
      const deny1 = preHook({ tool_name: "read", tool_use_id: "tu1", tool_input: { filePath: "/tmp/a.txt" } })
        .then((r: any) => { settled = true; return r })

      // "Generation time" for block 2
      await new Promise((r) => setTimeout(r, 40))
      hook1SettledBeforeTurnEnd = settled

      if (settled) {
        // Cancel-on-deny: block 2 is beheaded; only block 1 exists.
        yield boundary("message_delta", sessionId)
        yield {
          type: "assistant", uuid: "u1",
          message: { id: "m1", type: "message", role: "assistant", content: [tu("tu1", "/tmp/a.txt")], model: "claude-sonnet-5", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
          session_id: sessionId,
        }
        await deny1
        yield denyMsg(["tu1"])
        return
      }

      // Deny held → generation completed with BOTH blocks.
      yield boundary("message_delta", sessionId)
      yield {
        type: "assistant", uuid: "u1",
        message: { id: "m1", type: "message", role: "assistant", content: [tu("tu1", "/tmp/a.txt"), tu("tu2", "/tmp/b.txt")], model: "claude-sonnet-5", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
        session_id: sessionId,
      }
      const deny2 = preHook({ tool_name: "read", tool_use_id: "tu2", tool_input: { filePath: "/tmp/b.txt" } })
      await deny1
      yield denyMsg(["tu1"])
      await deny2
      yield denyMsg(["tu2"])
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk", name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}), "proxy-nonstream-deny-hold.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

describe("non-stream deny-hold (#592)", () => {
  beforeEach(() => {
    clearSessionCache()
    hook1SettledBeforeTurnEnd = undefined
  })

  it("holds denies until the turn's assistant message — both parallel calls survive", async () => {
    // Passthrough is on via the OpenCode adapter default.
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonnet", stream: false, max_tokens: 500,
          tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } }],
          messages: [{ role: "user", content: "read both files" }],
        }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const toolUses = body.content.filter((b: any) => b.type === "tool_use")

    // The deny must NOT have settled while the turn was still generating
    expect(hook1SettledBeforeTurnEnd).toBe(false)
    // Both parallel same-tool calls delivered, matching streaming behavior
    expect(toolUses.length).toBe(2)
    expect(toolUses.map((t: any) => t.input.filePath).sort()).toEqual(["/tmp/a.txt", "/tmp/b.txt"])
    expect(body.stop_reason).toBe("tool_use")
  })
})
