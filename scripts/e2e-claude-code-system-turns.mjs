#!/usr/bin/env bun
// The real Claude Code client through a real proxy, SDK and CLI, against a
// scripted Messages API: no model calls. Does every tool round of a
// conversation resume its SDK session, or does one replay the whole history?
//
// claude-cli ends a tool-result request with a `system` turn (its
// mid-conversation-system feature), and on some models it appends a reminder
// that lives for that one request. On claude-fable-5-1 with 2.1.289 the turn is
//
//   system: [ "<total_tokens>N tokens left</total_tokens>" (cache_control),
//             "First privately list what you need next; ..." ]
//
// and the request after it carries the same turn as the plain string
// "<total_tokens>N tokens left</total_tokens>". Meridian hashed the reminder
// into the session's lineage, so every tool round after the first looked like
// edited history and was replayed into a new SDK session. On a live proxy on
// 2026-10-05, 32 such turns of nine Fable subagents wrote 5.4M tokens to the
// cache (168K each; the turns that resumed wrote 10K) and re-planned at 11K
// output tokens apiece. The one earlier gate with the real client,
// e2e-claude-code-client.mjs, stops after a single tool round, which is the one
// round that did resume.
//
// This gate runs ROUNDS tool rounds (default 5) and holds, for every request
// after the first: lineage `continuation`, an SDK query that resumes the
// session the round before it left, a history the API receives as structured
// tool_use/tool_result turns and not as a replay, and the request's own
// reminder delivered to the model.
//
//   bun scripts/e2e-claude-code-system-turns.mjs [model] [--expect-no-reminder]
//
// The model defaults to claude-fable-5-1. E2E_CLAUDE_CLIENT picks the client
// (default: `claude` on PATH) and E2E_CLAUDE_PATH the CLI the SDK drives. Both
// versions are printed. The default requires the exact reminder to disappear
// from a later request while its durable prefix stays. Models without it are
// tested only as explicit --expect-no-reminder negative controls.
import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const args = process.argv.slice(2)
const EXPECT_NO_REMINDER = args.includes("--expect-no-reminder")
const MODEL = args.find(arg => arg !== "--expect-no-reminder") ?? "claude-fable-5-1"
const ROUNDS = Number(process.env.ROUNDS ?? 5)
assert(Number.isInteger(ROUNDS) && ROUNDS >= 2, "ROUNDS must be at least 2 to observe a reminder's historical form")
const BATCHING_REMINDER_TEXT = "First privately list what you need next; then request every item that doesn't depend on another's result in this one response."
// The client runs in the fixture directory, so a relative path is resolved here.
const CLIENT = process.env.E2E_CLAUDE_CLIENT?.includes("/") ? resolve(process.env.E2E_CLAUDE_CLIENT) : process.env.E2E_CLAUDE_CLIENT ?? "claude"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-cc-system-turns-")))
const work = join(root, "work")
mkdirSync(work)
const fixtures = Array.from({ length: ROUNDS + 1 }, (_, index) => join(work, `fixture-${index}.txt`))
for (const [index, file] of fixtures.entries()) writeFileSync(file, `fixture ${index} ${randomUUID()}\n`)

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: "1", MERIDIAN_TELEMETRY_PERSIST: "0",
  // The fixture profile authenticates with an API key, so the SDK child needs
  // nothing from the user's own Claude config; its transcripts stay under root.
  CLAUDE_CONFIG_DIR: join(root, "claude-config"),
  ...(process.env.E2E_CLAUDE_PATH ? { MERIDIAN_CLAUDE_PATH: resolve(process.env.E2E_CLAUDE_PATH) } : {}),
})

function sse(blocks, stopReason, model, inputTokens) {
  const events = [{ type: "message_start", message: { id: `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`, type: "message", role: "assistant", content: [], model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }]
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
        { type: "content_block_stop", index })
    } else {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
        { type: "content_block_stop", index })
    }
  }
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }, { type: "message_stop" })
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "request-id": `system-turns-${upstreamCalls.length}` } })
}

// The scripted model: one Read per round (two in the first, as a parallel
// call), then the answer. Usage grows so each round's token notice differs.
const upstreamCalls = []
const upstreamErrors = []
let cliVersion
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 100 })
    const body = await request.json()
    const readName = (body.tools ?? []).map(tool => tool.name).find(name => name.endsWith("Read"))
    // The client's and the CLI's own side calls carry no Read tool.
    if (!readName) return sse([{ type: "text", text: "ok" }], "end_turn", body.model, 100)
    cliVersion ??= JSON.stringify(body.system ?? "").match(/cc_version=([0-9.]+[0-9])/)?.[1]
    const call = upstreamCalls.length + 1
    upstreamCalls.push({ call, messages: body.messages })
    const read = index => ({ type: "tool_use", id: `toolu_round${call}_${index}_${randomUUID().replaceAll("-", "").slice(0, 12)}`, name: readName, input: { file_path: fixtures[index] } })
    if (call === 1) return sse([{ type: "text", text: "Reading two." }, read(0), read(1)], "tool_use", body.model, 100 + 5000 * call)
    if (call <= ROUNDS) return sse([read(call)], "tool_use", body.model, 100 + 5000 * call)
    return sse([{ type: "text", text: "ALL-FIXTURES-READ" }], "end_turn", body.model, 100 + 5000 * call)
  } catch (error) {
    upstreamErrors.push(String(error?.stack ?? error))
    return new Response(String(error), { status: 500 })
  }
} })

const queries = []
const realQuery = sdk.query
const observer = spyOn(sdk, "query").mockImplementation(input => {
  queries.push({ model: input.options?.model, sessionId: input.options?.sessionId, resume: input.options?.resume,
    resumeSessionAt: input.options?.resumeSessionAt, maxTurns: input.options?.maxTurns,
    toolServer: Object.keys(input.options?.mcpServers ?? {}).length > 0,
    textPrompt: typeof input.prompt === "string" ? input.prompt : undefined })
  return realQuery(input)
})

const { startProxyServer } = await import("../src/proxy/server.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true,
  profiles: [{ id: "fixture", type: "api", apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${upstream.port}` }] })
const address = proxy.server.address()
assert(address && typeof address === "object")
const proxyUrl = `http://127.0.0.1:${address.port}`

// What the client sends, recorded on its way to the proxy.
const clientRequests = []
const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
  const url = new URL(request.url)
  if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
    return fetch(proxyUrl + url.pathname + url.search, { method: request.method, headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }) })
  }
  const raw = await request.text()
  const body = JSON.parse(raw)
  if ((body.tools ?? []).some(tool => tool.name === "Read")) clientRequests.push(body)
  return fetch(proxyUrl + url.pathname + url.search, { method: "POST", headers: request.headers, body: raw, signal: AbortSignal.timeout(180_000) })
} })

const failures = []
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}
const blocksOf = message => Array.isArray(message?.content) ? message.content : typeof message?.content === "string" ? [{ type: "text", text: message.content }] : []
const isReminder = block => block?.type === "text" && block.text === BATCHING_REMINDER_TEXT
const withoutCacheHint = ({ cache_control, ...block }) => block
let reminderTransitions = []

let clientVersion = "unknown"
try {
  const versionProcess = Bun.spawn([CLIENT, "--version"], { stdout: "pipe", stderr: "pipe" })
  clientVersion = (await new Response(versionProcess.stdout).text()).trim()
  await versionProcess.exited

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE|_)/.test(key) || key.startsWith("MERIDIAN_") || key.startsWith("ANTHROPIC_") || key === "ENABLE_TOOL_SEARCH") delete env[key]
  }
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(root, "client-config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${relay.port}`,
    ANTHROPIC_AUTH_TOKEN: "meridian-e2e-dummy", DISABLE_AUTOUPDATER: "1" })
  const child = Bun.spawn([CLIENT, "-p", "Read the fixture files one after another and report.", "--model", MODEL,
    "--allowedTools", "Read", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", ""],
    { cwd: work, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 240_000)
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)

  console.log(`\n=== ${clientVersion}, ${MODEL}, ${ROUNDS} tool rounds ===`)
  check(code === 0 && out.includes("ALL-FIXTURES-READ"), "the client finishes the conversation", `exit=${code} out=${JSON.stringify(out.trim().slice(0, 60))}${code === 0 ? "" : ` err=${JSON.stringify(err.slice(0, 300))}`}`)
  check(clientRequests.length === ROUNDS + 1, "the client makes one request per tool round and one for the answer", `${clientRequests.length} request(s)`)

  // What the client did with its system turns, for the record: this is the
  // behaviour the fix exists for, and the gate must not pass by its absence.
  const tailBlocks = clientRequests.slice(1).map(body => body.messages.at(-1)?.role === "system" ? blocksOf(body.messages.at(-1)).length : 0)
  const shed = clientRequests.slice(2).map((body, index) => {
    const earlier = clientRequests[index + 1]
    const position = earlier.messages.length - 1
    return blocksOf(earlier.messages[position]).length - blocksOf(body.messages[position]).length
  })
  reminderTransitions = clientRequests.slice(1, -1).flatMap((earlier, index) => {
    const position = earlier.messages.length - 1
    const active = earlier.messages[position]
    const historical = clientRequests[index + 2].messages[position]
    const blocks = blocksOf(active)
    if (active?.role !== "system" || historical?.role !== "system" || blocks.length < 2 || !isReminder(blocks.at(-1))) return []
    return isDeepStrictEqual(blocks.slice(0, -1).map(withoutCacheHint), blocksOf(historical).map(withoutCacheHint)) ? [index + 2] : []
  })
  const reminderRequests = clientRequests.filter(body => body.messages.some(message => message.role === "system" && blocksOf(message).some(isReminder)))
  console.log(`  note  trailing system turn blocks per request: [${tailBlocks.join(", ")}]; blocks gone from that turn one request later: [${shed.join(", ")}]`)
  check(EXPECT_NO_REMINDER ? reminderRequests.length === 0 : reminderTransitions.length > 0,
    EXPECT_NO_REMINDER ? "negative control sends no known batching reminder" : "the exact batching reminder disappears while every durable block stays",
    `${reminderRequests.length} reminder request(s), ${reminderTransitions.length} witnessed transition(s)`)

  const rows = telemetryStore.getRecent({ limit: 200 }).filter(row => (row.toolCount ?? 0) > 0).sort((a, b) => a.timestamp - b.timestamp)
  check(rows.length === ROUNDS + 1 && rows.every(row => row.status === 200), "the proxy answers each of them", `${rows.length} row(s), statuses ${[...new Set(rows.map(row => row.status))].join(",")}`)
  const lineage = rows.map(row => row.lineageType)
  check(lineage[0] === "new" && lineage.slice(1).every(type => type === "continuation") && rows.slice(1).every(row => row.isResume === true),
    "every request after the first is a continuation that resumes", lineage.join(", "))

  // The conversation's own queries are the ones handed the client's tools;
  // its side calls carry none. The turn budget is no marker: tools the
  // client defers lift the one-turn cap.
  const main = queries.filter(query => query.toolServer)
  const chained = main.slice(1).every((query, index) => typeof query.resume === "string" && query.resume.length > 0 && typeof query.resumeSessionAt === "string")
  check(main.length === ROUNDS + 1 && chained && !main[0].resume, "each SDK query after the first resumes at the round before it",
    main.map(query => query.resume ? "resume" : "fresh").join(", "))
  check(main.slice(1).every(query => query.textPrompt === undefined || !query.textPrompt.includes("<conversation_history>")),
    "no round is sent as a replay of the conversation")

  check(upstreamCalls.length === ROUNDS + 1, "each request costs one Messages call", `${upstreamCalls.length} call(s)`)
  const last = upstreamCalls.at(-1)?.messages ?? []
  const structuredRounds = last.filter(message => message.role === "assistant" && blocksOf(message).some(block => block.type === "tool_use")).length
  const results = last.flatMap(message => blocksOf(message).filter(block => block.type === "tool_result"))
  check(structuredRounds === ROUNDS && results.length === ROUNDS + 1 && fixtures.slice(0, ROUNDS + 1).every((_, index) => JSON.stringify(results).includes(`fixture ${index} `)),
    "the last call carries every round as structured tool_use and tool_result turns", `${structuredRounds} tool round(s), ${results.length} result(s)`)
  for (const body of reminderRequests) {
    const index = clientRequests.indexOf(body)
    const lastTurn = JSON.stringify(upstreamCalls[index]?.messages.at(-1) ?? "")
    check(lastTurn.includes(JSON.stringify(BATCHING_REMINDER_TEXT).slice(1, -1)), "the request's own reminder reaches the model", `request ${index + 1}`)
  }
  assert.deepEqual(upstreamErrors, [])
} finally {
  await proxy.close()
  await relay.stop(true)
  await upstream.stop(true)
  observer.mockRestore()
}
console.log(`\nclient ${clientVersion}; CLI on the wire: cc_version=${cliVersion ?? "unknown"} (${process.env.MERIDIAN_CLAUDE_PATH ?? "resolved by the proxy"})`)
// A failed run keeps its sessions and transcripts for inspection.
if (failures.length === 0) rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify({ result: failures.length === 0 ? "PASS" : "FAIL", coverage: EXPECT_NO_REMINDER ? "negative-control" : "affected-reminder",
  reminderTransitions: reminderTransitions.length, model: MODEL, rounds: ROUNDS, failures, ...(failures.length === 0 ? {} : { root }) }))
process.exit(failures.length === 0 ? 0 : 1)
