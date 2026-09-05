#!/usr/bin/env bun
// Real Claude/SDK probe; observes PreToolUse without changing its arguments.
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-input-repair-")))
const stream = process.argv.includes("--stream")
const fixture = process.argv.includes("--fixture")
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: "1", MERIDIAN_TELEMETRY_PERSIST: "0" })
let upstreamCalls = 0
const receipt = `MEASURED-${randomUUID().slice(0, 8)}`
const upstream = fixture ? Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 100 })
  const body = await request.json()
  upstreamCalls++
  const tool = body.tools?.find(tool => tool.name.endsWith("record_measurement"))
  if (!tool) return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  if (upstreamCalls > 1) assert(body.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
    block.type === "tool_result" && block.tool_use_id === "toolu_fixture_repair" && JSON.stringify(block.content).includes(receipt))),
  "The resumed real CLI request must contain the actual client result")
  const content = upstreamCalls === 1
    ? { type: "tool_use", id: "toolu_fixture_repair", name: tool.name, input: {} }
    : { type: "text", text: "" }
  const events = [
    { type: "message_start", message: { id: `msg_fixture_${upstreamCalls}`, type: "message", role: "assistant", content: [], model: body.model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_delta", index: 0, delta: upstreamCalls === 1
      ? { type: "input_json_delta", partial_json: JSON.stringify({ timeout: "60", app: '{"relay":"true"}' }) }
      : { type: "text_delta", text: receipt } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: upstreamCalls === 1 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "request-id": `fixture-${upstreamCalls}` } })
} }) : undefined
const seen = []
const queries = []
const realQuery = sdk.query
const observer = spyOn(sdk, "query").mockImplementation(input => {
  queries.push({ resume: input.options?.resume, forkSession: input.options?.forkSession, resumeSessionAt: input.options?.resumeSessionAt })
  const hooks = input.options?.hooks
  return realQuery({ ...input, options: { ...input.options, hooks: { ...hooks,
    PreToolUse: hooks?.PreToolUse?.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(hook => async (...args) => {
      seen.push(structuredClone(args[0]))
      return await hook(...args)
    }) })),
  } } })
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true,
  ...(upstream ? { profiles: [{ id: "fixture", type: "api", apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${upstream.port}` }] } : {}),
})
const address = proxy.server.address()
assert(address && typeof address === "object")
try {
  const tool = { name: "record_measurement", description: "Records a synthetic fixture measurement without side effects.",
    input_schema: { type: "object", properties: {
      timeout: { type: "number", description: "Timeout in seconds" },
      app: { type: "object", properties: { relay: { type: "boolean" } }, required: ["relay"] },
    }, required: ["timeout", "app"] } }
  const initial = [{ role: "user", content: 'Exercise a legacy JSON encoding regression in our synthetic measurement fixture. Call record_measurement once with exactly {"timeout":"60","app":"{\\"relay\\":\\"true\\"}"}. The quoted values intentionally test the receiver\'s type repair; preserve them exactly. Do not execute other tools. After receiving the measurement result, reply with its receipt identifier only.' }]
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": "repair-fixture" },
    body: JSON.stringify({ model: process.env.E2E_MODEL ?? "haiku", stream, max_tokens: 256, tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: initial,
    }), signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  console.log(JSON.stringify({ root, stream, fixture, upstreamCalls, status: response.status,
    seen: seen.map(({ tool_name, tool_input, tool_use_id }) => ({ tool_name, tool_input, tool_use_id })) }))
  assert.equal(response.status, 200, raw)
  const content = stream ? [] : JSON.parse(raw).content
  if (stream) for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue
    const event = JSON.parse(line.slice(5))
    assert.notEqual(event.type, "error", raw)
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block, json: "" }
    if (event.delta?.type === "input_json_delta") content[event.index].json += event.delta.partial_json
    if (event.delta?.type === "thinking_delta") content[event.index].thinking = (content[event.index].thinking ?? "") + event.delta.thinking
    if (event.delta?.type === "signature_delta") content[event.index].signature = (content[event.index].signature ?? "") + event.delta.signature
    if (event.delta?.type === "text_delta") content[event.index].text = (content[event.index].text ?? "") + event.delta.text
    if (event.type === "content_block_stop" && content[event.index]?.type === "tool_use") {
      content[event.index].input = JSON.parse(content[event.index].json || "{}")
    }
  }
  const calls = content.filter(block => block.type === "tool_use")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, tool.name)
  assert.deepEqual(calls[0].input, { timeout: 60, app: { relay: true } })
  const session = seen.find(event => event.tool_name.endsWith("record_measurement"))?.session_id
  assert(session, "No actual CLI hook observation")
  const history = await sdk.getSessionMessages(session, { dir: root })
  const original = history.flatMap(row => Array.isArray(row.message?.content) ? row.message.content : [])
    .find(block => block.type === "tool_use" && block.id === calls[0].id)
  const observed = seen.find(event => event.tool_use_id === calls[0].id)?.tool_input
  assert.deepEqual(original?.input, observed, "Client repair must leave SDK source input unchanged")
  if (fixture) assert.deepEqual(observed, { timeout: 60, app: { relay: "true" } }, "The real CLI must exercise nested string repair")
  const followup = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": "repair-fixture" },
    body: JSON.stringify({ model: process.env.E2E_MODEL ?? "haiku", stream, max_tokens: 256, tools: [tool],
      messages: [...initial, { role: "assistant", content: content.filter(Boolean).map(({ json, ...block }) => block) },
        { role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].id, content: JSON.stringify({ receipt }) }] }],
    }), signal: AbortSignal.timeout(120_000),
  })
  const followupRaw = await followup.text()
  assert.equal(followup.status, 200, followupRaw)
  let answer = ""
  if (stream) {
    const events = followupRaw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
    assert(!events.some(event => event.type === "error"), followupRaw)
    assert.equal(events.filter(event => event.type === "message_stop").length, 1, followupRaw)
    assert(!events.some(event => event.content_block?.type === "tool_use"), followupRaw)
    answer = events.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join("")
  } else {
    const blocks = JSON.parse(followupRaw).content
    assert(!blocks.some(block => block.type === "tool_use"), followupRaw)
    answer = blocks.filter(block => block.type === "text").map(block => block.text).join("")
  }
  assert.equal(answer.trim(), receipt, followupRaw)
  assert.equal(queries.length, 2, "Exactly one SDK query per client request")
  assert.equal(queries[1].resume, session, "The result must resume the captured source")
  assert.equal(queries[1].forkSession, true)
  assert(queries[1].resumeSessionAt, "The denied tool turn must be replaced at its checkpoint")
  assert.deepEqual(await sdk.getSessionMessages(session, { dir: root }), history, "Follow-up mutated the source history")
  console.log(JSON.stringify({ result: "PASS", stream, fixture, repairExercised: typeof observed?.app?.relay === "string", followupCorrect: true, queries }))
} finally {
  await proxy.close()
  await upstream?.stop(true)
  observer.mockRestore()
}
