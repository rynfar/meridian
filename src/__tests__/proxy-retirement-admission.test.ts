import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  assistantMessage, withMockSdkSessionId, parseSSE, messageStart,
  textBlockStart, textDelta, blockStop, messageDelta, messageStop,
} from "./helpers"

const queryProfiles: Array<string | undefined> = []
// When set, the next query parks inside the SDK until released, holding its
// turn (and its prepared transcript) in flight.
let holdNextQuery: { entered: () => void; release: Promise<void> } | undefined
installSdkMock(() => ({
  query: (params: { options?: { sessionId?: string; resume?: string; includePartialMessages?: boolean; env?: Record<string, string | undefined> } }) => (async function* () {
    queryProfiles.push(params.options?.env?.CLAUDE_CONFIG_DIR)
    const hold = holdNextQuery
    holdNextQuery = undefined
    if (hold) {
      hold.entered()
      await hold.release
    }
    if (params.options?.includePartialMessages) {
      for (const event of [messageStart(), textBlockStart(), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop()]) {
        yield withMockSdkSessionId(event, params.options)
      }
    }
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-retirement-admission.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx, fn) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { setSessionStoreDir, readSessionStoreSnapshot } = await import("../proxy/sessionStore")

let root: string
let proxy: ReturnType<typeof createProxyServer> | undefined
const savedEnv: Record<string, string | undefined> = {}
const overrides = {
  MERIDIAN_SESSION_GC_MAX_PENDING: "2",
  MERIDIAN_SESSION_GC_GRACE_MS: "3600000",
  MERIDIAN_ROUTING: "manual",
  MERIDIAN_PASSTHROUGH: "0",
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-retirement-http-")))
  for (const key of [...Object.keys(overrides), "MERIDIAN_WORKDIR", "MERIDIAN_CONFIG_DIR", "MERIDIAN_SESSION_PROFILE_COPY_PRUNE", "MERIDIAN_SESSION_PROFILE_COPY_GRACE_MS", "CLAUDE_PROXY_SESSION_PROFILE_COPY_PRUNE"]) savedEnv[key] = process.env[key]
  Object.assign(process.env, overrides, { MERIDIAN_WORKDIR: root, MERIDIAN_CONFIG_DIR: join(root, "config") })
  setSessionStoreDir(join(root, "sessions"))
  resetActiveProfile()
  await clearSessionCache()
  queryProfiles.length = 0
  for (const id of ["personal", "work"]) mkdirSync(join(root, id))
  proxy = createProxyServer({
    port: 0, host: "127.0.0.1", defaultProfile: "personal",
    profiles: ["personal", "work"].map(id => ({ id, claudeConfigDir: join(root, id) })),
  })
})

afterEach(async () => {
  await proxy?.sweepSessionGc?.()
  proxy = undefined
  await clearSessionCache()
  resetActiveProfile()
  setSessionStoreDir(null)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

async function request(key: string, stream: boolean) {
  if (!proxy) throw new Error("test proxy not initialized")
  return await proxy.app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model: "haiku", stream, messages: [{ role: "user", content: key }] }),
  }))
}

async function sweep() {
  if (!proxy?.sweepSessionGc) throw new Error("SDK proxy GC not initialized")
  await proxy.sweepSessionGc()
}

describe("profile switch admission with bounded retirement", () => {
  it.each([false, true])("admits a fresh request after clearing old profile mappings (stream=%s)", async (stream) => {
    for (const key of ["old-a", "old-b"]) {
      const response = await request(key, false)
      expect(response.status, await response.clone().text()).toBe(200)
    }
    expect(Object.values(readSessionStoreSnapshot())).toHaveLength(2)
    if (!proxy) throw new Error("test proxy not initialized")
    // Drain a sweep started by the completed request before changing its pins.
    await sweep()
    const switched = await proxy.app.fetch(new Request("http://localhost/profiles/active", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "work" }),
    }))
    expect(switched.status).toBe(200)
    // A switch keeps profile-scoped mappings; losing them all is what leaves
    // every old transcript pending retirement at the bound.
    expect(Object.values(readSessionStoreSnapshot())).toHaveLength(2)
    await clearSessionCache()
    expect(Object.values(readSessionStoreSnapshot())).toHaveLength(0)
    await sweep()
    const sidecar = JSON.parse(readFileSync(join(root, "sessions", "session-gc.json"), "utf8")) as {
      resources: Record<string, { state: string }>
    }
    expect(Object.values(sidecar.resources).some(resource => resource.state === "retired")).toBe(true)
    const response = await request("new-work", stream)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    if (stream) {
      const events = parseSSE(text)
      expect(events.some(event => event.event === "error"), text).toBe(false)
      expect(events.filter(event => event.event === "message_stop")).toHaveLength(1)
      expect(text).toContain("ok")
    } else {
      expect(JSON.parse(text).content).toEqual([{ type: "text", text: "ok" }])
    }
    expect(queryProfiles).toEqual([join(root, "personal"), join(root, "personal"), join(root, "work")])
    expect(Object.values(readSessionStoreSnapshot())).toHaveLength(1)
    expect(Object.values(sidecar.resources).filter(resource => resource.state === "retired")).toHaveLength(1)
  })

  it.each([false, true])("admits concurrent turns while the retirement backlog sits at its passive bound (stream=%s)", async (stream) => {
    for (const key of ["old-a", "old-b"]) {
      const response = await request(key, false)
      expect(response.status, await response.clone().text()).toBe(200)
    }
    await sweep()
    await clearSessionCache()
    await sweep()
    const retired = () => Object.values((JSON.parse(readFileSync(join(root, "sessions", "session-gc.json"), "utf8")) as {
      resources: Record<string, { state: string }>
    }).resources).filter(resource => resource.state === "retired").length
    expect(retired()).toBe(1)

    let entered!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    holdNextQuery = { entered: () => entered(), release: new Promise<void>(resolve => { release = resolve }) }
    const first = request("busy-a", stream)
    await inside
    try {
      const second = await request("busy-b", stream)
      const text = await second.text()
      expect(second.status, text).toBe(200)
      if (stream) expect(parseSSE(text).some(event => event.event === "error"), text).toBe(false)
    } finally {
      release()
    }
    const firstResponse = await first
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200)
    await firstResponse.text()
  })
})


describe("profile-copy pruning consent", () => {
  for (const enabled of [undefined, "0", "false", "1"]) {
    it(`only retires old mappings with explicit opt-in (${enabled ?? "unset"})`, async () => {
      delete process.env.CLAUDE_PROXY_SESSION_PROFILE_COPY_PRUNE
      if (enabled === undefined) delete process.env.MERIDIAN_SESSION_PROFILE_COPY_PRUNE
      else process.env.MERIDIAN_SESSION_PROFILE_COPY_PRUNE = enabled
      process.env.MERIDIAN_SESSION_PROFILE_COPY_GRACE_MS = "0"
      const document = {
        "personal:policy": { claudeSessionId: "older", createdAt: 1, lastUsedAt: 1, messageCount: 1 },
        "work:policy": { claudeSessionId: "newer", createdAt: 2, lastUsedAt: 2, messageCount: 1 },
      }
      mkdirSync(join(root, "sessions"), { recursive: true })
      writeFileSync(join(root, "sessions", "sessions.json"), JSON.stringify(document))
      proxy = createProxyServer({ port: 0, host: "127.0.0.1", profiles: ["personal", "work"].map(id => ({ id, claudeConfigDir: join(root, id) })) })
      await proxy.sweepSessionGc?.()
      expect(Object.keys(readSessionStoreSnapshot()).sort()).toEqual(enabled === "1"
        ? ["work:policy"] : ["personal:policy", "work:policy"])
    })
  }
})
