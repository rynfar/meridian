/**
 * Task 4 - the ChatGPT writer lease.
 *
 * The constraint this exists to satisfy is that EXACTLY ONE PROCESS may hold
 * refresh authority for a ChatGPT account, at any instant, forever. ChatGPT
 * refresh tokens are single-use: two processes exchanging the same token do
 * not produce a retry, they produce an account that no amount of retrying
 * recovers - only a human logging in again.
 *
 * Every exclusion test here therefore uses a REAL SECOND OS PROCESS. An
 * in-process guard would pass while protecting nothing, and this repo already
 * contains the cautionary example: tokenRefresh.ts holds a Map and a WeakMap
 * that look like mutual exclusion and are confined to one process. Anthropic
 * tolerates that because its refresh tokens survive reuse. ChatGPT will not.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireWriterLease,
  WriterLeaseLostError,
  WriterLeaseUnavailableError,
} from "../proxy/chatgpt/lease"

const LEASE_MODULE = join(import.meta.dir, "../proxy/chatgpt/lease.ts")
const STORE_MODULE = join(import.meta.dir, "../proxy/chatgpt/credentials.ts")

/** Short enough to keep the suite quick; safe because reclaim needs a DEAD owner, not merely an old file. */
const STALE_MS = 400
const HEARTBEAT_MS = 80

let dir: string
let lockPath: string
let storePath: string
const held: Array<{ release(): void }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meridian-chatgpt-lease-"))
  lockPath = join(dir, "chatgpt.lock")
  storePath = join(dir, "chatgpt-accounts.json")
})

afterEach(() => {
  while (held.length > 0) {
    try { held.pop()?.release() } catch { /* already released by the test */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

async function take(overrides: Record<string, number> = {}) {
  const lease = await acquireWriterLease({
    lockPath,
    staleMs: STALE_MS,
    heartbeatMs: HEARTBEAT_MS,
    waitMs: 0,
    ...overrides,
  })
  held.push(lease)
  return lease
}

/** Run `body` in a real second process against the same lock file. */
async function inChildProcess(body: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import { acquireWriterLease, WriterLeaseUnavailableError } from ${JSON.stringify(LEASE_MODULE)}
      import { createChatGptCredentialStore } from ${JSON.stringify(STORE_MODULE)}
      const LOCK_PATH = ${JSON.stringify(lockPath)}
      const STORE_PATH = ${JSON.stringify(storePath)}
      const STALE_MS = ${STALE_MS}
      const HEARTBEAT_MS = ${HEARTBEAT_MS}
      ${body}
    `],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("ChatGPT writer lease - exclusion across real processes", () => {
  it("refuses a second OS process while this one holds the lease", async () => {
    await take()

    const result = await inChildProcess(`
      try {
        await acquireWriterLease({ lockPath: LOCK_PATH, staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS, waitMs: 0 })
        console.log("ACQUIRED")
      } catch (error) {
        console.log(error instanceof WriterLeaseUnavailableError ? "REFUSED" : "OTHER:" + error?.name)
      }
    `)

    expect(result.stdout.trim()).toBe("REFUSED")
    expect(result.exitCode).toBe(0)
  })

  it("does NOT evict a live holder whose lock file has gone stale by time alone", async () => {
    // Heartbeat parked beyond this test's lifetime deliberately. With the
    // normal one running it would refresh the mtime while the child is still
    // starting, so the child would refuse because the lock looked FRESH -
    // and this test would pass against an implementation with no liveness
    // probe in it at all.
    const lease = await take({ heartbeatMs: 60_000 })

    // Backdate well past the stale threshold, simulating a heartbeat that
    // stopped - a paused, swapping or overloaded holder. Time alone must
    // never be permission to spend another process's single-use token.
    const ancient = new Date(Date.now() - STALE_MS * 50)
    utimesSync(lockPath, ancient, ancient)

    const result = await inChildProcess(`
      try {
        await acquireWriterLease({ lockPath: LOCK_PATH, staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS, waitMs: 0 })
        console.log("ACQUIRED")
      } catch (error) {
        console.log(error instanceof WriterLeaseUnavailableError ? "REFUSED" : "OTHER:" + error?.name)
      }
    `)

    expect(result.stdout.trim()).toBe("REFUSED")
    lease.assertValid()
  })

  it("hands the lease to the next process once the holder releases it", async () => {
    const lease = await take()
    lease.release()

    const result = await inChildProcess(`
      const lease = await acquireWriterLease({ lockPath: LOCK_PATH, staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS, waitMs: 0 })
      lease.assertValid()
      lease.release()
      console.log("ACQUIRED")
    `)

    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe("ACQUIRED")
  })

  it("reclaims a SIGKILLed holder and observes its last durably committed state", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { acquireWriterLease } from ${JSON.stringify(LEASE_MODULE)}
        import { createChatGptCredentialStore } from ${JSON.stringify(STORE_MODULE)}
        const lease = await acquireWriterLease({
          lockPath: ${JSON.stringify(lockPath)},
          staleMs: ${STALE_MS},
          heartbeatMs: ${HEARTBEAT_MS},
          waitMs: 0,
        })
        const store = createChatGptCredentialStore({ path: ${JSON.stringify(storePath)}, lease })
        store.commitAccount("user-killed", () => ({
          accountUserId: "user-killed",
          accountId: "acct-shared",
          email: "killed@example.test",
          refreshToken: "refresh-committed-before-death",
          accessToken: null,
          expiresAt: null,
          tokenRotatedAt: 1,
        }))
        console.log("COMMITTED")
        setInterval(() => {}, 1000)
      `],
      stdout: "pipe",
      stderr: "pipe",
    })

    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("COMMITTED")) {
      const { done, value } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    expect(seen).toContain("COMMITTED")

    child.kill("SIGKILL")
    await child.exited

    // The lock survives the kill - nothing ran to clean it up. That is the
    // state a crashed writer really leaves behind.
    expect(existsSync(lockPath)).toBe(true)

    await new Promise(resolve => setTimeout(resolve, STALE_MS + 150))

    const lease = await take()
    const { createChatGptCredentialStore } = await import("../proxy/chatgpt/credentials")
    const store = createChatGptCredentialStore({ path: storePath, lease })
    const account = store.readAccount("user-killed")

    expect(account?.refreshToken).toBe("refresh-committed-before-death")
    expect(account?.tokenRotatedAt).toBe(1)
  })

  it("reclaims a dead holder at once, before its lock goes stale", async () => {
    // A restart's successor starts within seconds of its predecessor exiting
    // without releasing. Waiting out the stale window refused every start in
    // between, though the holder was provably gone.
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { acquireWriterLease } from ${JSON.stringify(LEASE_MODULE)}
        await acquireWriterLease({ lockPath: ${JSON.stringify(lockPath)}, heartbeatMs: ${HEARTBEAT_MS}, waitMs: 0 })
        console.log("HELD")
        setInterval(() => {}, 1000)
      `],
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("HELD")) {
      const { done, value } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    expect(seen).toContain("HELD")
    child.kill("SIGKILL")
    await child.exited

    const lease = await take({ staleMs: 60_000 })

    lease.assertValid()
  })
})

describe("ChatGPT writer lease - validity", () => {
  it("creates the lock file readable only by its owner", async () => {
    await take()
    expect(statSync(lockPath).mode & 0o777).toBe(0o600)
  })

  it("assertValid throws once the lease has been released", async () => {
    const lease = await take()
    lease.release()
    expect(() => lease.assertValid()).toThrow(WriterLeaseLostError)
  })

  it("assertValid throws when another owner's lock has replaced ours", async () => {
    const lease = await take()
    // Release without telling the lease object, then let a different owner
    // take the file. This is what a stale reclaim looks like from the
    // dispossessed side, and it MUST be caught before a token is spent.
    rmSync(lockPath, { force: true })
    const usurper = await acquireWriterLease({
      lockPath,
      staleMs: STALE_MS,
      heartbeatMs: HEARTBEAT_MS,
      waitMs: 0,
    })
    held.push(usurper)

    expect(() => lease.assertValid()).toThrow(WriterLeaseLostError)
    usurper.assertValid()
  })

  it("release is idempotent and never removes a lock it no longer owns", async () => {
    const lease = await take()
    lease.release()

    const other = await take()
    lease.release()

    expect(existsSync(lockPath)).toBe(true)
    other.assertValid()
  })

  it("keeps the lock fresh while held, so a peer never sees it as abandoned", async () => {
    await take()
    const first = statSync(lockPath).mtimeMs
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS * 3))
    const later = statSync(lockPath).mtimeMs

    expect(later).toBeGreaterThan(first)
    expect(Date.now() - later).toBeLessThan(STALE_MS)
  })
})
