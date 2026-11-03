/**
 * Real HTTP ownership cases, run alone by npm test because their namespace and
 * SDK/log controls must outlive every proxy and its background maintenance.
 * The SDK is mocked; no Claude model or host transcript is used.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { assertSyntheticClaudeBoundary, setSdkMock } from "./sdkMock"
import { setLoggerMock } from "./loggerMock"
import { setMcpToolsMock } from "./mcpToolsMock"
import { getSessionStoreDir, readSessionStoreSnapshot } from "../proxy/sessionStore"
import { computeLineageHash } from "../proxy/session/lineage"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

type MockQueryParams = Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]
let heldQuery: ((params: MockQueryParams) => AsyncGenerator<SDKMessage>) | undefined

interface ConcurrentLog {
  requestId?: string
  event: string
  error?: string
  reason?: string
  targetSessionId?: string
}
let concurrentLogs: ConcurrentLog[] | undefined
const mockLogContext = new AsyncLocalStorage<{ requestId?: string }>()
const concurrentLogEvents = new Set([
  "session.fresh_prepared", "session.publication_deferred", "session.fingerprint_publication_lost",
  "session.fork_abandon_failed", "upstream.completed", "response.completed", "error.unhandled", "proxy.error",
])

function stringField(value: unknown, key: string): string | undefined {
  if (value !== null && typeof value === "object" && key in value) {
    const field = Reflect.get(value, key)
    if (typeof field === "string") return field
  }
  return undefined
}

const namespaceKeys = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_SESSION_DIR", "CLAUDE_CONFIG_DIR", "MERIDIAN_WORKDIR"] as const
const savedNamespace = new Map(namespaceKeys.map(key => [key, process.env[key]]))
let fixtureRoot: string
let configDirectory: string
let sessionDirectory: string
let claudeDirectory: string
let workingDirectory: string

beforeAll(async () => {
  // Stay outside preload's teardown root: an unjoined owner must retain its
  // paths, even when this file fails and the process is about to exit.
  fixtureRoot = realpathSync(mkdtempSync(join(dirname(tmpdir()), "meridian-concurrent-")))
  configDirectory = join(fixtureRoot, "meridian")
  sessionDirectory = join(fixtureRoot, "sessions")
  claudeDirectory = join(fixtureRoot, "claude")
  workingDirectory = join(fixtureRoot, "workdir")
  for (const directory of [configDirectory, sessionDirectory, claudeDirectory, workingDirectory]) {
    mkdirSync(directory, { mode: 0o700 })
  }
  Object.assign(process.env, {
    MERIDIAN_CONFIG_DIR: configDirectory,
    MERIDIAN_SESSION_DIR: sessionDirectory,
    CLAUDE_CONFIG_DIR: claudeDirectory,
    MERIDIAN_WORKDIR: workingDirectory,
  })
  // These process-owned mocks are not reset by a hook that could run before a
  // timed-out backend has joined. The dedicated Bun process owns their lifetime.
  setSdkMock(() => ({
    query: (params: MockQueryParams) => {
      if (!heldQuery) throw new Error("Concurrent SDK query has no fixture owner")
      return heldQuery(params)
    },
    createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
    tool: () => ({}),
  }), "integration-concurrent.test.ts")
  setMcpToolsMock(() => ({
    createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
  }))
  await assertSyntheticClaudeBoundary()
})

beforeAll(() => setLoggerMock(() => ({
  claudeLog: (event: string, data: unknown) => {
    if (concurrentLogs && concurrentLogEvents.has(event)) {
      concurrentLogs.push({
        requestId: mockLogContext.getStore()?.requestId,
        event,
        error: stringField(data, "error"),
        reason: stringField(data, "reason"),
        targetSessionId: stringField(data, "targetSessionId"),
      })
    }
  },
  withClaudeLogContext: (ctx: unknown, fn: () => unknown) =>
    mockLogContext.run({ requestId: stringField(ctx, "requestId") }, fn),
})))

const { createProxyServer } = await import("../proxy/server")
const openProxies = new Set<ReturnType<typeof createProxyServer>>()
const publishedTargets = new Set<string>()

type OwnedResource = {
  state: string
  locator: { sessionId: string; configDir: string; projectDir?: string }
  activeLeases?: Record<string, { purpose?: "publication" }>
}
function readOwnedResources(): OwnedResource[] {
  expect(getSessionStoreDir()).toBe(sessionDirectory)
  const lifecyclePath = join(sessionDirectory, "session-gc.json")
  if (!existsSync(lifecyclePath)) return []
  const sidecar = JSON.parse(readFileSync(lifecyclePath, "utf8")) as {
    resources: Record<string, OwnedResource>
  }
  const resources = Object.values(sidecar.resources)
  for (const resource of resources) {
    expect(resource.locator.configDir).toBe(claudeDirectory)
    expect(resource.locator.projectDir).toBe(workingDirectory)
  }
  return resources
}

function assertPriorResources(): void {
  const resources = readOwnedResources()
  expect(resources).toHaveLength(publishedTargets.size)
  for (const resource of resources) {
    expect(publishedTargets.has(resource.locator.sessionId)).toBe(true)
    expect(resource.state).toBe("live")
    expect(Object.keys(resource.activeLeases ?? {})).toHaveLength(0)
  }
  const mappings = Object.values(readSessionStoreSnapshot())
  expect(mappings).toHaveLength(publishedTargets.size)
  for (const mapping of mappings) {
    expect(publishedTargets.has(mapping.claudeSessionId)).toBe(true)
    expect(mapping.currentTranscript?.configDir).toBe(claudeDirectory)
    expect(mapping.currentTranscript?.projectDir).toBe(workingDirectory)
  }
}

afterAll(() => {
  if (openProxies.size > 0) {
    throw new Error(`Concurrent fixture retains ${openProxies.size} unjoined proxy owner(s); namespace retained at ${fixtureRoot}`)
  }
  for (const [key, value] of savedNamespace) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fixtureRoot, { recursive: true })
})

// ============================================================
// CONCURRENT HEADERLESS REQUESTS
// ============================================================

describe("Integration: Concurrent independent headerless requests", () => {
  for (const completionOrder of ["together", "reverse order"] as const) {
    it(`publishes all 3 overlapping requests when they finish ${completionOrder}`, async () => {
      // A completed immediate generator does not prove that all three SDK
      // queries overlap. Keep every writer active until the HTTP fixture has
      // observed all three, then drive their terminal publication explicitly.
      expect(openProxies.size).toBe(0)
      assertPriorResources()
      const proxy = createProxyServer({
        port: 0, host: "127.0.0.1", maxConcurrent: 3,
        profiles: [{ id: "concurrent-fixture", claudeConfigDir: claudeDirectory }],
        defaultProfile: "concurrent-fixture",
      })
      openProxies.add(proxy)
      const fixtureId = crypto.randomUUID()
      const barrier = Promise.withResolvers<void>()
      const fixtures = Array.from({ length: 3 }, (_, index) => ({
        index,
        requestId: `concurrent-${fixtureId}-${index}`,
        prompt: `Concurrent ${fixtureId} request ${index}`,
        release: Promise.withResolvers<void>(),
        abort: new AbortController(),
        sdkTarget: undefined as string | undefined,
        status: undefined as number | undefined,
        sessionHeader: undefined as string | null | undefined,
        body: undefined as unknown,
      }))
      const started = new Set<number>()
      const finished: number[] = []
      let activeQueries = 0
      concurrentLogs = []
      const ownership: Array<{ stage: string; resources: OwnedResource[] }> = []
      const resourcesForFixture = (): OwnedResource[] => {
        const resources = readOwnedResources()
        expect(resources).toHaveLength(publishedTargets.size + fixtures.length)
        for (const resource of resources) {
          expect(publishedTargets.has(resource.locator.sessionId)
            || fixtures.some(fixture => fixture.sdkTarget === resource.locator.sessionId)).toBe(true)
          if (publishedTargets.has(resource.locator.sessionId)) {
            expect(resource.state).toBe("live")
            expect(Object.keys(resource.activeLeases ?? {})).toHaveLength(0)
          }
        }
        return resources.filter(resource =>
          fixtures.some(fixture => fixture.sdkTarget === resource.locator.sessionId))
      }
      const diagnostics = () => JSON.stringify({
        requests: fixtures.map(({ index, requestId, sdkTarget, status, sessionHeader, body }) =>
          ({ index, requestId, sdkTarget, status, sessionHeader, body })),
        started: [...started], finished, activeQueries, ownership, events: concurrentLogs,
      }).replaceAll(getSessionStoreDir(), "<test-session-store>")
        .replaceAll(fixtureRoot, "<concurrent-fixture>")

      // All admission/response waits share one budget, leaving the three bounded
      // cleanup phases and hook reset below Bun's 30-second suite timeout.
      const mainDeadline = performance.now() + 10_000
      const bounded = async <T>(pending: Promise<T>, stage: string, timeoutMs = Math.max(1, mainDeadline - performance.now())): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Concurrent fixture did not reach ${stage}`)), timeoutMs)
          })])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }

      heldQuery = params => (async function* () {
        const fixture = fixtures.find(candidate => params.prompt === candidate.prompt)
        if (!fixture) throw new Error("Concurrent SDK query did not match a fixture request")
        expect(params.options?.cwd).toBe(workingDirectory)
        expect(params.options?.env?.CLAUDE_CONFIG_DIR).toBe(claudeDirectory)
        fixture.sdkTarget = params.options?.sessionId
        const signal = params.options?.abortController?.signal
        const releaseOnAbort = () => fixture.release.resolve()
        signal?.addEventListener("abort", releaseOnAbort, { once: true })
        if (signal?.aborted) releaseOnAbort()
        activeQueries++
        started.add(fixture.index)
        if (started.size === fixtures.length) barrier.resolve()
        try {
          await fixture.release.promise
          signal?.throwIfAborted()
          yield withMockSdkSessionId(
            assistantMessage([{ type: "text", text: `Done ${fixture.index}.` }]), params.options,
          )
        } finally {
          activeQueries--
          finished.push(fixture.index)
          signal?.removeEventListener("abort", releaseOnAbort)
        }
      })()

      const requests = fixtures.map(fixture => Promise.resolve(proxy.app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dummy", "x-request-id": fixture.requestId },
        signal: fixture.abort.signal,
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          stream: false,
          messages: [{ role: "user", content: fixture.prompt }],
        }),
      }))).then(async response => {
        fixture.status = response.status
        fixture.sessionHeader = response.headers.get("x-claude-session-id")
        fixture.body = await response.json()
        return response
      }))
      // Attach rejection observers immediately, including while the barrier is
      // waiting: a request rejected before SDK admission must remain diagnosable.
      const settled = Promise.allSettled(requests)
      let failed = false
      let failure: unknown
      let primaryEvidence = ""
      const cleanup: Array<{ phase: string; result: "completed" | "failed or unjoined"; error?: string }> = []
      try {
        await bounded(barrier.promise, "all three SDK writers")
        expect(activeQueries).toBe(3)
        expect(fixtures.every(fixture => typeof fixture.sdkTarget === "string" && fixture.sdkTarget.length > 0)).toBe(true)
        expect(new Set(fixtures.map(fixture => fixture.sdkTarget)).size).toBe(3)
        const heldResources = resourcesForFixture()
        ownership.push({ stage: "all writers held", resources: heldResources })
        expect(heldResources).toHaveLength(3)
        for (const resource of heldResources) {
          const leases = Object.values(resource.activeLeases ?? {})
          expect(leases.filter(lease => lease.purpose === "publication")).toHaveLength(1)
          expect(leases.filter(lease => lease.purpose !== "publication")).toHaveLength(1)
        }

        if (completionOrder === "together") {
          for (const fixture of fixtures) fixture.release.resolve()
        }
        for (const fixture of [...fixtures].reverse()) {
          fixture.release.resolve()
          const response = await bounded(requests[fixture.index]!, `response ${fixture.index}`)
          expect(response.status).toBe(200)
          expect(fixture.sessionHeader).toBe(fixture.sdkTarget)
          expect(fixture.body).toMatchObject({
            type: "message", role: "assistant", stop_reason: "end_turn",
            content: [{ type: "text", text: `Done ${fixture.index}.` }],
          })
        }
        expect([...finished].sort()).toEqual([0, 1, 2])
        if (completionOrder === "reverse order") expect(finished).toEqual([2, 1, 0])
        expect(activeQueries).toBe(0)
        const mappings = Object.values(readSessionStoreSnapshot())
        for (const fixture of fixtures) {
          const ownedMappings = mappings.filter(mapping => mapping.claudeSessionId === fixture.sdkTarget)
          expect(ownedMappings).toHaveLength(1)
          expect(ownedMappings[0]?.messageCount).toBe(1)
          expect(ownedMappings[0]?.lineageHash).toBe(computeLineageHash([{ role: "user", content: fixture.prompt }]))
          expect(ownedMappings[0]?.currentTranscript?.sessionId).toBe(fixture.sdkTarget)
        }
        const publishedResources = resourcesForFixture()
        ownership.push({ stage: "all responses complete", resources: publishedResources })
        expect(publishedResources).toHaveLength(3)
        for (const resource of publishedResources) {
          expect(resource.state).toBe("live")
          expect(Object.keys(resource.activeLeases ?? {})).toHaveLength(0)
        }
        expect(proxy.getInFlightCount?.()).toBe(0)
        for (const fixture of fixtures) publishedTargets.add(fixture.sdkTarget!)
      } catch (error) {
        failed = true
        failure = error
      } finally {
        // Save the assertion evidence before cleanup can fail or stall. The
        // early failure record also survives an outer test-runner timeout.
        primaryEvidence = diagnostics()
        if (failed) console.error(`[concurrent fixture failure] ${primaryEvidence}`)
        const clean = async (phase: string, operation: () => Promise<unknown>): Promise<void> => {
          try {
            await bounded(operation(), `cleanup ${phase}`, 5_000)
            cleanup.push({ phase, result: "completed" })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            cleanup.push({ phase, result: "failed or unjoined", error: message })
            console.error(`[concurrent fixture cleanup] ${JSON.stringify(cleanup[cleanup.length - 1])}`)
            if (!failed) {
              failed = true
              failure = error
            }
          }
        }
        try {
          for (const fixture of fixtures) {
            fixture.release.resolve()
            if (failed) fixture.abort.abort(new Error("Concurrent fixture cleanup"))
          }
          // These are fixture HTTP promises and the embedding APIs' maintenance
          // work. A deadline records unfinished work; it does not prove a join.
          await clean("HTTP requests", () => settled)
          await clean("GC sweep", () => {
            if (!proxy.sweepSessionGc) throw new Error("Concurrent proxy has no GC join")
            return proxy.sweepSessionGc()
          })
          await clean("backend resources", async () => {
            if (!proxy.closeBackend) throw new Error("Concurrent proxy has no backend join")
            await proxy.closeBackend()
            openProxies.delete(proxy)
          })
        } finally {
          // A deadline is still a failure, even if this backend joins later.
          // Do not replace its SDK/log controls while it still owns work.
          if (!openProxies.has(proxy)) {
            heldQuery = undefined
            concurrentLogs = undefined
          }
        }
      }
      if (failed) throw new Error(
        `Concurrent HTTP ownership assertion failed\n${primaryEvidence}\ncleanup=${JSON.stringify(cleanup)}`,
        { cause: failure },
      )
    }, 30_000)
  }
})

