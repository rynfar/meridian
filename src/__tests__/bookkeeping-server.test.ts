import { afterEach, beforeEach, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  assistantMessage, withMockSdkSessionId, messageStart, textBlockStart, textDelta,
  blockStop, messageDelta, messageStop,
} from "./helpers"
import {
  initializeSessionBookkeeping, type BookkeepingHandle,
} from "../proxy/session/bookkeeping/database"
import { initializeProxyBookkeeping } from "../proxy/session/bookkeeping/runtime"
import { setSessionStoreDir, readSessionStoreSnapshot } from "../proxy/sessionStore"

let queries = 0
let fault: "before" | "after" | "busy" | undefined
// Another writer holds the database from this SDK query on, until released.
let lockFromQuery: number | undefined
let locked = false
installSdkMock(() => ({
  query: (params: { options?: { sessionId?: string; resume?: string; includePartialMessages?: boolean } }) =>
    (async function* () {
      queries++
      if (queries === lockFromQuery) locked = true
      if (params.options?.includePartialMessages) {
        for (const event of [messageStart(), textBlockStart(), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop()]) {
          yield withMockSdkSessionId(event, params.options)
        }
      }
      yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
    })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "bookkeeping-server.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context, callback) => callback() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer } = await import("../proxy/server")

let root: string
let directory: string
let observer: BookkeepingHandle
let startup: BookkeepingHandle | undefined
let proxy: ReturnType<typeof createProxyServer> | undefined
const saved: Record<string, string | undefined> = {}
const overrides = {
  MERIDIAN_BOOKKEEPING: "sqlite", MERIDIAN_ROUTING: "manual", MERIDIAN_PASSTHROUGH: "0",
  MERIDIAN_SESSION_GC_GRACE_MS: "3600000", MERIDIAN_NO_UPDATE_CHECK: "1",
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "bookkeeping-server-"))
  directory = join(root, "sessions")
  mkdirSync(join(root, "config"))
  for (const key of [...Object.keys(overrides), "MERIDIAN_CONFIG_DIR", "MERIDIAN_WORKDIR"]) saved[key] = process.env[key]
  Object.assign(process.env, overrides, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_WORKDIR: root })
  setSessionStoreDir(directory)
  queries = 0
  fault = undefined
  lockFromQuery = undefined
  locked = false
  observer = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    if (locked && sql === "BEGIN IMMEDIATE") {
      throw Object.assign(new Error("injected concurrent writer"), { code: "SQLITE_BUSY" })
    }
    if (sql === "COMMIT" && db.inTransaction && fault
      && Number((db.prepare("SELECT count(*) AS n FROM mappings").get() as { n: number }).n) > 0) {
      const requested = fault
      fault = undefined
      if (requested === "after") db.exec(sql)
      throw Object.assign(new Error("injected publication COMMIT fault"), {
        code: requested === "busy" ? "SQLITE_BUSY" : "SQLITE_IOERR",
      })
    }
    db.exec(sql)
  } })
  startup = await initializeProxyBookkeeping()
  proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
})
afterEach(async () => {
  proxy?.beginDrain?.()
  await proxy?.closeBackend?.()
  proxy = undefined
  startup?.close()
  startup = undefined
  observer.close()
  setSessionStoreDir(null)
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

const opening = [{ role: "user", content: "hello" }]
const followUp = [...opening, { role: "assistant", content: "ok" }, { role: "user", content: "again" }]

async function request(stream: boolean, key = `sql-client:${root}`, messages: unknown[] = opening) {
  if (!proxy) throw new Error("proxy missing")
  return proxy.app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model: "haiku", stream, messages }),
  }))
}

it.each([false, true])("publishes a production SQL request without JSON (stream=%s)", async (stream) => {
  const response = await request(stream)
  const text = await response.text()
  expect(response.status, text).toBe(200)
  expect(text).toContain("ok")
  expect(text).not.toContain('"type":"error"')
  expect(queries).toBe(1)
  expect(Object.keys(readSessionStoreSnapshot())).toHaveLength(1)
  expect(observer.reader.get("SELECT count(*) AS n FROM mapping_pins")?.n).toBe(1)
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  expect(existsSync(join(directory, "session-gc.json"))).toBe(false)
})

it.each(["before", "after", "busy"] as const)("fails closed on publication COMMIT %s", async (failure) => {
  fault = failure
  const response = await request(false)
  const text = await response.text()
  expect(response.status, text).toBe(503)
  expect(text).toContain("overloaded_error")
  expect(fault).toBeUndefined()
  await proxy?.sweepSessionGc?.()
  const entries = readSessionStoreSnapshot()
  expect(Object.keys(entries)).toHaveLength(failure === "after" ? 1 : 0)
  if (failure === "after") {
    expect(observer.reader.get("SELECT count(*) AS n FROM mapping_pins")?.n).toBe(1)
    expect(observer.reader.get("SELECT state FROM resources")?.state).toBe("live")
  }
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
})

it.each(["before", "after", "busy"] as const)("streaming publication COMMIT %s remains typed and preserves uncertain authority", async (failure) => {
  fault = failure
  const response = await request(true)
  const text = await response.text()
  expect(text).toContain("overloaded_error")
  expect(text).not.toContain('"type":"api_error"')
  expect(fault).toBeUndefined()
  await proxy?.sweepSessionGc?.()
  expect(Object.keys(readSessionStoreSnapshot())).toHaveLength(failure === "after" ? 1 : 0)
  if (failure === "after") {
    expect(observer.reader.get("SELECT count(*) AS n FROM mapping_pins")?.n).toBe(1)
    expect(observer.reader.get("SELECT state FROM resources")?.state).toBe("live")
  }
})

// Upstream defers a terminal lock error by invalidating the mapping instead.
// In SQLite mode that invalidation waits on the same refused writer lock, and
// a failed invalidation of a resumed mapping keeps the session turn fence, so
// the conversation would hang on every retry. The refusal must stay retryable.
it.each([false, true])("a resumed turn refused by a held writer lock leaves the conversation retryable (stream=%s)", async (stream) => {
  const budget = { MERIDIAN_SESSION_GC_LOCK_WAIT_MS: "300", MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "300" }
  const previous = Object.fromEntries(Object.keys(budget).map(key => [key, process.env[key]]))
  Object.assign(process.env, budget)
  try {
    const first = await request(stream)
    expect(first.status, await first.text()).toBe(200)

    lockFromQuery = queries + 1
    const refused = await request(stream, undefined, followUp)
    const refusedText = await refused.text()
    expect(refusedText).toContain("overloaded_error")
    expect(locked).toBe(true)
    locked = false

    const retry = await Promise.race([
      request(stream, undefined, followUp).then(async response => ({ status: response.status, text: await response.text() })),
      new Promise<undefined>(resolve => setTimeout(resolve, 5000)),
    ])
    expect(retry, "retry is still waiting on the session turn fence").toBeDefined()
    expect(retry!.status, retry!.text).toBe(200)
    expect(retry!.text).toContain("ok")
    expect(retry!.text).not.toContain('"type":"error"')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 20000)
