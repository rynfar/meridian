/**
 * The keepalive runner's permit discipline: a beat that cannot pin its source
 * transcript never takes an SDK permit, and one that finds no free permit
 * releases its pin. A leaked permit would shrink the SDK budget real turns get.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"
import { createCacheKeepaliveRunner, type CacheKeepaliveRecipe } from "../proxy/cacheKeepaliveRunner"
import type { SemaphoreLease } from "../proxy/concurrency"

let dir = ""
const cwd = "/tmp/keepalive-project"
const sessionId = "11111111-1111-4111-8111-111111111111"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meridian-keepalive-runner-"))
  setSessionStoreDir(dir)
  storeSharedSession("ses_runner", sessionId, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { sessionId, configDir: dir, projectDir: cwd })
})

afterEach(() => {
  setSessionStoreDir(null)
  rmSync(dir, { recursive: true, force: true })
})

const recipe: CacheKeepaliveRecipe = {
  mappingKey: "ses_runner",
  options: { cwd },
  createMcpServers: () => ({}),
  adapterName: "opencode",
  profileId: "default",
  profileType: "claude-max",
  extendedContext: false,
  model: "sonnet",
}

function deps(overrides: { pin?: () => () => void; permit?: () => SemaphoreLease | undefined }) {
  const calls = { permits: 0, queries: 0, released: 0 }
  return {
    calls,
    runner: createCacheKeepaliveRunner({
      tryAcquirePermit: () => { calls.permits++; return overrides.permit?.() },
      runQuery: () => { calls.queries++; return (async function* () {})() },
      pinTranscript: overrides.pin ?? (() => () => { calls.released++ }),
      isDraining: () => false,
      accountBlock: () => undefined,
    }),
  }
}

describe("cache keepalive runner permits", () => {
  it("takes no permit when the source transcript cannot be pinned, and stops tracking", async () => {
    const { calls, runner } = deps({ pin: () => { throw new Error("invalid transcript locator") } })
    expect(await runner(recipe, sessionId, new AbortController().signal)).toBe("stop")
    expect(calls.permits).toBe(0)
    expect(calls.queries).toBe(0)
  })

  it("releases its pin when no permit is free", async () => {
    const { calls, runner } = deps({ permit: () => undefined })
    expect(await runner(recipe, sessionId, new AbortController().signal)).toBe("retry")
    expect(calls.permits).toBe(1)
    expect(calls.released).toBe(1)
    expect(calls.queries).toBe(0)
  })
})
