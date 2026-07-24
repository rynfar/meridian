/**
 * /v1/responses image input — through the HTTP layer with a mocked SDK.
 * A real base64 PNG posted as an `input_image` part must reach the SDK as an
 * actual image content block, not the "[Image attached]" placeholder the
 * text-only flatten path in server.ts would produce.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

// A real, valid 1x1 red PNG (69 bytes).
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

// The prompt the route handed to query(). Multimodal turns arrive as an async
// iterable of user messages; a dropped image degrades this to a plain string.
let capturedPrompt: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedPrompt = opts.prompt
    return (async function* () {
      yield {
        type: "assistant",
        uuid: "uuid-1",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I see a red pixel." }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 5 },
        },
        session_id: "sdk-1",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
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

function postImageRequest(stream: boolean) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What color is this pixel?" },
            { type: "input_image", image_url: `data:image/png;base64,${RED_PNG_B64}` },
          ],
        }],
        stream,
      }),
    })
  )
}

/** Drain the captured prompt and return the user message's content blocks. */
async function sdkUserContent(): Promise<any[]> {
  if (typeof capturedPrompt === "string") return [{ type: "text", text: capturedPrompt }]
  const msgs: any[] = []
  for await (const m of capturedPrompt) msgs.push(m)
  const userMsg = msgs.find((m) => (m.role ?? m.message?.role) === "user")
  return userMsg?.content ?? userMsg?.message?.content ?? []
}

function expectImageDelivered(content: any[]) {
  expect(JSON.stringify(content)).not.toContain("[Image attached]")
  const image = content.find((b) => b?.type === "image")
  expect(image?.source).toEqual({ type: "base64", media_type: "image/png", data: RED_PNG_B64 })
}

describe("/v1/responses image input reaches the SDK", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompt = null
  })

  it("non-stream: delivers the PNG as an image block with the exact payload", async () => {
    const res = await postImageRequest(false)
    expect(res.status).toBe(200)
    const content = await sdkUserContent()
    expectImageDelivered(content)
    expect(JSON.stringify(content)).toContain("What color is this pixel?")
  })

  it("stream: delivers the PNG as an image block with the exact payload", async () => {
    const res = await postImageRequest(true)
    expect(res.status).toBe(200)
    await res.text() // drain SSE so the route fully runs
    expectImageDelivered(await sdkUserContent())
  })
})
