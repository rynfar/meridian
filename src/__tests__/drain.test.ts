/**
 * POST /drain: new requests are held (never refused) so the running ones can
 * finish and GET /inflight can reach 0; a drain ends by DELETE, by its own
 * timeout, or at shutdown, and each held request is admitted at its hold cap.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir } from "../proxy/sessionStore"
import { AdmissionHold, DEFAULT_DRAIN_OPTIONS, parseDrainOptions } from "../proxy/admissionHold"
import {
  assistantMessage,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
  resolveMockSdkSessionId,
  textBlockStart,
  textDelta,
} from "./helpers"

interface AttemptControl {
  release: () => void
  started: Promise<void>
}

let controls: AttemptControl[] = []
let queryCalls = 0

installSdkMock(() => ({
  query: (params: any) => {
    queryCalls++
    let release = () => {}
    let markStarted = () => {}
    const wait = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    controls.push({ release, started })
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-drain-${queryCalls}`)
    const generator = (async function* () {
      markStarted()
      yield { ...messageStart(), session_id: sessionId }
      await wait
      yield { ...textBlockStart(0), session_id: sessionId }
      yield { ...textDelta(0, "ok"), session_id: sessionId }
      yield { ...blockStop(0), session_id: sessionId }
      yield { ...messageDelta("end_turn"), session_id: sessionId }
      yield { ...messageStop(), session_id: sessionId }
      yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
    })()
    return Object.assign(generator, { close: () => {} })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "drain.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, startProxyServer, clearSessionCache } = await import("../proxy/server")

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } }

function messages(sessionId: string, stream: boolean): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages: [{ role: "user", content: "hi" }] }),
  })
}

function drainRequest(method: "POST" | "DELETE", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/drain", {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(2)
  }
}

describe("AdmissionHold", () => {
  it("admits at once without a drain", async () => {
    const hold = new AdmissionHold()
    await hold.admit()
    expect(hold.snapshot()).toMatchObject({ active: false, held: 0, lastEnded: null })
  })

  it("holds new requests until the drain is cancelled, then admits every one", async () => {
    const ended: string[] = []
    const hold = new AdmissionHold((reason) => { ended.push(reason) })
    const started = hold.start({ holdMs: 60_000, timeoutMs: 60_000 }, 1_000)
    expect(started).toMatchObject({ active: true, startedAt: new Date(1_000).toISOString(), endsAt: new Date(61_000).toISOString(), holdMs: 60_000 })
    let admitted = 0
    const waits = [hold.admit().then(() => { admitted++ }), hold.admit().then(() => { admitted++ })]
    await Bun.sleep(10)
    expect(admitted).toBe(0)
    expect(hold.snapshot().held).toBe(2)
    expect(hold.end("cancelled")).toBe(true)
    await Promise.all(waits)
    expect(admitted).toBe(2)
    expect(hold.snapshot()).toMatchObject({ active: false, held: 0, lastEnded: { reason: "cancelled" } })
    expect(ended).toEqual(["cancelled"])
    expect(hold.end("cancelled")).toBe(false)
  })

  it("admits a held request once it has waited holdMs, while the drain stays active", async () => {
    const hold = new AdmissionHold()
    hold.start({ holdMs: 30, timeoutMs: 60_000 })
    const before = Date.now()
    await hold.admit()
    expect(Date.now() - before).toBeGreaterThanOrEqual(25)
    expect(hold.snapshot()).toMatchObject({ active: true, held: 0, admittedAtCap: 1 })
    hold.end("cancelled")
  })

  it("ends by itself at its timeout and admits whoever is held", async () => {
    const ended: string[] = []
    const hold = new AdmissionHold((reason) => { ended.push(reason) })
    hold.start({ holdMs: 60_000, timeoutMs: 30 })
    await hold.admit()
    expect(hold.active).toBe(false)
    expect(ended).toEqual(["timeout"])
    expect(hold.snapshot().lastEnded?.reason).toBe("timeout")
  })

  it("lets a client that went away go at once", async () => {
    const hold = new AdmissionHold()
    hold.start({ holdMs: 60_000, timeoutMs: 60_000 })
    const controller = new AbortController()
    const waiting = hold.admit(controller.signal)
    await Bun.sleep(5)
    controller.abort()
    await waiting
    expect(hold.snapshot().held).toBe(0)
    hold.end("cancelled")
  })

  it("keeps the first drain's terms when started again", () => {
    const hold = new AdmissionHold()
    const first = hold.start({ holdMs: 5_000, timeoutMs: 20_000 }, 0)
    const again = hold.start({ holdMs: 9_000, timeoutMs: 90_000 }, 5_000)
    expect(again).toEqual(first)
    hold.end("cancelled")
  })
})

describe("parseDrainOptions", () => {
  it("defaults absent fields and bounds present ones", () => {
    expect(parseDrainOptions(undefined)).toEqual(DEFAULT_DRAIN_OPTIONS)
    expect(parseDrainOptions({})).toEqual(DEFAULT_DRAIN_OPTIONS)
    expect(parseDrainOptions({ holdMs: 30_000, timeoutMs: 120_000 })).toEqual({ holdMs: 30_000, timeoutMs: 120_000 })
    expect(parseDrainOptions({ holdMs: 500 })).toBe("holdMs must be an integer from 1000 to 240000")
    expect(parseDrainOptions({ timeoutMs: 1.5 })).toBe("timeoutMs must be an integer from 10000 to 3600000")
    expect(parseDrainOptions({ holdMs: "60000" })).toBe("holdMs must be an integer from 1000 to 240000")
    expect(parseDrainOptions([1])).toBe("body must be a JSON object")
  })
})

describe("POST /drain", () => {
  let sessionDir = ""

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-drain-test-"))
    setSessionStoreDir(sessionDir)
    queryCalls = 0
    controls = []
    clearSessionCache()
  })

  afterEach(async () => {
    for (const control of controls) control.release()
    await Bun.sleep(25)
    rmSync(sessionDir, { recursive: true, force: true })
  })

  it("answers only loopback callers that are not browser pages", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    expect((await app.fetch(drainRequest("POST"))).status).toBe(403)
    expect((await app.fetch(drainRequest("POST"), { incoming: { socket: { remoteAddress: "192.168.1.20" } } })).status).toBe(403)
    expect((await app.fetch(drainRequest("POST", undefined, { "x-forwarded-for": "203.0.113.9" }), LOOPBACK)).status).toBe(403)
    expect((await app.fetch(drainRequest("POST", undefined, { origin: "http://localhost:8080" }), LOOPBACK)).status).toBe(403)
    expect((await app.fetch(drainRequest("DELETE", undefined, { origin: "http://localhost:8080" }), LOOPBACK)).status).toBe(403)
    const inflight = await (await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json() as { draining: boolean }
    expect(inflight.draining).toBe(false)
    expect((await app.fetch(drainRequest("POST", { holdMs: 1 }), LOOPBACK)).status).toBe(400)
  })

  it("holds a new turn while the running one finishes, so /inflight reaches 0, then admits it on DELETE", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const inflight = async () => (await (await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()) as {
      scope: string
      total: number
      draining: boolean
      drain: { active: boolean; held: number; holdMs: number | null; endsAt: string | null }
    }

    const running = await app.fetch(messages("drain-a", true))
    await waitFor(() => controls.length === 1, "the running stream to reach the SDK")
    await controls[0]!.started

    const start = await app.fetch(drainRequest("POST"), LOOPBACK)
    expect(start.status).toBe(200)
    expect(await start.json()).toMatchObject({ started: true, drain: { active: true, holdMs: DEFAULT_DRAIN_OPTIONS.holdMs } })
    expect(await (await app.fetch(drainRequest("POST"), LOOPBACK)).json()).toMatchObject({ started: false })

    let heldSettled = false
    const held = Promise.resolve(app.fetch(messages("drain-b", false))).finally(() => { heldSettled = true })
    await waitFor(async () => (await inflight()).drain.held === 1, "the new turn to be held")
    let seen = await inflight()
    expect(seen).toMatchObject({ scope: "client-http", total: 1, draining: true })
    expect(controls.length).toBe(1)

    controls[0]!.release()
    await running.text()
    await waitFor(async () => (await inflight()).total === 0, "the running stream to finish")
    seen = await inflight()
    expect(seen.drain.held).toBe(1)
    expect(heldSettled).toBe(false)

    const cancel = await app.fetch(drainRequest("DELETE"), LOOPBACK)
    expect(await cancel.json()).toMatchObject({ ended: true, drain: { active: false, lastEnded: { reason: "cancelled" } } })
    await waitFor(() => controls.length === 2, "the held turn to reach the SDK")
    controls[1]!.release()
    const response = await held
    expect(response.status).toBe(200)
    expect((await inflight()).draining).toBe(false)
  }, 20_000)

  it("admits a held turn normally at the hold cap, and the drain ends by itself at its timeout", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    await app.fetch(drainRequest("POST", { holdMs: 1_000, timeoutMs: 10_000 }), LOOPBACK)
    const began = Date.now()
    const held = app.fetch(messages("drain-cap", false))
    await waitFor(() => controls.length === 1, "the held turn to be admitted at its cap", 5_000)
    expect(Date.now() - began).toBeGreaterThanOrEqual(900)
    controls[0]!.release()
    expect((await held).status).toBe(200)
    const during = await (await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json() as { draining: boolean; drain: { admittedAtCap: number } }
    expect(during).toMatchObject({ draining: true, drain: { admittedAtCap: 1 } })
    await waitFor(async () => {
      const body = await (await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json() as { draining: boolean }
      return body.draining === false
    }, "the drain to time out", 15_000)
  }, 30_000)

  it("releases held requests into the shutdown answer when the process shuts down", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const held = proxy.app.fetch(messages("drain-shutdown", false))
    await Bun.sleep(20)
    proxy.beginDrain!()
    const response = await held
    expect(response.status).toBe(503)
    expect(response.headers.get("x-meridian-draining")).toBe("1")
    expect(controls.length).toBe(0)
  })

  it("reads the real socket peer when served over HTTP", async () => {
    const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    try {
      const { port } = proxy.server.address() as AddressInfo
      const started = await fetch(`http://127.0.0.1:${port}/drain`, { method: "POST" })
      expect(started.status).toBe(200)
      const proxied = await fetch(`http://127.0.0.1:${port}/drain`, { method: "DELETE", headers: { "x-forwarded-for": "203.0.113.9" } })
      expect(proxied.status).toBe(403)
      const ended = await fetch(`http://127.0.0.1:${port}/drain`, { method: "DELETE" })
      expect(await ended.json()).toMatchObject({ ended: true })
    } finally {
      await proxy.close()
    }
  }, 20_000)
})
