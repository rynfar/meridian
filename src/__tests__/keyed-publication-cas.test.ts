/**
 * A keyed turn must not lose its answer to an unrelated conversation.
 *
 * A turn whose key has no mapping yet (a conversation's first turn on an
 * account, including one that just moved there) fences publication on the
 * key's absence generation, which is named by one of 65,536 shared slots.
 * Every write to any mapping in that slot used to advance it, so each turn of
 * a busy conversation in the same slot failed the fresh turn with "Shared
 * session mapping changed before publication" after the model had answered,
 * and the next turn, fresh again, failed the same way.
 */
import { installModelsMock } from "./modelsMock"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  evictSharedSession,
  lookupSharedSession,
  lookupSharedSessionResult,
  setSessionStoreDir,
  storeSharedSession,
} from "../proxy/sessionStore"
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
const logged: string[] = []

function armTurn(): void {
  turnStarted = new Promise<void>(resolve => { markTurnStarted = resolve })
}

installSdkMock(() => ({
  query: (params: { options?: { sessionId?: string } }) => {
    queryCalls++
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-keyed-cas-${queryCalls}`)
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
}), "keyed-publication-cas.test.ts")

installLoggerMock(() => ({
  claudeLog: (event: string) => { logged.push(event) },
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

installModelsMock(() => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
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
const SECOND_TURN = [...FIRST_TURN, { role: "assistant", content: "ok" }, { role: "user", content: "again" }]

/** Another mapping key whose absence generation shares `key`'s slot. */
function slotNeighbor(key: string): string {
  const slot = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 4)
  const target = slot(key)
  for (let index = 0; ; index++) {
    const candidate = `personal:neighbor-${index}`
    if (candidate !== key && slot(candidate) === target) return candidate
  }
}

function generationOf(key: string): string | undefined {
  const found = lookupSharedSessionResult(key)
  if (found.status === "error") throw found.error
  return found.generation
}

function turn(sessionId: string, messages = FIRST_TURN, stream = false): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
  })
}

type ProxyApp = ReturnType<typeof createProxyServer>["app"]

/** Run one turn, doing `whileHeld` after the model started and before it answers. */
async function turnWith(app: ProxyApp, request: Request, whileHeld: () => Promise<void> = async () => {}) {
  armTurn()
  const pending = app.fetch(request)
  await turnStarted
  await whileHeld()
  releaseTurn()
  const response = await pending
  return { status: response.status, text: await response.text() }
}

describe("absence generation slots", () => {
  let sessionDir = ""

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-keyed-cas-store-"))
    setSessionStoreDir(sessionDir)
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  it("does not move when another mapping in the slot is written", async () => {
    const key = "personal:fresh"
    const neighbor = slotNeighbor(key)
    const absent = generationOf(key)

    expect(await storeSharedSession(neighbor, "sdk-neighbor", 1)).toBeTruthy()
    expect(await storeSharedSession(neighbor, "sdk-neighbor", 3)).toBeTruthy()

    expect(generationOf(key)).toBe(absent)
    expect(await storeSharedSession(key, "sdk-fresh", 1, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, absent)).toBeTruthy()
  }, 20_000)

  it("still fences a key that was created and removed again", async () => {
    const key = "personal:aba"
    const absent = generationOf(key)

    const created = await storeSharedSession(key, "sdk-other", 1)
    expect(created).toBeTruthy()
    expect(await evictSharedSession(key, created || undefined)).toBe(true)

    expect(lookupSharedSessionResult(key).status).toBe("missing")
    expect(generationOf(key)).not.toBe(absent)
    expect(await storeSharedSession(key, "sdk-stale", 1, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, absent)).toBe(false)
  }, 20_000)
})

describe("keyed turn publication", () => {
  let sessionDir = ""

  beforeEach(async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-keyed-cas-"))
    setSessionStoreDir(sessionDir)
    resetActiveProfile()
    await clearSessionCache()
    queryCalls = 0
    logged.length = 0
    armTurn()
  })

  afterEach(async () => {
    releaseTurn()
    await Bun.sleep(25)
    rmSync(sessionDir, { recursive: true, force: true })
  })

  for (const stream of [false, true]) {
    const mode = stream ? "stream" : "non-stream"

    it(`publishes a fresh ${mode} turn while a slot neighbor keeps writing`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
      const id = `neighbor-${mode}`
      const neighbor = slotNeighbor(`personal:${id}`)

      const first = await turnWith(app, turn(id, FIRST_TURN, stream), async () => {
        expect(await storeSharedSession(neighbor, "sdk-neighbor", 1)).toBeTruthy()
      })
      expect(first.text).not.toContain("Shared session mapping changed")
      expect(first.status).toBe(200)
      expect(lookupSharedSession(`personal:${id}`)?.messageCount).toBe(FIRST_TURN.length)
      expect(logged).not.toContain("session.keyed_publication_lost")
    }, 20_000)

    it(`answers a ${mode} turn whose key was created and removed under it, and the next turn publishes`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
      const id = `aba-${mode}`
      const key = `personal:${id}`

      const first = await turnWith(app, turn(id, FIRST_TURN, stream), async () => {
        const created = await storeSharedSession(key, "sdk-elsewhere", 1)
        expect(created).toBeTruthy()
        expect(await evictSharedSession(key, created || undefined)).toBe(true)
      })
      expect(first.text).not.toContain("Shared session mapping changed")
      expect(first.status).toBe(200)
      expect(first.text).toContain("ok")
      expect(logged).toContain("session.keyed_publication_lost")
      expect(lookupSharedSession(key)).toBeUndefined()

      const second = await turnWith(app, turn(id, SECOND_TURN, stream))
      expect(second.status).toBe(200)
      expect(lookupSharedSession(key)?.messageCount).toBe(SECOND_TURN.length)
    }, 20_000)
  }
})
