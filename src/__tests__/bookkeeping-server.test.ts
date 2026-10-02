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
installSdkMock(() => ({
  query: (params: { options?: { sessionId?: string; resume?: string; includePartialMessages?: boolean } }) =>
    (async function* () {
      queries++
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
  observer = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
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

async function request(stream: boolean, key = `sql-client:${root}`) {
  if (!proxy) throw new Error("proxy missing")
  return proxy.app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model: "haiku", stream, messages: [{ role: "user", content: "hello" }] }),
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
