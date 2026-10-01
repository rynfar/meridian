/**
 * Prior-thinking pruning through the HTTP layer during a passthrough tool loop.
 *
 * B1: the pending tool loop's thinking must survive pruning on every SDK attempt
 * path, including the four fresh-replay/model-fallback call sites, even though
 * the hidden digest assistant is written after the client-visible tool turn.
 * B2: a prune refusal must never replace an already-delivered turn, must leave
 * the transcript byte-identical, and must not poison the next resume.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { blockStop, inputJsonDelta, messageDelta, messageStart, messageStop, parseSSE, streamEvent, textBlockStart, textDelta, toolUseBlockStart } from "./helpers"
import { PASSTHROUGH_DENY_REASON } from "../proxy/passthroughDenial"
import { setSessionStoreDir } from "../proxy/sessionStore"

type Fault = "malformed_row" | "unparseable_line" | "truncated_tail" | "checkpoint_absent" | "transcript_not_found" | "not_regular_file" | "target_not_leased"
type Refusal = "missing_message" | "extra_usage"

let root: string
let storeDir: string
let calls: Array<{ options: Options; prompt: unknown; sessionId?: string }> = []
let logs: Array<{ event: string; data: Record<string, unknown> }> = []
/** One entry per query(): what the SDK attempt does. */
let script: Array<{ kind: "text" | "tool"; refuse?: Refusal; fault?: Fault }> = []
let seq = 0
const written = new Map<string, string>()
const thought = { type: "thinking", thinking: "loop thought", signature: "loop signature" }
const READ_TOOL = { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }

function projectDirectory(options: Options): string {
  return join(root, "projects", String(options.cwd).replace(/[^a-zA-Z0-9]/g, "-"))
}
function transcriptFile(options: Options, sessionId: string): string {
  return join(projectDirectory(options), `${sessionId}.jsonl`)
}
function rowsOf(options: Options, sessionId: string): any[] {
  return readFileSync(transcriptFile(options, sessionId), "utf8").split("\n").filter(line => {
    try { JSON.parse(line); return true } catch { return false }
  }).map(line => JSON.parse(line))
}

installSdkMock(() => ({
  query: (params: { prompt: string | AsyncIterable<unknown>; options: Options }) => (async function* () {
    const options = params.options
    // A refusing step refuses every resumed attempt (the [1m] cooldown is
    // process-global, so the number of resumed retries depends on test order)
    // and is consumed by the first fresh attempt, which then succeeds.
    const head = script[0]
    const step = head?.refuse && options.resume ? head : (script.shift() ?? { kind: "text" as const })
    if (step === head && step.refuse && !options.resume) step.refuse = undefined
    const prompt: unknown[] = []
    if (typeof params.prompt !== "string") for await (const message of params.prompt) prompt.push(message)
    calls.push({ options, prompt: typeof params.prompt === "string" ? params.prompt : prompt })
    if (step.refuse === "missing_message") throw new Error("No message found with message.uuid of: 6f1c0f4e-0a1e-4d61-9a2f-7b0c1d2e3f40")
    if (step.refuse === "extra_usage") throw new Error("Claude Code returned an error result: API Error: 400 You're out of extra usage.")
    const sessionId = options.sessionId!
    calls.at(-1)!.sessionId = sessionId
    let prior = ""
    if (options.resume && existsSync(transcriptFile(options, options.resume))) {
      prior = readFileSync(transcriptFile(options, options.resume), "utf8")
      // resumeSessionAt rewinds the synthetic denial tail before appending.
      if (options.resumeSessionAt) {
        const lines = prior.split("\n")
        const at = lines.findIndex(line => line.includes(`"uuid":"${options.resumeSessionAt}"`))
        prior = lines.slice(0, at + 1).join("\n") + "\n"
      }
    }
    const n = ++seq
    const uid = (label: string) => `${label}-${n}-${crypto.randomUUID()}`
    const parent = prior.trim() ? JSON.parse(prior.trim().split("\n").at(-1)!).uuid : null
    const user = { type: "user", uuid: uid("user"), parentUuid: parent, sessionId, message: { role: "user", content: "turn" } }
    const rows: unknown[] = [user]
    const events: unknown[] = []
    const preHook = (options.hooks as any)?.PreToolUse?.[0]?.hooks?.[0]
    const emit = (event: Record<string, unknown>) => events.push({ ...event, session_id: sessionId })
    if (step.kind === "text") {
      const id = `msg_text_${n}`
      const a1 = { type: "assistant", uuid: uid("t"), parentUuid: user.uuid, sessionId, message: { role: "assistant", id, content: [thought] } }
      const a2 = { type: "assistant", uuid: uid("x"), parentUuid: a1.uuid, sessionId, message: { role: "assistant", id, content: [{ type: "text", text: "answer" }] } }
      rows.push(a1, a2)
      if (options.includePartialMessages) {
        emit(messageStart(id)); emit(textBlockStart(0)); emit(textDelta(0, "answer")); emit(blockStop(0)); emit(messageDelta()); emit(messageStop())
      }
      emit({ ...a2, message: { ...a2.message, type: "message", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [thought, { type: "text", text: "answer" }] }, parent_tool_use_id: null })
    } else {
      const id = `msg_tool_${n}`
      const callId = `call_${n}`
      const tool = { type: "tool_use", id: callId, name: "read", input: { path: "x" } }
      const a1 = { type: "assistant", uuid: uid("t"), parentUuid: user.uuid, sessionId, message: { role: "assistant", id, content: [thought] } }
      const a2 = { type: "assistant", uuid: uid("c"), parentUuid: a1.uuid, sessionId, message: { role: "assistant", id, content: [tool] } }
      const deny = { type: "user", uuid: uid("d"), parentUuid: a2.uuid, sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: PASSTHROUGH_DENY_REASON, is_error: true }] } }
      const digestId = `msg_digest_${n}`
      const g1 = { type: "assistant", uuid: uid("g"), parentUuid: deny.uuid, sessionId, message: { role: "assistant", id: digestId, content: [thought] } }
      const g2 = { type: "assistant", uuid: uid("h"), parentUuid: g1.uuid, sessionId, message: { role: "assistant", id: digestId, content: [{ type: "text", text: "digest" }] } }
      rows.push(a1, a2, deny, g1, g2)
      if (options.includePartialMessages) {
        emit(messageStart(id))
        emit(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }))
        emit(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought.thinking } }))
        emit(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thought.signature } }))
        emit(blockStop(0)); emit(toolUseBlockStart(1, "read", callId)); emit(inputJsonDelta(1, '{"path":"x"}')); emit(blockStop(1))
        emit(messageDelta("tool_use")); emit(messageStop())
      }
      // checkpoint_absent: the checkpoint the iterator reports is not in the file.
      const yielded = { ...a2, uuid: step.fault === "checkpoint_absent" ? uid("absent") : a2.uuid, message: { ...a2.message, type: "message", model: "claude-opus-5-5", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [thought, tool] }, parent_tool_use_id: null }
      emit(yielded)
      events.push({ hook: { tool_name: "read", tool_use_id: callId, tool_input: tool.input } })
      emit(deny)
      emit({ ...g2, message: { ...g2.message, type: "message", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null })
    }
    mkdirSync(projectDirectory(options), { recursive: true })
    const path = transcriptFile(options, sessionId)
    let body = prior + rows.map(row => JSON.stringify(row)).join("\n") + "\n"
    if (step.fault === "malformed_row") body += JSON.stringify({ type: "assistant", uuid: uid("bad"), message: { content: [thought] } }) + "\n"
    if (step.fault === "unparseable_line") body = "{broken\n" + body
    if (step.fault === "truncated_tail") body += '{"type":"assistant","uuid":"cut'
    written.set(sessionId, body)
    if (step.fault === "not_regular_file") {
      const real = join(root, `real-${sessionId}.jsonl`)
      writeFileSync(real, body, { mode: 0o600 })
      symlinkSync(real, path)
    } else if (step.fault !== "transcript_not_found") {
      writeFileSync(path, body, { mode: 0o600 })
    }
    for (const event of events as Array<Record<string, any>>) {
      if (event.hook) {
        if (preHook) await preHook(event.hook, undefined, { signal: new AbortController().signal })
        continue
      }
      yield event
    }
    // target_not_leased: a locator-bookkeeping mismatch. The attempt's sessionId
    // no longer names any leased locator when the prune gate runs.
    if (step.fault === "target_not_leased") options.sessionId = crypto.randomUUID()
    yield { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "", uuid: crypto.randomUUID(), session_id: sessionId,
      duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-prior-thinking-loop.test.ts")
installLoggerMock(() => ({
  claudeLog: (event: string, data: Record<string, unknown> = {}) => { logs.push({ event, data }) },
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetExtendedContextUnavailable } = await import("../proxy/models")

const keys = ["MERIDIAN_DROP_PRIOR_THINKING", "CLAUDE_CONFIG_DIR", "MERIDIAN_PASSTHROUGH", "MERIDIAN_BUSY_RETRY_DELAY_MS"]
let previous: Array<string | undefined>
beforeEach(() => {
  previous = keys.map(key => process.env[key])
  root = mkdtempSync(join(tmpdir(), "meridian-thinking-loop-"))
  storeDir = mkdtempSync(join(tmpdir(), "meridian-thinking-loop-store-"))
  setSessionStoreDir(storeDir)
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.MERIDIAN_PASSTHROUGH = "1"
  process.env.MERIDIAN_DROP_PRIOR_THINKING = "1"
  process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = "5"
  calls = []
  written.clear()
  logs = []
  script = []
  clearSessionCache()
})
afterEach(async () => {
  // The extra-usage fixture records the process-global [1m] cooldown; clear it
  // so later files resolving [1m] context windows are unaffected.
  resetExtendedContextUnavailable()
  keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] })
  await Bun.sleep(25)
  setSessionStoreDir(null)
  rmSync(root, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

async function send(app: ReturnType<typeof createProxyServer>["app"], stream: boolean, messages: unknown[], affinity: string) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-meridian-agent": "pi", "x-session-affinity": affinity },
    body: JSON.stringify({ model: "claude-opus-5-5", stream, max_tokens: 2048, thinking: { type: "adaptive" }, tools: [READ_TOOL], messages }),
  }))
  expect(response.status).toBe(200)
  if (stream) {
    const events = parseSSE(await response.text())
    expect(events.some(event => event.event === "error" || event.data.type === "error")).toBe(false)
    const blocks = events.filter(event => event.data.type === "content_block_start").map(event => event.data.content_block as Record<string, unknown>)
    return blocks
  }
  const body = await response.json() as { type: string; content: Array<Record<string, unknown>> }
  expect(body.type).toBe("message")
  return body.content
}
const first = [{ role: "user", content: "first" }]
const answered = [...first, { role: "assistant", content: [thought, { type: "text", text: "answer" }] }]
const next = [...answered, { role: "user", content: "use the tool" }]
function toolResultTurn(callId: string) {
  return [...next,
    { role: "assistant", content: [thought, { type: "tool_use", id: callId, name: "read", input: { path: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "17" }] }]
}
function callIdOf(blocks: Array<Record<string, unknown>>): string {
  return (blocks.find(block => block.type === "tool_use") as { id: string }).id
}
function lastCall() { return calls.at(-1)! }
function expectLoopThinkingKept(sessionId: string) {
  const rows = rowsOf(lastCall().options, sessionId)
  const toolGroup = rows.filter(row => row.type === "assistant" && String(row.message.id).startsWith("msg_tool_"))
  const digest = rows.filter(row => row.type === "assistant" && String(row.message.id).startsWith("msg_digest_"))
  const older = rows.filter(row => row.type === "assistant" && String(row.message.id).startsWith("msg_text_"))
  expect(toolGroup.flatMap(row => row.message.content).map((block: any) => block.type)).toEqual(["thinking", "tool_use"])
  expect(digest.flatMap(row => row.message.content).map((block: any) => block.type)).toEqual(["text"])
  for (const row of older) expect(row.message.content.some((block: any) => block.type === "thinking")).toBe(false)
}

describe("pending tool loop thinking survives pruning", () => {
  for (const stream of [false, true]) {
    const mode = stream ? "stream" : "non_stream"
    it(`${mode}: wired resume path keeps the loop's thinking with the digest row last`, async () => {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      script = [{ kind: "text" }, { kind: "tool" }, { kind: "text" }]
      await send(app, stream, first, `wired-${mode}`)
      const blocks = await send(app, stream, next, `wired-${mode}`)
      const target = lastCall().options.sessionId!
      expect(lastCall().options.resume).toBeTruthy()
      expectLoopThinkingKept(target)
      await send(app, stream, toolResultTurn(callIdOf(blocks)), `wired-${mode}`)
      expect(lastCall().options.resume).toBe(target)
      expect(lastCall().options.resumeSessionAt).toBeTruthy()
      expect(logs.filter(log => log.event === "session.prior_thinking_prune_failed")).toEqual([])
      const pruned = logs.filter(log => log.event === "session.prior_thinking_pruned")
      expect(pruned.length).toBe(3)
      for (const log of pruned) {
        expect(Object.keys(log.data).sort()).toEqual(["blocks", "bytesAfter", "bytesBefore", "messages", "mode"])
        expect(log.data.mode).toBe(mode)
      }
    })
    for (const refuse of ["missing_message", "extra_usage"] as const) {
      const site = `${stream ? "stream" : "non_stream"}_fresh ${refuse === "missing_message" ? "resume-replay" : "model fallback"}`
      it(`${site}: keeps the loop's thinking and the next tool_result turn resumes`, async () => {
        const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
        // [1m] is stripped on the first extra-usage refusal; the resumed base
        // model refusing again is what takes the fresh model-fallback path.
        script = [{ kind: "text" }, { kind: "tool", refuse }, { kind: "text" }]
        await send(app, stream, first, `site-${site}`)
        const blocks = await send(app, stream, next, `site-${site}`)
        expect(blocks.some(block => block.type === "tool_use")).toBe(true)
        const fresh = calls.at(-1)!
        expect(calls.slice(1, -1).every(call => Boolean(call.options.resume))).toBe(true)
        expect(fresh.options.resume).toBeUndefined()
        const target = fresh.options.sessionId!
        expectLoopThinkingKept(target)
        const callId = callIdOf(blocks)
        expect(logs.some(log => log.event === "session.prior_thinking_pruned" && log.data.mode === `${mode}_fresh`)).toBe(true)
        await send(app, stream, toolResultTurn(callId), `site-${site}`)
        expect(lastCall().options.resume).toBe(target)
        expect(lastCall().options.resumeSessionAt).toBeTruthy()
      })
    }
  }
})

describe("prune failures never fail a turn", () => {
  const reasons: Record<Fault, string | undefined> = {
    malformed_row: "malformed_row",
    unparseable_line: "unparseable_line",
    truncated_tail: undefined,
    checkpoint_absent: "checkpoint_absent",
    transcript_not_found: "transcript_not_found",
    not_regular_file: "not_regular_file",
    target_not_leased: "target_not_leased",
  }
  for (const stream of [false, true]) {
    const mode = stream ? "stream" : "non_stream"
    for (const [fault, reason] of Object.entries(reasons) as Array<[Fault, string | undefined]>) {
      it(`${mode} ${fault}: delivers the turn, leaves the transcript untouched, and the next turn resumes`, async () => {
        const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
        script = [{ kind: "text" }, { kind: "tool", fault }, { kind: "text" }]
        await send(app, stream, first, `fault-${mode}-${fault}`)
        const blocks = await send(app, stream, next, `fault-${mode}-${fault}`)
        expect(blocks.some(block => block.type === "tool_use")).toBe(true)
        const target = calls[1]!.sessionId!
        const failed = logs.filter(log => log.event === "session.prior_thinking_prune_failed")
        if (reason) {
          expect(failed).toEqual([{ event: "session.prior_thinking_prune_failed", data: { mode, reason } }])
          if (fault !== "transcript_not_found") {
            const raw = fault === "not_regular_file"
              ? readFileSync(join(root, `real-${target}.jsonl`), "utf8")
              : readFileSync(transcriptFile(calls[1]!.options, target), "utf8")
            expect(raw).toBe(written.get(target)!)
          }
        } else {
          expect(failed).toEqual([])
          const raw = readFileSync(transcriptFile(calls[1]!.options, target), "utf8")
          expect(raw.endsWith('{"type":"assistant","uuid":"cut')).toBe(true)
          expectLoopThinkingKept(target)
        }
        const callId = callIdOf(blocks)
        await send(app, stream, toolResultTurn(callId), `fault-${mode}-${fault}`)
        expect(lastCall().options.resume).toBe(target)
      })
    }
  }
})
