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

/**
 * #712/#713 — the user's own message must reach the model.
 *
 * The lineage tests pin the CLASSIFICATION (compaction that resumes past the
 * last message is now rejected). This pins the OUTCOME, which is where the bug
 * actually bit: a wrong verdict made server.ts take its `resumeFrom <
 * allMessages.length` fallback and send getLastUserMessage() — the LAST
 * user-role message, which for these clients is a constant injected tail, not
 * the turn the user just typed. HTTP 200, fluent output, nothing in the logs.
 *
 * Stateless chat frontends (SillyTavern and most roleplay UIs) re-send the
 * whole history every turn and append a constant block after the user's own
 * message: an injected assistant line plus a prefill sent as a user message.
 * That block matches the stored tail, so the suffix anchor lands on the final
 * message. Without a classification test AND this one, a future change to the
 * fallback could restore the data loss while the lineage tests stayed green.
 */
describe("stateless client with a trailing injected block (#712)", () => {
  const INJECTED_ASSISTANT = { role: "assistant", content: "[post-history instructions]" }
  const PREFILL = { role: "user", content: "思考已结束。" }

  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  it("delivers the user's message, not the injected prefill", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const prior = [
      { role: "user", content: "turn one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "turn two" },
      { role: "assistant", content: "answer two" },
      { role: "user", content: "turn three" },
      { role: "assistant", content: "answer three" },
      INJECTED_ASSISTANT,
      PREFILL,
    ]
    storeSession("sess-712", prior, "sdk-712", "/tmp/test", prior.map(() => null))

    // Next turn: the assistant replied, the user typed something new, and the
    // client re-appended its constant block.
    const res = await post(
      app,
      [
        ...prior.slice(0, 6),
        { role: "assistant", content: "answer three continued" },
        { role: "user", content: "WHAT THE USER ACTUALLY ASKED" },
        INJECTED_ASSISTANT,
        PREFILL,
      ],
      { "x-opencode-session": "sess-712" }
    )
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(typeof prompt).toBe("string")
    // The whole point: the user's turn is in the prompt.
    expect(prompt).toContain("WHAT THE USER ACTUALLY ASKED")
    // And it is not merely the injected tail standing in for it.
    expect(prompt).not.toBe("思考已结束。")
  })
})

/**
 * #720 — a user's own <thinking> block must reach the model.
 *
 * `thinking` was on the unconditional strip list, and the sanitizer runs on
 * user-authored text, so a paired <thinking>…</thinking> in a prompt was
 * deleted before the model saw it — on full replay as well as on resume. Every
 * unit test asserted the stripping worked; none asserted it should not happen
 * to user content, which is why this went unnoticed.
 */
describe("user-authored <thinking> survives (#720)", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  it("delivers a user's <thinking> block to the model", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<thinking>Reason step by step before answering.</thinking>\n\nWhat is 2+2?" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(typeof prompt).toBe("string")
    expect(prompt).toContain("<thinking>")
    expect(prompt).toContain("Reason step by step before answering.")
    expect(prompt).toContain("What is 2+2?")
  })

  it("still strips harness tags from the same message", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<env>cwd=/tmp</env><thinking>my reasoning</thinking>the question" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).toContain("<thinking>my reasoning</thinking>")
    expect(prompt).not.toContain("<env>")
    expect(prompt).not.toContain("cwd=/tmp")
  })
})
