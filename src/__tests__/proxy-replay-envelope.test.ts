/**
 * Fresh-session replay envelope — #619.
 *
 * When a multi-turn conversation is rebuilt as a fresh session (no resume),
 * the flattened history must be framed as context-only with the live user
 * message separated, so the model answers instead of pattern-continuing the
 * transcript (self-play / confabulated tool output). Resume deltas stay bare.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

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
const { storeSession, getSessionByClaudeId } = await import("../proxy/session/cache")

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
    expect(prompt).toContain("<thinking>Reason step by step before answering.</thinking>")
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

  it("survives on the resume path, not just full replay", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const prior = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]
    storeSession("sess-720-resume", prior, "sdk-720-resume", "/tmp/test", [null, "uuid-1"])

    const res = await post(
      app,
      [
        ...prior,
        { role: "user", content: "<thinking>Reason step by step before answering.</thinking>\n\nWhat is 2+2?" },
      ],
      { "x-opencode-session": "sess-720-resume" }
    )
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).toContain("<thinking>Reason step by step before answering.</thinking>")
  })
})

describe("assistant content: Meridian's own markers stripped on replay (#724)", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  it("does not replay Meridian's 'Files changed:' summary back to the model", async () => {
    // server.ts appends this onto the assistant's last text block; the client
    // echoes that turn back next request, and before #724 it replayed verbatim.
    // NON_XML_PATTERNS carried a matcher for it that could never fire, because
    // the sanitizer only ran on user-authored text.
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "create a file" },
      { role: "assistant", content: "Done.\n\n---\nFiles changed:\n  - src/a.ts\n" },
      { role: "user", content: "now what?" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).not.toContain("Files changed:")
    expect(prompt).not.toContain("src/a.ts")
    // The assistant's real answer must survive.
    expect(prompt).toContain("Done.")
    expect(prompt).toContain("now what?")
  })

  it("leaves XML tags in assistant output alone — that is the model's own answer", async () => {
    // The #720 failure mirrored: stripping the allowlist from model output
    // would delete a legitimate answer about configuration.
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "show me an env block" },
      { role: "assistant", content: "Sure:\n<env>\nFOO=1\n</env>\nThat sets FOO." },
      { role: "user", content: "thanks" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).toContain("FOO=1")
  })

  it("still strips the same markers from user-authored text", async () => {
    // The user path must not regress while the assistant path is added.
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<env>cwd=/tmp</env>the question" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).not.toContain("cwd=/tmp")
    expect(prompt).toContain("the question")
  })
})

/**
 * MERIDIAN_STRIP_THINKING — escape hatch for harnesses observed leaking raw
 * <thinking> tags into user-authored prompts that haven't been surveyed. Off
 * by default (see the #720 suite above); this suite pins the env-var override.
 */
describe("MERIDIAN_STRIP_THINKING env escape hatch", () => {
  const priorMeridian = process.env.MERIDIAN_STRIP_THINKING
  const priorClaudeProxy = process.env.CLAUDE_PROXY_STRIP_THINKING

  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  afterEach(() => {
    if (priorMeridian === undefined) delete process.env.MERIDIAN_STRIP_THINKING
    else process.env.MERIDIAN_STRIP_THINKING = priorMeridian
    if (priorClaudeProxy === undefined) delete process.env.CLAUDE_PROXY_STRIP_THINKING
    else process.env.CLAUDE_PROXY_STRIP_THINKING = priorClaudeProxy
  })

  it("leaves <thinking> intact when the env var is unset (default)", async () => {
    delete process.env.MERIDIAN_STRIP_THINKING
    delete process.env.CLAUDE_PROXY_STRIP_THINKING
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<thinking>my reasoning</thinking>the question" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).toContain("<thinking>my reasoning</thinking>")
  })

  it("strips <thinking> through the real HTTP path when MERIDIAN_STRIP_THINKING=1", async () => {
    process.env.MERIDIAN_STRIP_THINKING = "1"
    delete process.env.CLAUDE_PROXY_STRIP_THINKING
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<thinking>my reasoning</thinking>the question" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).not.toContain("<thinking>")
    expect(prompt).toContain("the question")
  })
})

describe("passthrough checkpoint preservation across storeSession calls", () => {
  beforeEach(() => {
    clearSessionCache()
  })

  it("preserves checkpoint when storeSession is called with undefined passthrough fields", () => {
    const messages = [{ role: "user", content: "hello" }]
    // First call: store a checkpoint
    storeSession(
      "checkpoint-preserve-test",
      messages,
      "sdk-checkpoint",
      undefined,
      [null],
      undefined,
      "uuid-123",
      ["toolA", "toolB"]
    )
    // Second call: no checkpoint (undefined passthrough fields) — must preserve
    storeSession(
      "checkpoint-preserve-test",
      messages,
      "sdk-checkpoint",
      undefined,
      [null],
      undefined,
      undefined,
      undefined
    )
    // Verify checkpoint is still intact
    const state = getSessionByClaudeId("sdk-checkpoint")
    expect(state?.passthroughToolCallAssistantUuid).toBe("uuid-123")
    expect(state?.passthroughToolCallIds).toEqual(["toolA", "toolB"])
  })

  it("clears checkpoint when storeSession is called with null passthrough fields", () => {
    const messages = [{ role: "user", content: "hello" }]
    // First call: store a checkpoint
    storeSession(
      "checkpoint-clear-test",
      messages,
      "sdk-clear",
      undefined,
      [null],
      undefined,
      "uuid-456",
      ["toolC"]
    )
    // Second call: explicit null — must clear
    storeSession(
      "checkpoint-clear-test",
      messages,
      "sdk-clear",
      undefined,
      [null],
      undefined,
      null,
      null
    )
    const state = getSessionByClaudeId("sdk-clear")
    expect(state?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(state?.passthroughToolCallIds).toBeUndefined()
  })
})
