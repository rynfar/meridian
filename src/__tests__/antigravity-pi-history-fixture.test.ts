import { expect, test } from "bun:test"
import { z } from "zod"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { assertImportedHistory, boundedCompletion, historyFixture, inspectRenderedHistory, observeClient, liveLifecycle, serializedSnapshots, forwardResponse } from "../../scripts/e2e-antigravity-pi-history.mjs"
import { parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"
import type { AgMessage } from "../proxy/backends/antigravityProtocol"

const fixture = historyFixture("/public-fixture", "gemini-3.8-flash-low", "LATEST_FIXTURE")
const publicText = z.object({ type: z.literal("text"), text: z.string() })
const publicMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [publicText,
    z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.object({ content: z.string(), path: z.string() }) }),
  ])) }),
  z.object({ role: z.literal("toolResult"), toolCallId: z.string(), content: z.array(publicText), isError: z.boolean() }),
])
const entries = z.array(z.object({ type: z.string(), version: z.number().optional(), id: z.string(), parentId: z.string().nullable().optional(), message: publicMessage.optional() })).parse(fixture.entries)
// Unit-only projection for testing the escrow's rejection predicates. Actual
// live acceptance uses Pi's own translator and never calls this projection.
function unitWire() {
  const messages: AgMessage[] = []
  for (const entry of entries) {
    if (!entry.message) continue
    const message = entry.message
    if (message.role === "toolResult") messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content, is_error: message.isError }] })
    else if (message.role === "user") messages.push({ role: "user", content: message.content })
    else messages.push({ role: "assistant", content: message.content.map(block => block.type === "toolCall" ? { type: "tool_use", id: block.id, name: block.name, input: block.arguments } : block) })
  }
  return { messages }
}

test("public Pi fixture keeps a v3 linked branch and complete real-file write/result records", () => {
  expect(entries[0]?.type).toBe("session")
  expect(entries[0]?.version).toBe(3)
  let parentId: string | null = null
  for (const entry of entries.slice(1)) {
    expect(entry.parentId).toBe(parentId)
    expect(entry.id).toMatch(/^[0-9a-f]{8}$/)
    parentId = entry.id
  }
  expect(fixture.files.size).toBe(41)
  expect(fixture.fixtureIds).toHaveLength(41)
  expect(fixture.longText.length).toBeGreaterThan(200000)
  expect(fixture.large.length).toBeGreaterThan(100000)
  expect(fixture.files.get(fixture.seedPath)).toBe(fixture.large)
  expect(() => assertImportedHistory(unitWire(), fixture)).not.toThrow()
})

test("escrow rejects missing correlation, lost large input, changed target, and omitted long history", () => {
  const valid = unitWire()
  const withoutResults = { messages: valid.messages.filter(message => !Array.isArray(message.content) || !message.content.some(block => block.type === "tool_result" && block.tool_use_id === "fixture-current-large")) }
  expect(() => assertImportedHistory(withoutResults, fixture)).toThrow()
  for (const field of ["content", "path"]) {
    const changed = structuredClone(valid)
    for (const message of changed.messages) if (Array.isArray(message.content)) for (const block of message.content) {
      if (block.type === "tool_use" && block.id === "fixture-current-large") block.input[field] = "corrupted"
    }
    expect(() => assertImportedHistory(changed, fixture)).toThrow()
  }
  const withoutLongText = { messages: valid.messages.filter(message => !Array.isArray(message.content) || !message.content.some(block => block.type === "text" && block.text === fixture.longText)) }
  expect(() => assertImportedHistory(withoutLongText, fixture)).toThrow()
})

test("escrow requires the imported newest typed request and rejects duplicate historical call IDs", () => {
  const changed = unitWire()
  changed.messages.push({ role: "user", content: "Different latest request" })
  expect(() => assertImportedHistory(changed, fixture)).toThrow()
  const duplicate = unitWire()
  const call = duplicate.messages.find(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_use"))
  if (!call) throw new Error("Fixture lacks a call")
  duplicate.messages.splice(1, 0, structuredClone(call))
  expect(() => assertImportedHistory(duplicate, fixture)).toThrow()
})

class FakePipe extends EventEmitter {
  destroyCalls = 0
  destroy() { this.destroyCalls++; this.emit("close") }
}
class FakeClient extends EventEmitter {
  stdout = new FakePipe()
  stderr = new FakePipe()
  exitCode: number | null = null
  signalCode: string | null = null
  constructor(readonly pid: number | undefined) { super() }
  exit(code: number) { this.exitCode = code; this.emit("exit", code, null) }
  close(code: number) {
    this.exitCode = code
    for (const stream of [this.stdout, this.stderr]) { stream.emit("end"); stream.emit("close") }
    this.emit("close", code, null)
  }
}

test("escrow spawn errors remain failures and join close without signaling an absent role (fake events only)", async () => {
  const child = new FakeClient(undefined), signals: string[] = []
  const role = observeClient(child, { signalGroup: (_pid, signal) => { signals.push(signal) } })
  child.emit("error", Object.assign(new Error("fixture spawn"), { code: "ENOENT" }))
  expect(role.state.failure).toContain("ENOENT")
  expect(role.state.closeEvent).toBe(false)
  child.close(-2); await role.join
  expect(role.state.closeEvent).toBe(true)
  expect(signals).toEqual([])
})

test("exited leader with held pipes reaches a finite unknown join without stale signals (fake events only)", async () => {
  const child = new FakeClient(123), signals: string[] = []
  const role = observeClient(child, { deadlineMs: 10, joinGraceMs: 5, killGraceMs: 2, signalGroup: (_pid, signal) => { signals.push(signal) } })
  child.exit(0)
  const outcome = await Promise.race([role.join, new Promise<string>(resolve => setTimeout(() => resolve("WAIT_BOUND_EXCEEDED"), 40))])
  child.close(0) // Release the old implementation's fake timers after the observation.
  if (typeof outcome === "string") throw new Error(outcome)
  expect(outcome).toMatchObject({ outcome: "UNKNOWN_CLOSE_TIMEOUT", closeEvent: false })
  expect(signals).toEqual([])
  expect(role.state.failure).toContain("close join")
  expect(role.state.joinExpired && role.state.localPipeCloseRequested).toBe(true)
  expect(child.stdout.destroyCalls).toBe(1)
})

test("error then leader exit before escalation preserves first failure and finite unknown join (fake events only)", async () => {
  const child = new FakeClient(123), signals: string[] = []
  const role = observeClient(child, { joinGraceMs: 5, killGraceMs: 2, signalGroup: (_pid, signal) => { signals.push(signal) } })
  child.emit("error", Object.assign(new Error("fixture primary failure"), { code: "EIO" }))
  child.exit(143)
  const outcome = await Promise.race([role.join, new Promise<string>(resolve => setTimeout(() => resolve("WAIT_BOUND_EXCEEDED"), 40))])
  child.close(143)
  if (typeof outcome === "string") throw new Error(outcome)
  expect(outcome).toMatchObject({ outcome: "UNKNOWN_CLOSE_TIMEOUT", closeEvent: false })
  expect(role.state.failure).toContain("EIO")
  expect(signals).toEqual(["SIGTERM"])
})

test("missing and late close cannot reclassify an unknown join as success (fake events only)", async () => {
  const child = new FakeClient(undefined)
  const role = observeClient(child, { deadlineMs: 1, joinGraceMs: 5, killGraceMs: 2, signalGroup: () => { throw new Error("Must not signal absent role") } })
  const outcome = await Promise.race([role.join, new Promise<string>(resolve => setTimeout(() => resolve("WAIT_BOUND_EXCEEDED"), 40))])
  child.close(0)
  if (typeof outcome === "string") throw new Error(outcome)
  expect(outcome).toMatchObject({ outcome: "UNKNOWN_CLOSE_TIMEOUT", closeEvent: false })
  expect(await role.join).toEqual(outcome)
  expect(role.state.failure).toContain("deadline")
  expect(role.state.lateCloseEvent).toBe(true)
})

test("failed escalation stays a failed unknown join and does not replace the first capture error (fake events only)", async () => {
  const child = new FakeClient(123)
  const role = observeClient(child, { captureBytes: 1, joinGraceMs: 10, killGraceMs: 2, signalGroup: () => { throw Object.assign(new Error("fixture denied signal"), { code: "EPERM" }) } })
  child.stdout.emit("data", Buffer.from("overflow"))
  const outcome = await role.join
  expect(outcome).toMatchObject({ outcome: "UNKNOWN_CLOSE_TIMEOUT", closeEvent: false })
  expect(role.state.failure).toContain("capture cap")
  expect(role.state.signals).toEqual([{ signal: "SIGTERM", sent: false, code: "EPERM" }, { signal: "SIGKILL", sent: false, code: "EPERM" }])
  expect(role.state.stdoutEnd || role.state.stderrEnd || role.state.closeEvent).toBe(false)
  expect(role.state.stdoutClose && role.state.stderrClose && role.state.localPipeCloseRequested).toBe(true)
  child.close(0)
  expect((await role.join).outcome).toBe("UNKNOWN_CLOSE_TIMEOUT")
})

test("unknown and rejected public-close promises are finite and late resolution cannot become proof (fake promise only)", async () => {
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  const outcome = await boundedCompletion(() => pending, 5)
  expect(outcome.outcome).toBe("UNKNOWN_TIMEOUT")
  expect(outcome.error).toContain("deadline")
  release?.(); await pending
  expect(outcome.outcome).toBe("UNKNOWN_TIMEOUT")
  const failed = await boundedCompletion(() => { throw new Error("fixture public-close EIO") }, 5)
  expect(failed.outcome).toBe("REJECTED")
  expect(failed.error).toContain("EIO")
  expect((await boundedCompletion(() => Promise.resolve(), 5)).outcome).toBe("RESOLVED")
})

test("long temporary paths match only the current-call advisory preview while full history stays exact", () => {
  const path = join(tmpdir(), "meridian-agy-pi-history-" + "x".repeat(80), "project", "already-completed.txt")
  expect(path.length).toBeGreaterThan(80)
  const request = parseAgRequest({ model: "gemini-3.8-flash-low", messages: [
    { role: "user", content: "The large write is complete; continue the new target." },
    { role: "assistant", content: [{ type: "tool_use", id: "fixture-current-large", name: "write", input: { content: "x".repeat(100000), path } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "fixture-current-large", content: "Completed." }] },
  ] })
  const rendered = renderAgPrompt(request), prefix = rendered.slice(0, rendered.indexOf("Client conversation:\n"))
  expect(prefix.includes('"target":' + JSON.stringify(path))).toBe(false)
  const observed = inspectRenderedHistory(rendered, request.messages, path)
  expect(observed).toMatchObject({ currentTargetInRecap: true, targetPreviewChars: 80, targetPreviewTruncated: true, fullHistoryExact: true, advisoryPreviewOnly: true })
  expect(inspectRenderedHistory(rendered, request.messages, "/wrong").currentTargetInRecap).toBe(false)
  expect(inspectRenderedHistory(rendered.replace('"id":"fixture-current-large"', '"id":"other"'), request.messages, path).currentTargetInRecap).toBe(false)
  expect(inspectRenderedHistory(rendered + "changed", request.messages, path).fullHistoryExact).toBe(false)
})

test("started-role errors and capture caps stop the same role, preserve the first error and still join (fake events only)", async () => {
  const child = new FakeClient(123), signals: string[] = []
  const role = observeClient(child, { captureBytes: 4, signalGroup: (_pid, signal) => { signals.push(signal) } })
  child.emit("error", Object.assign(new Error("fixture running error"), { code: "EIO" }))
  child.stdout.emit("data", Buffer.from("12345"))
  role.stop("secondary cleanup failure")
  expect(role.state.failure).toContain("EIO")
  expect(role.state.closeEvent).toBe(false)
  expect(role.state.stdout.length).toBeLessThanOrEqual(4)
  child.close(143); await role.join
  expect(signals).toEqual(["SIGTERM"])
  expect(role.state.stdoutEnd && role.state.stderrEnd && role.state.stdoutClose && role.state.stderrClose).toBe(true)
})

test("capture overflow and deadlines cannot become a clean client success (fake events only)", async () => {
  for (const deadline of [false, true]) {
    const child = new FakeClient(123), signals: string[] = []
    const role = observeClient(child, { captureBytes: 4, deadlineMs: deadline ? 1 : 240000, signalGroup: (_pid, signal) => { signals.push(signal) } })
    if (deadline) await new Promise(resolve => setTimeout(resolve, 10))
    else child.stdout.emit("data", Buffer.from("12345"))
    expect(role.state.failure).toContain(deadline ? "deadline" : "capture cap")
    child.close(0); await role.join
    expect(role.state.failure).toBeDefined()
    expect(signals).toEqual(["SIGTERM"])
  }
})

function deferred<T>() {
  let release: (value: T) => void = () => { throw new Error("Deferred not initialized") }
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test("one captured public close keeps its first UNKNOWN across overlapping and later callers", async () => {
  const instance = { id: "old" }, close = deferred<void>(), receipts: string[] = []
  let closeCalls = 0
  const owner = liveLifecycle({ start: async () => instance, close: async () => { closeCalls++; await close.promise }, closeMs: 5,
    onClose: async (_instance, _label, outcome) => { receipts.push(outcome.outcome) } })
  await owner.start()
  const first = owner.close(instance, "result-tail"), second = owner.close(instance, "final")
  expect(first).toBe(second)
  const firstOutcome = await first
  close.release(); await close.promise; await tick()
  const secondOutcome = await second
  expect(firstOutcome.outcome).toBe("UNKNOWN_TIMEOUT")
  expect(secondOutcome).toBe(firstOutcome)
  expect((await owner.close(instance, "late-caller")).outcome).toBe("UNKNOWN_TIMEOUT")
  expect(receipts).toEqual(["UNKNOWN_TIMEOUT"])
  expect(closeCalls).toBe(1)
  expect(owner.state.firstFailure?.kind).toBe("proxy-close")
  await owner.drain()
})

test("retirement during deferred old close joins the handler without starting or forwarding replacement", async () => {
  const instance = { id: "old" }, close = deferred<void>()
  let starts = 0, forwards = 0
  const owner = liveLifecycle({ start: async () => { starts++; return instance }, close: async () => close.promise, closeMs: 100, drainMs: 100 })
  await owner.start()
  const handler = owner.run("relay-request", async () => {
    await owner.close(instance, "result-tail")
    await owner.start()
    owner.forward(() => { forwards++ })
  })
  // Attach rejection observer before retirement can reject the pending handler.
  const handlerResult = handler.then(() => "RESOLVED", error => String(error))
  await tick(); owner.retire("Client exited")
  const drain = owner.drain()
  close.release()
  expect(await handlerResult).toContain("retired")
  expect((await drain).outcome).toBe("RESOLVED")
  expect(starts).toBe(1); expect(forwards).toBe(0)
  expect(() => owner.forward(() => { forwards++ })).toThrow("retired")
  await expect(owner.start()).rejects.toThrow("retired")
  expect(starts).toBe(1); expect(forwards).toBe(0)
})

test("replacement already acquiring at retirement is retained and closed before a qualified drain", async () => {
  const old = { id: "old" }, late = { id: "late" }, acquired = deferred<typeof late>()
  const lateClose = deferred<void>(), closed: string[] = [], receipts: string[] = []
  let starts = 0, forwards = 0
  const owner = liveLifecycle({ start: async () => ++starts === 1 ? old : acquired.promise,
    close: async (instance, label) => { closed.push(instance.id + ":" + label); if (instance === late) await lateClose.promise },
    onClose: async (instance, _label, outcome) => { receipts.push(instance.id + ":" + outcome.outcome) }, closeMs: 100, drainMs: 100 })
  await owner.start()
  const handler = owner.run("relay-request", async () => {
    await owner.close(old, "result-tail")
    await owner.start()
    owner.forward(() => { forwards++ })
  }).then(() => "RESOLVED", error => String(error))
  await tick(); expect(starts).toBe(2)
  owner.retire("Client exited"); const drain = owner.drain()
  acquired.release(late); await tick()
  expect(closed).toContain("late:late-start-after-retirement")
  expect(receipts).not.toContain("late:RESOLVED")
  lateClose.release()
  expect(await handler).toContain("after retirement")
  expect((await drain).outcome).toBe("RESOLVED")
  expect(receipts).toEqual(["old:RESOLVED", "late:RESOLVED"])
  expect(forwards).toBe(0)
})

test("cleanup waits for the actual close-qualification callback and retains its late failure", async () => {
  const instance = { id: "old" }, qualification = deferred<void>()
  const owner = liveLifecycle({ start: async () => instance, close: async () => {}, drainMs: 100,
    onClose: async () => { await qualification.promise; throw new Error("receipt qualification EIO") } })
  await owner.start()
  const close = owner.close(instance, "result-tail").then(() => "RESOLVED", error => String(error))
  await tick()
  let drained = false
  const drain = owner.drain().then(result => { drained = true; return result })
  await tick(); expect(drained).toBe(false)
  expect(owner.state.closes[0]?.receiptCallbackOutcome).toBe("PENDING")
  qualification.release()
  expect(await close).toContain("qualification EIO")
  expect((await drain).outcome).toBe("RESOLVED")
  expect(owner.state.firstFailure).toEqual({ kind: "proxy-close-qualification", error: "Error: receipt qualification EIO" })
  expect(owner.state.closes[0]?.receiptCallbackOutcome).toBe("REJECTED")
  expect(owner.state.operations.every(operation => operation.outcome !== "PENDING")).toBe(true)
  await expect(owner.run("after-retirement", async () => { throw new Error("Must not run") })).rejects.toThrow("retired")
})

test("unknown operation drain stays unknown when an acquired instance arrives later", async () => {
  const late = { id: "late" }, acquired = deferred<typeof late>(), closed: string[] = []
  const owner = liveLifecycle({ start: () => acquired.promise, close: async instance => { closed.push(instance.id) }, operationMs: 100, drainMs: 5 })
  const startResult = owner.start().then(() => "RESOLVED", error => String(error))
  await tick(); owner.retire("Cleanup"); const drain = await owner.drain()
  expect(drain.outcome).toBe("UNKNOWN_TIMEOUT")
  acquired.release(late)
  expect(await startResult).toContain("after retirement")
  expect(closed).toEqual(["late"])
  expect((await owner.drain()).outcome).toBe("UNKNOWN_TIMEOUT")
  expect(owner.state.firstFailure?.kind).toBe("lifecycle-drain")
})

test("checkpoint snapshots are captured at submission, serialized and drained before sealing", async () => {
  const first = deferred<void>(), records: object[] = []
  let active = 0, maximum = 0
  const writer = serializedSnapshots(async snapshot => {
    active++; maximum = Math.max(maximum, active)
    if (records.length === 0) await first.promise
    records.push(snapshot); active--
  }, 100)
  const source = { stage: "one", events: ["original"] }
  const one = writer.submit(source)
  source.events.push("later"); source.stage = "mutated"
  const two = writer.submit({ stage: "two" })
  const final = writer.seal({ stage: "final" })
  await tick(); expect(active).toBe(1); expect(records).toEqual([])
  first.release(); await one; await two
  expect((await final).outcome).toBe("RESOLVED")
  expect(records).toEqual([{ stage: "one", events: ["original"] }, { stage: "two" }, { stage: "final" }])
  expect(maximum).toBe(1)
  expect((await writer.submit({ stage: "late" })).outcome).toBe("NOT_ADMITTED_AFTER_SEAL")
  expect(records).toHaveLength(3)
})

test("timed-out physical artifact write forbids queued writes even after its late completion", async () => {
  const pending = deferred<void>(), writes: object[] = []
  const writer = serializedSnapshots(async snapshot => { writes.push(snapshot); await pending.promise }, 5)
  const first = writer.submit({ stage: "first" }), second = writer.submit({ stage: "second" })
  expect((await first).outcome).toBe("UNKNOWN_TIMEOUT")
  expect((await second).outcome).toBe("NOT_WRITTEN_AFTER_FAILURE")
  expect((await writer.seal({ stage: "final" })).error).toContain("UNKNOWN_TIMEOUT")
  pending.release(); await tick()
  expect(writes).toEqual([{ stage: "first" }])
  expect(writer.state.completed).toBe(0)
})

test("forwarding retains the original upstream cause before downstream destruction and later failures", async () => {
  const source = new PassThrough(), records: object[] = [], instance = { id: "proxy" }
  const writer = serializedSnapshots(async snapshot => { records.push(snapshot) }, 100)
  const owner = liveLifecycle({ start: async () => instance, close: async () => { throw new Error("cleanup close EIO") } })
  await owner.start()
  const downstream = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  let causeAtDestroy: { kind: string; error: string } | undefined
  downstream.on("close", () => { causeAtDestroy = owner.state.firstFailure })
  const checkpoint = (stage: string) => writer.submit({ stage, lifecycle: owner.state })
  const handler = owner.run("relay-request", async () => forwardResponse(source, downstream, owner, checkpoint)).then(() => "RESOLVED", error => String(error))
  await tick(); source.destroy(new Error("original upstream ECONNRESET"))
  expect(await handler).toContain("original upstream ECONNRESET")
  owner.fail("client", new Error("Pi exit 1"))
  await owner.drain(); await tick()
  expect(causeAtDestroy).toEqual({ kind: "response-stream", error: "Error: original upstream ECONNRESET" })
  expect(owner.state.firstFailure).toEqual(causeAtDestroy)
  expect(owner.state.failures.some(failure => failure.kind === "client" && failure.error.includes("exit 1"))).toBe(true)
  expect(owner.state.failures.some(failure => failure.kind === "proxy-close" && failure.error.includes("cleanup close EIO"))).toBe(true)
  expect(owner.state.retired).toBe(true)
  expect(() => owner.forward(() => { throw new Error("Must never forward") })).toThrow("retired")
  await writer.seal({ stage: "final", lifecycle: owner.state })
  expect(records[0]).toMatchObject({ lifecycle: { firstFailure: { kind: "response-stream", error: "Error: original upstream ECONNRESET" } } })
  expect(records.at(-1)).toMatchObject({ lifecycle: { firstFailure: causeAtDestroy, retired: true } })
})

test("normal forwarding tracks the real stream finish and preserves a clean owner", async () => {
  const owner = liveLifecycle({ start: async () => ({ id: "unused" }), close: async () => {} })
  const source = new PassThrough(), chunks: string[] = []
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback() } })
  const handler = owner.run("relay-request", async () => forwardResponse(source, response, owner, async () => {}))
  await tick(); source.end("actual stream bytes"); await handler; await owner.drain()
  expect(chunks.join("")).toBe("actual stream bytes")
  expect(owner.state.firstFailure).toBeUndefined()
  expect(owner.state.operations[0]?.outcome).toBe("RESOLVED")
})
