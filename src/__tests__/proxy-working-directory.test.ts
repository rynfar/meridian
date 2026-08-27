/**
 * Working Directory Tests
 *
 * The proxy must pass the correct working directory to the Claude SDK
 * so that Claude's system prompt shows the user's project directory,
 * not the proxy's installation directory.
 *
 * Configurable via CLAUDE_PROXY_WORKDIR env var. When the resolved cwd
 * doesn't exist on the proxy host (remote-server case, issue #381) we
 * fall back to process.cwd() to keep the SDK spawn from dying with
 * ENOENT.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

const V1_BODY = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode-request.json"), "utf8"))
const V2_CAPTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode-v2-request.json"), "utf8"))

let mockMessages: any[] = []
let capturedQueryParams: any = null
let capturedQueryHistory: any[] = []

installSdkMock(() => ({
  query: (params: any) => {
    capturedQueryParams = params
    capturedQueryHistory.push(params)
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, params.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-working-directory.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(
  app: any,
  body: any,
  headers: Record<string, string> = {},
  path = "/v1/messages",
) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

function systemPromptAppend(params: any): string {
  const prompt = params?.options?.systemPrompt
  return typeof prompt === "string" ? prompt : prompt?.append ?? ""
}

function clientCwdFromAppend(params: any): string | undefined {
  return systemPromptAppend(params).match(/<env>\nWorking directory: ([^\n]+)\n<\/env>/)?.[1]
}

describe("Working directory", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hi" }])]
    capturedQueryParams = null
    capturedQueryHistory = []
    clearSessionCache()
  })

  it("should pass cwd option to the SDK query", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.cwd).toBeDefined()
    expect(typeof capturedQueryParams.options.cwd).toBe("string")
  })

  it("should use CLAUDE_PROXY_WORKDIR when set and the path exists", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    // tmpdir() always exists; using a fake path triggers the existsSync
    // fallback (covered separately below).
    const realPath = tmpdir()
    process.env.CLAUDE_PROXY_WORKDIR = realPath

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }, { "user-agent": "opencode/1.18.22" })).json()

      expect(capturedQueryParams.options.cwd).toBe(realPath)
      expect(clientCwdFromAppend(capturedQueryParams)).toBeUndefined()
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
      else delete process.env.CLAUDE_PROXY_WORKDIR
    }
  })

  it("should fall back to process.cwd() when CLAUDE_PROXY_WORKDIR points at a non-existent path (#381)", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    process.env.CLAUDE_PROXY_WORKDIR = "/this/definitely/does/not/exist/zzz"

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
      else delete process.env.CLAUDE_PROXY_WORKDIR
    }
  })

  it("should fall back to process.cwd() when client-supplied cwd doesn't exist (#381 remote-host case)", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.MERIDIAN_WORKDIR

    try {
      const app = createTestApp()
      // Simulate OpenCode embedding a remote machine's path in <env>.
      // The path doesn't exist on the proxy host — without the fallback,
      // the SDK would fail with ENOENT (reported as "binary not found").
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        system: "<env>\nWorking directory: /Users/remoteclient/proj\nIs directory a git repo: yes\n</env>",
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })

  it("should use the client-supplied cwd when it exists on the proxy host (same-host case)", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.MERIDIAN_WORKDIR

    try {
      const realPath = tmpdir()
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        system: `<env>\nWorking directory: ${realPath}\nIs directory a git repo: yes\n</env>`,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(realPath)
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })

  it("should default to process.cwd() when CLAUDE_PROXY_WORKDIR is not set", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })

  it("routes a captured V1 non-stream request through HTTP without losing the remote CWD", async () => {
    const originalProxy = process.env.CLAUDE_PROXY_WORKDIR
    const originalMeridian = process.env.MERIDIAN_WORKDIR
    const proxyPath = tmpdir()
    process.env.CLAUDE_PROXY_WORKDIR = proxyPath
    delete process.env.MERIDIAN_WORKDIR

    try {
      const app = createTestApp()
      const body = structuredClone(V1_BODY)
      body.stream = false
      const response = await post(app, body, {
        "user-agent": "opencode/1.18.22",
        "x-opencode-session": "ses_cwd_v1",
        "x-opencode-agent-mode": "primary",
      })
      await response.json()

      expect(response.status).toBe(200)
      expect(capturedQueryHistory).toHaveLength(1)
      expect(capturedQueryParams.options.cwd).toBe(proxyPath)
      expect(clientCwdFromAppend(capturedQueryParams)).toBe("C:\\projects\\example-app")
      expect(systemPromptAppend(capturedQueryParams)).toContain("Client-managed tools run in the client environment")
    } finally {
      if (originalProxy === undefined) delete process.env.CLAUDE_PROXY_WORKDIR
      else process.env.CLAUDE_PROXY_WORKDIR = originalProxy
      if (originalMeridian === undefined) delete process.env.MERIDIAN_WORKDIR
      else process.env.MERIDIAN_WORKDIR = originalMeridian
    }
  })

  it("routes the captured supported V2 stream shape and exact request URL through HTTP", async () => {
    const originalProxy = process.env.CLAUDE_PROXY_WORKDIR
    const originalMeridian = process.env.MERIDIAN_WORKDIR
    const proxyPath = tmpdir()
    process.env.CLAUDE_PROXY_WORKDIR = proxyPath
    delete process.env.MERIDIAN_WORKDIR

    try {
      const app = createTestApp()
      const response = await post(app, structuredClone(V2_CAPTURE.body), {
        "user-agent": V2_CAPTURE.capture.userAgent,
        "x-session-affinity": "ses_cwd_v2",
      }, V2_CAPTURE.capture.requestUrl)
      await response.text()

      expect(response.status).toBe(200)
      expect(capturedQueryHistory).toHaveLength(1)
      expect(capturedQueryParams.options.cwd).toBe(proxyPath)
      expect(capturedQueryParams.options.includePartialMessages).toBe(true)
      expect(clientCwdFromAppend(capturedQueryParams)).toBe("C:\\projects\\example-v2-app")
      expect(systemPromptAppend(capturedQueryParams)).not.toContain("`git status`")
    } finally {
      if (originalProxy === undefined) delete process.env.CLAUDE_PROXY_WORKDIR
      else process.env.CLAUDE_PROXY_WORKDIR = originalProxy
      if (originalMeridian === undefined) delete process.env.MERIDIAN_WORKDIR
      else process.env.MERIDIAN_WORKDIR = originalMeridian
    }
  })

  it("keeps the environment boundary when client and proxy report the same path text", async () => {
    const originalProxy = process.env.CLAUDE_PROXY_WORKDIR
    const originalMeridian = process.env.MERIDIAN_WORKDIR
    const sharedText = tmpdir()
    process.env.CLAUDE_PROXY_WORKDIR = sharedText
    delete process.env.MERIDIAN_WORKDIR

    try {
      const app = createTestApp()
      const response = await post(app, {
        model: "claude-haiku-4-5",
        max_tokens: 64,
        stream: false,
        system: `<env>\nWorking directory: ${sharedText}\nIs directory a git repo: no\n</env>`,
        messages: [{ role: "user", content: "hello" }],
      }, {
        "user-agent": "opencode/1.18.22",
        "x-opencode-session": "ses_equal_path",
      })
      await response.json()

      expect(response.status).toBe(200)
      expect(capturedQueryParams.options.cwd).toBe(sharedText)
      expect(clientCwdFromAppend(capturedQueryParams)).toBe(sharedText)
      expect(systemPromptAppend(capturedQueryParams)).toContain("may not describe the client environment")
    } finally {
      if (originalProxy === undefined) delete process.env.CLAUDE_PROXY_WORKDIR
      else process.env.CLAUDE_PROXY_WORKDIR = originalProxy
      if (originalMeridian === undefined) delete process.env.MERIDIAN_WORKDIR
      else process.env.MERIDIAN_WORKDIR = originalMeridian
    }
  })
})
