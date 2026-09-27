/**
 * Integration test: OpenCode V2 user-invoked skills reach the SDK prompt.
 *
 * OpenCode V2 sends `/skill-name` as a user message whose first text block is
 * the skill body wrapped in `<skill_content>` (with a nested `<skill_files>`
 * list). When the user typed nothing after the command, that block is the
 * whole message. Stripping it as orchestration markup handed the model an
 * empty turn, and it answered that the message came through empty.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null
let savedPassthrough: string | undefined

installSdkMock(() => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, params.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-skill-content-preservation.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

async function post(body: any) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  const res = await app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
  await res.json()
}

// Shape of Skill.toModelOutput in OpenCode V2 (packages/core/src/skill.ts).
const SKILL_BLOCK = [
  '<skill_content name="pulse-setup">',
  "# Skill: pulse-setup",
  "",
  "SKILL_BODY_MARKER: write .pulse/config.toml and the anchor block.",
  "",
  "Base directory for this skill: /home/dev/.config/opencode/skills/pulse-setup",
  "<skill_files>",
  "<file>/home/dev/.config/opencode/skills/pulse-setup/SKILL.md</file>",
  "</skill_files>",
  "</skill_content>",
].join("\n")

function promptText(): string {
  const p = capturedQueryParams?.prompt
  return typeof p === "string" ? p : String(p)
}

describe("OpenCode V2 user-invoked skill content", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("keeps the skill body when it is the only content of the user message", async () => {
    await post({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: SKILL_BLOCK }] }],
    })

    const prompt = promptText()
    expect(prompt).toContain('<skill_content name="pulse-setup">')
    expect(prompt).toContain("SKILL_BODY_MARKER")
    expect(prompt).toContain("<skill_files>")
    expect(prompt).toContain("</skill_content>")
  })

  it("keeps the skill body alongside typed arguments", async () => {
    await post({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: SKILL_BLOCK }, { type: "text", text: "use four parallel agents" }],
      }],
    })

    const prompt = promptText()
    expect(prompt).toContain("SKILL_BODY_MARKER")
    expect(prompt).toContain("use four parallel agents")
  })

  it("keeps an earlier skill turn in fresh replay history", async () => {
    await post({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: SKILL_BLOCK }] },
        { role: "assistant", content: [{ type: "text", text: "Which repository?" }] },
        { role: "user", content: "this one" },
      ],
    })

    const prompt = promptText()
    expect(prompt).toContain("SKILL_BODY_MARKER")
    expect(prompt).toContain("this one")
  })

  it("still strips unconditional orchestration tags next to a skill", async () => {
    await post({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: `<task_metadata>{"id":"t1"}</task_metadata>\n${SKILL_BLOCK}` }],
      }],
    })

    const prompt = promptText()
    expect(prompt).toContain("SKILL_BODY_MARKER")
    expect(prompt).not.toContain("task_metadata")
  })
})
