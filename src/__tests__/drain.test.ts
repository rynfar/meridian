/**
 * POST /drain: new requests are held (never refused) so the running ones can
 * finish and GET /inflight can reach 0; a drain ends by DELETE, by its own
 * timeout, or at shutdown, and each held request is admitted at its hold cap.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir } from "../proxy/sessionStore"
import * as sessionStore from "../proxy/sessionStore"
import { processSessionTree } from "../proxy/sessionTree"
import * as antigravityBackend from "../proxy/backends/antigravity"
import { disabledProvider } from "../proxy/backends/providerStatus"
import { AdmissionHold, DEFAULT_DRAIN_OPTIONS, MAX_HELD_REQUESTS, parseDrainOptions } from "../proxy/admissionHold"
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

interface CancelReceipt {
  cancelled: { sessions: number; requests: number }
  requestIds: string[]
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
const TEST_CONFIG = {
  port: 0, host: "127.0.0.1", silent: true,
  profiles: [{ id: "fixture", type: "api" as const, apiKey: "fixture-no-live-credential" }],
  defaultProfile: "fixture",
}

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

function treeMessages(session: string, parent?: string, signal?: AbortSignal, requestId?: string): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-meridian-agent": "prime", ...(requestId ? { "x-request-id": requestId } : {}) },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream: false,
      metadata: { user_id: JSON.stringify({ session_id: session, parent_session_id: parent }) },
      messages: [{ role: "user", content: "hi" }] }),
  })
}

function storeSnapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath, entry.name)
      return [path.slice(dir.length), createHash("sha256").update(readFileSync(path)).digest("hex")]
    }))
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

  it("bounds retained waiters and fails open without false cap counts", async () => {
    const hold = new AdmissionHold()
    hold.start({ holdMs: 60_000, timeoutMs: 60_000 })
    expect(MAX_HELD_REQUESTS).toBe(128)
    const reservations = Array.from({ length: 128 }, () => hold.reserve())
    expect(reservations.every(Boolean)).toBe(true)
    expect(hold.snapshot().held).toBe(MAX_HELD_REQUESTS)
    expect(hold.reserve()).toBeUndefined()
    expect(hold.snapshot()).toMatchObject({ held: MAX_HELD_REQUESTS, admittedAtCap: 0 })
    reservations[0]!.cancel()
    const replacement = hold.reserve()
    expect(replacement).toBeDefined()
    expect(hold.snapshot().held).toBe(MAX_HELD_REQUESTS)
    hold.end("cancelled")
    await Promise.all(reservations.map(reservation => reservation!.ready))
    await replacement!.ready
    expect(hold.snapshot().held).toBe(0)
  })

  it("counts a cap only after the caller accepts its live reservation", async () => {
    const hold = new AdmissionHold()
    hold.start({ holdMs: 10, timeoutMs: 60_000 })
    const refused = hold.reserve(undefined, () => false)!
    expect(await refused.ready).toBe("cap")
    expect(hold.snapshot().admittedAtCap).toBe(0)
    const accepted = hold.reserve(undefined, () => true)!
    expect(await accepted.ready).toBe("cap")
    expect(hold.snapshot().admittedAtCap).toBe(1)
    hold.end("cancelled")
  })

  it("old cancellation cannot release a successor hold and abort wins before cap", async () => {
    const hold = new AdmissionHold()
    hold.start({ holdMs: 10, timeoutMs: 60_000 })
    const old = hold.reserve()!
    hold.end("cancelled")
    hold.start({ holdMs: 60_000, timeoutMs: 60_000 })
    const signal = new AbortController()
    const next = hold.reserve(signal.signal)!
    old.cancel()
    expect(hold.snapshot().held).toBe(1)
    signal.abort()
    expect(await next.ready).toBe("aborted")
    expect(hold.snapshot()).toMatchObject({ held: 0, admittedAtCap: 0 })
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

  beforeEach(async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-drain-test-"))
    setSessionStoreDir(sessionDir)
    queryCalls = 0
    controls = []
    await clearSessionCache()
    processSessionTree.clear()
  })

  afterEach(async () => {
    for (const control of controls) control.release()
    await Bun.sleep(25)
    rmSync(sessionDir, { recursive: true, force: true })
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_API_KEY
    delete process.env.MERIDIAN_ADAPTER_INSTANCES
  })

  it("answers only loopback callers that are not browser pages", async () => {
    const { app } = createProxyServer(TEST_CONFIG)
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
    const { app } = createProxyServer(TEST_CONFIG)
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
    const { app } = createProxyServer(TEST_CONFIG)
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
    const proxy = createProxyServer(TEST_CONFIG)
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
    const proxy = await startProxyServer(TEST_CONFIG)
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

  it("honors both configured key forms while inflight remains keyless", async () => {
    process.env.MERIDIAN_API_KEY = "operator-fixture"
    const { app } = createProxyServer(TEST_CONFIG)
    for (const method of ["POST", "DELETE"] as const) {
      expect((await app.fetch(drainRequest(method), LOOPBACK)).status).toBe(401)
      expect((await app.fetch(drainRequest(method, undefined, { "x-api-key": "wrong" }), LOOPBACK)).status).toBe(401)
      const headers: Record<string, string> = method === "POST" ? { "x-api-key": "operator-fixture" } : { authorization: "Bearer operator-fixture" }
      const response = await app.fetch(drainRequest(method, undefined, headers), LOOPBACK)
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect((await app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).status).toBe(200)
  })

  it("keeps oldestStartedAt anchored to HTTP admission rather than held arrival", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const pending = proxy.app.fetch(messages("held-timestamp", false))
    await waitFor(() => processSessionTree.stats().tracked === 1, "held timestamp request")
    await Bun.sleep(30)
    const releasedAt = Date.now()
    await proxy.app.fetch(drainRequest("DELETE"), LOOPBACK)
    await waitFor(() => controls.length === 1, "timestamp request admitted")
    const seen = await (await proxy.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json() as { oldestStartedAt: string }
    expect(Date.parse(seen.oldestStartedAt)).toBeGreaterThanOrEqual(releasedAt)
    controls[0]!.release()
    const response = await pending
    expect(response.status).toBe(200)
    await response.text()
    proxy.beginDrain!()
  })

  it("rejects every Origin and each forwarding header, including empty values", async () => {
    const { app } = createProxyServer(TEST_CONFIG)
    for (const header of ["origin", "forwarded", "x-forwarded-for", "x-real-ip"]) {
      for (const value of ["", "null", "http://localhost"]) {
        expect((await app.fetch(drainRequest("POST", undefined, { [header]: value }), LOOPBACK)).status).toBe(403)
        expect((await app.fetch(drainRequest("DELETE", undefined, { [header]: value }), LOOPBACK)).status).toBe(403)
      }
    }
  })

  it("cancels already-arrived same-key and descendant holds without future cancellation or store effects", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const before = storeSnapshot(sessionDir)
    const storeRead = spyOn(sessionStore, "readSessionStoreGenerationSnapshot")
    try {
      const same = proxy.app.fetch(treeMessages("parent", undefined, undefined, "duplicate"))
      const child = proxy.app.fetch(treeMessages("child", "parent", undefined, "duplicate"))
      const grandchild = proxy.app.fetch(treeMessages("grandchild", "child"))
      await waitFor(() => processSessionTree.stats().tracked === 3, "all parsed held identities")
      expect(proxy.getInFlightCount!()).toBe(3)
      const cancelled = await (await proxy.app.fetch(new Request("http://localhost/v1/sessions/parent/cancel", { method: "POST" }))).json() as CancelReceipt
      expect(cancelled.cancelled).toEqual({ sessions: 3, requests: 3 })
      expect(cancelled.requestIds.filter((id: string) => id === "duplicate")).toHaveLength(2)
      for (const response of await Promise.all([same, child, grandchild])) {
        expect(response.status).toBe(499)
        await response.text()
      }
      expect(queryCalls).toBe(0)
      expect(storeRead).not.toHaveBeenCalled()
      expect(storeSnapshot(sessionDir)).toEqual(before)
      expect(processSessionTree.stats().tracked).toBe(0)
      expect(proxy.getInFlightCount!()).toBe(0)
      const later = proxy.app.fetch(treeMessages("child", "parent"))
      await waitFor(() => processSessionTree.stats().tracked === 1, "a later live request")
      await proxy.app.fetch(drainRequest("DELETE"), LOOPBACK)
      await waitFor(() => controls.length === 1, "future request admitted normally")
      controls[0]!.release()
      expect((await later).status).toBe(200)
    } finally { storeRead.mockRestore(); proxy.beginDrain!() }
  })

  it("raw socket abort removes a hold with zero SDK calls and store reads", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const socket = new AbortController()
    const before = storeSnapshot(sessionDir)
    const storeRead = spyOn(sessionStore, "readSessionStoreGenerationSnapshot")
    try {
      const held = proxy.app.fetch(treeMessages("raw-abort", undefined, socket.signal))
      await waitFor(() => processSessionTree.stats().tracked === 1, "held raw socket identity")
      socket.abort()
      const response = await held
      expect(response.status).toBe(499)
      await response.text()
      await proxy.app.fetch(drainRequest("DELETE"), LOOPBACK)
      expect(queryCalls).toBe(0)
      expect(storeRead).not.toHaveBeenCalled()
      expect(storeSnapshot(sessionDir)).toEqual(before)
      expect(proxy.getInFlightCount!()).toBe(0)
      expect(processSessionTree.stats().tracked).toBe(0)
    } finally { storeRead.mockRestore(); proxy.beginDrain!() }
  })

  it("owns inactive admission before its first await and preserves accepted work during shutdown", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    const realReserve = AdmissionHold.prototype.reserve
    let ownedAtBoundary = 0
    const admission = spyOn(AdmissionHold.prototype, "reserve").mockImplementation(function (this: AdmissionHold, signal, accept) {
      ownedAtBoundary = proxy.getInFlightCount!()
      queueMicrotask(() => proxy.beginDrain!())
      return realReserve.call(this, signal, accept)
    })
    try {
      const pending = proxy.app.fetch(messages("inactive-owned", false))
      await waitFor(() => controls.length === 1, "already owned request after shutdown begins")
      expect(ownedAtBoundary).toBe(1)
      controls[0]!.release()
      const response = await pending
      expect(response.status).toBe(200)
      await response.text()
      expect(proxy.getInFlightCount!()).toBe(0)
    } finally { admission.mockRestore(); proxy.beginDrain!() }
  })

  it("owns a held original body parser through shutdown and never starts its generation", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const before = storeSnapshot(sessionDir)
    let producer: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({ start(controller) { producer = controller } })
    const pending = proxy.app.fetch(new Request("http://localhost/v1/messages", { method: "POST", body: stream, headers: { "content-type": "application/json", "x-opencode-session": "slow-body" } }))
    await waitFor(() => proxy.getInFlightCount!() === 1 && stream.locked, "the owned original parser")
    proxy.beginDrain!()
    await Bun.sleep(5)
    expect(proxy.getInFlightCount!()).toBe(1)
    producer!.enqueue(new TextEncoder().encode(JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] })))
    producer!.close()
    const response = await pending
    expect(response.status).toBe(503)
    await response.text()
    expect(queryCalls).toBe(0)
    expect(storeSnapshot(sessionDir)).toEqual(before)
    expect(proxy.getInFlightCount!()).toBe(0)
  })

  it("holds each public OpenAI translation once with its existing cancellable identity", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const requests = [
      new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "user-agent": "jcode/fixture", "x-jcode-session": "chat-held" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }) }),
      new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", input: "hi", prompt_cache_key: "responses-held" }) }),
    ]
    const pending = requests.map(request => proxy.app.fetch(request))
    await waitFor(() => processSessionTree.stats().tracked === 2, "two translated held identities")
    const seen = await (await proxy.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()
    expect(seen).toMatchObject({ total: 0, drain: { held: 2 } })
    expect(proxy.getInFlightCount!()).toBe(2)
    for (const key of ["chat-held", "responses-held"]) {
      const cancelled = await (await proxy.app.fetch(new Request(`http://localhost/v1/sessions/${key}/cancel`, { method: "POST" }))).json() as CancelReceipt
      expect(cancelled.cancelled.requests).toBe(1)
      expect(cancelled.requestIds).toHaveLength(1)
    }
    for (const response of await Promise.all(pending)) { expect(response.status).toBe(499); await response.text() }
    expect(queryCalls).toBe(0)
    expect(proxy.getInFlightCount!()).toBe(0)
    expect(processSessionTree.stats().tracked).toBe(0)
    proxy.beginDrain!()
  })

  it("transfers already-accepted OpenAI parsing ownership once across shutdown", async () => {
    for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
      const proxy = createProxyServer(TEST_CONFIG)
      const realReserve = AdmissionHold.prototype.reserve
      const reservations: number[] = []
      const admission = spyOn(AdmissionHold.prototype, "reserve").mockImplementation(function (this: AdmissionHold, signal, accept) {
        reservations.push(proxy.getInFlightCount!())
        return realReserve.call(this, signal, accept)
      })
      let producer: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({ start(controller) { producer = controller } })
      try {
        const pending = proxy.app.fetch(new Request(`http://localhost${endpoint}`, {
          method: "POST", body,
          headers: { "content-type": "application/json", "user-agent": "jcode/fixture", "x-jcode-session": "accepted-translation" },
        }))
        await waitFor(() => body.locked && proxy.getInFlightCount!() === 1, "the accepted original OpenAI parser")
        proxy.beginDrain!()
        const payload = endpoint === "/v1/responses"
          ? { model: "claude-sonnet-4-6", input: "hi", prompt_cache_key: "accepted-responses" }
          : { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }
        producer!.enqueue(new TextEncoder().encode(JSON.stringify(payload)))
        producer!.close()
        const before = controls.length
        await waitFor(() => controls.length > before, "the accepted internal Messages hop")
        expect(reservations).toEqual([1])
        expect(proxy.getInFlightCount!()).toBe(1)
        controls.at(-1)!.release()
        const response = await pending
        expect(response.status).toBe(200)
        await response.text()
        expect(proxy.getInFlightCount!()).toBe(0)
      } finally { admission.mockRestore(); proxy.beginDrain!() }
    }
  })

  it("does not let public admission-owner headers bypass a hold", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const request = messages("spoofed-owner", false)
    request.headers.set("x-meridian-internal-hop", "public-forgery")
    request.headers.set("x-meridian-admission-owner", "public-forgery")
    const pending = proxy.app.fetch(request)
    await waitFor(() => processSessionTree.liveRequestsFor("spoofed-owner").length === 1, "the forged request to remain held")
    expect(queryCalls).toBe(0)
    expect(proxy.getInFlightCount!()).toBe(1)
    const cancelled = await proxy.app.fetch(new Request("http://localhost/v1/sessions/spoofed-owner/cancel", { method: "POST" }))
    await cancelled.text()
    const response = await pending
    expect(response.status).toBe(499)
    await response.text()
    expect(proxy.getInFlightCount!()).toBe(0)
    proxy.beginDrain!()
  })

  it("keeps a held adapter's execution identity consistent if configured instances change", async () => {
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({ "configured-hold": { base: "prime" } })
    const proxy = createProxyServer(TEST_CONFIG)
    await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
    const request = treeMessages("configured-held")
    request.headers.set("x-meridian-agent", "configured-hold")
    const pending = proxy.app.fetch(request)
    await waitFor(() => processSessionTree.liveRequestsFor("configured-held").length === 1, "the original configured identity")
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({ "configured-hold": { base: "opencode" } })
    await proxy.app.fetch(drainRequest("DELETE"), LOOPBACK)
    await waitFor(() => controls.length === 1, "the held execution")
    controls[0]!.release()
    const response = await pending
    expect(response.status).toBe(200)
    await response.text()
    expect(sessionStore.lookupSharedSession("fixture:configured-held")).toBeDefined()
    expect(proxy.getInFlightCount!()).toBe(0)
    proxy.beginDrain!()
  })

  it("joins slow operator body cancellation and rejects late drain authority", async () => {
    const proxy = createProxyServer(TEST_CONFIG)
    let join = () => {}
    const joined = new Promise<void>(resolve => { join = resolve })
    let cancelStarted = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelStarted = true; return joined } })
    const pending = proxy.app.fetch(new Request("http://localhost/drain", { method: "POST", body: stream }), LOOPBACK)
    await waitFor(() => proxy.getInFlightCount!() === 1, "the owned operator reader")
    proxy.beginDrain!()
    await Bun.sleep(5)
    expect(cancelStarted).toBe(true)
    expect(proxy.getInFlightCount!()).toBe(1)
    join()
    const response = await pending
    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBeDefined()
    const seen = await (await proxy.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json() as { drain: { active: boolean } }
    expect(seen.drain.active).toBe(false)
    expect(proxy.getInFlightCount!()).toBe(0)
  })

  it("holds combined generation only and preserves every admitted POST HTTP count", async () => {
    const forwarded: string[] = []
    const backend = spyOn(antigravityBackend, "createAntigravityServer").mockImplementation(config => ({
      config, app: { fetch: async request => { forwarded.push(new URL(request.url).pathname); return Response.json({ fixture: true }) } },
      closeBackend: async () => {}, providerStatus: async () => disabledProvider("antigravity"),
      beginDrain: () => {}, getInFlightCount: () => 0,
    }))
    const proxy = createProxyServer({ ...TEST_CONFIG, backend: "combined" })
    try {
      await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
      const held = proxy.app.fetch(new Request("http://localhost/antigravity/v1/messages", { method: "POST", body: "{}" }))
      await waitFor(async () => (await (await proxy.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json() as { drain: { held: number } }).drain.held === 1, "combined generation held")
      expect(forwarded).toEqual([])
      expect(proxy.getInFlightCount!()).toBe(1)
      for (const path of ["/v1/messages/count_tokens", "/v1/responses/input_tokens", "/v1/responses/resp_agy_123/cancel", "/unknown-control"]) {
        const response = await proxy.app.fetch(new Request(`http://localhost/antigravity${path}`, { method: "POST", body: "{}" }))
        expect(response.status).toBe(200)
        const seen = await (await proxy.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()
        expect(seen).toMatchObject({ total: 1, drain: { held: 1 }, upstreams: { antigravity: { requests: 1 } } })
        await response.text()
      }
      expect(forwarded).toHaveLength(4)
      await proxy.app.fetch(drainRequest("DELETE"), LOOPBACK)
      const response = await held
      expect(forwarded.at(-1)).toBe("/v1/messages")
      expect(proxy.getInFlightCount!()).toBe(1)
      await response.text()
      expect(proxy.getInFlightCount!()).toBe(0)
      expect(queryCalls).toBe(0)
    } finally { proxy.beginDrain!(); backend.mockRestore() }
  })

  it("combined held abort and shutdown never reach the backend", async () => {
    let forwards = 0
    const backend = spyOn(antigravityBackend, "createAntigravityServer").mockImplementation(config => ({
      config, app: { fetch: async () => { forwards++; return Response.json({ fixture: true }) } },
      closeBackend: async () => {}, providerStatus: async () => disabledProvider("antigravity"),
      beginDrain: () => {}, getInFlightCount: () => 0,
    }))
    try {
      for (const ending of ["abort", "shutdown"] as const) {
        const proxy = createProxyServer({ ...TEST_CONFIG, backend: "combined" })
        await proxy.app.fetch(drainRequest("POST"), LOOPBACK)
        const socket = new AbortController()
        const held = proxy.app.fetch(new Request("http://localhost/antigravity/v1/responses", { method: "POST", body: "{}", signal: socket.signal }))
        await waitFor(() => proxy.getInFlightCount!() === 1, "private combined held ownership")
        if (ending === "abort") socket.abort()
        else proxy.beginDrain!()
        const response = await held
        expect(response.status).toBe(ending === "abort" ? 499 : 503)
        const payload = await response.json() as { error: { type: string }; type?: unknown }
        expect(payload.error.type).toBe(ending === "abort" ? "request_cancelled" : "overloaded_error")
        expect(payload.type).toBeUndefined()
        expect(proxy.getInFlightCount!()).toBe(0)
        proxy.beginDrain!()
      }
      expect(forwards).toBe(0)
    } finally { backend.mockRestore() }
  })

  it("combined private close ownership outlives response cancellation until its reader joins", async () => {
    let join = () => {}
    const joined = new Promise<void>(resolve => { join = resolve })
    let cancelStarted = false
    const backend = spyOn(antigravityBackend, "createAntigravityServer").mockImplementation(config => ({
      config, app: { fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelStarted = true; return joined } })) },
      closeBackend: async () => {}, providerStatus: async () => disabledProvider("antigravity"),
      beginDrain: () => {}, getInFlightCount: () => 0,
    }))
    const proxy = createProxyServer({ ...TEST_CONFIG, backend: "combined" })
    try {
      const response = await proxy.app.fetch(new Request("http://localhost/antigravity/v1/messages", { method: "POST", body: "{}" }))
      const cancelling = response.body!.cancel()
      await Bun.sleep(5)
      expect(cancelStarted).toBe(true)
      expect(proxy.getInFlightCount!()).toBe(1)
      join()
      await cancelling
      expect(proxy.getInFlightCount!()).toBe(0)
    } finally { join(); proxy.beginDrain!(); backend.mockRestore() }
  })
})
