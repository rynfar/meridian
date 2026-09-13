#!/usr/bin/env bun
// Real SDK/CLI + local API. Explicit delivery faults reproduce capped partial
// and silent turns; this does not claim a live model reproduced the fault.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-cap-")))
const stream = process.argv.includes("--stream")
const mode = process.argv.find(arg => arg.startsWith("--case="))?.slice(7) ?? "partial"
assert(["partial", "empty", "thinking", "unhandled", "retry", "retry-resume", "pinned"].includes(mode))
const retry = mode.startsWith("retry")
const silent = retry || mode === "pinned"
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: "1", MERIDIAN_TELEMETRY_PERSIST: "0" })
if (mode === "pinned") process.env.MERIDIAN_PASSTHROUGH_MAX_TURNS = "1"
let phase = mode === "retry-resume" ? "seed" : "cap"
let capAttempt = 0
const apiCallsByQuery = new Map()
const upstreamErrors = []
let upstreamCalls = 0
let withheld = 0
const receipt = `RECEIPT-${randomUUID()}`
const toolId = "toolu_cap_read"
const queries = []
const results = []
const hooks = []
const tool = { name: "read_fixture", description: "Read synthetic data without side effects", input_schema: { type: "object", properties: {} } }
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 100 })
    const body = await request.json()
    if (!body.tools?.some(candidate => candidate.name.endsWith(tool.name))) {
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }
    upstreamCalls++
    const apiPhase = request.headers.get("x-cap-phase")
    const apiAttempt = Number(request.headers.get("x-cap-attempt"))
    assert(apiPhase, "CLI did not forward fixture query identity")
    const queryKey = `${apiPhase}:${apiAttempt}`
    const apiCalls = (apiCallsByQuery.get(queryKey) ?? 0) + 1
    apiCallsByQuery.set(queryKey, apiCalls)
    const capFault = apiPhase === "cap" && apiAttempt === 1
    const handoff = apiPhase === "cap" && apiAttempt === 2 && apiCalls === 1
    if (apiPhase === "followup") assert(body.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
      block.type === "tool_result" && block.tool_use_id === toolId && JSON.stringify(block.content).includes(receipt))),
    "The resumed CLI must receive the actual client result")
    const text = apiPhase === "seed" ? "The fixture is ready." : apiPhase === "followup" ? receipt : mode === "empty" ? "" : "A partial answer"
    const blocks = handoff ? [{ type: "tool_use", id: toolId, name: body.tools.find(candidate => candidate.name.endsWith(tool.name)).name, input: {} }]
      : [mode === "thinking" ? { type: "thinking", thinking: "internal fixture reasoning", signature: "fixture-signature" } : { type: "text", text },
        ...(capFault ? [{ type: "tool_use", id: "toolu_missing_fixture", name: "__cap_fixture_missing__", input: {} }] : [])]
    const events = [{ type: "message_start", message: { id: `msg_cap_${upstreamCalls}`, type: "message", role: "assistant", content: [], model: body.model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }]
    for (const [index, block] of blocks.entries()) {
      if (block.type === "thinking") {
        events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
          { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } },
          { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } },
          { type: "content_block_stop", index })
        continue
      }
      events.push({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : block },
        { type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index })
    }
    events.push({ type: "message_delta", delta: { stop_reason: capFault || handoff ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: "message_stop" })
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream", "request-id": `cap-${upstreamCalls}` } })
  } catch (error) {
    upstreamErrors.push(String(error))
    return new Response(String(error), { status: 500 })
  }
} })
const realQuery = sdk.query
const observer = spyOn(sdk, "query").mockImplementation(input => {
  const queryPhase = phase
  const attempt = phase === "cap" ? ++capAttempt : 0
  queries.push({ phase, maxTurns: input.options?.maxTurns, sessionId: input.options?.sessionId, resume: input.options?.resume,
    forkSession: input.options?.forkSession, resumeSessionAt: input.options?.resumeSessionAt })
  const actualHooks = input.options?.hooks
  const actual = realQuery({ ...input, options: { ...input.options,
    env: { ...input.options?.env, ANTHROPIC_CUSTOM_HEADERS: `x-cap-phase: ${queryPhase}\nx-cap-attempt: ${attempt}` },
    hooks: { ...actualHooks,
    PreToolUse: actualHooks?.PreToolUse?.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(hook => async (...args) => {
      hooks.push({ phase: queryPhase, attempt, name: args[0].tool_name })
      return await hook(...args)
    }) })),
  } } })
  return new Proxy(actual, { get(target, property) {
    if (property === Symbol.asyncIterator) return async function* () {
      for await (const message of actual) {
        if (message.type === "result") results.push({ phase: queryPhase, attempt, subtype: message.subtype })
        // The unknown fixture tool makes the REAL CLI spend its capped turn
        // without executing a tool. Withhold its wire/assistant content, or all
        // content for silent recovery. The CLI result and session stay real.
        if (queryPhase === "cap" && attempt === 1 && mode !== "unhandled") {
          if (message.type === "stream_event" && (silent || message.event?.index === 1)) { withheld++; continue }
          if (message.type === "assistant") {
            withheld++
            if (!silent) yield { ...message, message: { ...message.message, content: message.message.content.filter(block => block.type !== "tool_use") } }
            continue
          }
        }
        yield message
      }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true,
  profiles: [{ id: "fixture", type: "api", apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${upstream.port}` }],
})
const address = proxy.server.address()
assert(address && typeof address === "object")
async function request(messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": "cap-fixture" },
    body: JSON.stringify({ model: "haiku", stream, max_tokens: 256, tools: [tool], messages }), signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  const content = stream ? [] : JSON.parse(raw).content ?? []
  const events = stream ? raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))) : []
  for (const event of events) {
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block, json: "" }
    if (event.delta?.type === "text_delta") content[event.index].text += event.delta.text
    if (event.delta?.type === "input_json_delta") content[event.index].json += event.delta.partial_json
    if (event.type === "content_block_stop" && content[event.index]?.type === "tool_use") content[event.index].input = JSON.parse(content[event.index].json || "{}")
  }
  const stop = stream ? events.findLast(event => event.type === "message_delta")?.delta.stop_reason : JSON.parse(raw).stop_reason
  return { status: response.status, raw, content: content.filter(Boolean).map(({ json, ...block }) => block), events, stop }
}
function success(response, stop) {
  assert.equal(response.status, 200, response.raw)
  assert(!response.events.some(event => event.type === "error"), response.raw)
  assert.equal(response.stop, stop, response.raw)
  if (stream) assert.equal(response.events.filter(event => event.type === "message_stop").length, 1)
}
const resources = () => Object.values(JSON.parse(readFileSync(join(root, "sessions", "session-gc.json"), "utf8")).resources)
async function waitForState(id, state) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (resources().some(row => row.locator.sessionId === id && row.state === state)) return
    await Bun.sleep(20)
  }
  assert.fail(`Session ${id} did not reach ${state}`)
}
try {
  let messages = []
  let source
  let sourceHistory
  if (phase === "seed") {
    messages = [{ role: "user", content: "Prepare the fixture." }]
    const seed = await request(messages)
    success(seed, "end_turn")
    source = queries[0].sessionId
    sourceHistory = await sdk.getSessionMessages(source, { dir: root })
    messages.push({ role: "assistant", content: seed.content })
    phase = "cap"
  }
  messages.push({ role: "user", content: "Read the synthetic fixture and report its receipt." })
  const response = await request(messages)
  assert(results.some(result => result.phase === "cap" && result.attempt === 1 && result.subtype === "error_max_turns"), JSON.stringify(results))
  assert(!hooks.some(hook => hook.phase === "cap" && hook.attempt === 1), "Fault attempt executed a real hook")
  const capQueries = queries.filter(query => query.phase === "cap")
  assert.equal(capQueries.length, retry ? 2 : 1)
  assert.equal(capQueries[0].maxTurns, 1)
  if (retry) {
    success(response, "tool_use")
    assert.equal(capQueries[1].maxTurns, 3)
    assert.notEqual(capQueries[1].sessionId, capQueries[0].sessionId)
    for (const query of capQueries) {
      assert.equal(query.resume, source)
      if (source) assert.equal(query.forkSession, true)
    }
    await waitForState(capQueries[0].sessionId, "retired")
    await waitForState(capQueries[1].sessionId, "live")
    const history = await sdk.getSessionMessages(capQueries[1].sessionId, { dir: root })
    assert(history.some(row => row.message?.content?.some?.(block => block.type === "tool_use" && block.id === toolId)))
    assert(!history.some(row => row.message?.content?.some?.(block => block.type === "tool_use" && block.id === "toolu_missing_fixture")), "Refused attempt leaked into retry")
    assert.equal(response.content.filter(block => block.type === "tool_use").length, 1)
    phase = "followup"
    const followup = await request([...messages, { role: "assistant", content: response.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: receipt }] }])
    success(followup, "end_turn")
    assert.equal(followup.content.filter(block => block.type === "text").map(block => block.text).join(""), receipt)
    const last = queries.at(-1)
    assert.equal(last.resume, capQueries[1].sessionId)
    assert.equal(last.forkSession, true)
    assert(last.resumeSessionAt)
    assert.deepEqual(await sdk.getSessionMessages(capQueries[1].sessionId, { dir: root }), history)
    if (source) assert.deepEqual(await sdk.getSessionMessages(source, { dir: root }), sourceHistory)
  } else if (mode === "partial") {
    success(response, "max_tokens")
    assert.equal(response.content.filter(block => block.type === "text").map(block => block.text).join(""), "A partial answer")
  } else {
    if (stream) assert(response.events.some(event => event.type === "error"), response.raw)
    else assert.equal(response.status, 500, response.raw)
  }
  assert.deepEqual(upstreamErrors, [])
  console.log(JSON.stringify({ result: "PASS", mode, stream, root, withheld, queries, results, upstreamCalls }))
} finally {
  await proxy.close()
  await upstream.stop(true)
  observer.mockRestore()
}
