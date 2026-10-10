/**
 * A held deny lasts as long as the turn keeps generating.
 *
 * The CLI dispatches a tool's PreToolUse hook as soon as that block finishes
 * streaming, and cancels the in-flight request if the deny lands while a later
 * parallel call is still generating; proxy-stream-deny-hold.test.ts models the
 * same CLI. The hold's deadline is a backstop for a turn that has stopped, so
 * it must not expire while a long call - a file write streaming its input for
 * minutes - is still arriving, and it must still expire once nothing arrives.
 *
 * Runs in its own `bun test` invocation: the hold deadline is read once, when
 * the server module loads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { makeRequest, parseSSE, resolveMockSdkSessionId } from "./helpers"
import { setSessionStoreDir } from "../proxy/sessionStore"

const HOLD_MS = 1_000
process.env.MERIDIAN_DENY_HOLD_TIMEOUT_MS = String(HOLD_MS)

const PREFIX = "mcp__oc__"
// The write streams for twice the hold deadline and never pauses for anywhere
// near it.
const CHUNK_GAP_MS = 50
const CHUNKS = 40
const writeInput = {
  filePath: "/tmp/inventory.py",
  content: Array.from({ length: CHUNKS }, (_, i) => `line ${i}`).join("\n"),
}
const writeJson = JSON.stringify(writeInput)
const pieceSize = Math.ceil(writeJson.length / CHUNKS)
const pieces = Array.from({ length: CHUNKS }, (_, i) => writeJson.slice(i * pieceSize, (i + 1) * pieceSize))
  .filter((piece) => piece.length > 0)

type Mode = "generating" | "serialized"
let mode: Mode = "generating"
let timeline: string[] = []
let bashHookHeldMs: number | undefined

type PreToolUseHook = (
  input: { tool_name: string; tool_use_id: string; tool_input: unknown },
  toolUseId: undefined,
  context: { signal: AbortSignal },
) => unknown
interface MockQueryParams {
  options?: { hooks?: { PreToolUse?: Array<{ hooks?: PreToolUseHook[] }> } }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const streamEvent = (event: Record<string, unknown>, sessionId: string) => ({
  type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId,
})
const msgStart = (sessionId: string) => streamEvent({
  type: "message_start",
  message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
}, sessionId)
const blockStart = (index: number, name: string, id: string, sessionId: string) =>
  streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: `${PREFIX}${name}`, input: {} } }, sessionId)
const blockDelta = (index: number, json: string, sessionId: string) =>
  streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } }, sessionId)
const blockStop = (index: number, sessionId: string) => streamEvent({ type: "content_block_stop", index }, sessionId)
const msgDelta = (sessionId: string) =>
  streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } }, sessionId)
const assistantMsg = (content: unknown[], sessionId: string) => ({
  type: "assistant",
  message: { id: "m1", type: "message", role: "assistant", content, model: "claude-sonnet-4-5-20250929", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 30 } },
  parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId,
})
const denyMsg = (ids: string[], sessionId: string) => ({
  type: "user",
  message: { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "denied" })) },
  parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: sessionId,
})

installSdkMock(() => ({
  query: (params: MockQueryParams) => {
    const sessionId = resolveMockSdkSessionId(params.options, "test-session")
    const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    return (async function* () {
      if (!hook) {
        yield assistantMsg([{ type: "text", text: "All done." }], sessionId)
        return
      }
      const callHook = (name: string, id: string, input: unknown) => Promise.resolve(
        hook({ tool_name: `${PREFIX}${name}`, tool_use_id: id, tool_input: input }, undefined, { signal: new AbortController().signal }),
      )
      yield msgStart(sessionId)
      yield blockStart(0, "bash", "tb1", sessionId)
      yield blockDelta(0, '{"command":"ls /tmp"}', sessionId)
      yield assistantMsg([{ type: "tool_use", id: "tb1", name: `${PREFIX}bash`, input: { command: "ls /tmp" } }], sessionId)
      yield blockStop(0, sessionId)

      // The CLI dispatches bash's hook while the write has yet to generate.
      const heldFrom = Date.now()
      let bashDenied = false
      const bashHook = callHook("bash", "tb1", { command: "ls /tmp" }).then(() => {
        bashDenied = true
        bashHookHeldMs = Date.now() - heldFrom
        timeline.push("bash_deny_resolved")
      })
      // A CLI that waits for the hook before generating more: nothing arrives
      // until the hold gives up.
      if (mode === "serialized") await bashHook

      yield blockStart(1, "write", "tw1", sessionId)
      for (const piece of pieces) {
        if (mode === "generating") {
          await sleep(CHUNK_GAP_MS)
          if (bashDenied) {
            // Cancel-on-deny: the write is beheaded mid-input, turn 2 begins.
            timeline.push("CANCELED")
            yield denyMsg(["tb1"], sessionId)
            yield msgStart(sessionId)
            return
          }
        }
        yield blockDelta(1, piece, sessionId)
      }
      yield assistantMsg([{ type: "tool_use", id: "tw1", name: `${PREFIX}write`, input: writeInput }], sessionId)
      yield blockStop(1, sessionId)
      const writeHook = callHook("write", "tw1", writeInput)
      yield msgDelta(sessionId)
      timeline.push("message_delta")
      await bashHook
      await writeHook
      yield denyMsg(["tb1"], sessionId)
      yield denyMsg(["tw1"], sessionId)
      yield assistantMsg([{ type: "text", text: "turn 2 digest" }], sessionId)
      yield { type: "result", subtype: "success", is_error: false, session_id: sessionId }
      timeline.push("canonical_result")
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-deny-hold-generating.test.ts")
installLoggerMock(() => ({
  claudeLog: (event: string) => { timeline.push(`log:${event}`) },
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
type App = ReturnType<typeof createProxyServer>["app"]

const tool = (name: string) => ({ name, description: `${name} tool`, input_schema: { type: "object", properties: {}, additionalProperties: true } })

function post(app: App, sid: string, stream: boolean) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sid },
    body: JSON.stringify(makeRequest({ stream, tools: [tool("bash"), tool("write")], messages: [{ role: "user", content: "write the module" }] })),
  }))
}

interface StreamedTool { id: string; index: number; input: string; stopped: boolean }

async function streamedTools(app: App, sid: string): Promise<StreamedTool[]> {
  const events = parseSSE(await (await post(app, sid, true)).text())
  const tools = new Map<number, StreamedTool>()
  for (const { event, data } of events) {
    const index = typeof data.index === "number" ? data.index : -1
    const block = data.content_block as { type?: string; id?: string } | undefined
    const delta = data.delta as { type?: string; partial_json?: string } | undefined
    if (event === "content_block_start" && block?.type === "tool_use" && block.id) {
      tools.set(index, { id: block.id, index, input: "", stopped: false })
    }
    const streamed = tools.get(index)
    if (!streamed) continue
    if (event === "content_block_delta" && delta?.type === "input_json_delta") streamed.input += delta.partial_json ?? ""
    if (event === "content_block_stop") streamed.stopped = true
  }
  return [...tools.values()]
}

async function waitFor(label: string) {
  const deadline = Date.now() + 5_000
  while (!timeline.includes(label) && Date.now() < deadline) await sleep(10)
  if (!timeline.includes(label)) throw new Error(`timed out after 5s waiting for ${label}; timeline=[${timeline.join(", ")}]`)
}

describe("a held deny while the turn is still generating", () => {
  let isolatedSessionDir = ""
  let origPassthrough: string | undefined

  beforeEach(async () => {
    isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-deny-hold-test-"))
    setSessionStoreDir(isolatedSessionDir)
    origPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mode = "generating"
    timeline = []
    bashHookHeldMs = undefined
    await clearSessionCache()
  })

  afterEach(async () => {
    if (origPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = origPassthrough
    // Request completion releases the cross-process lease asynchronously.
    await Bun.sleep(25)
    rmSync(isolatedSessionDir, { recursive: true, force: true })
  })

  it("stream: holds past the deadline while a long call keeps generating", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const tools = await streamedTools(app, crypto.randomUUID())

    expect(timeline).not.toContain("CANCELED")
    expect(timeline).not.toContain("log:passthrough.deny_hold_timeout")
    expect(timeline.indexOf("message_delta")).toBeLessThan(timeline.indexOf("bash_deny_resolved"))
    expect(bashHookHeldMs).toBeGreaterThan(HOLD_MS)
    expect(tools.map((t) => t.id)).toEqual(["tb1", "tw1"])
    expect(tools.every((t) => t.stopped)).toBe(true)
    expect(JSON.parse(tools[1]!.input)).toEqual(writeInput)
    await waitFor("canonical_result")
  })

  it("non-stream: holds past the deadline while a long call keeps generating", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const response = await post(app, crypto.randomUUID(), false)
    const body = await response.json() as { stop_reason?: string; content?: Array<{ type: string; id?: string; input?: unknown }> }

    expect(timeline).not.toContain("CANCELED")
    expect(timeline).not.toContain("log:passthrough.deny_hold_timeout")
    expect(timeline.indexOf("message_delta")).toBeLessThan(timeline.indexOf("bash_deny_resolved"))
    expect(response.status).toBe(200)
    const toolUses = (body.content ?? []).filter((block) => block.type === "tool_use")
    expect(toolUses.map((block) => block.id)).toEqual(["tb1", "tw1"])
    expect(toolUses[1]?.input).toEqual(writeInput)
    expect(body.stop_reason).toBe("tool_use")
    await waitFor("canonical_result")
  })

  it("stream: still releases a deny once the turn goes quiet", async () => {
    mode = "serialized"
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const tools = await streamedTools(app, crypto.randomUUID())

    expect(timeline).toContain("log:passthrough.deny_hold_timeout")
    expect(bashHookHeldMs).toBeGreaterThanOrEqual(HOLD_MS - 20)
    expect(tools.map((t) => t.id)).toEqual(["tb1", "tw1"])
    expect(tools.every((t) => t.stopped)).toBe(true)
    await waitFor("canonical_result")
  })
})
