/**
 * Make plugin-less OpenCode visible, since it cannot be fixed silently.
 *
 * OpenCode 1.18.11 sends `x-session-affinity` natively, so a client with no
 * Meridian plugin is fully keyed and never reaches the fingerprint fallback.
 * That is why it breaks rather than degrades: its internal `title` agent runs
 * under the SAME session id as the user's chat, so one real key names two
 * unrelated conversations. Captured at the wire with no plugin configured:
 *
 *   seq 1  tools=0   msgs=1  x-session-affinity: ses_fe4c…   ← title one-shot
 *   seq 2  tools=10  msgs=1  x-session-affinity: ses_fe4c…   ← the user's turn
 *
 * Both attempts of that run returned HTTP 400 `session_turn_conflict` after a
 * ~8s wait. The agent-scoped session key that fixes this reads the plugin's
 * `x-opencode-agent-mode`, so it cannot reach a client that sends none.
 *
 * Inferring the agent from request shape was tried and reverted — "tool-less,
 * one message" is equally the first turn of an ordinary tool-less chat. So the
 * exposure stays, and the least-bad thing is to stop it being SILENT. The
 * startup warning in bin/cli.ts does not cover this: it is gated on an OpenCode
 * config FILE existing, so the documented `ANTHROPIC_BASE_URL=… opencode` path
 * with no config warns nothing at all.
 *
 * A request-time signal has no such gap and no false positives: a `opencode/`
 * User-Agent arriving without the plugin's headers is definitionally the
 * exposed case.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { notePluginlessOpenCodeRequest, clearPluginlessWarnings } from "../proxy/setup"

const OPENCODE_UA = "opencode/1.18.11 ai-sdk/provider-utils/4.0.27 runtime/bun/1.3.14"

describe("notePluginlessOpenCodeRequest", () => {
  beforeEach(() => clearPluginlessWarnings())

  it("warns for an OpenCode request carrying no plugin headers", () => {
    const msg = notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA,
      agentModeHeader: undefined,
      sessionId: "ses_fe4c090d9ffeymDAOxKAoBeqQ2",
    })
    expect(msg).toBeDefined()
    expect(msg).toContain("meridian setup")
  })

  it("stays quiet when the plugin's agent header is present", () => {
    expect(notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA,
      agentModeHeader: "primary",
      sessionId: "ses_a",
    })).toBeUndefined()
  })

  it("stays quiet for clients that are not OpenCode", () => {
    // MERIDIAN_DEFAULT_AGENT defaults to opencode, so unrelated clients reach
    // the OpenCode adapter. The User-Agent is what makes this unambiguous —
    // warning them would be telling a Pi user to configure an OpenCode plugin.
    for (const ua of [
      "claude-cli/2.1.0",
      "litellm/1.0",
      "python-httpx/0.27",
      "Charm-Crush/0.87",
      undefined,
    ]) {
      expect(notePluginlessOpenCodeRequest({
        userAgent: ua, agentModeHeader: undefined, sessionId: "ses_b",
      })).toBeUndefined()
    }
  })

  it("warns once per session, not once per request", () => {
    const args = { userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: "ses_c" }
    expect(notePluginlessOpenCodeRequest(args)).toBeDefined()
    expect(notePluginlessOpenCodeRequest(args)).toBeUndefined()
    expect(notePluginlessOpenCodeRequest(args)).toBeUndefined()
  })

  it("warns again for a different session", () => {
    expect(notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: "ses_d",
    })).toBeDefined()
    expect(notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: "ses_e",
    })).toBeDefined()
  })

  it("treats an empty agent-mode header as absent", () => {
    expect(notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: "", sessionId: "ses_f",
    })).toBeDefined()
  })

  it("handles a keyless request without warning on every one of them", () => {
    const args = { userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: undefined }
    expect(notePluginlessOpenCodeRequest(args)).toBeDefined()
    expect(notePluginlessOpenCodeRequest(args)).toBeUndefined()
  })

  it("names the consequence, not just the missing plugin", () => {
    const msg = notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: "ses_g",
    })!
    // An operator who reads only this line should understand why they care.
    expect(msg.toLowerCase()).toContain("title")
    expect(msg).toMatch(/cold cache|400/)
  })

  it("does not leak a whole session id into the log line", () => {
    const full = "ses_fe4c090d9ffeymDAOxKAoBeqQ2"
    const msg = notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: full,
    })!
    expect(msg).not.toContain(full)
  })

  it("is bounded — a long-lived proxy cannot grow one entry per session forever", () => {
    for (let i = 0; i < 5000; i++) {
      notePluginlessOpenCodeRequest({
        userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: `ses_${i}`,
      })
    }
    // The earliest sessions have been evicted, so they warn again rather than
    // being remembered forever. That is the intended trade: bounded memory.
    expect(notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: "ses_0",
    })).toBeDefined()
    // A recent one is still remembered.
    expect(notePluginlessOpenCodeRequest({
      userAgent: OPENCODE_UA, agentModeHeader: undefined, sessionId: "ses_4999",
    })).toBeUndefined()
  })
})

/**
 * The unit tests above pin the decision; this pins that the request path
 * actually asks. A helper nobody calls is the classic way a warning like this
 * ships dead.
 */
describe("plugin-less warning through the HTTP path", () => {
  it("records a diagnostic for a plugin-less OpenCode request, and not for a plugin-ful one", async () => {
    const { mock } = await import("bun:test")
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => (async function* () {
        yield {
          type: "assistant",
          uuid: "u1",
          session_id: "test-session",
          message: { id: "m1", type: "message", role: "assistant", model: "m",
            content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 } },
        }
      })(),
      createSdkMcpServer: () => ({ type: "sdk", name: "t", instance: { tool: () => {}, registerTool: () => ({}) } }),
      tool: () => ({}),
    }))
    mock.module("../logger", () => ({ claudeLog: () => {}, withClaudeLogContext: (_c: unknown, f: () => unknown) => f() }))
    mock.module("../mcpTools", () => ({
      createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
    }))

    const { createProxyServer, clearSessionCache } = await import("../proxy/server")
    const { diagnosticLog } = await import("../telemetry")
    clearSessionCache()
    clearPluginlessWarnings()
    diagnosticLog.clear()

    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const send = (headers: Record<string, string>) => app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 32, stream: false,
        messages: [{ role: "user", content: "hi" }] }),
    }))

    // Plugin-less: exactly what OpenCode 1.18.11 sends on its own.
    await send({ "user-agent": OPENCODE_UA, "x-session-affinity": "ses_pluginless" })
    const afterPluginless = diagnosticLog.getRecent({ limit: 50 })
      .filter((l) => l.message.includes("without the Meridian plugin"))
    expect(afterPluginless.length).toBe(1)
    expect(afterPluginless[0]!.level).toBe("warn")

    // Plugin-ful: the agent header is present, so nothing new is logged.
    await send({
      "user-agent": OPENCODE_UA,
      "x-opencode-session": "ses_withplugin",
      "x-opencode-agent-mode": "primary",
      "x-opencode-agent-name": "build",
    })
    const afterPluginful = diagnosticLog.getRecent({ limit: 50 })
      .filter((l) => l.message.includes("without the Meridian plugin"))
    expect(afterPluginful.length).toBe(1)
  })
})
