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

  it("classifies an in-process teammate's progress caption as auxiliary", async () => {
    expect(await auxiliary(progressBody(), { "x-claude-code-agent-id": "design-a@session-25a7d9d8" })).toBe(true)
  })

  it("classifies the first caption, which quotes no previous caption", async () => {
    const body = progressBody()
    body.messages.at(-1)!.content = [
      { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" },
      { type: "text", text: PROGRESS_FIRST_PROMPT },
    ]
    expect(await auxiliary(body)).toBe(true)
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

  it("classifies a first-turn caption followed by a trailing system context message", async () => {
    const systemText = "The following deferred tools are now available via ToolSearch.\n\n# Environment\n - Primary working directory: /tmp/project\n\nToday's date is 2026-10-14."
    for (const systemContent of [
      systemText,
      [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      "<system-reminder>\n<total_tokens>4151 / 200000 tokens left</total_tokens>\n</system-reminder>",
    ]) {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\nAttribution for git commits\n</system-reminder>" },
            { type: "text", text: "Run `sleep 40` three times." },
            { type: "text", text: PROGRESS_FIRST_PROMPT },
          ],
        },
        { role: "system", content: systemContent },
      ]
      expect(await auxiliary({ ...progressBody(), messages })).toBe(true)
    }

    // Negative cases: the real Turn-1 subagent request (same [user, system]
    // shape without the caption instruction), a system message containing the
    // caption text, an empty system message, or two trailing system messages.
    expect(await auxiliary({
      ...progressBody(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\nAttribution for git commits\n</system-reminder>" },
            { type: "text", text: "Run `sleep 40` three times." },
          ],
        },
        { role: "system", content: systemText },
      ],
    })).toBe(false)
    expect(await auxiliary({
      ...progressBody(),
      messages: [
        { role: "user", content: "Run `sleep 40` three times." },
        { role: "system", content: PROGRESS_FIRST_PROMPT },
      ],
    })).toBe(false)
    expect(await auxiliary({
      ...progressBody(),
      messages: [
        { role: "user", content: PROGRESS_FIRST_PROMPT },
        { role: "system", content: "   " },
      ],
    })).toBe(false)
    expect(await auxiliary({
      ...progressBody(),
      messages: [
        { role: "user", content: PROGRESS_FIRST_PROMPT },
        { role: "system", content: systemText },
        { role: "system", content: systemText },
      ],
    })).toBe(false)
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
