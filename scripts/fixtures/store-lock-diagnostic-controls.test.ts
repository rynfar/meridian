import { expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
const helperFile = process.env.BOOKKEEPING_LOCK_DIAGNOSTIC_HELPER_FILE
if (!helperFile) throw new Error("diagnostic helper custody path is required")
const { eventBuffer, lockMetadata, observedCall }: typeof import("../../src/__tests__/fixtures/store-lock-diagnostic") = await import(pathToFileURL(helperFile).href)

test("native receiver, argument, return and throw identities survive the observer", () => {
  const receiver = {}, argument = {}, result = {}, health = { observerError: false }
  const original = function(this: unknown, value: unknown): unknown {
    expect(this).toBe(receiver); expect(value).toBe(argument); return result
  }
  let observed = 0
  expect(observedCall(original, receiver, [argument], () => { observed++ }, health)).toBe(result)
  expect(observed).toBe(1)
  const thrown = {}
  try { observedCall(() => { throw thrown }, receiver, [], () => { observed++ }, health); throw new Error("did not throw") }
  catch (error) { expect(error).toBe(thrown) }
  expect(observed).toBe(2)
  expect(health.observerError).toBe(false)
})

test("recording failure cannot replace a native result or thrown object", () => {
  const health = { observerError: false }, result = {}, thrown = {}
  const brokenRecord = (): never => { throw new Error("recorder failed") }
  expect(observedCall(() => result, null, [], brokenRecord, health)).toBe(result)
  expect(health.observerError).toBe(true)
  health.observerError = false
  try { observedCall(() => { throw thrown }, null, [], brokenRecord, health); throw new Error("did not throw") }
  catch (error) { expect(error).toBe(thrown) }
  expect(health.observerError).toBe(true)
})

test("event and byte caps explicitly mark the trace incomplete", () => {
  const byCount = eventBuffer(1, 1000)
  byCount.add({ op: "first" }); byCount.add({ op: "second" })
  expect(byCount.events).toHaveLength(1); expect(byCount.capped).toBe(true)
  const byBytes = eventBuffer(10, 1)
  byBytes.add({ op: "first" })
  expect(byBytes.events).toHaveLength(0); expect(byBytes.capped).toBe(true)
})

test("lock metadata hashes token and nonce and excludes hostname and unrelated content", () => {
  const incarnation = { version: 1, pid: 123, hostId: "a".repeat(64),
    bootId: "00000000-0000-4000-8000-000000000000", startId: "1", startIdKind: "linux-proc-start-ticks" }
  const raw = JSON.stringify({ pid: 123, hostname: "private-host", token: "private-nonce", incarnation, unrelated: "private-buffer" })
  const metadata = lockMetadata(raw), serialized = JSON.stringify(metadata)
  expect(metadata.tokenSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(metadata.nonceSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(metadata.incarnation).toEqual(incarnation)
  for (const secret of ["private-host", "private-nonce", "private-buffer", "hostname"]) expect(serialized).not.toContain(secret)
  expect(lockMetadata("malformed-lock").parsed).toBe(false)
})
