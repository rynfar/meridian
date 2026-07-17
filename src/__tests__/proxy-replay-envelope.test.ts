/**
 * Fresh-session replay envelope — #619.
 *
 * When a multi-turn conversation is rebuilt as a fresh session (no resume),
 * the flattened history must be framed as context-only with the live user
 * message separated, so the model answers instead of pattern-continuing the
 * transcript (self-play / confabulated tool output). Resume deltas stay bare.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

let capturedPrompts: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedPrompts.push(opts.prompt)
    return (async function* () {
      yield {
        type: "assistant",
        uuid: "uuid-1",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        session_id: "sdk-1",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")

function post(app: any, messages: any[], headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: "sonnet", stream: false, messages }),
    })
  )
}

describe("fresh-session replay envelope (#619)", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  it("frames a fresh multi-turn replay and separates the live user message", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "read the config" },
      { role: "assistant", content: "I read it. Port is 3456." },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "port=3456" },
      ] },
      { role: "user", content: "now change the port to 4000" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(typeof prompt).toBe("string")
    expect(prompt).toContain("<conversation_history>")
    expect(prompt).toContain("</conversation_history>")
    expect(prompt).toContain("context only")
    // Live message is terminal, outside the envelope
    expect(prompt.trimEnd()).toEndWith("now change the port to 4000")
    expect(prompt.indexOf("</conversation_history>")).toBeLessThan(prompt.indexOf("now change the port to 4000"))
    // Anti-imitation markers preserved, classic trigger absent
    expect(prompt).toContain("[Assistant: I read it. Port is 3456.]")
    expect(prompt).not.toContain("Human:")
  })

  it("leaves single-message fresh conversations bare", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [{ role: "user", content: "hello" }])
    expect(res.status).toBe(200)
    expect(capturedPrompts[0]).toBe("hello")
  })

  it("keeps resume deltas bare — no envelope on continuation", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const prior = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]
    storeSession("sess-env-1", prior, "sdk-prior", "/tmp/test", [null, "uuid-1"])

    const res = await post(
      app,
      [...prior, { role: "user", content: "follow up" }],
      { "x-opencode-session": "sess-env-1" }
    )
    expect(res.status).toBe(200)
    const prompt = capturedPrompts[0] as string
    expect(prompt).not.toContain("<conversation_history>")
    expect(prompt).toBe("follow up")
  })
})
