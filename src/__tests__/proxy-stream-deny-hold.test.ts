/**
 * Streaming deny-hold + pending-store (#552 red reads, root cause v2).
 *
 * Observed live (scripts/e2e-stream-parallel.mjs): the CLI dispatches each
 * tool's PreToolUse hook AS SOON AS that block finishes streaming — while
 * later parallel blocks are still generating — and a deny landing
 * mid-generation makes the CLI CANCEL the in-flight API request. The cancel
 * beheads trailing parallel calls (client renders `glob {}` "Tool execution
 * aborted") and the model regenerates them next turn — kabo's loop.
 *
 * The mock below models that CLI behavior faithfully — including
 * cancel-on-deny — which is exactly what previous mocks failed to do (they
 * fired hooks only after complete turns, so two releases shipped fixes that
 * passed mocked tests and failed in the field).
 *
 * Pins:
 *   1. Deny-hold: hook responses are held until the turn's message_delta, so
 *      the cancel can never land mid-generation → all parallel blocks stream
 *      to completion with full inputs.
 *   2. Kill switch: without the hold the mock takes its cancel path — and the
 *      flush guard still closes the beheaded block (no unterminated block).
 *   3. Pending-store: the background drain finishes AFTER the client response;
 *      an instant follow-up awaits the in-flight store and RESUMES.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { makeRequest, parseSSE } from "./helpers"

const PREFIX = "mcp__oc__"

let capturedController: AbortController | undefined
let capturedResume: string | undefined
let timeline: string[] = []
// Deny persistence delay — simulates the CLI's post-release deny latency that
// makes the store land after the client response (the fast-client race).
let denyDelayMs = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const streamEvent = (event: any) => ({
  type: "stream_event", event, parent_tool_use_id: null,
  uuid: crypto.randomUUID(), session_id: "test-session",
})
const msgStart = () => streamEvent({
  type: "message_start",
  message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5-20250929", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
})
const blockStart = (idx: number, name: string, id: string) =>
  streamEvent({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id, name: `${PREFIX}${name}`, input: {} } })
const blockDelta = (idx: number, json: string) =>
  streamEvent({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: json } })
const blockStop = (idx: number) => streamEvent({ type: "content_block_stop", index: idx })
const msgDelta = () => streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } })
const assistantMsg = (blocks: any[]) => ({
  type: "assistant",
  message: { id: "m1", type: "message", role: "assistant", content: blocks, model: "claude-sonnet-4-5-20250929", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 30 } },
  parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "test-session",
})
const denyMsg = (ids: string[]) => ({
  type: "user",
  message: { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "denied" })) },
  parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "test-session",
})

// CLI-faithful mock: per-block assistant messages, mid-stream hook dispatch,
// CANCEL-ON-DENY when a deny resolves while generation is in flight.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedController = opts?.options?.abortController
    capturedResume = opts?.options?.resume
    const hook = opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    return (async function* () {
      if (!hook) {
        // Follow-up turn (no tools emitted): plain final answer.
        yield assistantMsg([{ type: "text", text: "All done." }])
        return
      }
      yield msgStart()
      timeline.push("message_start")

      // bash block streams fully, then its hook dispatches MID-STREAM.
      yield blockStart(2, "bash", "tb1")
      yield blockDelta(2, '{"command":"ls /tmp"}')
      yield assistantMsg([{ type: "tool_use", id: "tb1", name: `${PREFIX}bash`, input: { command: "ls /tmp" } }])
      yield blockStop(2)
      let bashDenied = false
      const bashHook = Promise.resolve(
        hook({ tool_name: `${PREFIX}bash`, tool_use_id: "tb1", tool_input: { command: "ls /tmp" } }, undefined, { signal: new AbortController().signal })
      ).then(() => { bashDenied = true; timeline.push("bash_deny_resolved") })

      // The generation gap in which the real CLI would receive the deny.
      await sleep(25)

      if (bashDenied) {
        // CANCEL-ON-DENY: glob is beheaded mid-block (start, no stop), the
        // turn's message_delta never arrives, turn 2 begins. This is the
        // exact field behavior from kabo's v1.49.1 transcript.
        timeline.push("CANCELED")
        yield blockStart(3, "glob", "tg1")
        yield blockDelta(3, '{"patt') // cut mid-JSON
        yield denyMsg(["tb1"])
        yield msgStart() // turn 2
        timeline.push("turn2_message_start")
        return
      }

      // Held deny → generation completes normally.
      yield blockStart(3, "glob", "tg1")
      yield blockDelta(3, '{"pattern":"*.md"}')
      yield assistantMsg([{ type: "tool_use", id: "tg1", name: `${PREFIX}glob`, input: { pattern: "*.md" } }])
      yield blockStop(3)
      timeline.push("glob_streamed")
      const globHook = Promise.resolve(
        hook({ tool_name: `${PREFIX}glob`, tool_use_id: "tg1", tool_input: { pattern: "*.md" } }, undefined, { signal: new AbortController().signal })
      ).then(() => timeline.push("glob_deny_resolved"))

      yield msgDelta()
      timeline.push("message_delta")

      await bashHook
      await globHook
      if (denyDelayMs > 0) await sleep(denyDelayMs)
      yield denyMsg(["tb1"])
      yield denyMsg(["tg1"])
      // Early stop aborts here; nothing further should be pulled.
      timeline.push("post_denies")
      yield assistantMsg([{ type: "text", text: "turn 2 digest garbage" }])
      timeline.push("turn2_consumed")
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: (event: string) => { timeline.push(`log:${event}`) },
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))
mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const tool = (name: string) => ({ name, description: `${name} tool`, input_schema: { type: "object", properties: {}, additionalProperties: true } })

async function postStream(app: any, sid: string, messages: unknown[]) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sid },
    body: JSON.stringify(makeRequest({ stream: true, tools: [tool("bash"), tool("glob")], messages })),
  })
  const response = await app.fetch(req)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let raw = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }
  return parseSSE(raw)
}

function envelope(events: any[]) {
  const starts = events.filter((e: any) => e.event === "content_block_start")
  const stopIdx = events.filter((e: any) => e.event === "content_block_stop").map((e: any) => e.data.index)
  return {
    toolStarts: starts.filter((e: any) => e.data?.content_block?.type === "tool_use").map((e: any) => e.data.content_block),
    dangling: starts.map((e: any) => e.data.index).filter((i: number) => !stopIdx.includes(i)),
  }
}

describe("streaming deny-hold (#552 root cause v2)", () => {
  let origPassthrough: string | undefined
  let origEarlyStop: string | undefined

  beforeEach(() => {
    origPassthrough = process.env.MERIDIAN_PASSTHROUGH
    origEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    process.env.MERIDIAN_PASSTHROUGH = "1"
    delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    timeline = []
    denyDelayMs = 0
    capturedController = undefined
    capturedResume = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (origPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = origPassthrough
    if (origEarlyStop === undefined) delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    else process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = origEarlyStop
  })

  it("holds denies until message_delta — parallel blocks stream to completion, no cancel", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const events = await postStream(app, "hold-1", [{ role: "user", content: "test tools" }])
    const { toolStarts, dangling } = envelope(events)

    // The mock's cancel path never taken: generation completed.
    expect(timeline).not.toContain("CANCELED")
    // The deny resolved only after the turn finished generating.
    expect(timeline.indexOf("glob_streamed")).toBeLessThan(timeline.indexOf("bash_deny_resolved"))
    expect(timeline.indexOf("message_delta")).toBeLessThan(timeline.indexOf("bash_deny_resolved"))
    // Client contract: both tool blocks, fully terminated.
    expect(toolStarts.map((t: any) => t.id).sort()).toEqual(["tb1", "tg1"])
    expect(dangling).toEqual([])
    // The client response ends at the turn boundary while the drain (denies →
    // early stop → abort) finishes in the background — poll briefly for it.
    const deadline = Date.now() + 1500
    while (!capturedController!.signal.aborted && Date.now() < deadline) await sleep(10)
    // Early stop aborted before the digest turn was consumed.
    expect(capturedController!.signal.aborted).toBe(true)
    expect(timeline).not.toContain("turn2_consumed")
  })

  it("kill switch: cancel path still cannot leave an unterminated block (flush guard)", async () => {
    process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const events = await postStream(app, "hold-2", [{ role: "user", content: "test tools" }])
    const { dangling } = envelope(events)

    // Without the hold the mock cancels (legacy field behavior)...
    expect(timeline).toContain("CANCELED")
    // ...but every started block is still closed before the stream ends —
    // the render can no longer be `glob {}` "Tool execution aborted".
    expect(dangling).toEqual([])
  })

  it("fast follow-up awaits the in-flight background store and RESUMES", async () => {
    denyDelayMs = 150 // denies (and thus the store) land after the client response
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    await postStream(app, "hold-3", [{ role: "user", content: "test tools" }])

    // Immediately send the follow-up — before the drain could have stored.
    capturedResume = undefined
    await postStream(app, "hold-3", [
      { role: "user", content: "test tools" },
      { role: "assistant", content: [
        { type: "tool_use", id: "tb1", name: "bash", input: { command: "ls /tmp" } },
        { type: "tool_use", id: "tg1", name: "glob", input: { pattern: "*.md" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tb1", content: "ok" },
        { type: "tool_result", tool_use_id: "tg1", content: "ok" },
      ]},
    ])
    expect(capturedResume ?? "(fresh)").toBe("test-session")
  })
})
