/**
 * The idle transcript sweep as the proxy wires it, with the SDK mocked.
 *
 * Pinned here: what an idle child is handed (the request isolation, the
 * resolved period, no prompt, no session persistence, no credential of its
 * own, every proxy variable pointing at a loopback proxy that refuses), that
 * the stored login it runs beside is left untouched, and that a root with a
 * request's Claude Code process in it is left alone until that request ends.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

interface SweepChildRecord {
  readonly options: Record<string, any>
  connectReply: string
  promptMessages: number
}

let sweepChildren: SweepChildRecord[] = []
let requestStarted: () => void = () => undefined
let releaseRequest: () => void = () => undefined
let requestGate: Promise<void> = Promise.resolve()

function proxyReply(proxyUrl: string): Promise<string> {
  const { hostname, port } = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    let reply = ""
    const socket = connect(Number(port), hostname, () => {
      socket.write("CONNECT platform.claude.com:443 HTTP/1.1\r\nHost: platform.claude.com:443\r\n\r\n")
    })
    socket.on("data", (chunk) => { reply += chunk.toString("latin1") })
    socket.on("close", () => resolve(reply.split("\r\n")[0] ?? ""))
    socket.on("error", reject)
  })
}

installSdkMock(() => ({
  query: (params: any) => {
    const options = params.options ?? {}
    if (options.persistSession === false) {
      return (async function* () {
        const record: SweepChildRecord = { options, connectReply: await proxyReply(options.env.HTTPS_PROXY), promptMessages: 0 }
        sweepChildren.push(record)
        void (async () => {
          for await (const _message of params.prompt) record.promptMessages++
        })()
        // What Claude Code does once its background cleanup has run.
        setTimeout(() => writeFileSync(join(options.env.CLAUDE_CONFIG_DIR, ".last-cleanup"), "now"), 30)
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }))
        throw new Error("Claude Code process aborted by user")
      })()
    }
    const sessionId = resolveMockSdkSessionId(options, "request-session")
    return (async function* () {
      requestStarted()
      await requestGate
      yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-transcript-sweep.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "MERIDIAN_CREDENTIALS_READONLY"]

describe.skipIf(process.platform === "darwin")("idle transcript sweep through the proxy", () => {
  let dir: string
  let rootA: string
  let rootB: string
  const saved: Record<string, string | undefined> = {}

  function fileDigest(path: string): string {
    const stat = statSync(path)
    return `${stat.ino}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
  }

  function makeRoot(name: string): string {
    const root = join(dir, name)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 6 * 3_600_000 },
    }), { mode: 0o600 })
    makeDue(root)
    return root
  }

  function makeDue(root: string): void {
    writeFileSync(join(root, ".last-cleanup"), "then")
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000
    utimesSync(join(root, ".last-cleanup"), twoDaysAgo, twoDaysAgo)
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    dir = mkdtempSync(join(tmpdir(), "meridian-proxy-transcript-sweep-"))
    rootA = makeRoot("a")
    rootB = makeRoot("b")
    sweepChildren = []
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const server = () => createProxyServer({
    port: 0,
    host: "127.0.0.1",
    silent: true,
    profiles: [{ id: "a", claudeConfigDir: rootA }, { id: "b", claudeConfigDir: rootB }],
    defaultProfile: "a",
  })

  it("starts each due root's child isolated, with no prompt, no network and no credential of its own", async () => {
    process.env.ANTHROPIC_API_KEY = "inherited-api-key"
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-oauth-token"
    const before = [fileDigest(join(rootA, ".credentials.json")), fileDigest(join(rootB, ".credentials.json"))]

    const results = await server().transcriptSweep!.runPass()

    expect(results.map((result) => [result.profileIds, result.outcome.kind])).toEqual([[["a"], "swept"], [["b"], "swept"]])
    expect(sweepChildren.map((child) => child.options.cwd)).toEqual([rootA, rootB])
    for (const child of sweepChildren) {
      const { options } = child
      expect(options.settingSources).toEqual([])
      expect(options.settings.cleanupPeriodDays).toBe(30)
      expect(options.persistSession).toBe(false)
      expect(options.tools).toEqual([])
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(options.cwd)
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(options.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      for (const key of ["HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
        expect(options.env[key]).toBe(options.env.HTTPS_PROXY)
      }
      expect(options.env.NO_PROXY).toBe("")
      expect(options.env.no_proxy).toBe("")
      expect(child.connectReply).toBe("HTTP/1.1 502 Bad Gateway")
      expect(child.promptMessages).toBe(0)
    }
    expect([fileDigest(join(rootA, ".credentials.json")), fileDigest(join(rootB, ".credentials.json"))]).toEqual(before)
  })

  it("leaves a root alone while a request's Claude Code process runs there", async () => {
    const proxy = server()
    let started!: Promise<void>
    started = new Promise<void>((resolve) => { requestStarted = resolve })
    requestGate = new Promise<void>((resolve) => { releaseRequest = resolve })
    const response = proxy.app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-meridian-profile": "a" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }),
    }))
    await started

    const whileBusy = await proxy.transcriptSweep!.runPass()
    expect(whileBusy.map((result) => result.outcome.kind === "skipped" ? result.outcome.reason : result.outcome.kind))
      .toEqual(["busy", "swept"])

    releaseRequest()
    expect((await response).status).toBe(200)
    makeDue(rootB)
    const afterwards = await proxy.transcriptSweep!.runPass()
    expect(afterwards.map((result) => result.outcome.kind)).toEqual(["swept", "swept"])
    requestGate = Promise.resolve()
  })

  it("starts nothing under MERIDIAN_CREDENTIALS_READONLY", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    expect(await server().transcriptSweep!.runPass()).toEqual([])
    expect(sweepChildren).toHaveLength(0)
  })
})
