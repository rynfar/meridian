/**
 * Slow session bookkeeping must not fail a turn whose model already answered.
 *
 * Terminal publication records where the NEXT turn resumes. When its lifecycle
 * lock could not be admitted - a holder stalled under a frozen event loop, a
 * full queue, an external lock deadline - every concurrent answered turn used
 * to fail at once with a 503, and each client re-ran its whole turn.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { lookupSharedSession, setSessionStoreDir } from "../proxy/sessionStore"
import * as sessionStore from "../proxy/sessionStore"
import * as lifecycle from "../proxy/sessionLifecycle"
import { SessionLifecycleLockError, SessionLifecycleQueueStalledError } from "../proxy/session/lifecycleErrors"
import { diagnosticLog } from "../telemetry"
import { LifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import { getConversationFingerprint } from "../proxy/session/fingerprint"
import { createPriorityAttestation } from "../../plugin/priority-attestation"
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

let queryCalls = 0
interface QueryOptions {
  sessionId?: string
  resume?: string
  resumeSessionAt?: string
  forkSession?: boolean
  cwd?: string
}
const capturedQueries: Array<{ options: QueryOptions; sessionId: string; prompt: string | unknown[] }> = []

installSdkMock(() => ({
  query: (params: { options?: QueryOptions; prompt: string | AsyncIterable<unknown> }) => {
    queryCalls++
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-degrade-${queryCalls}`)
    const inputs: unknown[] = []
    const captured = { options: { ...params.options }, sessionId, prompt: typeof params.prompt === "string" ? params.prompt : inputs }
    capturedQueries.push(captured)
    const generator = (async function* () {
      if (typeof params.prompt !== "string") {
        for await (const input of params.prompt) inputs.push(input)
      }
      yield { ...messageStart(), session_id: sessionId }
      yield { ...textBlockStart(0), session_id: sessionId }
      yield { ...textDelta(0, "answered"), session_id: sessionId }
      yield { ...blockStop(0), session_id: sessionId }
      yield { ...messageDelta("end_turn"), session_id: sessionId }
      yield { ...messageStop(), session_id: sessionId }
      yield { ...assistantMessage([{ type: "text", text: "answered" }]), session_id: sessionId }
    })()
    return Object.assign(generator, { close: () => {} })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "lifecycle-publication-degrade.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

import { resolveSdkModelDefaults } from "../proxy/models"

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

const profiles = [{ id: "personal", claudeConfigDir: "/home/.claude" }]
const FIRST_TURN = [{ role: "user", content: "hi" }]
const SECOND_TURN = [...FIRST_TURN, { role: "assistant", content: "answered" }, { role: "user", content: "again" }]
const THIRD_TURN = [...SECOND_TURN, { role: "assistant", content: "answered" }, { role: "user", content: "once more" }]

function turn(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: string }>,
  stream: boolean,
  options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sessionId ? { "x-opencode-session": sessionId } : {}), ...options.headers },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
    signal: options.signal,
  })
}

const stalled = () => new SessionLifecycleQueueStalledError("active lifecycle holder stalled for /store/session-gc.json.lock")

function expectFreshReplay(queryIndex: number, oldSessionIds: string[], history: string, liveTurn: string): void {
  const query = capturedQueries[queryIndex]!
  expect(query.options.sessionId).toBeDefined()
  expect(query.options.resume).toBeUndefined()
  expect(query.options.resumeSessionAt).toBeUndefined()
  expect(query.options.forkSession).not.toBe(true)
  for (const id of oldSessionIds) expect(query.sessionId).not.toBe(id)
  expect(typeof query.prompt).toBe("string")
  if (typeof query.prompt !== "string") throw new Error("expected text replay input")
  expect(query.prompt.match(/^<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/)?.[1]).toBe(history)
  expect(query.prompt.endsWith(liveTurn)).toBe(true)
}

function expectFailedPublication(status: number, text: string, stream: boolean): void {
  if (stream) {
    expect(text).toContain("event: error")
    expect(text).not.toContain('"stop_reason":"end_turn"')
  } else {
    expect(status).toBeGreaterThanOrEqual(400)
  }
}

describe("terminal publication under a stalled lifecycle lock", () => {
  let sessionDir = ""

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-publication-degrade-"))
    setSessionStoreDir(sessionDir)
    resetActiveProfile()
    clearSessionCache()
    diagnosticLog.clear()
    queryCalls = 0
    capturedQueries.length = 0
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  for (const silent of [false, true]) {
    it(`retains late-deadline diagnostics with operational stderr ${silent ? "suppressed" : "enabled"}`, async () => {
      createProxyServer({ port: 0, host: "127.0.0.1", silent, profiles })
      const stderr = spyOn(console, "error").mockImplementation(() => {})
      const holder = Promise.withResolvers<void>()
      let now = 0
      let deadline: (() => void) | undefined
      const queue = new LifecycleLockQueue({
        stallMs: 100, lagToleranceMs: 10, now: () => now,
        schedule: callback => {
          deadline = callback
          return () => { deadline = undefined }
        },
      })
      const active = queue.run("logging-store", undefined, () => holder.promise)
      try {
        now = 111
        deadline?.()
        const operational = stderr.mock.calls.map(call => String(call[0]))
          .filter(line => line.includes("session.lifecycle_stall_deadline_late"))
        expect(operational).toHaveLength(silent ? 0 : 1)
        expect(diagnosticLog.getRecent({ category: "session" })
          .filter(entry => entry.message.includes("session.lifecycle_stall_deadline_late")))
          .toHaveLength(1)
      } finally {
        holder.resolve()
        await active
        stderr.mockRestore()
        createProxyServer({ port: 0, host: "127.0.0.1", silent: false, profiles })
      }
    })
  }

  for (const stream of [false, true]) {
    for (const step of ["commitFork", "publishPinnedTranscript"] as const) {
      it(`delivers the answered ${stream ? "stream" : "non-stream"} turn when ${step} cannot be admitted`, async () => {
        const { app, sweepSessionGc } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
        const key = `degrade-${stream ? "stream" : "json"}-${step}`
        expect((await app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
        const before = lookupSharedSession(`personal:${key}`)
        expect(before).toBeDefined()

        const spy = spyOn(lifecycle, step).mockImplementation(async () => { throw stalled() })
        let text: string
        let status: number
        try {
          const response = await app.fetch(turn(key, SECOND_TURN, stream))
          status = response.status
          text = await response.text()
        } finally {
          spy.mockRestore()
        }

        expect(status).toBe(200)
        expect(text).toContain("answered")
        expect(text).not.toContain("bookkeeping")
        if (stream) {
          expect(text).toContain("event: message_stop")
          expect(text).not.toContain("event: error")
        }
        // The old mapping would resume a transcript without this turn's
        // answer, so it is gone and the next turn replays instead.
        expect(lookupSharedSession(`personal:${key}`)).toBeUndefined()
        const deferrals = diagnosticLog.getRecent({ category: "session" })
          .filter(entry => entry.message.includes("session.publication_deferred"))
        expect(deferrals).toHaveLength(1)
        expect(deferrals[0]!.message).toContain(`mode=${stream ? "stream" : "non_stream"} reason=SessionLifecycleQueueStalledError`)
        expect(deferrals[0]!.requestId).toBeDefined()

        const next = await app.fetch(turn(key, THIRD_TURN, stream))
        expect(next.status).toBe(200)
        await next.text()
        expectFreshReplay(2, [before!.claudeSessionId, capturedQueries[1]!.sessionId],
          "hi\n\n[Assistant: answered]\n\nagain\n\n[Assistant: answered]", "once more")
        expect(lookupSharedSession(`personal:${key}`)?.messageCount).toBe(THIRD_TURN.length)
        await sweepSessionGc?.()
      })
    }

    it(`preserves healthy ${stream ? "stream" : "non-stream"} publication and resume`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
      const key = `healthy-${stream}`
      expect((await app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
      const before = lookupSharedSession(`personal:${key}`)!
      const response = await app.fetch(turn(key, SECOND_TURN, stream))
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain("event: error")
      expect(capturedQueries[1]!.options.resume).toBe(before.claudeSessionId)
      expect(capturedQueries[1]!.options.forkSession).toBe(true)
      expect(capturedQueries[1]!.prompt).toBe("again")
      expect(lookupSharedSession(`personal:${key}`)?.messageCount).toBe(SECOND_TURN.length)
      expect(diagnosticLog.getRecent({ category: "session" })
        .filter(entry => entry.message.includes("session.publication_deferred"))).toHaveLength(0)
    })

    for (const identity of ["fresh", "headerless"] as const) {
      it(`defers ${identity} ${stream ? "stream" : "non-stream"} publication and replays into a distinct target`, async () => {
        const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
        const key = identity === "fresh" ? `fresh-deferred-${stream}` : undefined
        const spy = spyOn(lifecycle, "publishPinnedTranscript").mockImplementation(async () => { throw stalled() })
        try {
          const response = await app.fetch(turn(key, FIRST_TURN, stream))
          expect(response.status).toBe(200)
          const text = await response.text()
          expect(text).toContain("answered")
          expect(text).not.toContain("event: error")
        } finally {
          spy.mockRestore()
        }
        const mappingKey = key ? `personal:${key}` : getConversationFingerprint(FIRST_TURN, capturedQueries[0]!.options.cwd)
        expect(lookupSharedSession(mappingKey)).toBeUndefined()
        const next = await app.fetch(turn(key, SECOND_TURN, stream))
        expect(next.status).toBe(200)
        await next.text()
        expectFreshReplay(1, [capturedQueries[0]!.sessionId], "hi\n\n[Assistant: answered]", "again")
      })
    }

    it(`preserves a concurrent mapping winner when ${stream ? "stream" : "non-stream"} invalidation loses`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
      const key = `publication-winner-${stream}`
      expect((await app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
      const spy = spyOn(lifecycle, "publishPinnedTranscript").mockImplementation(async () => {
        expect(await sessionStore.storeSharedSession(`personal:${key}`, "concurrent-winner")).toBeTruthy()
        throw stalled()
      })
      try {
        const response = await app.fetch(turn(key, SECOND_TURN, stream))
        expectFailedPublication(response.status, await response.text(), stream)
        expect(lookupSharedSession(`personal:${key}`)?.claudeSessionId).toBe("concurrent-winner")
        expect(diagnosticLog.getRecent({ category: "session" })
          .filter(entry => entry.message.includes("session.publication_deferred"))).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })

    it(`does not deliver ${stream ? "stream" : "non-stream"} success when durable invalidation fails`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
      const key = `publication-invalidation-failed-${stream}`
      expect((await app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
      const before = lookupSharedSession(`personal:${key}`)!
      const publication = spyOn(lifecycle, "publishPinnedTranscript").mockImplementation(async () => { throw stalled() })
      const invalidation = spyOn(sessionStore, "evictSharedSession").mockImplementation(() => {
        throw new Error("controlled durable invalidation failure")
      })
      try {
        const response = await app.fetch(turn(key, SECOND_TURN, stream))
        const text = await response.text()
        expectFailedPublication(response.status, text, stream)
        expect(text).toContain("controlled durable invalidation failure")
        expect(lookupSharedSession(`personal:${key}`)?.claudeSessionId).toBe(before.claudeSessionId)
      } finally {
        publication.mockRestore()
        invalidation.mockRestore()
      }
    })

    for (const interruption of ["cancel", "shutdown"] as const) {
      it(`does not authorize ${stream ? "stream" : "non-stream"} success after publication ${interruption}`, async () => {
        const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
        const key = `publication-${interruption}-${stream}`
        expect((await proxy.app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
        const controller = new AbortController()
        const spy = spyOn(lifecycle, "publishPinnedTranscript").mockImplementation(async () => {
          if (interruption === "cancel") controller.abort(new Error("controlled publication cancellation"))
          else proxy.forceAbortInFlight?.()
          throw stalled()
        })
        try {
          const response = await proxy.app.fetch(turn(key, SECOND_TURN, stream, { signal: controller.signal }))
          expectFailedPublication(response.status, await response.text(), stream)
          expect(lookupSharedSession(`personal:${key}`)).toBeUndefined()
        } finally {
          spy.mockRestore()
        }
      })
    }

    for (const rejection of ["queue", "external"] as const) {
      it(`delivers ${stream ? "stream" : "non-stream"} answer after an actual ${rejection} rejection before callback entry`, async () => {
        const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
        const key = `publication-actual-${rejection}-${stream}`
        expect((await app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
        const holder = Promise.withResolvers<void>()
        const queue = new LifecycleLockQueue({ maxPending: 0 })
        const active = queue.run("controlled-publication", undefined, () => holder.promise)
        let callbackEntered = false
        let admissionError: unknown
        const original = lifecycle.publishPinnedTranscript
        const publication = spyOn(lifecycle, "publishPinnedTranscript").mockImplementation(async <T extends boolean | string>(
          locator: lifecycle.TranscriptLocator, publish: () => T | Promise<T>, options: lifecycle.SessionLifecycleOptions = {},
        ): Promise<T> => {
          try {
            if (rejection === "queue") {
              return await queue.run("controlled-publication", options.admissionSignal, async () => {
                callbackEntered = true
                return original(locator, publish, options)
              })
            }
            const lock = join(sessionDir, "session-gc.json.lock")
            writeFileSync(lock, `controlled external owner\n${Date.now()}\n`)
            try {
              return await original(locator, () => { callbackEntered = true; return publish() }, { ...options, lockWaitMs: 0 })
            } finally {
              rmSync(lock, { force: true })
            }
          } catch (error) {
            admissionError = error
            throw error
          }
        })
        try {
          const response = await app.fetch(turn(key, SECOND_TURN, stream))
          expect(response.status).toBe(200)
          const text = await response.text()
          expect(text).toContain("answered")
          expect(text).not.toContain("event: error")
          expect(admissionError).toBeInstanceOf(SessionLifecycleLockError)
          expect(callbackEntered).toBe(false)
          expect(lookupSharedSession(`personal:${key}`)).toBeUndefined()
        } finally {
          publication.mockRestore()
          holder.resolve()
          await active
        }
      })
    }

    it(`requires atomic durable priority publication for an answered ${stream ? "stream" : "non-stream"} turn`, async () => {
      const savedRouting = process.env.MERIDIAN_ROUTING
      const savedKey = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      const signingKey = Buffer.alloc(32, 3)
      process.env.MERIDIAN_ROUTING = "priority"
      process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = signingKey.toString("base64url")
      const key = `publication-priority-${stream}`
      const headers = (humanMessageId: string, offset: number): Record<string, string> => {
        const token = createPriorityAttestation({
          generation: "oc1", sessionId: key, agentId: "build", humanMessageId,
          issuedAt: Math.floor(Date.now() / 1000) + offset,
        }, signingKey)
        if (!token) throw new Error("test attestation could not be signed")
        return { "x-opencode-request": humanMessageId, "x-opencode-agent-name": "build", "x-opencode-agent-mode": "primary", "x-meridian-opencode-turn": token }
      }
      try {
        const { app } = createProxyServer({
          port: 0, host: "127.0.0.1", silent: true,
          profiles: [...profiles, { id: "secondary", claudeConfigDir: "/home/.claude-secondary" }],
        })
        expect((await app.fetch(turn(key, FIRST_TURN, false, { headers: headers("human-1", 0) }))).status).toBe(200)
        const before = sessionStore.lookupPriorityAssignmentResult(`opencode:${key}`)
        expect(before.status).toBe("found")
        const publication = spyOn(lifecycle, "publishPinnedTranscript").mockImplementation(async () => { throw stalled() })
        try {
          const response = await app.fetch(turn(key, SECOND_TURN, stream, { headers: headers("human-2", 1) }))
          expectFailedPublication(response.status, await response.text(), stream)
          const retained = sessionStore.lookupPriorityAssignmentResult(`opencode:${key}`)
          expect(retained.status).toBe("found")
          if (before.status !== "found" || retained.status !== "found") throw new Error("test priority authority is missing")
          expect(retained.assignment).toEqual(before.assignment)
          expect(retained.generation).toBe(before.generation)
          expect(diagnosticLog.getRecent({ category: "session" })
            .filter(entry => entry.message.includes("session.publication_deferred"))).toHaveLength(0)
        } finally {
          publication.mockRestore()
        }
      } finally {
        if (savedRouting === undefined) delete process.env.MERIDIAN_ROUTING
        else process.env.MERIDIAN_ROUTING = savedRouting
        if (savedKey === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
        else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = savedKey
      }
    })
  }
})
