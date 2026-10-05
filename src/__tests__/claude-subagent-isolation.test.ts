/** Causal mocked-SDK controls for native Claude Code Agent identity and cancellation. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  assistantMessage, messageStart, textBlockStart, textDelta, blockStop,
  messageDelta, messageStop, resolveMockSdkSessionId,
} from "./helpers"

const fixtureRoot = mkdtempSync(join(tmpdir(), "meridian-subagent-http-"))
const environmentKeys = /^(MERIDIAN_|CLAUDE_|CLAUDECODE$|CLAUDE_PROXY_|ANTHROPIC_)/
const originalEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentKeys.test(key)))

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) if (environmentKeys.test(key)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
}

function isolateEnvironment(): void {
  for (const key of Object.keys(process.env)) if (environmentKeys.test(key)) delete process.env[key]
  Object.assign(process.env, {
    MERIDIAN_CONFIG_DIR: join(fixtureRoot, "config"),
    MERIDIAN_SESSION_DIR: join(fixtureRoot, "sessions"),
    CLAUDE_CONFIG_DIR: join(fixtureRoot, "claude"),
    MERIDIAN_NO_UPDATE_CHECK: "1",
    MERIDIAN_TELEMETRY_PERSIST: "0",
    MERIDIAN_PASSTHROUGH: "1",
    MERIDIAN_MAX_CONCURRENT: "8",
    MERIDIAN_SESSION_TURN_MAX_HOLD_MS: "10000",
  })
}

interface SdkOptions {
  abortController?: AbortController
  resume?: string
  resumeSessionAt?: string
  sessionId?: string
}

interface SdkCall {
  readonly options: SdkOptions
  readonly started: Promise<void>
  readonly settled: Promise<void>
  readonly sdkSessionId: string
  release(): void
}

type Behavior = "hold" | "complete" | { readonly failure: string }
let behaviors: Behavior[] = []
let calls: SdkCall[] = []
let activeQueries = 0

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

installSdkMock(() => ({
  query: (params: { options?: SdkOptions }) => {
    const options = params.options ?? {}
    const behavior = behaviors.shift() ?? "complete"
    const release = deferred()
    const started = deferred()
    const settled = deferred()
    const sdkSessionId = resolveMockSdkSessionId(options, `sdk-agent-isolation-${calls.length}`)
    const call: SdkCall = { options, started: started.promise, settled: settled.promise,
      sdkSessionId, release: release.resolve }
    calls.push(call)
    return Object.assign((async function* () {
      activeQueries++
      started.resolve()
      try {
        if (typeof behavior === "object") throw new Error(behavior.failure)
        yield { ...messageStart(), session_id: sdkSessionId }
        if (behavior === "hold") {
          const signal = options.abortController?.signal
          if (!signal) throw new Error("Held SDK fixture requires an abort controller")
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("Owned SDK fixture aborted"))
            if (signal.aborted) return abort()
            signal.addEventListener("abort", abort, { once: true })
            void release.promise.then(() => {
              signal.removeEventListener("abort", abort)
              resolve()
            })
          })
        }
        yield { ...textBlockStart(), session_id: sdkSessionId }
        yield { ...textDelta(0, "ok"), session_id: sdkSessionId }
        yield { ...blockStop(), session_id: sdkSessionId }
        yield { ...messageDelta("end_turn"), session_id: sdkSessionId }
        yield { ...messageStop(), session_id: sdkSessionId }
        yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sdkSessionId }
      } finally {
        activeQueries--
        settled.resolve()
      }
    })(), { close: () => release.resolve() })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }),
  tool: () => ({}),
}), "claude-subagent-isolation.test.ts")

installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }) }))

// Prevent import-time path initialization from touching the operator's stores.
isolateEnvironment()
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { claudeCodeSessionKey } = await import("../proxy/adapters/claudecode")
const { processSessionTree } = await import("../proxy/sessionTree")
const { processSessionTurns } = await import("../proxy/session/turnCoordinator")
const { getProcessSdkSemaphore, resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { setSessionStoreDir, readSessionStoreSnapshot, lookupSharedSessionResult, storeSharedSession } = await import("../proxy/sessionStore")
const { storeSession } = await import("../proxy/session/cache")
const { computeLineageHash, computeMessageHashes, computeMessageBlockHashes } = await import("../proxy/session/lineage")
restoreEnvironment()

type Messages = Array<{ role: string; content: unknown }>
type App = { fetch(request: Request): Response | Promise<Response> }

interface RequestOptions {
  sessionId: string
  agentId?: string
  parentSessionId?: string
  messages?: Messages
  auxiliary?: "classifier" | "header"
  stream?: boolean
  requestId?: string
  signal?: AbortSignal
}

function sessionKey(sessionId: string, agentId?: string): string {
  const key = claudeCodeSessionKey(agentId, { metadata: { user_id: JSON.stringify({ session_id: sessionId }) } })
  if (key === undefined) throw new Error("Synthetic session identity did not derive")
  return key
}

function request(options: RequestOptions): Request {
  const identity = { session_id: options.sessionId,
    ...(options.parentSessionId ? { parent_session_id: options.parentSessionId } : {}) }
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "user-agent": "claude-cli/2.1.287",
      ...(options.agentId ? { "x-claude-code-agent-id": options.agentId } : {}),
      ...(options.auxiliary === "header" ? { "x-claude-code-request-class": "auxiliary" } : {}),
      ...(options.requestId ? { "x-request-id": options.requestId } : {}),
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128,
      stream: options.stream ?? false,
      messages: options.messages ?? [{ role: "user", content: options.auxiliary ? "Check the proposed fixture action" : "hello" }],
      ...(options.auxiliary === "classifier" ? {
        // The billing preamble is a separate block. Omitted tools and stops
        // exercise the official stage-two envelope, without an override header.
        system: [
          { type: "text", text: "x-anthropic-billing-header: owned synthetic fixture" },
          { type: "text", text: "You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\nowned fixture permissions\n</cc_automode_permissions>" },
        ],
      } : {}),
      metadata: { user_id: JSON.stringify(identity) },
    }),
    signal: options.signal,
  })
}

interface RunningRequest {
  readonly abort: AbortController
  readonly response: Promise<Response>
  readonly call: SdkCall
}

let requests: Array<{ readonly abort: AbortController; readonly response: Promise<Response> }> = []
let servers: Array<{ getInFlightCount?: () => number }> = []
let testSessionDir: string

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within two seconds`)), 2_000)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForCall(index: number): Promise<SdkCall> {
  const deadline = performance.now() + 2_000
  while (!calls[index]) {
    if (performance.now() >= deadline) throw new Error(`SDK fixture call ${index} was not admitted within two seconds`)
    await Bun.sleep(1)
  }
  const call = calls[index]!
  await bounded(call.started, `SDK fixture call ${index} start`)
  return call
}

async function start(app: App, options: RequestOptions, behavior: Behavior = "hold"): Promise<RunningRequest> {
  const index = calls.length
  const abort = new AbortController()
  behaviors.push(behavior)
  const response = Promise.resolve(app.fetch(request({ ...options, signal: abort.signal })))
  requests.push({ abort, response })
  const call = await waitForCall(index)
  return { abort, response, call }
}

async function complete(running: RunningRequest): Promise<Response> {
  running.call.release()
  const response = await bounded(running.response, "HTTP fixture response")
  await bounded(response.text(), "HTTP fixture terminal body")
  await bounded(running.call.settled, "SDK fixture terminal")
  return response
}

async function waitForTracked(expected: number): Promise<void> {
  const deadline = performance.now() + 2_000
  while (processSessionTree.stats().tracked !== expected) {
    if (performance.now() >= deadline) throw new Error(`Registry did not reach ${expected} live requests within two seconds`)
    await Bun.sleep(1)
  }
}

async function cancel(app: App, key: string): Promise<{ requestIds: string[]; cancelled: { requests: number } }> {
  const response = await bounded(Promise.resolve(app.fetch(new Request(
    `http://localhost/v1/sessions/${encodeURIComponent(key)}/cancel`, { method: "POST" },
  ))), "Explicit cancellation response")
  expect(response.status).toBe(200)
  return await response.json() as { requestIds: string[]; cancelled: { requests: number } }
}

async function assertLeasesReleased(keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort("Owned lease cleanup deadline"), 2_000)
    try {
      const lease = await processSessionTurns.acquire(`session:${key}`, abort.signal)
      lease.release()
    } finally {
      clearTimeout(timer)
    }
  }
}

function createApp(): App {
  const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true,
    profiles: [{ id: "default", type: "api", apiKey: "owned-synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1" }],
    defaultProfile: "default", pluginDir: join(fixtureRoot, "plugins"),
    pluginConfigPath: join(fixtureRoot, "plugins.json"),
  })
  servers.push(server)
  return server.app
}

beforeEach(() => {
  isolateEnvironment()
  testSessionDir = mkdtempSync(join(fixtureRoot, "store-"))
  for (const dir of ["config", "claude", "plugins"]) mkdirSync(join(fixtureRoot, dir), { recursive: true })
  setSessionStoreDir(testSessionDir)
  calls = []
  behaviors = []
  requests = []
  servers = []
  activeQueries = 0
  clearSessionCache()
  processSessionTree.clear()
  resetProcessSdkSemaphoreForTests()
})

afterEach(async () => {
  // Cleanup is separate from every cancellation assertion. It also unblocks
  // a faulty baseline whose registry never reached the intended SDK query.
  for (const running of requests) running.abort.abort("Owned fixture cleanup")
  for (const call of calls) {
    call.options.abortController?.abort("Owned fixture cleanup")
    call.release()
  }
  const responses = await bounded(Promise.allSettled(requests.map(running => running.response)), "HTTP cleanup joins")
  for (const response of responses) {
    if (response.status === "fulfilled" && response.value.body && !response.value.body.locked) {
      await bounded(response.value.body.cancel("Owned fixture cleanup"), "HTTP cleanup body")
    }
  }
  await bounded(Promise.all(calls.map(call => call.settled)), "SDK cleanup joins")
  await waitForTracked(0)
  expect(activeQueries).toBe(0)
  expect(getProcessSdkSemaphore().snapshot).toMatchObject({ active: 0, queued: 0 })
  for (const server of servers) expect(server.getInFlightCount?.()).toBe(0)
  processSessionTree.clear()
  clearSessionCache()
  setSessionStoreDir(null)
  resetProcessSdkSemaphoreForTests()
  rmSync(testSessionDir, { recursive: true, force: true })
  restoreEnvironment()
})

afterAll(() => {
  restoreEnvironment()
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe("Claude Code Agent cancellation isolation", () => {
  it("explicit root cancellation reaches undeclared native agents and every active classifier", async () => {
    const app = createApp()
    const root = "native-root-cancel"
    const flows: RequestOptions[] = [
      { sessionId: root, requestId: "root-main" },
      { sessionId: root, agentId: "agent_a", requestId: "root-agent-a" },
      { sessionId: root, agentId: "agent_b", requestId: "root-agent-b" },
      { sessionId: root, auxiliary: "classifier", requestId: "root-main-aux" },
      { sessionId: root, agentId: "agent_a", auxiliary: "classifier", requestId: "root-agent-a-aux" },
      { sessionId: root, agentId: "agent_b", auxiliary: "classifier", requestId: "root-agent-b-aux" },
    ]
    const running: RunningRequest[] = []
    for (const flow of flows) running.push(await start(app, flow))
    const unrelated = await start(app, { sessionId: "unrelated-root", requestId: "unrelated-main" })
    expect(activeQueries).toBe(7)
    const result = await cancel(app, root)
    expect(result.requestIds.toSorted()).toEqual(flows.map(flow => flow.requestId!).toSorted())
    expect(result.cancelled.requests).toBe(6)
    for (const flow of running) expect(flow.call.options.abortController?.signal.aborted).toBe(true)
    expect(unrelated.call.options.abortController?.signal.aborted).toBe(false)
    for (const flow of running) expect((await complete(flow)).status).toBe(499)
    await waitForTracked(1)
    expect(getProcessSdkSemaphore().snapshot).toMatchObject({ active: 1, queued: 0 })
    expect((await complete(unrelated)).status).toBe(200)
    await assertLeasesReleased([root, sessionKey(root, "agent_a"), sessionKey(root, "agent_b")])
  })

  for (const cause of ["request signal", "response body"] as const) {
    it(`keeps undeclared native agents alive when the main ${cause} closes`, async () => {
      const app = createApp()
      const root = `native-incidental-${cause}`
      const main = await start(app, { sessionId: root, stream: cause === "response body" })
      const mainAux = await start(app, { sessionId: root, auxiliary: "classifier" })
      const agentA = await start(app, { sessionId: root, agentId: "agent_a" })
      const agentB = await start(app, { sessionId: root, agentId: "agent_b" })
      const agentAux = await start(app, { sessionId: root, agentId: "agent_a", auxiliary: "classifier" })
      const declaredChild = await start(app, { sessionId: "declared-child", parentSessionId: root })
      const declaredGrandchild = await start(app, { sessionId: "declared-grandchild", parentSessionId: "declared-child" })
      if (cause === "request signal") main.abort.abort("Owned main client disconnected")
      else {
        const response = await bounded(main.response, "Streaming main response")
        if (!response.body) throw new Error("Streaming fixture has no response body")
        await bounded(response.body.cancel("Owned reader disconnected"), "Streaming main body cancellation")
      }
      await bounded(Promise.all([main.call.settled, mainAux.call.settled, declaredChild.call.settled,
        declaredGrandchild.call.settled]), "Declared cancellation terminals")
      expect(mainAux.call.options.abortController?.signal.aborted).toBe(true)
      expect(declaredChild.call.options.abortController?.signal.aborted).toBe(true)
      expect(declaredGrandchild.call.options.abortController?.signal.aborted).toBe(true)
      for (const flow of [agentA, agentB, agentAux]) expect(flow.call.options.abortController?.signal.aborted).toBe(false)
      expect((await complete(mainAux)).status).toBe(499)
      expect((await complete(declaredChild)).status).toBe(499)
      expect((await complete(declaredGrandchild)).status).toBe(499)
      if (cause === "request signal") expect((await complete(main)).status).toBe(499)
      await waitForTracked(3)
      expect(getProcessSdkSemaphore().snapshot).toMatchObject({ active: 3, queued: 0 })
      for (const flow of [agentAux, agentA, agentB]) expect((await complete(flow)).status).toBe(200)
      await assertLeasesReleased([root, sessionKey(root, "agent_a"), sessionKey(root, "agent_b"), "declared-child", "declared-grandchild"])
    })
  }

  it("explicit scoped-agent cancellation leaves the main and sibling mappings untouched", async () => {
    const app = createApp()
    const root = "native-scoped-cancel"
    const opening = [{ role: "user", content: "hello" }]
    for (const agentId of [undefined, "agent_a", "agent_b"]) {
      expect((await complete(await start(app, { sessionId: root, agentId, messages: opening }, "complete"))).status).toBe(200)
    }
    const before = readSessionStoreSnapshot()
    const continuation = [...opening, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }]
    const main = await start(app, { sessionId: root, messages: continuation, requestId: "scope-main" })
    const agentA = await start(app, { sessionId: root, agentId: "agent_a", messages: continuation, requestId: "scope-agent-a" })
    const agentB = await start(app, { sessionId: root, agentId: "agent_b", messages: continuation, requestId: "scope-agent-b" })
    const disconnectedAux = await start(app, { sessionId: root, agentId: "agent_a", auxiliary: "classifier", requestId: "scope-disconnected-aux" })
    disconnectedAux.abort.abort("Owned auxiliary client disconnected")
    expect((await complete(disconnectedAux)).status).toBe(499)
    for (const flow of [main, agentA, agentB]) expect(flow.call.options.abortController?.signal.aborted).toBe(false)
    expect(readSessionStoreSnapshot()).toEqual(before)
    const auxA = await start(app, { sessionId: root, agentId: "agent_a", auxiliary: "classifier", requestId: "scope-agent-a-aux" })
    const result = await cancel(app, sessionKey(root, "agent_a"))
    expect(result.requestIds.toSorted()).toEqual(["scope-agent-a", "scope-agent-a-aux"])
    for (const flow of [agentA, auxA]) expect((await complete(flow)).status).toBe(499)
    for (const flow of [main, agentB]) expect(flow.call.options.abortController?.signal.aborted).toBe(false)
    const after = readSessionStoreSnapshot()
    expect(after[sessionKey(root)]).toEqual(before[sessionKey(root)])
    expect(after[sessionKey(root, "agent_b")]).toEqual(before[sessionKey(root, "agent_b")])
    expect(after[sessionKey(root, "agent_a")]).toBeUndefined()
    expect((await complete(main)).status).toBe(200)
    expect((await complete(agentB)).status).toBe(200)
    await assertLeasesReleased([sessionKey(root, "agent_a")])
    const restarted = await start(app, { sessionId: root, agentId: "agent_a", messages: continuation }, "complete")
    expect(restarted.call.options.resume).toBeUndefined()
    expect((await complete(restarted)).status).toBe(200)
  })
})

describe("Claude Code Agent key and checkpoint isolation", () => {
  it("resumes an ordinary arbitrary raw main ID from its unmarked legacy checkpoint", async () => {
    const app = createApp()
    const rawMain = "arbitrary main:agent:legacy / fixture".repeat(8)
    const opening = [{ role: "user", content: "read the owned fixture" }]
    expect(sessionKey(rawMain)).toBe(rawMain)
    expect(storeSession(rawMain, opening, "legacy-ordinary-main", undefined, [null], undefined,
      "legacy-ordinary-checkpoint", ["toolu-legacy-main"])).toBeTruthy()
    const continuation = [...opening,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu-legacy-main", name: "Read", input: { file_path: "fixture.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-legacy-main", content: "owned fixture receipt" }] },
    ]
    const main = await start(app, { sessionId: rawMain, messages: continuation }, "complete")
    expect(main.call.options.resume).toBe("legacy-ordinary-main")
    expect(main.call.options.resumeSessionAt).toBe("legacy-ordinary-checkpoint")
    expect((await complete(main)).status).toBe(200)
    const stored = readSessionStoreSnapshot()[rawMain]
    expect(stored?.keyNamespace).toBeUndefined()
    expect(stored?.claudeSessionId).toBe(main.call.sdkSessionId)
    expect(stored?.previousClaudeSessionId).toBe("legacy-ordinary-main")
    expect(stored?.messageCount).toBe(3)
  })

  it("separates a native agent from a bare main ID matching the old derived string", async () => {
    const app = createApp()
    const root = "collision-root"
    const agentId = "agent_a"
    const bareMain = `${root}:agent:${agentId}`
    const opening = [{ role: "user", content: "identical opening history" }]
    const mainFirst = await start(app, { sessionId: bareMain, messages: opening }, "complete")
    expect((await complete(mainFirst)).status).toBe(200)
    const publishedMain = readSessionStoreSnapshot()[sessionKey(bareMain)]
    const agentFirst = await start(app, { sessionId: root, agentId, messages: opening }, "complete")
    expect(agentFirst.call.options.resume).toBeUndefined()
    expect((await complete(agentFirst)).status).toBe(200)
    expect(agentFirst.call.sdkSessionId).not.toBe(mainFirst.call.sdkSessionId)
    expect(readSessionStoreSnapshot()[sessionKey(bareMain)]).toEqual(publishedMain)
    expect(readSessionStoreSnapshot()[sessionKey(root, agentId)]?.claudeSessionId).toBe(agentFirst.call.sdkSessionId)

    const continuation = [...opening, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }]
    const mainNext = await start(app, { sessionId: bareMain, messages: continuation })
    const agentNext = await start(app, { sessionId: root, agentId, messages: continuation })
    expect(activeQueries).toBe(2)
    expect(mainNext.call.options.resume).toBe(mainFirst.call.sdkSessionId)
    expect(agentNext.call.options.resume).toBe(agentFirst.call.sdkSessionId)
    expect((await complete(agentNext)).status).toBe(200)
    expect((await complete(mainNext)).status).toBe(200)
    const stored = readSessionStoreSnapshot()
    expect(stored[sessionKey(bareMain)]?.messageCount).toBe(3)
    expect(stored[sessionKey(root, agentId)]?.messageCount).toBe(3)
    await assertLeasesReleased([sessionKey(bareMain), sessionKey(root, agentId)])
  })

  it("keeps a subagent classifier refusal from evicting the main and sibling checkpoints", async () => {
    const app = createApp()
    const root = "native-aux-checkpoints"
    const opening = [{ role: "user", content: "read the owned fixture" }]
    for (const agentId of [undefined, "agent_a", "agent_b"]) {
      expect((await complete(await start(app, { sessionId: root, agentId, messages: opening }, "complete"))).status).toBe(200)
    }
    const original = readSessionStoreSnapshot()
    const agentAKey = sessionKey(root, "agent_a")
    const sdkSessionId = original[agentAKey]?.claudeSessionId
    if (!sdkSessionId) throw new Error("Agent checkpoint fixture was not published")
    expect(storeSession(agentAKey, opening, sdkSessionId, undefined, [null], undefined,
      "owned-agent-checkpoint", ["toolu-owned-agent"], undefined, undefined, undefined, undefined,
      original[agentAKey]?.keyNamespace)).toBeTruthy()
    const checkpoint = lookupSharedSessionResult(agentAKey)
    const continuation = [...opening,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu-owned-agent", name: "Read", input: { file_path: "fixture.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-owned-agent", content: "owned fixture receipt" }] },
    ]
    behaviors.push({ failure: "No message found with message.uuid of: owned-agent-checkpoint" }, "complete")
    const auxiliary = await start(app, { sessionId: root, agentId: "agent_a", auxiliary: "header", messages: continuation }, "complete")
    expect((await complete(auxiliary)).status).toBe(200)
    expect(calls.slice(3).length).toBe(2)
    for (const call of calls.slice(3)) {
      expect(call.options.resume).toBeUndefined()
      expect(call.options.resumeSessionAt).toBeUndefined()
    }
    expect(lookupSharedSessionResult(agentAKey)).toEqual(checkpoint)
    const after = readSessionStoreSnapshot()
    expect(after[sessionKey(root)]).toEqual(original[sessionKey(root)])
    expect(after[sessionKey(root, "agent_b")]).toEqual(original[sessionKey(root, "agent_b")])
    const agentContinuation = await start(app, { sessionId: root, agentId: "agent_a", messages: continuation }, "complete")
    expect(agentContinuation.call.options.resume).toBe(sdkSessionId)
    expect(agentContinuation.call.options.resumeSessionAt).toBe("owned-agent-checkpoint")
    expect((await complete(agentContinuation)).status).toBe(200)
  })

  it("replays an unmarked legacy reserved-key collision without inheriting its checkpoint or transcript", async () => {
    const app = createApp()
    const root = "reserved-legacy-root"
    const agentId = "agent_a"
    const key = sessionKey(root, agentId)
    const opening = [{ role: "user", content: "identical legacy history" }]
    const unrelated = await start(app, { sessionId: "unrelated-legacy-control", messages: opening }, "complete")
    expect((await complete(unrelated)).status).toBe(200)
    const unrelatedMapping = readSessionStoreSnapshot()["unrelated-legacy-control"]
    // A pre-upgrade arbitrary raw client ID could have occupied precisely this
    // new reserved slot. A namespace mismatch is not permission to resume it.
    expect(storeSharedSession(key, "legacy-unmarked-sdk", opening.length,
      computeLineageHash(opening), computeMessageHashes(opening), [null], undefined,
      computeMessageBlockHashes(opening), "legacy-unmarked-checkpoint", ["toolu-legacy-unmarked"],
      { sessionId: "legacy-unmarked-sdk", configDir: join(fixtureRoot, "legacy-claude") },
    )).toBeTruthy()
    const legacy = readSessionStoreSnapshot()[key]
    expect(legacy?.keyNamespace).toBeUndefined()
    const continuation = [...opening,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu-legacy-unmarked", name: "Read", input: { file_path: "fixture.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-legacy-unmarked", content: "owned fixture receipt" }] },
    ]
    const fresh = await start(app, { sessionId: root, agentId, messages: continuation }, "complete")
    expect(fresh.call.options.resume).toBeUndefined()
    expect(fresh.call.options.resumeSessionAt).toBeUndefined()
    expect((await complete(fresh)).status).toBe(200)
    const replaced = readSessionStoreSnapshot()[key]
    expect(replaced?.claudeSessionId).toBe(fresh.call.sdkSessionId)
    expect(replaced?.previousClaudeSessionId).toBeUndefined()
    expect(replaced?.previousTranscript).toBeUndefined()
    expect(replaced?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(replaced?.currentTranscript?.sessionId).not.toBe("legacy-unmarked-sdk")
    expect(replaced?.keyNamespace).toBe("claude-code:1")
    expect(readSessionStoreSnapshot()["unrelated-legacy-control"]).toEqual(unrelatedMapping)
    const next = await start(app, { sessionId: root, agentId, messages: [
      ...continuation, { role: "assistant", content: "ok" }, { role: "user", content: "continue" },
    ] }, "complete")
    expect(next.call.options.resume).toBe(fresh.call.sdkSessionId)
    expect((await complete(next)).status).toBe(200)
  })
})
