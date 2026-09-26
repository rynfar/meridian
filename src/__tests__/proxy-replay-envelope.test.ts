/**
 * Fresh-session replay envelope — #619.
 *
 * When a multi-turn conversation is rebuilt as a fresh session (no resume),
 * the flattened history must be framed as context-only with the live user
 * message separated, so the model answers instead of pattern-continuing the
 * transcript (self-play / confabulated tool output). Resume deltas stay bare.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { estimateTokens, replayBudgetFor } from "../proxy/replayBudget"
import { resetExtendedContextUnavailable } from "../proxy/models"
let capturedPrompts: any[] = []
let overflowFailures = 0
let overflowMessage = "Claude Code returned an error result: Prompt is too long"
let capturedPromptTexts: string[] = []
let capturedOptions: any[] = []

import { resolveMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (opts: any) => {
    capturedPrompts.push(opts.prompt)
    capturedOptions.push(opts.options)
    return (async function* () {
      if (typeof opts.prompt === "string") capturedPromptTexts.push(opts.prompt)
      else {
        const inputs = []
        for await (const input of opts.prompt) inputs.push(input)
        capturedPromptTexts.push(JSON.stringify(inputs))
      }
      if (overflowFailures > 0) {
        overflowFailures--
        throw new Error(overflowMessage)
      }
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
        session_id: resolveMockSdkSessionId(opts.options, "sdk-1"),
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-replay-envelope.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")
const { diagnosticLog } = await import("../telemetry")

function post(app: any, messages: any[], headers: Record<string, string> = {}, stream = false, model = "sonnet") {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, stream, messages }),
    })
  )
}

describe("bounded fresh replay", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
    overflowFailures = 0
    overflowMessage = "Claude Code returned an error result: Prompt is too long"
    capturedPromptTexts = []
    capturedOptions = []
    resetExtendedContextUnavailable()
  })
  afterEach(() => { overflowFailures = 0; resetExtendedContextUnavailable() })

  const history = () => [
    { role: "user", content: "objective" },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: `question ${i}` },
      { role: "assistant", content: "я".repeat(60_000) },
    ]).flat(),
    { role: "user", content: "live question" },
  ]

  it("trims a long fresh history before the SDK call", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, history())
    expect(res.status).toBe(200)
    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0]).toContain("were omitted from this replay")
    expect(capturedPrompts[0]).toContain("objective")
    expect(capturedPrompts[0]).toEndWith("live question")
  })

  for (const streaming of [false, true]) {
    for (const error of ["rate limit exceeded", "extra usage required for 1m"]) {
      it(`rebudgets fresh replay after ${error} (stream=${streaming})`, async () => {
        overflowFailures = 1
        overflowMessage = error
        const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
        const res = await post(app, history(), {}, streaming, "opus[1m]")
        await res.text()
        expect(res.status).toBe(200)
        expect(capturedPrompts).toHaveLength(2)
        expect(capturedOptions[0].model).toBe("opus[1m]")
        expect(capturedOptions[1].model).toBe("opus")
        expect(estimateTokens(capturedPromptTexts[0])).toBeGreaterThan(replayBudgetFor("opus"))
        expect(estimateTokens(capturedPromptTexts[1])).toBeLessThanOrEqual(replayBudgetFor("opus"))
        expect(capturedPromptTexts[1]).toContain("were omitted from this replay")
      })
    }

    it(`does not retry an overflowing indivisible live tail (stream=${streaming})`, async () => {
      overflowFailures = 3
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const res = await post(app, [...history(), { role: "user", content: "я".repeat(200_000) }], {}, streaming)
      const body = await res.text()
      expect(capturedPrompts).toHaveLength(1)
      if (!streaming) expect(res.status).toBe(400)
      else expect(body).toContain("error")
    })

    it(`budgets the fresh fallback after a refused resume (stream=${streaming})`, async () => {
      const prior = [...history(), { role: "assistant", content: "prior answer" }]
      storeSession("sess-budget-refusal", prior, "sdk-budget-refusal", "/tmp/test", prior.map(() => null))
      overflowFailures = 1
      overflowMessage = "No message found with message.uuid of: 6f1c0f4e-0a1e-4d61-9a2f-7b0c1d2e3f40"
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const res = await post(app, [...prior, { role: "user", content: "continue" }], { "x-opencode-session": "sess-budget-refusal" }, streaming)
      await res.text()
      expect(res.status).toBe(200)
      expect(capturedPrompts).toHaveLength(2)
      expect(capturedOptions[0].resume).toBe("sdk-budget-refusal")
      expect(capturedOptions[1].resume).toBeUndefined()
      expect(capturedPrompts[1]).toContain("were omitted from this replay")
      expect(estimateTokens(capturedPromptTexts[1])).toBeLessThanOrEqual(replayBudgetFor("sonnet"))
    })

    it(`budgets undo without a rollback point (stream=${streaming})`, async () => {
      const prior = [...history(), { role: "assistant", content: "prior answer" }, { role: "user", content: "later" }]
      storeSession("sess-budget-undo", prior, "sdk-budget-undo", "/tmp/test", prior.map(() => null))
      diagnosticLog.clear()
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const res = await post(app, [...prior.slice(0, -3), { role: "user", content: "replacement question" }], { "x-opencode-session": "sess-budget-undo" }, streaming)
      await res.text()
      expect(res.status).toBe(200)
      expect(capturedPrompts).toHaveLength(1)
      expect(capturedOptions[0].resume).toBeUndefined()
      expect(capturedOptions[0].resumeSessionAt).toBeUndefined()
      expect(capturedPrompts[0]).toContain("were omitted from this replay")
      expect(capturedPrompts[0]).toEndWith("replacement question")
      expect(diagnosticLog.getRecent().some(entry => entry.message.includes("lineage=undo"))).toBe(true)
    })

    it(`retries fresh overflow with a smaller prompt (stream=${streaming})`, async () => {
      overflowFailures = 1
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const res = await post(app, history(), {}, streaming)
      await res.text()
      expect(res.status).toBe(200)
      expect(capturedPrompts).toHaveLength(2)
      expect(capturedPrompts[1].length).toBeLessThan(capturedPrompts[0].length)
      expect(capturedOptions[1].sessionId).not.toBe(capturedOptions[0].sessionId)
    })

    it(`does not retry resumed overflow (stream=${streaming})`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const prior = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there" }]
      storeSession("sess-overflow", prior, "sdk-overflow", "/tmp/test", [null, "uuid-1"])
      overflowFailures = 1
      const res = await post(app, [...prior, { role: "user", content: "follow up" }], { "x-opencode-session": "sess-overflow" }, streaming)
      const body = await res.text()
      expect(capturedPrompts).toHaveLength(1)
      expect(capturedPrompts[0]).toBe("follow up")
      if (!streaming) expect(res.status).toBe(400)
      else expect(body).toContain("error")
    })
  }

  it("renders the string omission marker in structured replays and rebuilds them on overflow", async () => {
    overflowFailures = 1
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const messages = [...history().slice(0, -1), { role: "user", content: [
      { type: "text", text: "live image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ] }]
    const res = await post(app, messages)
    expect(res.status).toBe(200)
    expect(capturedPromptTexts).toHaveLength(2)
    expect(capturedPromptTexts[0]).toContain("were omitted from this replay")
    expect(capturedPromptTexts[1]).toContain("were omitted from this replay")
    expect(capturedPromptTexts[1]).toContain("aGVsbG8=")
    expect(capturedPromptTexts[1]!.length).toBeLessThan(capturedPromptTexts[0]!.length)
  })

  it("uses token counts in an overflow error to reduce the retry budget", async () => {
    overflowFailures = 1
    overflowMessage = "Prompt is too long: 400000 tokens > 200000 maximum"
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, history())
    expect(res.status).toBe(200)
    expect(capturedPrompts).toHaveLength(2)
    expect(capturedPrompts[1].length).toBeLessThan(capturedPrompts[0].length)
  })

  it("returns the existing context error after at most two retries", async () => {
    overflowFailures = 3
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, history())
    expect(res.status).toBe(400)
    expect(capturedPrompts).toHaveLength(3)
    expect(await res.text()).toContain("context")
  })
})

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
