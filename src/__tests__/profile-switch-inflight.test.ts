/**
 * A profile switch must not fail a turn that is already in flight.
 *
 * Publication fences each keyed turn with a compare-and-swap on the durable
 * mapping generation it read at admission. A switch that wiped the durable
 * store advanced every key's generation underneath that turn, so a turn whose
 * model had already answered failed with "Shared session mapping changed
 * before publication". Automatic account switchers fire while turns are live,
 * which made this routine rather than a corner case.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { lookupSharedSession, setSessionStoreDir } from "../proxy/sessionStore"
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

let releaseTurn: () => void = () => {}
let turnStarted: Promise<void> = Promise.resolve()
let markTurnStarted: () => void = () => {}
let queryCalls = 0

function armTurn(): void {
  turnStarted = new Promise<void>(resolve => { markTurnStarted = resolve })
}

installSdkMock(() => ({
  query: (params: { options?: { sessionId?: string } }) => {
    queryCalls++
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-inflight-${queryCalls}`)
    const held = new Promise<void>(resolve => { releaseTurn = resolve })
    const generator = (async function* () {
      yield { ...messageStart(), session_id: sessionId }
      markTurnStarted()
      await held
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
}), "profile-switch-inflight.test.ts")

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

const profiles = [
  { id: "personal", claudeConfigDir: "/home/.claude" },
  { id: "work", claudeConfigDir: "/home/.claude-work" },
]

const FIRST_TURN = [{ role: "user", content: "hi" }]
const SECOND_TURN = [...FIRST_TURN, { role: "assistant", content: "ok" }, { role: "user", content: "again" }]

function turn(
  sessionId: string,
  messages: Array<{ role: string; content: string }> = FIRST_TURN,
  stream = false,
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream,
      messages,
    }),
  })
}

type ProxyApp = ReturnType<typeof createProxyServer>["app"]

async function completeTurn(app: ProxyApp, request: Request): Promise<Response> {
  armTurn()
  const pending = app.fetch(request)
  await turnStarted
  releaseTurn()
  return pending
}

function switchTo(profile: string): Request {
  return new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  })
}

describe("profile switch during an in-flight turn", () => {
  let sessionDir = ""

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-switch-inflight-"))
    setSessionStoreDir(sessionDir)
    resetActiveProfile()
    clearSessionCache()
    queryCalls = 0
    armTurn()
  })

  afterEach(async () => {
    releaseTurn()
    await Bun.sleep(25)
    rmSync(sessionDir, { recursive: true, force: true })
  })

  for (const stream of [false, true]) {
    it(`publishes the answered ${stream ? "stream" : "non-stream"} turn instead of failing it`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
      const key = `inflight-${stream ? "stream" : "json"}`

      // The CAS only breaks when the switch has a mapping to wipe, which is
      // every turn after a conversation's first.
      expect((await completeTurn(app, turn(key))).status).toBe(200)
      expect(lookupSharedSession(`personal:${key}`)).toBeDefined()

      armTurn()
      const pending = app.fetch(turn(key, SECOND_TURN, stream))
      await turnStarted

      expect((await app.fetch(switchTo("work"))).status).toBe(200)

      releaseTurn()
      const response = await pending
      const text = await response.text()
      expect(text).not.toContain("Shared session mapping changed")
      expect(response.status).toBe(200)
      expect(lookupSharedSession(`personal:${key}`)?.messageCount).toBe(SECOND_TURN.length)
    })
  }

  it("keeps another profile's durable resume state", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })

    expect((await completeTurn(app, turn("resting-1"))).status).toBe(200)
    const before = lookupSharedSession("personal:resting-1")
    expect(before).toBeDefined()

    expect((await app.fetch(switchTo("work"))).status).toBe(200)

    // Keys are scoped by profile, so the work profile can never resume it;
    // wiping it only forced a full replay when the account came back.
    expect(lookupSharedSession("personal:resting-1")?.claudeSessionId).toBe(before!.claudeSessionId)
    expect((await completeTurn(app, turn("resting-1"))).status).toBe(200)
    const work = lookupSharedSession("work:resting-1")
    expect(work).toBeDefined()
    expect(work?.claudeSessionId).not.toBe(before!.claudeSessionId)
    expect(lookupSharedSession("personal:resting-1")?.claudeSessionId).toBe(before!.claudeSessionId)
  })
})
