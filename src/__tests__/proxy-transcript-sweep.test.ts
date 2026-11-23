/**
 * The idle transcript sweep as the proxy wires it, with the SDK mocked.
 *
 * Pinned here: what an idle child is handed (the request isolation, the
 * resolved period, no prompt, no session persistence, no credential of its
 * own, every proxy variable pointing at a loopback proxy that refuses), that
 * the stored login it runs beside is left untouched, that a root with a
 * request's Claude Code process in it is left alone until that request ends,
 * that a request arriving in a root stops the child there at once, that the
 * SDK permit stays the child's until it has exited, and that a request whose
 * child will run Claude Code's cleanup first keeps the transcripts Meridian
 * still maps.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { createOwnedCredentialStore } from "./modelsMock"
import * as tokens from "../proxy/tokenRefresh"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

interface SweepChildRecord {
  readonly options: Record<string, any>
  connectReply: string
  promptMessages: number
}

let sweepChildren: SweepChildRecord[] = []
/** Whether a sweep child writes `.last-cleanup` (Claude Code's cleanup ran). */
let sweepChildCleans = true
/** A stopped sweep child exits once this settles. */
let sweepChildExitGate: Promise<void> = Promise.resolve()
let sweepChildExited = 0
let requestOptions: Record<string, any>[] = []
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
        if (sweepChildCleans) setTimeout(() => writeFileSync(join(options.env.CLAUDE_CONFIG_DIR, ".last-cleanup"), "now"), 30)
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }))
        await sweepChildExitGate
        sweepChildExited++
        throw new Error("Claude Code process aborted by user")
      })()
    }
    const sessionId = resolveMockSdkSessionId(options, "request-session")
    requestOptions.push(options)
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

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { setSetting } = await import("../settings")
const { idleTranscriptSweeps } = await import("../proxy/transcriptSweep")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const { getProcessSdkSemaphore } = await import("../proxy/concurrency")
const { storeSession } = await import("../proxy/session/cache")

function sweepOf(proxy: ReturnType<typeof createProxyServer>) {
  const sweep = idleTranscriptSweeps.get(proxy)
  if (!sweep) throw new Error("createProxyServer registered no transcript sweep")
  return sweep
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

function postMessage(proxy: ReturnType<typeof createProxyServer>, profile: string, headers: Record<string, string> = {}) {
  return proxy.app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-meridian-profile": profile, ...headers },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }),
  }))
}

/** Each test drives whole requests through the proxy, slow on a loaded host. */
const PROXY_TEST_TIMEOUT_MS = 60_000

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "MERIDIAN_CREDENTIALS_READONLY", "MERIDIAN_FOLLOW_ACTIVE"]

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

  let storeOverride: { mockRestore(): void } | undefined

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    dir = mkdtempSync(join(tmpdir(), "meridian-proxy-transcript-sweep-"))
    setSessionStoreDir(join(dir, "sessions"))
    await clearSessionCache()
    // The sweep reads each root's own login, so these roots keep the real file
    // backend behind a path guard; the SDK mock leaves every other store empty.
    tokens.setCredentialStorePlatformForTests("linux")
    storeOverride = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options =>
      createOwnedCredentialStore(dir, options?.claudeConfigDir))
    rootA = makeRoot("a")
    rootB = makeRoot("b")
    sweepChildren = []
    sweepChildCleans = true
    sweepChildExitGate = Promise.resolve()
    sweepChildExited = 0
    requestOptions = []
    requestGate = Promise.resolve()
    // Retention is opt-in; the sweep only runs where it is on.
    setSetting("transcriptRetentionDays", 30)
  })

  afterEach(async () => {
    // Request completion releases the cross-process lease asynchronously.
    await Bun.sleep(25)
    setSetting("transcriptRetentionDays", undefined)
    storeOverride?.mockRestore()
    storeOverride = undefined
    tokens.setCredentialStorePlatformForTests(null)
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const server = (maxConcurrent?: number) => createProxyServer({
    port: 0,
    host: "127.0.0.1",
    silent: true,
    profiles: [{ id: "a", claudeConfigDir: rootA }, { id: "b", claudeConfigDir: rootB }],
    defaultProfile: "a",
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
  })

  it("starts each due root's child isolated, with no prompt, no network and no credential of its own", async () => {
    process.env.ANTHROPIC_API_KEY = "inherited-api-key"
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-oauth-token"
    const before = [fileDigest(join(rootA, ".credentials.json")), fileDigest(join(rootB, ".credentials.json"))]

    const results = await sweepOf(server()).runPass()

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
  }, PROXY_TEST_TIMEOUT_MS)

  it("leaves a root alone while a request's Claude Code process runs there", async () => {
    const proxy = server()
    let started!: Promise<void>
    started = new Promise<void>((resolve) => { requestStarted = resolve })
    requestGate = new Promise<void>((resolve) => { releaseRequest = resolve })
    const response = postMessage(proxy, "a")
    await started

    const whileBusy = await sweepOf(proxy).runPass()
    expect(whileBusy.map((result) => result.outcome.kind === "skipped" ? result.outcome.reason : result.outcome.kind))
      .toEqual(["busy", "swept"])

    releaseRequest()
    expect((await response).status).toBe(200)
    makeDue(rootB)
    const afterwards = await sweepOf(proxy).runPass()
    expect(afterwards.map((result) => result.outcome.kind)).toEqual(["swept", "swept"])
  }, PROXY_TEST_TIMEOUT_MS)

  it("stops the sweep's child at once when a request arrives in its root", async () => {
    sweepChildCleans = false
    const proxy = server()
    const pass = sweepOf(proxy).runPass()
    await waitFor(() => sweepChildren.length === 1)
    expect(sweepChildren[0]?.options.cwd).toBe(rootA)

    const response = await postMessage(proxy, "a")
    expect(response.status).toBe(200)
    // Root b's child would wait for a cleanup that never comes.
    await sweepOf(proxy).stop()
    const results = await pass
    expect(results[0]?.outcome.kind).toBe("preempted")
    expect(sweepChildren[0]?.options.abortController.signal.aborted).toBe(true)
    expect(sweepOf(proxy).disabled).toBe(false)
  }, PROXY_TEST_TIMEOUT_MS)

  it("keeps the SDK permit for the sweep's child until it has exited", async () => {
    sweepChildCleans = false
    let letChildExit!: () => void
    sweepChildExitGate = new Promise<void>((resolve) => { letChildExit = resolve })
    const semaphore = getProcessSdkSemaphore()
    const activeBefore = semaphore.snapshot.active
    const proxy = server()
    const pass = sweepOf(proxy).runPass()
    await waitFor(() => sweepChildren.length === 1)
    expect(semaphore.snapshot.active).toBe(activeBefore + 1)

    let stopReturned = false
    const stopped = sweepOf(proxy).stop().then(() => { stopReturned = true })
    await waitFor(() => sweepChildren[0]?.options.abortController.signal.aborted === true)
    // Stopped, not yet exited: the permit is still the child's, and stop()
    // has not returned.
    expect(sweepChildExited).toBe(0)
    expect(semaphore.snapshot.active).toBe(activeBefore + 1)
    expect(stopReturned).toBe(false)

    letChildExit()
    await stopped
    expect(sweepChildExited).toBe(1)
    expect(semaphore.snapshot.active).toBe(activeBefore)
    expect((await pass)[0]?.outcome.kind).toBe("stopped")
  }, PROXY_TEST_TIMEOUT_MS)

  it("keeps a still-mapped transcript out of reach of a request's cleanup", async () => {
    const project = join(rootA, "projects", "-tmp-test")
    mkdirSync(project, { recursive: true })
    const pinned = join(project, "pinned-session.jsonl")
    const loose = join(project, "loose-session.jsonl")
    const fortyDaysAgo = (Date.now() - 40 * 86_400_000) / 1000
    for (const file of [pinned, loose]) {
      writeFileSync(file, "{}\n")
      utimesSync(file, fortyDaysAgo, fortyDaysAgo)
    }
    await storeSession("conversation-pinned", [{ role: "user", content: "hello" }], "pinned-session", "/tmp/test",
      undefined, undefined, undefined, undefined, { sessionId: "pinned-session", configDir: rootA, projectDir: "/tmp/test" })

    const response = await postMessage(server(), "a")
    expect(response.status).toBe(200)
    expect(requestOptions.at(-1)?.settings?.cleanupPeriodDays).toBe(30)
    expect(Date.now() - statSync(pinned).mtimeMs).toBeLessThan(3_600_000)
    expect(statSync(loose).mtimeMs).toBe(fortyDaysAgo * 1000)
  }, PROXY_TEST_TIMEOUT_MS)

  it("starts nothing under MERIDIAN_CREDENTIALS_READONLY", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    expect(await sweepOf(server()).runPass()).toEqual([])
    expect(sweepChildren).toHaveLength(0)
  }, PROXY_TEST_TIMEOUT_MS)

  it("starts nothing in an instance that follows another one", async () => {
    process.env.MERIDIAN_FOLLOW_ACTIVE = "http://127.0.0.1:9"
    expect(await sweepOf(server()).runPass()).toEqual([])
    expect(sweepChildren).toHaveLength(0)
  }, PROXY_TEST_TIMEOUT_MS)
})
