import { expect, test } from "bun:test"
import { z } from "zod"
import { EventEmitter } from "node:events"
import { assertImportedHistory, historyFixture, observeClient } from "../../scripts/e2e-antigravity-pi-history.mjs"
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

class FakeClient extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: string | null = null
  constructor(readonly pid: number | undefined) { super() }
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
