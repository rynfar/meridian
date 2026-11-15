#!/usr/bin/env bun
// Real Meridian HTTP handler → real SDK/CLI → loopback-only canned Anthropic SSE.
// No provider credentials, live model calls, or existing Meridian state are used.
// bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/absolute/path/to/claude
// Optional: --thinking --calls=1|2|3 --transient-tail (client-history mutation control).
// --mixed emits one registered/captured call and the remaining bare/rejected calls.
// --deferred lifts maxTurns to 4: rejected-only calls run a hidden digest;
// captured batches stop via PostToolBatch. Both complete normally with success.
// --non-stream exercises JSON completion; --captured emits only registered calls.
// --result-kind=error-first|error-later|image-first|image-later|reversed|missing-later
// changes client results only, including subsequent --follow-on turns.
// --input-validation sends raw-tab JSON to registered names, refused before hooks.
// --captured-last puts the captured call last in a mixed batch (JSON backfill).
// --sse-delay-ms=25 paces individual upstream frames; --distinct-tools with
// --captured uses a different registered tool for each parallel call.
// A single name-dispatch rejection at maxTurns=1 retains and resumes. Other
// uncaptured calls evict and replay; captured streamed batches use hybrid resume.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const executable = process.argv.find(arg => arg.startsWith("--claude="))?.slice(9)
assert(executable, "pass --claude=/absolute/path/to/claude")
const cli = resolve(executable)
const sourceRoot = resolve(process.argv.find(arg => arg.startsWith("--source-root="))?.slice(14)
  ?? new URL("..", import.meta.url).pathname)
const loadSource = path => import(join(sourceRoot, path))
const callCount = Number(process.argv.find(arg => arg.startsWith("--calls="))?.slice(8) ?? 1)
assert(Number.isInteger(callCount) && callCount > 0 && callCount <= 3, "--calls must be 1, 2, or 3")
const thinking = process.argv.includes("--thinking")
const transientTail = process.argv.includes("--transient-tail")
const mixed = process.argv.includes("--mixed")
const deferred = process.argv.includes("--deferred")
const nonStream = process.argv.includes("--non-stream")
// Exercise real CLI assistant-only output while keeping Meridian's SSE path.
// The isolated launcher removes only the CLI's partial-event output flag.
const unstreamed = process.argv.includes("--unstreamed")
assert(!unstreamed || !nonStream, "--unstreamed requires Meridian SSE")
const captured = process.argv.includes("--captured")
const followOn = process.argv.includes("--follow-on")
assert(!followOn || (captured && !nonStream && !unstreamed), "--follow-on needs captured streamed calls")
const resultKind = process.argv.find(arg => arg.startsWith("--result-kind="))?.slice(14) ?? "text"
assert(["text", "error-first", "error-later", "image-first", "image-later", "reversed", "missing-later"].includes(resultKind),
  "unknown --result-kind")
assert(resultKind === "text" || (captured && !nonStream && !unstreamed && callCount >= 2),
  "--result-kind requires --captured streamed calls with --calls=2 or 3")
const missingLater = resultKind === "missing-later"
assert(!missingLater || callCount === 2, "--result-kind=missing-later requires --calls=2")
const capturedLast = process.argv.includes("--captured-last")
const inputValidation = process.argv.includes("--input-validation")
const distinctTools = process.argv.includes("--distinct-tools")
const sseDelayMs = Number(process.argv.find(arg => arg.startsWith("--sse-delay-ms="))?.slice(15) ?? 0)
assert(Number.isFinite(sseDelayMs) && sseDelayMs >= 0, "--sse-delay-ms must be nonnegative")
assert(!distinctTools || captured, "--distinct-tools requires --captured")
assert(!capturedLast || mixed, "--captured-last requires --mixed")
assert(!mixed || callCount > 1, "--mixed requires at least two calls")
assert(!(mixed && captured), "choose --mixed or --captured")
assert(!unstreamed || captured || mixed, "--unstreamed requires --captured or --mixed")
const extended = mixed || deferred || nonStream || captured || inputValidation || unstreamed
const digestExpected = deferred && !mixed && !captured
const calls = Array.from({ length: callCount }, (_, index) => ({
  type: "tool_use", id: index === 0 ? "toolu_offline" : "toolu_offline_" + index,
  name: distinctTools && index > 0 ? "read_" + index : "read",
  input: { file_path: "new-" + (inputValidation ? "\t" : "") + index },
}))
const secondCalls = calls.map((call, index) => ({ ...call, id: "toolu_followon_" + index }))
const singleCalls = [{ ...calls[0], id: "toolu_final_single" }]
const realResult = call => "REAL_CLIENT_RESULT[" + call.id + "]"
// Valid 1x1 PNG; small enough that the CLI need not resize/re-encode it.
const resultImage = { type: "image", source: { type: "base64", media_type: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" } }
const clientResults = batch => {
  const results = (missingLater ? batch.slice(0, 1) : batch).map((call, index) => {
    const selected = resultKind.endsWith("-first") ? index === 0 : index === 1
    return { type: "tool_result", tool_use_id: call.id,
      content: selected && resultKind.startsWith("image-")
        ? [{ type: "text", text: realResult(call) }, resultImage] : realResult(call),
      ...(selected && resultKind.startsWith("error-") ? { is_error: true } : {}),
    }
  })
  return resultKind === "reversed" ? results.reverse() : results
}
const upstreamCalls = calls.map((call, index) => ({ ...call,
  name: inputValidation || captured || (mixed && index === (capturedLast ? callCount - 1 : 0)) ? "mcp__oc__" + call.name : call.name,
}))
const capturedCall = index => captured || (mixed && index === (capturedLast ? callCount - 1 : 0))
const rawInput = (block, index) => inputValidation && !capturedCall(index)
  ? JSON.stringify(block.input).replaceAll("\\t", "\t") : JSON.stringify(block.input)
const root = mkdtempSync(join(process.env.MERIDIAN_E2E_SCRATCH ?? process.cwd(), ".fresh-checkpoint-e2e-"))
const launcher = join(root, "claude-unstreamed")
const launcherWitness = join(root, "partial-flag-removed")
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
if (unstreamed) writeFileSync(launcher, [
  "#!/bin/bash", "set -eu", "args=()",
  'for arg in "$@"; do',
  '  if [[ "$arg" == --include-partial-messages ]]; then',
  "    printf 'removed\\n' >> " + shellQuote(launcherWitness),
  '  else args+=("$arg"); fi', "done",
  "exec " + shellQuote(cli) + ' "${args[@]}"', "",
].join("\n"), { mode: 0o755 })
// Start without inherited provider credentials or operational overrides.
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|MERIDIAN_)/.test(key)) delete process.env[key]
}
Object.assign(process.env, {
  HOME: root,
  TMPDIR: root,
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_CLAUDE_PATH: unstreamed ? launcher : cli,
  MERIDIAN_PASSTHROUGH: "1",
  MERIDIAN_TELEMETRY_PERSIST: "0",
})
const debugEvents = []
const originalDebug = console.debug
if (unstreamed) {
  process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = "1"
  console.debug = (...args) => {
    const prefix = "[opencode-claude-code-provider] "
    if (typeof args[0] === "string" && args[0].startsWith(prefix)) debugEvents.push(JSON.parse(args[0].slice(prefix.length)))
    else originalDebug(...args)
  }
}
const wire = []
let followUp = false
let firstRequestCalls = 0
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/messages")
    const body = await request.json()
    wire.push(body)
    assert.equal(body.stream, true)
    assert(body.tools.some(tool => tool.name === "mcp__oc__read"))
    const first = wire.length === 1
    if (!followUp) firstRequestCalls++
    assert(firstRequestCalls <= (digestExpected ? 2 : 1), "no retry or extra digest is permitted")
    assert(wire.length <= (followOn ? 4 : digestExpected ? 3 : 2), "no retry is permitted")
    const blocks = first
      ? [...(thinking ? [{ type: "thinking", thinking: "offline thought", signature: "offline-signature" }] : []), ...upstreamCalls]
      : [{ type: "text", text: followUp ? "read complete" : "hidden digest" },
        ...(followOn && wire.length === 2 ? secondCalls : followOn && wire.length === 3 ? singleCalls : [])
          .map(call => ({ ...call, name: "mcp__oc__" + call.name }))]
    const events = [
      ["message_start", { type: "message_start", message: {
        id: "msg_offline_" + wire.length, type: "message", role: "assistant", model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      } }],
      ...blocks.flatMap((block, index) => [
        ["content_block_start", { type: "content_block_start", index, content_block: block.type === "tool_use"
          ? { ...block, input: {} } : block.type === "thinking" ? { ...block, thinking: "", signature: "" } : { ...block, text: "" } }],
        ...(block.type === "thinking" ? [
          ["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }],
          ["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }],
        ] : [["content_block_delta", { type: "content_block_delta", index, delta: block.type === "tool_use"
          ? { type: "input_json_delta", partial_json: rawInput(block, index - (thinking ? 1 : 0)) }
          : { type: "text_delta", text: block.text } }]]),
        ["content_block_stop", { type: "content_block_stop", index }],
      ]),
      ["message_delta", { type: "message_delta", delta: {
        stop_reason: blocks.some(block => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
      }, usage: { output_tokens: 10 } }],
      ["message_stop", { type: "message_stop" }],
    ]
    const frames = events.map(([event, data]) =>
      "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n")
    const responseBody = sseDelayMs === 0 ? frames.join("") : new ReadableStream({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(frame))
          await Bun.sleep(sseDelayMs)
        }
        controller.close()
      },
    })
    return new Response(responseBody, { headers: { "content-type": "text/event-stream" } })
  },
})
let proxy
try {
  const version = Bun.spawnSync([cli, "--version"], { env: process.env }).stdout.toString().trim()
  const { createProxyServer } = await loadSource("src/proxy/server.ts")
  const { PASSTHROUGH_DENY_REASON } = await loadSource("src/proxy/passthroughDenial.ts")
  const { lookupSharedSession } = await loadSource("src/proxy/sessionStore.ts")
  const { telemetryStore } = await loadSource("src/telemetry/index.ts")
  const { computeMessageHashes, verifyLineage } = await loadSource("src/proxy/session/lineage.ts")
  const { parseSSE } = await loadSource("src/__tests__/helpers.ts")
  const { flattenAssistantContent, normalizeStructuredUserContent } = await loadSource("src/proxy/replay.ts")
  proxy = createProxyServer({ silent: true, profiles: [
    { id: "offline", type: "api", apiKey: "offline-test-key", baseUrl: upstream.url.origin },
  ], defaultProfile: "offline" })
  const session = "offline-fresh-checkpoint"
  const tools = [...new Set(calls.map(call => call.name))].map(name => ({ name, input_schema: {
    type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"],
  } })).concat(deferred ? [{ name: "lsp_diagnostics", defer_loading: true,
    input_schema: { type: "object", properties: { file: { type: "string" } } } }] : [])
  const history = [
    { role: "user", content: "read old file" },
    { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "read", input: { file_path: "old" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "old data" }] },
    { role: "assistant", content: "old file read" },
    { role: "user", content: "now read new file" },
  ]
  const post = messages => proxy.app.fetch(new Request("http://offline.invalid/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi",
      "user-agent": "pi/1.4.0", "x-session-affinity": session },
    body: JSON.stringify({ model: "opus[1m]", max_tokens: 400, stream: !nonStream, tools, messages }),
  }))
  const suffix = transientTail ? [
    { role: "user", content: "request-only context" },
    { role: "user", content: [{ type: "text", text: "request-only notice" }] },
  ] : []
  const firstHistory = [...history, ...suffix]
  const first = await post(firstHistory)
  const firstBody = await first.text()
  assert.equal(first.status, 200)
  assert(!firstBody.includes("event: error"), firstBody)
  assert(firstBody.includes('"stop_reason":"tool_use"'), firstBody)
  assert.equal(firstRequestCalls, digestExpected ? 2 : 1, "deferred flow must complete its hidden second model turn")
  const hybrid = captured && callCount > 1 && !nonStream && !unstreamed
  const retainCheckpoint = (captured && (callCount === 1 || hybrid)) || (!nonStream && !mixed && !deferred && !inputValidation && callCount === 1)
  const mapping = lookupSharedSession("offline:" + session)
  const rejectionText = "<tool_use_error>Error: No such tool available: read</tool_use_error>"
  if (extended) {
    const transcripts = readdirSync(root, { recursive: true }).filter(path => String(path).endsWith(".jsonl"))
    const rows = transcripts.flatMap(file => readFileSync(join(root, String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line)))
    for (const [index, call] of calls.entries()) {
      const results = rows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content : [])
        .filter(block => block.type === "tool_result" && block.tool_use_id === call.id)
      assert(results.length > 0, "CLI transcript lacks result for " + call.id)
      if (inputValidation && !capturedCall(index)) assert(results.some(block =>
        block.is_error === true && typeof block.content === "string" &&
        block.content.startsWith("<tool_use_error>InputValidationError: mcp__oc__read was called with input that could not be parsed as JSON.\n")),
        "malformed registered call must be rejected before PreToolUse")
      else if (upstreamCalls[index].name === "read") assert(results.some(block => block.content === rejectionText), "bare call must be name-dispatch rejected")
      else assert(results.some(block => JSON.stringify(block.content).includes(PASSTHROUGH_DENY_REASON)), "registered call must reach PreToolUse deny")
    }
    if (digestExpected) assert(rows.some(row => row.message?.content?.some?.(block => block.type === "text" && block.text === "hidden digest")), "CLI must commit hidden second-turn completion")
    if (unstreamed) {
      assert(readFileSync(launcherWitness, "utf8").includes("removed"), "real CLI launcher must suppress partial events")
      const completion = debugEvents.find(event => event.event === "upstream.completed" && event.mode === "stream")
      assert.equal(completion?.streamEventsSeen, 0, "real SDK iterator must emit no partial frames")
      assert(debugEvents.some(event => event.event === "response.unstreamed_turn_forwarded"), "must exercise the unstreamed SSE envelope")
      console.log("UNSTREAMED " + JSON.stringify({ streamEventsSeen: completion.streamEventsSeen, envelopeForwarded: true }))
    }
    console.log("SHAPE " + JSON.stringify({ mixed, deferred, nonStream, unstreamed, captured, capturedLast, inputValidation, checkpointRetained: Boolean(mapping), firstRequestCalls }))
  } else if (retainCheckpoint) {
    assert(mapping, "fresh canonical rejection lost its mapping")
    assert.deepEqual(mapping.messageHashes, computeMessageHashes(firstHistory))
    assert.deepEqual(mapping.passthroughToolCallIds, calls.map(call => call.id))
    assert(mapping.passthroughToolCallAssistantUuid)
    const file = readdirSync(root, { recursive: true }).find(path =>
      String(path).endsWith(mapping.claudeSessionId + ".jsonl"))
    assert(file, "mapped CLI transcript must exist before terminal delivery")
    const rows = readFileSync(join(root, String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line))
    assert(rows.some(row => row.type === "assistant" && row.uuid === mapping.passthroughToolCallAssistantUuid))
    assert(rows.some(row => row.message?.content?.some?.(block => block.type === "tool_result" &&
      block.content === rejectionText)))
    console.log("PASS fresh: CLI rejected bare read before PreToolUse; canonical transcript and checkpoint exist")
  } else {
    assert.equal(mapping, undefined, "multi-call canonical rejection must evict its mapping")
    const transcripts = readdirSync(root, { recursive: true }).filter(path => String(path).endsWith(".jsonl"))
    assert(transcripts.length > 0, "CLI transcript must exist even when the mapping is evicted")
    const rows = transcripts.flatMap(file => readFileSync(join(root, String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line)))
    assert(rows.some(row => row.message?.content?.some?.(block => block.type === "tool_result" &&
      block.content === rejectionText)), "CLI must still have rejected the calls before PreToolUse")
    console.log("PASS fresh: CLI rejected " + callCount + " bare reads before PreToolUse; mapping evicted")
  }
  // Assemble the exact client-visible assistant from the emitted stream, not
  // from the canned upstream or the CLI's assistant metadata.
  const content = nonStream ? JSON.parse(firstBody).content : []
  const json = new Map()
  for (const { event, data } of nonStream ? [] : parseSSE(firstBody)) {
    const index = data.index
    if (event === "content_block_start") content[index] = { ...data.content_block }
    if (event !== "content_block_delta") continue
    const delta = data.delta
    if (delta.type === "thinking_delta") content[index].thinking += delta.thinking
    if (delta.type === "signature_delta") content[index].signature += delta.signature
    if (delta.type === "input_json_delta") json.set(index, (json.get(index) ?? "") + delta.partial_json)
  }
  const { parseToolInputObject } = await loadSource("src/proxy/toolInputJson.ts")
  for (const [index, value] of json) {
    content[index].input = inputValidation ? parseToolInputObject(value) : JSON.parse(value)
    assert(content[index].input, "client must be able to repair the complete tool input")
  }
  // Assistant-only fallback currently emits captured calls, not rejected ones.
  // Keep the full-call assertion for every ordinary matrix row; these explicit
  // unstreamed rows prove delivery of every result the real client can return.
  const clientCalls = unstreamed ? calls.filter((_, index) => capturedCall(index)) : calls
  assert.deepEqual(content.filter(block => block.type === "tool_use"), clientCalls)
  console.log("CLIENT_CALLS " + JSON.stringify({ upstream: calls.length, expected: clientCalls.length,
    received: content.filter(block => block.type === "tool_use").length }))
  if (thinking) assert.equal(content[0].type, "thinking")
  const firstResults = clientResults(clientCalls)
  const nextHistory = [...history,
    { role: "assistant", content },
    { role: "user", content: firstResults },
    ...suffix,
  ]
  if (mapping) {
    const lineage = verifyLineage({ ...mapping, lastAccess: 0 }, nextHistory)
    assert.equal(lineage.type, transientTail ? "diverged" : "continuation")
    if (!transientTail) console.log("PASS lineage: exact streamed assistant plus client results is continuation")
    if (transientTail) {
      assert.equal(lineage.reason, "modified-history")
      assert.equal(lineage.mismatch.index, firstHistory.length - 2)
      assert.equal(firstHistory[lineage.mismatch.index].role, "user")
      assert.equal(lineage.mismatch.incomingShape.role, "assistant")
      console.log("PASS diagnostic: incoming assistant replaces a stored transient USER slot at count - 2")
    }
  }
  followUp = true
  const next = await post(nextHistory)
  const nextBody = await next.text()
  assert.equal(next.status, 200)
  assert(!nextBody.includes("event: error"), nextBody)
  assert(nextBody.includes("read complete"), nextBody)
  assert.equal(wire.length, digestExpected ? 3 : 2)
  const followUpWire = wire.at(-1)
  const replayShape = batch => resultKind === "image-later" && batch.length > 1
  const expectResume = retainCheckpoint && !transientTail && !missingLater && !replayShape(clientCalls)
  // CLI 2.1.322 serializes the identical environment system message as a
  // singleton text-block array when marked, and a string when unmarked.
  // Canonicalize only that equivalent text representation; never alter text.
  const stripCache = value => Array.isArray(value) ? value.map(stripCache)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "cache_control").map(([key, item]) => [key,
        key === "content" && typeof item === "string" ? [{ type: "text", text: item }] : stripCache(item)])) : value
  const withoutCache = value => Array.isArray(value) ? value.map(withoutCache)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCache(item)])) : value
  const assertResultFidelity = (request, batch, supplied) => {
    const blocks = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    const native = blocks.filter(block => block.type === "tool_result" && block.tool_use_id === batch[0].id)
    assert.equal(native.length, 1, "native call-1 result must occur once")
    assert.deepEqual(withoutCache(native[0]), supplied.find(result => result.tool_use_id === batch[0].id),
      "native call-1 result must structurally preserve client content and is_error")
    for (const call of batch.slice(1)) {
      const result = supplied.find(result => result.tool_use_id === call.id)
      assert(result, "fidelity assertion needs a complete result set")
      // Derive the exact completed-call record from the SAME primitives used by
      // fresh replay, independently of hybridToolResultContinuation.
      const expected = [{ type: "text", text: "[Assistant: " + flattenAssistantContent([call], name => "mcp__oc__" + name) + "]" },
        ...normalizeStructuredUserContent([result])]
      const matches = request.messages.flatMap(message => Array.isArray(message.content)
        ? message.content.flatMap((_, index) => JSON.stringify(withoutCache(message.content.slice(index, index + expected.length))) ===
          JSON.stringify(expected) ? [index] : []) : [])
      assert.equal(matches.length, 1, "completed-call record must preserve replay-rendered result/error/media exactly once for " + call.id)
      assert(!blocks.some(block => block.type === "tool_use" && block.id === call.id),
        "hybrid must rewind before later native calls")
      assert(!blocks.some(block => block.type === "tool_result" && block.tool_use_id === call.id),
        "later results must be records, not orphan native results")
    }
    console.log("PASS result fidelity: native call-1 structurally equals client result; later records equal replay renderer (" + resultKind + ")")
  }
  if (expectResume) {
    assert.deepEqual(stripCache(followUpWire.system), stripCache(wire[0].system), "R1: system prefix changed")
    assert.deepEqual(stripCache(followUpWire.tools), stripCache(wire[0].tools), "R1: tools prefix changed")
    assert.deepEqual(stripCache(followUpWire.messages.slice(0, wire[0].messages.length)),
      stripCache(wire[0].messages), "R1: upstream message prefix changed")
    assert(mapping, "R1: all-captured streamed checkpoint must retain the existing SDK session")
    if (hybrid) {
      assert.equal(mapping.passthroughNativeToolCallId, calls[0].id)
      assert.deepEqual(mapping.passthroughToolCallIds, calls.map(call => call.id))
    }
    console.log("PASS R1: system, tools and messages retain the complete upstream prefix")
  }
  const replayParts = []
  const collectReplayText = (value) => {
    if (typeof value === "string") replayParts.push(value)
    else if (Array.isArray(value)) for (const item of value) collectReplayText(item)
    else if (value && typeof value === "object") for (const item of Object.values(value)) collectReplayText(item)
  }
  collectReplayText(followUpWire.messages)
  const replayText = replayParts.join("\n")
  if (expectResume) {
    const results = followUpWire.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === "tool_result") : [])
    console.log("RESUME_RESULTS " + JSON.stringify({
      real: clientCalls.filter(call => results.some(block => block.tool_use_id === call.id &&
        JSON.stringify(withoutCache(block)) === JSON.stringify(firstResults.find(result => result.tool_use_id === call.id)))).map(call => call.id),
      internalError: results.filter(block => block.content === "[Tool result missing due to internal error]")
        .map(block => block.tool_use_id),
    }))
  }
  if (expectResume) for (const call of hybrid ? clientCalls.slice(0, 1) : clientCalls) {
    assert(followUpWire.messages.some(message => message.role === "assistant" &&
      message.content?.some?.(block => block.type === "tool_use" && block.id === call.id)))
    assert(followUpWire.messages.some(message => message.content?.some?.(block =>
      block.type === "tool_result" && block.tool_use_id === call.id &&
      JSON.stringify(withoutCache(block)) === JSON.stringify(firstResults.find(result => result.tool_use_id === call.id)))),
      "resumed upstream lacks real client result for " + call.id)
  }
  if (hybrid && expectResume) {
    for (const call of clientCalls.slice(1)) {
      assert(replayText.includes(`"tool_use_id":"${call.id}"`) && replayText.includes(realResult(call)),
        "R2: hybrid record lacks real client result for " + call.id)
      assert(!followUpWire.messages.some(message => message.role === "assistant" &&
        message.content?.some?.(block => block.type === "tool_use" && block.id === call.id)),
        "hybrid must rewind before later native calls")
    }
  }
  if (expectResume) assertResultFidelity(followUpWire, clientCalls, firstResults)
  const suppliedCalls = clientCalls.filter(call => firstResults.some(result => result.tool_use_id === call.id))
  for (const call of suppliedCalls) assert.equal(replayText.split(realResult(call)).length - 1, 1,
    "R2: real result must occur verbatim exactly once for " + call.id)
  if (!expectResume) {
    // A fresh SDK query cannot carry native assistant tool blocks. The replay
    // renders each client result as history text attributed to its call id.
    assert.equal(replayText.split("REAL_CLIENT_RESULT").length - 1, suppliedCalls.length,
      "fresh replay must contain one real client result per call")
    for (const call of suppliedCalls) {
      assert(replayText.includes(`"tool_use_id":"${call.id}"`) && replayText.includes(realResult(call)),
        "fresh replay lacks real client result for " + call.id)
    }
    assert(replayText.includes("now read new file"), "fresh replay must include the client history")
    assert(!followUpWire.messages.some(message => message.role === "assistant" &&
      message.content?.some?.(block => block.type === "tool_use")),
      "fresh replay must not resume a native assistant tool turn")
  }
  if (replayShape(clientCalls)) {
    for (const result of firstResults) assert(replayText.includes(normalizeStructuredUserContent([result])[0].text),
      "replay control must preserve renderer's result identity/error attribution")
    assert(followUpWire.messages.some(message => message.content?.some?.(block =>
      JSON.stringify(withoutCache(block)) === JSON.stringify(resultImage))), "replay control must preserve image bytes")
    console.log("PASS replay control: non-native image fails closed; real results exactly once; renderer attribution and image preserved; no prefix claim")
  }
  if (missingLater) {
    assert(!replayText.includes(realResult(clientCalls[1])), "missing result text must not be fabricated")
    assert(!replayText.includes('"tool_use_id":"' + clientCalls[1].id + '"'), "missing result record must not be fabricated")
    console.log("PASS incomplete results: fresh replay; supplied result exactly once; no fabricated missing result; no prefix claim")
  }
  assert(!replayText.includes("[Tool result missing due to internal error]"),
    "follow-up must not substitute CLI placeholders for real results")
  assert(!replayText.includes("InputValidationError"), "follow-up must not carry the CLI input rejection")
  assert(!replayText.includes("No such tool available"),
    expectResume ? "resume must rewind before the rejection" : "fresh replay must not carry the CLI rejection")
  if (extended) assert.equal(Boolean(mapping), retainCheckpoint, "multi-call or uncaptured checkpoint must be evicted except the canonical single-call name-dispatch control")
  const turns = telemetryStore.getRecent({ limit: 10 })
  assert.equal(turns.some(turn => turn.isResume === true), expectResume,
    retainCheckpoint ? "only an unchanged request prefix can resume" : "multi-call follow-up must be a fresh replay, not a resumed continuation")
  console.log(!expectResume && !transientTail
    ? "PASS follow-up: fresh replay, not a resumed continuation; every supplied real client result; no CLI rejection"
    : transientTail
    ? "PASS diagnostic: transient suffix reproduces fresh replay; no assistant rewriting"
    : (hybrid ? "PASS hybrid continuation: first native result plus completed-call records; every real result exactly once" : "PASS continuation: native assistant and real client result for every call; rejection rewound"))
  if (followOn) {
    let currentHistory = nextHistory
    let responseBody = nextBody
    const allSuppliedCalls = [...suppliedCalls]
    for (const settledCalls of [secondCalls, singleCalls]) {
      const visible = []
      const pending = new Map()
      for (const { event, data } of parseSSE(responseBody)) {
        if (event === "content_block_start") visible[data.index] = { ...data.content_block }
        if (event === "content_block_delta" && data.delta.type === "text_delta") visible[data.index].text += data.delta.text
        if (event === "content_block_delta" && data.delta.type === "input_json_delta")
          pending.set(data.index, (pending.get(data.index) ?? "") + data.delta.partial_json)
      }
      for (const [index, input] of pending) visible[index].input = JSON.parse(input)
      assert.deepEqual(visible.filter(block => block.type === "tool_use"), settledCalls)
      const checkpoint = lookupSharedSession("offline:" + session)
      assert(checkpoint, "follow-on checkpoint must remain published")
      assert.deepEqual(checkpoint.passthroughToolCallIds, settledCalls.map(call => call.id))
      if (settledCalls.length > 1) assert.equal(checkpoint.passthroughNativeToolCallId, settledCalls[0].id)
      const supplied = clientResults(settledCalls)
      const resume = (!missingLater || settledCalls.length === 1) && !replayShape(settledCalls)
      currentHistory = [...currentHistory, { role: "assistant", content: visible },
        { role: "user", content: supplied }]
      const previous = wire.at(-1)
      const response = await post(currentHistory)
      responseBody = await response.text()
      assert.equal(response.status, 200)
      assert(!responseBody.includes("event: error"), responseBody)
      const current = wire.at(-1)
      if (resume) {
        assert.deepEqual(stripCache(current.system), stripCache(previous.system), "follow-on R1: system")
        assert.deepEqual(stripCache(current.tools), stripCache(previous.tools), "follow-on R1: tools")
        assert.deepEqual(stripCache(current.messages.slice(0, previous.messages.length)),
          stripCache(previous.messages), "follow-on R1: messages")
        assertResultFidelity(current, settledCalls, supplied)
      } else {
        assert(!current.messages.some(message => message.role === "assistant" &&
          message.content?.some?.(block => block.type === "tool_use")), "incomplete follow-on must replay")
      }
      const values = []
      const collect = value => {
        if (typeof value === "string") values.push(value)
        else if (Array.isArray(value)) value.forEach(collect)
        else if (value && typeof value === "object") Object.values(value).forEach(collect)
      }
      collect(current.messages)
      allSuppliedCalls.push(...settledCalls.filter(call => supplied.some(result => result.tool_use_id === call.id)))
      for (const call of allSuppliedCalls)
        assert.equal(values.join("\n").split(realResult(call)).length - 1, 1, "follow-on R2: " + call.id)
      assert(!values.join("\n").includes("[Tool result missing due to internal error]"))
      if (replayShape(settledCalls)) {
        for (const result of supplied) assert(values.join("\n").includes(normalizeStructuredUserContent([result])[0].text),
          "follow-on replay control must preserve renderer attribution")
        assert(current.messages.some(message => message.content?.some?.(block =>
          JSON.stringify(withoutCache(block)) === JSON.stringify(resultImage))), "follow-on replay must preserve image bytes")
      }
      if (missingLater) for (const call of [...calls, ...secondCalls].filter(call => !allSuppliedCalls.includes(call))) {
        assert(!values.join("\n").includes(realResult(call)), "must not fabricate missing follow-on text")
        assert(!values.join("\n").includes('"tool_use_id":"' + call.id + '"'), "must not fabricate missing follow-on record")
      }
      const latest = telemetryStore.getRecent({ limit: 1 })[0]
      assert.equal(latest.isResume, resume, "follow-on must obey complete-result resume policy")
      console.log(resume
        ? "PASS follow-on R1/R2: settled " + settledCalls.length + " calls; existing prefix unchanged; every real result exactly once"
        : replayShape(settledCalls)
        ? "PASS follow-on replay control: non-native image; fresh replay; real results exactly once; attribution/image preserved; no prefix claim"
        : "PASS follow-on incomplete results: fresh replay; supplied results exactly once; nothing fabricated; no prefix claim")
    }
    assert.equal(wire.length, 4)
  }
  const sdkVersion = JSON.parse(readFileSync(join(sourceRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version
  console.log(JSON.stringify({ cli: version, sdk: sdkVersion, callCount, thinking, transientTail, mixed, deferred, nonStream, unstreamed, captured, capturedLast, inputValidation, distinctTools, sseDelayMs, followOn, resultKind, upstreamCalls: wire.length, liveModelCalls: 0 }))
} finally {
  const evidence = process.argv.find(arg => arg.startsWith("--wire="))?.slice(7)
  if (evidence) writeFileSync(evidence, JSON.stringify(wire, null, 2) + "\n")
  console.debug = originalDebug
  await proxy?.closeBackend?.()
  upstream.stop(true)
  rmSync(root, { recursive: true, force: true })
}
