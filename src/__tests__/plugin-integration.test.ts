/**
 * End-to-end plugin system test.
 *
 * Starts a real proxy server, points its plugins.json at a real plugin file
 * on disk (loaded via absolute path, simulating an external plugin repo),
 * and verifies the plugin's onRequest hook actually modifies the payload
 * sent to the SDK on a live HTTP request.
 *
 * This is the integration test that proves the loader → pipeline → request
 * handler wiring works together. Unit tests in plugin-loader.test.ts and
 * transform-pipeline.test.ts cover the pieces in isolation.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { assistantMessage } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request, ...rest: any[]) => Response | Promise<Response> }

let mockMessages: MockSdkMessage[] = []
interface CapturedParams {
  prompt?: unknown
  options?: Record<string, unknown>
}
let capturedParams: CapturedParams | null = null
function getCaptured(): CapturedParams | null { return capturedParams }

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedParams = params as CapturedParams
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: "sdk-integ-1" }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const sessionTmpDir = mkdtempSync(join(tmpdir(), "plugin-integ-sess-"))
process.env.CLAUDE_PROXY_SESSION_DIR = sessionTmpDir

// Isolate the test from any shell-exported auth key so `/plugins/*` and
// `/v1/*` don't return 401 during fetches below.
const savedApiKey = process.env.MERIDIAN_API_KEY
delete process.env.MERIDIAN_API_KEY

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(sessionTmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  if (savedApiKey !== undefined) process.env.MERIDIAN_API_KEY = savedApiKey
  mock.restore()
})

describe("Plugin integration — end-to-end via HTTP", () => {
  let pluginDir: string
  let externalPluginDir: string
  let pluginConfigPath: string

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedParams = null
    clearSessionCache()
    clearSharedSessions()

    pluginDir = mkdtempSync(join(tmpdir(), "plugin-integ-dir-"))
    externalPluginDir = mkdtempSync(join(tmpdir(), "plugin-integ-ext-"))
    pluginConfigPath = join(pluginDir, "plugins.json")
  })

  async function post(app: TestApp, body: unknown, headers: Record<string, string> = {}) {
    return app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }))
  }

  it("loads an absolute-path plugin and applies its onRequest hook to a live request", async () => {
    // External plugin lives outside ~/.config/meridian/plugins/ — simulates
    // a cloned-repo install (meridian-plugin-pi-scrub and friends).
    const externalPluginPath = join(externalPluginDir, "marker.js")
    writeFileSync(externalPluginPath, `
      export default {
        name: "marker",
        version: "1.0.0",
        description: "Prepends a marker to systemContext",
        onRequest(ctx) {
          return { ...ctx, systemContext: "[MARKED] " + (ctx.systemContext || "") }
        },
      }
    `)

    // Point plugins.json at the absolute path. Do NOT create ~/.config/meridian/plugins/
    // directory — proves the loader picks up config-referenced plugins even
    // when the auto-scan dir is missing.
    /* no config dir needed — pluginConfigPath is explicit */
    writeFileSync(
      pluginConfigPath,
      JSON.stringify({ plugins: [{ path: externalPluginPath, enabled: true }] })
    )

    const { app, initPlugins } = createProxyServer({ port: 0, host: "127.0.0.1", pluginDir: join(pluginDir, "plugins"), pluginConfigPath })
    if (initPlugins) await initPlugins()

    // Confirm the plugin loaded via the /plugins/list endpoint
    const listRes = await app.fetch(new Request("http://localhost/plugins/list"))
    const list = await listRes.json() as { plugins: Array<{ name: string; status: string }> }
    const marker = list.plugins.find(p => p.name === "marker")
    expect(marker).toBeDefined()
    expect(marker!.status).toBe("active")

    // Make a real request. The plugin's onRequest should prepend `[MARKED] `
    // to whatever systemContext reaches the SDK.
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      system: "you are helpful",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    await res.json()

    // The SDK call should have received the modified system prompt. In
    // meridian's text-prompt path, systemContext goes through the
    // resolveSystemPrompt helper — we can assert on options.systemPrompt.
    const captured = getCaptured()
    expect(captured).toBeTruthy()
    const systemOpt = captured!.options?.systemPrompt as string | { append?: string }
    const systemStr = typeof systemOpt === "string" ? systemOpt : systemOpt?.append ?? ""
    expect(systemStr).toContain("[MARKED]")
    expect(systemStr).toContain("you are helpful")
  })

  it("respects adapter scoping — plugin only runs for its configured adapter", async () => {
    const piOnlyPath = join(externalPluginDir, "pi-only.js")
    writeFileSync(piOnlyPath, `
      export default {
        name: "pi-only",
        version: "1.0.0",
        adapters: ["pi"],
        onRequest(ctx) {
          return { ...ctx, systemContext: "[PI_ONLY] " + (ctx.systemContext || "") }
        },
      }
    `)

    /* no config dir needed — pluginConfigPath is explicit */
    writeFileSync(
      pluginConfigPath,
      JSON.stringify({ plugins: [{ path: piOnlyPath, enabled: true }] })
    )

    const { app, initPlugins } = createProxyServer({ port: 0, host: "127.0.0.1", pluginDir: join(pluginDir, "plugins"), pluginConfigPath })
    if (initPlugins) await initPlugins()

    // Send via OpenCode session header → adapter = opencode, plugin should NOT run.
    await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      system: "base",
      messages: [{ role: "user", content: "hi" }],
    }, { "x-opencode-session": "integ-scope-1", "User-Agent": "opencode/1.0.0" })

    const opencodeCaptured = getCaptured()
    const opencodeSystem = opencodeCaptured?.options?.systemPrompt as string | { append?: string }
    const opencodeStr = typeof opencodeSystem === "string" ? opencodeSystem : opencodeSystem?.append ?? ""
    expect(opencodeStr).not.toContain("[PI_ONLY]")

    // Now as pi (no session header, meridian defaults to opencode for unknown UAs
    // — pi requires MERIDIAN_DEFAULT_AGENT=pi or the x-meridian-agent header).
    capturedParams = null
    await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      system: "base",
      messages: [{ role: "user", content: "hi" }],
    }, { "x-meridian-agent": "pi" })

    const piCaptured = getCaptured()
    const piSystem = piCaptured?.options?.systemPrompt as string | { append?: string }
    const piStr = typeof piSystem === "string" ? piSystem : piSystem?.append ?? ""
    expect(piStr).toContain("[PI_ONLY]")
  })

  it("plugin errors are isolated — a throwing plugin doesn't crash the request", async () => {
    const throwerPath = join(externalPluginDir, "thrower.js")
    const markerPath = join(externalPluginDir, "marker2.js")
    writeFileSync(throwerPath, `
      export default {
        name: "thrower",
        onRequest(ctx) { throw new Error("intentional test failure") },
      }
    `)
    writeFileSync(markerPath, `
      export default {
        name: "marker2",
        onRequest(ctx) {
          return { ...ctx, systemContext: "[M2] " + (ctx.systemContext || "") }
        },
      }
    `)

    /* no config dir needed — pluginConfigPath is explicit */
    writeFileSync(
      pluginConfigPath,
      JSON.stringify({
        plugins: [
          { path: throwerPath, enabled: true },
          { path: markerPath, enabled: true },
        ],
      })
    )

    const { app, initPlugins } = createProxyServer({ port: 0, host: "127.0.0.1", pluginDir: join(pluginDir, "plugins"), pluginConfigPath })
    if (initPlugins) await initPlugins()

    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      system: "base",
      messages: [{ role: "user", content: "hi" }],
    })

    // Request still succeeds — thrower is skipped, marker2 still runs.
    expect(res.status).toBe(200)
    await res.json()
    const captured = getCaptured()
    const systemOpt = captured?.options?.systemPrompt as string | { append?: string }
    const systemStr = typeof systemOpt === "string" ? systemOpt : systemOpt?.append ?? ""
    expect(systemStr).toContain("[M2]")
  })

  it("POST /plugins/reload picks up changes without restart", async () => {
    const pluginPath = join(externalPluginDir, "reload-test.js")
    writeFileSync(pluginPath, `
      export default {
        name: "reload-test-v1",
        version: "1.0.0",
        onRequest(ctx) { return ctx },
      }
    `)

    /* no config dir needed — pluginConfigPath is explicit */
    writeFileSync(
      pluginConfigPath,
      JSON.stringify({ plugins: [{ path: pluginPath, enabled: true }] })
    )

    const { app, initPlugins } = createProxyServer({ port: 0, host: "127.0.0.1", pluginDir: join(pluginDir, "plugins"), pluginConfigPath })
    if (initPlugins) await initPlugins()

    const beforeRes = await app.fetch(new Request("http://localhost/plugins/list"))
    const before = await beforeRes.json() as { plugins: Array<{ name: string; version?: string }> }
    expect(before.plugins.find(p => p.name === "reload-test-v1")).toBeDefined()

    // Rewrite the plugin file on disk
    writeFileSync(pluginPath, `
      export default {
        name: "reload-test-v2",
        version: "2.0.0",
        onRequest(ctx) { return ctx },
      }
    `)

    const reloadRes = await app.fetch(new Request("http://localhost/plugins/reload", { method: "POST" }))
    expect(reloadRes.status).toBe(200)

    const afterRes = await app.fetch(new Request("http://localhost/plugins/list"))
    const after = await afterRes.json() as { plugins: Array<{ name: string; version?: string }> }
    expect(after.plugins.find(p => p.name === "reload-test-v2")).toBeDefined()
    expect(after.plugins.find(p => p.name === "reload-test-v1")).toBeUndefined()
  })
})
