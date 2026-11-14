#!/usr/bin/env bun
/**
 * Real SDK/CLI + local API: a ToolSearch call made under the client tool
 * prefix (`mcp__oc__ToolSearch`) must stay inside the SDK, never reach the
 * client.
 *
 * The deferred-tools note lists every deferred tool by its registered
 * `mcp__oc__*` name, and a live model (Haiku 5.5 through Pi) once called the
 * search tool under that prefix. The CLI has no such tool and answers "No such
 * tool available", but the proxy took the prefix for a client tool, stripped
 * it, and streamed a `ToolSearch` call to a client that never declared one. Pi
 * then failed it ("Tool ToolSearch not found") and paid a full extra round.
 *
 * Claims, per transport (`--stream` or not):
 *   1. The client receives exactly the deferred tool's call, stop_reason
 *      tool_use, and no ToolSearch call under any name.
 *   2. Inside the SDK the model saw the CLI's rejection, retried with the real
 *      ToolSearch, and got the tool_reference: the load worked in one client
 *      round.
 *
 * No subscription or model is involved: the CLI talks to a local fixture.
 *
 *   bun scripts/e2e-prefixed-toolsearch.mjs [--stream]
 */
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-prefixed-search-")))
const stream = process.argv.includes("--stream")
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: "1", MERIDIAN_TELEMETRY_PERSIST: "0" })

const tool = { name: "read_fixture", description: "Read synthetic data without side effects", input_schema: { type: "object", properties: {} } }
const deferredTool = { name: "aux_fixture", description: "Deferred fixture tool", input_schema: { type: "object", properties: {} }, defer_loading: true }
const steps = []
const upstreamErrors = []

function sse(block, stopReason) {
  const events = [{ type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", content: [], model: "fixture",
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } },
  { type: "content_block_delta", index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } },
  { type: "message_stop" }]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "request-id": `req_${randomUUID()}` } })
}

/** The fixture model: a prefixed search first, the real one after the CLI refuses it, then the loaded tool. */
function answer(body) {
  const names = (body.tools ?? []).map(candidate => candidate.name)
  const registered = names.find(name => name.endsWith(`__${tool.name}`))
  if (!registered) return undefined
  const prefix = registered.slice(0, -tool.name.length)
  const last = body.messages.at(-1)
  const results = Array.isArray(last?.content) ? last.content.filter(block => block.type === "tool_result") : []
  const loaded = results.some(block => Array.isArray(block.content) && block.content.some(item => item.type === "tool_reference"))
  const refused = results.some(block => JSON.stringify(block.content).includes("No such tool available"))
  const query = { query: `select:${prefix}${deferredTool.name}`, max_results: 1 }
  if (loaded) {
    steps.push("call_loaded_tool")
    return sse({ type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name: `${prefix}${deferredTool.name}`, input: {} }, "tool_use")
  }
  if (refused && names.includes("ToolSearch")) {
    steps.push("real_search_after_refusal")
    return sse({ type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name: "ToolSearch", input: query }, "tool_use")
  }
  if (results.length === 0) {
    steps.push("prefixed_search")
    return sse({ type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name: `${prefix}ToolSearch`, input: query }, "tool_use")
  }
  steps.push("text")
  return sse({ type: "text", text: "DONE" }, "end_turn")
}

const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 100 })
    const response = answer(await request.json())
    return response ?? new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  } catch (error) {
    upstreamErrors.push(String(error))
    return new Response(String(error), { status: 500 })
  }
} })

const { startProxyServer } = await import("../src/proxy/server.ts")
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true,
  profiles: [{ id: "fixture", type: "api", apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${upstream.port}` }],
})
const address = proxy.server.address()
assert(address && typeof address === "object")

async function request(messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": `prefixed-search-${stream}` },
    body: JSON.stringify({ model: "haiku", stream, max_tokens: 256, tools: [tool, deferredTool], messages }), signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  if (!stream) {
    const body = JSON.parse(raw)
    return { status: response.status, raw, content: body.content ?? [], stop: body.stop_reason }
  }
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  const content = []
  for (const event of events) {
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block }
  }
  return { status: response.status, raw, content: content.filter(Boolean), stop: events.findLast(event => event.type === "message_delta")?.delta.stop_reason }
}

try {
  const handoff = await request([{ role: "user", content: "Load the deferred fixture tool and call it." }])
  assert.equal(handoff.status, 200, handoff.raw)
  const calls = handoff.content.filter(block => block.type === "tool_use").map(block => block.name)
  assert(!calls.some(name => name.endsWith("ToolSearch")), `A ToolSearch call reached the client: ${JSON.stringify(calls)}`)
  assert.deepEqual(calls, [deferredTool.name], handoff.raw)
  assert.equal(handoff.stop, "tool_use", handoff.raw)
  assert.deepEqual(steps, ["prefixed_search", "real_search_after_refusal", "call_loaded_tool"])
  assert.deepEqual(upstreamErrors, [])
  console.log(JSON.stringify({ result: "PASS", stream, steps, root }))
} finally {
  await proxy.close()
  await upstream.stop(true)
}
