#!/usr/bin/env bun
/**
 * Two queries of one conversation, open at the same time: does the second one
 * still reach the model with the client's tools?
 *
 * Meridian builds a conversation's passthrough tools once and hands them to
 * every query of that conversation. This drives the real Claude executable
 * through the Agent SDK with the options `buildQueryOptions` produces, against
 * a local credential-free API: one tool set, two queries, the first one's model
 * request held open by the API while the second runs. No model is called.
 *
 *   bun scripts/e2e-passthrough-mcp-overlap.mjs
 */
import assert from "node:assert/strict"
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { buildQueryOptions } from "../src/proxy/query.ts"
import { createPassthroughMcpServer } from "../src/proxy/passthroughTools.ts"

// The SDK merges options.env over process.env. Clear the parent too: inherited
// provider routing, proxy settings and credentials must never reach this probe.
const inheritedEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
process.env.PATH = inheritedEnv.PATH

const root = await mkdtemp(join(tmpdir(), "meridian-passthrough-mcp-overlap-"))
const claudeExecutable = new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url).pathname
process.env.HOME = root
process.env.CLAUDE_CONFIG_DIR = join(root, "config-home")
const STEP_MS = 90_000
const markers = { first: `first-${randomUUID()}`, second: `second-${randomUUID()}` }
const requests = []
let releaseFirst = () => {}
const firstReleased = new Promise(resolve => { releaseFirst = resolve })

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 255,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({})
    const body = await request.json()
    const conversation = JSON.stringify(body.messages ?? [])
    const turn = Object.keys(markers).find(name => conversation.includes(markers[name])) ?? "other"
    requests.push({ turn, tools: body.tools ?? [] })
    // A slow or stalled model stream keeps its query open the same way.
    if (turn === "first") await firstReleased
    const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 } }
    if (!body.stream) return Response.json(message)
    const events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } })
  },
})

// Built once and handed to both queries, as Meridian's per-session tool cache does.
const passthroughMcp = createPassthroughMcpServer([{
  name: "bash", description: "Run a shell command",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}])

function startQuery(turn) {
  const abortController = new AbortController()
  const config = buildQueryOptions({
    prompt: `${markers[turn]}: answer with one word`, model: "claude-opus-5-5", workingDirectory: root, systemContext: "",
    claudeExecutable, passthrough: true, stream: true, sdkAgents: {}, passthroughMcp,
    hasDeferredTools: passthroughMcp.hasDeferredTools, isUndo: false,
    blockedTools: [], incompatibleTools: [], mcpServerName: "oc", allowedMcpTools: [],
    settingSources: [], codeSystemPrompt: false, memory: false, dreaming: false,
    cleanEnv: {
      PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "config-home"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: randomUUID(),
      ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
    },
  }, abortController)
  const state = { init: undefined, result: undefined, error: undefined, settled: false, abort: () => abortController.abort() }
  const sdkQuery = query(config)
  state.done = (async () => {
    try {
      for await (const event of sdkQuery) {
        if (event.type === "system" && event.subtype === "init") state.init = event
        if (event.type === "result") state.result = event
      }
    } catch (error) {
      state.error = String(error)
    } finally {
      state.settled = true
      sdkQuery.close()
    }
  })()
  return state
}

async function until(condition, what) {
  const deadline = Date.now() + STEP_MS
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

function summarize(turn, state) {
  const sent = requests.filter(request => request.turn === turn)
  return {
    mcpServer: state.init?.mcp_servers?.find(entry => entry.name === passthroughMcp.serverName)?.status ?? null,
    modelRequests: sent.length,
    requestTools: sent[0]?.tools.map(tool => tool.name) ?? null,
    result: state.result?.subtype ?? state.error ?? null,
  }
}

/** The CLI's own record of a server it could not connect - the production signature. */
async function mcpConnectFailures() {
  const cache = join(root, ".cache")
  const files = await readdir(cache, { recursive: true }).catch(() => [])
  const failures = []
  for (const file of files.filter(name => /mcp-logs-[^/]+\/[^/]+\.jsonl$/.test(name))) {
    for (const line of (await readFile(join(cache, file), "utf8")).split("\n")) {
      if (line.includes("Failed to connect SDK MCP server")) failures.push(JSON.parse(line).error)
    }
  }
  return failures
}

let first
let second
try {
  await access(claudeExecutable)
  first = startQuery("first")
  await until(() => first.settled || requests.some(request => request.turn === "first"), "the first query's model request")
  assert.equal(first.settled, false, `the first query ended before its model request was held: ${first.error ?? first.result?.subtype}`)
  second = startQuery("second")
  await until(() => second.settled, "the second query")
  const secondRanWhileFirstOpen = !first.settled
  releaseFirst()
  await until(() => first.settled, "the first query")

  const report = {
    first: summarize("first", first),
    second: summarize("second", second),
    secondRanWhileFirstOpen,
    sameToolDefinitions: JSON.stringify(requests.find(request => request.turn === "first")?.tools)
      === JSON.stringify(requests.find(request => request.turn === "second")?.tools),
    mcpConnectFailures: await mcpConnectFailures(),
  }
  console.log(JSON.stringify(report, null, 2))
  assert.equal(report.secondRanWhileFirstOpen, true, "the first query closed before the second one ran, so nothing overlapped")
  assert.equal(report.first.mcpServer, "connected", "the first query could not connect the passthrough MCP server")
  assert.deepEqual(report.first.requestTools, passthroughMcp.toolNames, "the first query reached the model without the client's tools")
  assert.equal(report.second.mcpServer, "connected", "the second query could not connect the passthrough MCP server")
  assert.deepEqual(report.second.requestTools, passthroughMcp.toolNames, "the second query reached the model without the client's tools")
  assert.equal(report.sameToolDefinitions, true, "the two queries advertised different tool definitions")
  assert.deepEqual(report.mcpConnectFailures, [], "the CLI logged a passthrough MCP server it could not connect")
  assert.equal(report.first.result, "success", "the first query failed")
  assert.equal(report.second.result, "success", "the second query failed")
  console.log("PASS: both queries of the conversation reached the model with the client's tools")
} finally {
  releaseFirst()
  first?.abort()
  second?.abort()
  await Promise.race([Promise.all([first?.done, second?.done]), Bun.sleep(5_000)])
  server.stop(true)
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, inheritedEnv)
}
