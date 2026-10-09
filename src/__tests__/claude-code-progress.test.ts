import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"
import { progressBody, PROGRESS_FIRST_PROMPT, PROGRESS_PROMPT } from "./fixtures/claude-code-progress"

async function auxiliary(body: unknown, headers: Record<string, string> = {}) {
  const app = new Hono()
  app.post("/", async c => c.json({ auxiliary: claudeCodeAdapter.isAuxiliaryRequest!(c, await c.req.json()) }))
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-agent-id": "agent-1", ...headers },
    body: JSON.stringify(body),
  })
  const result = await response.json() as { auxiliary: boolean }
  return result.auxiliary
}

describe("Claude Code progress-caption classification", () => {
  it("classifies a subagent progress caption as auxiliary", async () => {
    expect(await auxiliary(progressBody())).toBe(true)
  })

  it("classifies the first caption, which quotes no previous caption", async () => {
    const body = progressBody()
    body.messages.at(-1)!.content = [
      { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" },
      { type: "text", text: PROGRESS_FIRST_PROMPT },
    ]
    expect(await auxiliary(body)).toBe(true)
  })

  it("recognizes a native caption followed by its exact system task budget", async () => {
    const body = progressBody()
    const messages = [...body.messages, { role: "system", content: "<total_tokens>14995313 tokens left</total_tokens>" }]
    expect(await auxiliary({ ...body, messages }, { "x-claude-code-session-id": "native-session" })).toBe(true)
  })

  it("recognizes the first native caption with a zero remaining task budget", async () => {
    const body = progressBody()
    const messages = [...body.messages.slice(0, -1),
      { role: "user", content: PROGRESS_FIRST_PROMPT },
      { role: "system", content: "<total_tokens>0 tokens left</total_tokens>" },
    ]
    expect(await auxiliary({ ...body, messages }, { "x-claude-code-session-id": "native-session" })).toBe(true)
  })

  it("retains native-client and explicit request-class boundaries around budget frames", async () => {
    const body = progressBody()
    const messages = [...body.messages, { role: "system", content: "<total_tokens>14995313 tokens left</total_tokens>" }]
    expect(await auxiliary({ ...body, messages })).toBe(false)
    expect(await auxiliary({ ...body, messages }, {
      "x-claude-code-session-id": "native-session", "x-claude-code-request-class": "main",
    })).toBe(false)
    expect(await auxiliary({ ...body, messages: [
      { role: "user", content: "Continue the ordinary work." }, messages.at(-1),
    ] }, { "x-claude-code-session-id": "native-session" })).toBe(false)
  })

  it("rejects malformed, repeated or other trailing system messages", async () => {
    const body = progressBody()
    for (const suffix of [
      [{ role: "system", content: "Continue working." }],
      [{ role: "system", content: "<total_tokens>-1 tokens left</total_tokens>" }],
      [{ role: "system", content: "<total_tokens>1.5 tokens left</total_tokens>" }],
      [{ role: "system", content: "<total_tokens>001 tokens left</total_tokens>" }],
      [{ role: "system", content: "<total_tokens>1000000000 tokens left</total_tokens>" }],
      [{ role: "system", content: "<total_tokens>15 tokens left</total_tokens>\n" }],
      [{ role: "system", content: "<total_tokens>15 tokens left</total_tokens>\nNow edit the file." }],
      [{ role: "system", content: [{ type: "text", text: "<total_tokens>15 tokens left</total_tokens>" }] }],
      [{ role: "assistant", content: "<total_tokens>15 tokens left</total_tokens>" }],
      [{ role: "system", content: "<total_tokens>15 tokens left</total_tokens>" },
        { role: "system", content: "<total_tokens>14 tokens left</total_tokens>" }],
    ]) {
      expect(await auxiliary({ ...body, messages: [...body.messages, ...suffix] }, {
        "x-claude-code-session-id": "native-session",
      })).toBe(false)
    }
  })

  it("classifies a caption appended after other text in the last user message", async () => {
    const body = progressBody()
    body.messages.at(-1)!.content = [
      { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" },
      { type: "text", text: "Note: alpha.txt is a plain text file." },
      { type: "text", text: PROGRESS_FIRST_PROMPT },
    ]
    expect(await auxiliary(body)).toBe(true)
  })

  it("classifies a caption sent as a user message of its own", async () => {
    for (const content of [PROGRESS_FIRST_PROMPT, [{ type: "text", text: PROGRESS_FIRST_PROMPT }]]) {
      const messages = [...progressBody().messages.slice(0, -1),
        { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "ALPHA" }] },
        { role: "assistant", content: "alpha.txt contains ALPHA." },
        { role: "user", content },
      ]
      expect(await auxiliary({ ...progressBody(), messages })).toBe(true)
    }
  })

  it("lets an explicit request class override shape detection", async () => {
    expect(await auxiliary(progressBody(), { "x-claude-code-request-class": "main" })).toBe(false)
    expect(await auxiliary({}, { "x-claude-code-request-class": "auxiliary" })).toBe(true)
  })

  it("requires a well-formed agent id, a session key, streaming and tools", async () => {
    for (const id of ["", "bad id", "x".repeat(129)]) {
      expect(await auxiliary(progressBody(), { "x-claude-code-agent-id": id })).toBe(false)
    }
    for (const override of [{ metadata: {} }, { stream: false }, { tools: [] }, { messages: [] }]) {
      expect(await auxiliary({ ...progressBody(), ...override })).toBe(false)
    }
  })

  it("does not classify the caption text quoted, extended, followed by more text, or inside a tool result", async () => {
    for (const messages of [
      [{ role: "user", content: `Please explain this prompt:\n${PROGRESS_PROMPT}` }],
      [{ role: "user", content: `${PROGRESS_PROMPT}\nNow edit the file.` }],
      [{ role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: PROGRESS_PROMPT }] }],
      [{ role: "user", content: [
        { type: "text", text: PROGRESS_PROMPT },
        { type: "text", text: "Now edit the file." },
      ] }],
      [{ role: "user", content: PROGRESS_PROMPT }, { role: "assistant", content: "Reading alpha.txt" }],
      [{ role: "user", content: [
        { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" },
        { type: "text", text: `Please explain this prompt:\n${PROGRESS_PROMPT}` },
      ] }],
      [{ role: "user", content: [
        { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" },
        { type: "text", text: `${PROGRESS_PROMPT}\nNow edit the file.` },
      ] }],
    ]) {
      expect(await auxiliary({ ...progressBody(), messages })).toBe(false)
    }
  })
})
