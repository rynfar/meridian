import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"
import { progressBody, PROGRESS_PROMPT } from "./fixtures/claude-code-progress"

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
      { type: "text", text: PROGRESS_PROMPT.replace(/Previous: .*\n\n/, "") },
    ]
    expect(await auxiliary(body)).toBe(true)
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

  it("does not classify the caption text typed, quoted, extended, or inside a tool result", async () => {
    for (const messages of [
      [{ role: "user", content: PROGRESS_PROMPT }],
      [{ role: "user", content: [{ type: "text", text: PROGRESS_PROMPT }] }],
      [{ role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: PROGRESS_PROMPT }] }],
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
