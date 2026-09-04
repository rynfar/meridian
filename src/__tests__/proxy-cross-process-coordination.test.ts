import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const testDir = dirname(fileURLToPath(import.meta.url))
const serverModule = pathToFileURL(resolve(testDir, "../proxy/server.ts")).href
const sessionStoreModule = pathToFileURL(resolve(testDir, "../proxy/sessionStore.ts")).href

// Each worker is a separate Bun OS process with its own module graph and
// createProxyServer instance. mock.module must run before server.ts is loaded;
// this is the subprocess seam that keeps the test off the real Agent SDK.
const workerSource = String.raw`
import { mock } from "bun:test"
import { appendFileSync, existsSync } from "node:fs"

const workerId = process.env.WORKER_ID
const eventFile = process.env.EVENT_FILE
const releaseFile = process.env.RELEASE_FILE
let requestActive = false
let queryCall = 0

function event(name, extra = {}) {
  appendFileSync(eventFile, JSON.stringify({
    name,
    workerId,
    pid: process.pid,
    at: Date.now(),
    ...extra,
  }) + "\n")
}

// Import a cache-busted copy as the implementation, then mock the canonical
// module imported by server.ts. The wrapper exposes the exact moment the route
// takes its durable arrival snapshot, before it waits on the process lock.
const realSessionStore = await import(
  process.env.SESSION_STORE_MODULE + "?cross-process-real=" + encodeURIComponent(workerId)
)
const readRealSessionStoreGenerationSnapshot = realSessionStore.readSessionStoreGenerationSnapshot
mock.module(process.env.SESSION_STORE_MODULE, () => ({
  ...realSessionStore,
  readSessionStoreGenerationSnapshot: (...args) => {
    const snapshot = readRealSessionStoreGenerationSnapshot(...args)
    if (requestActive) event("arrival-snapshot", { generations: snapshot })
    return snapshot
  },
}))

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params) => {
    const call = ++queryCall
    const resume = params?.options?.resume ?? null
    const sdkSessionId = params?.options?.sessionId
      ?? (params?.options?.forkSession ? undefined : params?.options?.resume)
      ?? "sdk-" + workerId
    const generator = (async function* () {
      event("sdk-start", { call, resume, sdkSessionId })
      while (!existsSync(releaseFile)) await Bun.sleep(5)

      const common = {
        parent_tool_use_id: null,
        session_id: sdkSessionId,
        uuid: workerId + "-uuid-" + call,
      }
      yield {
        type: "stream_event",
        ...common,
        event: {
          type: "message_start",
          message: {
            id: "msg-" + workerId,
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4-6",
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
      }
      yield {
        type: "stream_event",
        ...common,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }
      yield {
        type: "stream_event",
        ...common,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        },
      }
      yield {
        type: "stream_event",
        ...common,
        event: { type: "content_block_stop", index: 0 },
      }
      yield {
        type: "stream_event",
        ...common,
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        },
      }
      yield {
        type: "stream_event",
        ...common,
        event: { type: "message_stop" },
      }
      yield {
        type: "assistant",
        ...common,
        message: {
          id: "msg-" + workerId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }
      event("sdk-finish", { call, sdkSessionId })
    })()
    return Object.assign(generator, { close: () => {} })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

const { createProxyServer } = await import(process.env.SERVER_MODULE)
const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
const request = new Request("http://localhost/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...JSON.parse(process.env.REQUEST_HEADERS),
  },
  body: process.env.REQUEST_BODY,
})

requestActive = true
event("request-start")
try {
  const response = await app.fetch(request)
  const body = await response.text()
  event("result", { status: response.status, body })
} catch (error) {
  event("worker-error", {
    errorName: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  })
  throw error
} finally {
  requestActive = false
}
`

interface WorkerEvent {
  name: string
  workerId: string
  pid: number
  at: number
  status?: number
  body?: string
  resume?: string | null
  sdkSessionId?: string
  generations?: Record<string, string>
  errorName?: string
  message?: string
}

interface Paths {
  base: string
  sessions: string
  events: string
}

interface WorkerHandle {
  id: string
  releaseFile: string
  child: ReturnType<typeof Bun.spawn>
}

const tempRoots: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()

afterEach(async () => {
  for (const child of children) child.kill()
  children.clear()
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function makePaths(): Promise<Paths> {
  const base = await mkdtemp(join(tmpdir(), "meridian-proxy-process-test-"))
  tempRoots.push(base)
  return {
    base,
    sessions: join(base, "sessions"),
    events: join(base, "events.jsonl"),
  }
}

function spawnProxyWorker(
  paths: Paths,
  id: string,
  clientSessionId: string,
  messages: Array<{ role: string, content: unknown }>,
  options: { adapter?: "pi"; stream?: boolean } = {},
): WorkerHandle {
  const releaseFile = join(paths.base, `release-${id}`)
  const requestBody = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    stream: options.stream ?? false,
    messages,
    ...(options.adapter === "pi" ? { metadata: { user_id: JSON.stringify({ session_id: clientSessionId }) } } : {}),
  })
  const child = Bun.spawn([process.execPath, "-e", workerSource], {
    env: {
      ...process.env,
      SERVER_MODULE: serverModule,
      SESSION_STORE_MODULE: sessionStoreModule,
      MERIDIAN_SESSION_DIR: paths.sessions,
      MERIDIAN_PASSTHROUGH: "0",
      CLAUDE_PROXY_PASSTHROUGH: "0",
      MERIDIAN_MAX_CONCURRENT: "8",
      MERIDIAN_SESSION_TURN_ACQUIRE_TIMEOUT_MS: "5000",
      MERIDIAN_SESSION_TURN_MAX_HOLD_MS: "5000",
      MERIDIAN_SESSION_TURN_RETRY_MS: "5",
      EVENT_FILE: paths.events,
      RELEASE_FILE: releaseFile,
      WORKER_ID: id,
      CLIENT_SESSION_ID: clientSessionId,
      REQUEST_HEADERS: JSON.stringify(options.adapter === "pi"
        ? { "x-meridian-agent": "pi" } : { "x-opencode-session": clientSessionId }),
      REQUEST_BODY: requestBody,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  children.add(child)
  void child.exited.then(() => children.delete(child))
  return { id, releaseFile, child }
}

async function readEvents(path: string): Promise<WorkerEvent[]> {
  try {
    const text = await readFile(path, "utf8")
    return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as WorkerEvent)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function waitForEvent(
  path: string,
  workerId: string,
  name: string,
  timeoutMs = 5_000,
): Promise<WorkerEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const all = await readEvents(path)
    const workerError = all.find(item => item.workerId === workerId && item.name === "worker-error")
    if (workerError) {
      throw new Error(`${workerId} failed: ${workerError.errorName}: ${workerError.message}`)
    }
    const found = all.find(item => item.workerId === workerId && item.name === name)
    if (found) return found
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${workerId}:${name}`)
}

async function release(worker: WorkerHandle): Promise<void> {
  await writeFile(worker.releaseFile, "release")
}

async function expectSuccess(worker: WorkerHandle, timeoutMs = 5_000): Promise<void> {
  const timeout = Symbol("timeout")
  const outcome = await Promise.race([
    worker.child.exited,
    Bun.sleep(timeoutMs).then(() => timeout),
  ])
  if (outcome === timeout) {
    worker.child.kill()
    throw new Error(`Worker ${worker.id} did not exit within ${timeoutMs}ms`)
  }
  if (outcome === 0) return
  const stderr = worker.child.stderr instanceof ReadableStream
    ? await new Response(worker.child.stderr).text()
    : String(worker.child.stderr ?? "")
  throw new Error(`Worker ${worker.id} exited ${String(outcome)}: ${stderr}`)
}

async function result(paths: Paths, worker: WorkerHandle): Promise<WorkerEvent> {
  await expectSuccess(worker)
  return waitForEvent(paths.events, worker.id, "result", 250)
}

function conflictBody(event: WorkerEvent): unknown {
  return JSON.parse(event.body ?? "null")
}

describe("proxy coordination across OS processes", () => {
  for (const stream of [false, true]) {
    for (const firstName of ["main", "side"] as const) {
      test(`Pi keeps both branches valid across processes: ${firstName} first, stream=${stream}`, async () => {
        const paths = await makePaths()
        const key = `pi-race-${firstName}-${stream}`
        const prefix = [{ role: "user", content: "shared fixture" }, { role: "assistant", content: "ok" }]
        const main = [...prefix, { role: "user", content: "main-only fixture field" }]
        const side = [...prefix, { role: "user", content: "side-only fixture field" }]
        const owner = spawnProxyWorker(paths, "pi-owner", key, firstName === "main" ? main : side, { adapter: "pi", stream })
        const ownerSdk = await waitForEvent(paths.events, owner.id, "sdk-start")
        const waiter = spawnProxyWorker(paths, "pi-waiter", key, firstName === "main" ? side : main, { adapter: "pi", stream })
        await waitForEvent(paths.events, waiter.id, "arrival-snapshot")
        expect((await readEvents(paths.events)).some(row => row.workerId === waiter.id && row.name === "sdk-start")).toBe(false)
        await release(owner)
        expect((await result(paths, owner)).status).toBe(200)
        const waiterSdk = await waitForEvent(paths.events, waiter.id, "sdk-start")
        expect(waiterSdk.resume).toBeNull()
        expect(waiterSdk.sdkSessionId).not.toBe(ownerSdk.sdkSessionId)
        await release(waiter)
        expect((await result(paths, waiter)).status).toBe(200)

        const followup = spawnProxyWorker(paths, "pi-followup", key, [...main,
          { role: "assistant", content: "ok" }, { role: "user", content: "continue the main fixture" }], { adapter: "pi", stream })
        const followupSdk = await waitForEvent(paths.events, followup.id, "sdk-start")
        // A single key stores the most recent branch. A later main turn either
        // resumes that main branch or safely replays after a side branch.
        expect(followupSdk.resume).toBe(firstName === "side" ? waiterSdk.sdkSessionId! : null)
        await release(followup)
        expect((await result(paths, followup)).status).toBe(200)
      }, 20_000)
    }
  }

  test("serializes one session and rejects a stale arrival after durable advancement", async () => {
    const paths = await makePaths()
    const opening = [{ role: "user", content: "hello" }]
    const owner = spawnProxyWorker(paths, "stale-owner", "shared-stale", opening)
    const ownerArrival = await waitForEvent(paths.events, owner.id, "arrival-snapshot")
    expect(ownerArrival.generations?.["shared-stale"]).toMatch(/^a:/)
    await waitForEvent(paths.events, owner.id, "sdk-start")

    const stale = spawnProxyWorker(paths, "stale-waiter", "shared-stale", opening)
    const staleArrival = await waitForEvent(paths.events, stale.id, "arrival-snapshot")
    expect(staleArrival.generations?.["shared-stale"]).toBe(
      ownerArrival.generations?.["shared-stale"],
    )

    // The second proxy has taken its arrival snapshot, but cannot enter the SDK
    // while the first process owns the same durable turn lock.
    await Bun.sleep(75)
    expect((await readEvents(paths.events)).some(
      item => item.workerId === stale.id && item.name === "sdk-start",
    )).toBe(false)

    await release(owner)
    expect((await result(paths, owner)).status).toBe(200)
    const staleResult = await result(paths, stale)
    expect(staleResult.status).toBe(400)
    expect(conflictBody(staleResult)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.",
      },
    })
    expect((await readEvents(paths.events)).some(
      item => item.workerId === stale.id && item.name === "sdk-start",
    )).toBe(false)
  }, 15_000)

  test("refreshes durable lineage and resume state after waiting for another process", async () => {
    const paths = await makePaths()
    const opening = [{ role: "user", content: "hello" }]
    const continuation = [
      ...opening,
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ]
    const owner = spawnProxyWorker(paths, "refresh-owner", "shared-refresh", opening)
    const ownerSdk = await waitForEvent(paths.events, owner.id, "sdk-start")
    expect(ownerSdk.sdkSessionId).toMatch(/^[0-9a-f-]{36}$/)

    const waiter = spawnProxyWorker(paths, "refresh-waiter", "shared-refresh", continuation)
    const waiterArrival = await waitForEvent(paths.events, waiter.id, "arrival-snapshot")
    expect(waiterArrival.generations?.["shared-refresh"]).toMatch(/^a:/)
    await Bun.sleep(75)
    expect((await readEvents(paths.events)).some(
      item => item.workerId === waiter.id && item.name === "sdk-start",
    )).toBe(false)

    await release(owner)
    expect((await result(paths, owner)).status).toBe(200)
    const waiterSdk = await waitForEvent(paths.events, waiter.id, "sdk-start")
    expect(waiterSdk.resume).toBe(ownerSdk.sdkSessionId)

    const allAtResume = await readEvents(paths.events)
    const ownerFinished = allAtResume.find(
      item => item.workerId === owner.id && item.name === "sdk-finish",
    )
    expect(ownerFinished).toBeDefined()
    expect(ownerFinished!.at).toBeLessThanOrEqual(waiterSdk.at)

    await release(waiter)
    expect((await result(paths, waiter)).status).toBe(200)
    const durable = JSON.parse(await readFile(join(paths.sessions, "sessions.json"), "utf8"))
    expect(durable["shared-refresh"]).toMatchObject({
      claudeSessionId: waiterSdk.sdkSessionId,
      previousClaudeSessionId: ownerSdk.sdkSessionId,
      revision: 2,
      messageCount: continuation.length,
    })
  }, 15_000)

  test("allows different sessions to run concurrently in different processes", async () => {
    const paths = await makePaths()
    const first = spawnProxyWorker(
      paths,
      "parallel-first",
      "parallel-session-a",
      [{ role: "user", content: "one" }],
    )
    await waitForEvent(paths.events, first.id, "sdk-start")

    const second = spawnProxyWorker(
      paths,
      "parallel-second",
      "parallel-session-b",
      [{ role: "user", content: "two" }],
    )
    await waitForEvent(paths.events, second.id, "sdk-start")

    // Both SDK calls started before either release file existed.
    expect(existsSync(first.releaseFile)).toBe(false)
    expect(existsSync(second.releaseFile)).toBe(false)
    expect((await readEvents(paths.events)).filter(item => item.name === "sdk-start")).toHaveLength(2)

    await Promise.all([release(first), release(second)])
    const [firstResult, secondResult] = await Promise.all([
      result(paths, first),
      result(paths, second),
    ])
    expect(firstResult.status).toBe(200)
    expect(secondResult.status).toBe(200)
  }, 15_000)
})
