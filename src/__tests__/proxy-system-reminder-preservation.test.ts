/**
 * Integration test for issue #368 — preservation of <system-reminder>
 * content in user messages for non-Droid adapters.
 *
 * oh-my-opencode injects <system-reminder> blocks containing background-task
 * IDs (`bg_*`) that Claude must see. Prior to the fix, Meridian's sanitizer
 * stripped these blocks unconditionally, causing Claude to respond as if the
 * user message was empty.
 *
 * This test posts the exact payload shape from the user report and asserts
 * that the `bg_*` IDs reach the SDK prompt for OpenCode, but are still
 * stripped for Droid (where <system-reminder> leaks CWD info).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null
let savedPassthrough: string | undefined

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
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

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
}

// The exact content shape that triggers #368: an OMO-injected system-reminder
// announcing background-task completion with bg_* IDs the model needs.
const OMO_SYSTEM_REMINDER = `<system-reminder>
[ALL BACKGROUND TASKS COMPLETE]

**Completed:**
- \`bg_0aaa50b0\`: Find Activity entity and relations
- \`bg_8ff9ed0f\`: Find Activity DB schema and migrations

Use \`background_output(task_id="<id>")\` to retrieve each result.
</system-reminder>
<!-- OMO_INTERNAL_INITIATOR -->
11:41 AM`

function getPromptText(): string {
  const p = capturedQueryParams?.prompt
  if (typeof p === "string") return p
  // AsyncIterable case — just coerce; this test uses a text prompt
  return String(p)
}

describe("issue #368: <system-reminder> preservation by adapter", () => {
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

  it("OpenCode: preserves bg_* task IDs from <system-reminder> in the SDK prompt", async () => {
    const app = createTestApp()
    const body = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: OMO_SYSTEM_REMINDER }],
    }

    await (await post(app, body)).json()

    const prompt = getPromptText()
    expect(prompt).toContain("bg_0aaa50b0")
    expect(prompt).toContain("bg_8ff9ed0f")
    expect(prompt).toContain("[ALL BACKGROUND TASKS COMPLETE]")
    // OMO's unambiguous marker should still be stripped
    expect(prompt).not.toContain("OMO_INTERNAL_INITIATOR")
  })

  it("OpenCode: preserves <system-reminder> when content is an array of blocks", async () => {
    const app = createTestApp()
    const body = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: OMO_SYSTEM_REMINDER }],
        },
      ],
    }

    await (await post(app, body)).json()

    const prompt = getPromptText()
    expect(prompt).toContain("bg_0aaa50b0")
    expect(prompt).toContain("bg_8ff9ed0f")
  })

  it("Droid: still strips <system-reminder> (CWD leakage)", async () => {
    const app = createTestApp()
    const DROID_UA = "factory-cli/0.89.0"
    const body = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<system-reminder>\n% pwd\n/Users/dev/project\n</system-reminder>`,
            },
            { type: "text", text: "what does this repo do?" },
          ],
        },
      ],
      tools: [
        { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
      ],
    }

    await (await post(app, body, { "User-Agent": DROID_UA })).json()

    const prompt = getPromptText()
    expect(prompt).not.toContain("% pwd")
    expect(prompt).not.toContain("/Users/dev/project")
    expect(prompt).toContain("what does this repo do?")
  })
})
