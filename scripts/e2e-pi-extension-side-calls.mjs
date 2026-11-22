#!/usr/bin/env bun
// Real Pi 1.x (RPC mode) with the Meridian extension, against a recording stub
// that answers with canned Anthropic SSE replies. Asserts the identity Pi and
// the extension put on the wire for primary turns and for a compaction side
// call. It runs without credentials and does not exercise Claude or Meridian's
// server; scripts/e2e-pi-extension.mjs covers that path.
//
// Usage: bun scripts/e2e-pi-extension-side-calls.mjs [--pi=/path/to/pi]
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "..")
const pi = process.argv.find(arg => arg.startsWith("--pi="))?.slice(5) ?? Bun.which("pi")
assert(pi, "pi not found; pass --pi=/path/to/pi")
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-pi-side-call-")))
const agentDir = join(root, "agent")
const configDir = join(root, "meridian-config")
process.env.MERIDIAN_CONFIG_DIR = configDir
delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY

const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  MERIDIAN_CONFIG_DIR: configDir,
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  PATH: `${dirname(pi)}:${process.env.PATH}`,
}
for (const key of Object.keys(env)) {
  if (key.startsWith("ANTHROPIC_") || key === "PI_SUBAGENT_CHILD" || key === "MERIDIAN_SOURCE" || key === "PI_OFFLINE") delete env[key]
}

// Keep almost nothing verbatim so a two-turn session has something to compact.
mkdirSync(agentDir, { recursive: true })
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }))

const setup = Bun.spawnSync(["bun", join(repo, "bin", "cli.ts"), "setup", "--client", "pi"], { env, stdout: "pipe", stderr: "pipe" })
assert.equal(setup.exitCode, 0, setup.stderr.toString())

const { verifyPriorityAttestation, PRIORITY_ATTESTATION_HEADER } = await import("../src/proxy/priorityAttestation.ts")

const catalog = { data: [{ id: "claude-haiku-5-5", type: "model", owned_by: "anthropic", display_name: "Claude Haiku 5.5", context_window: 200000 }] }
function sse(text) {
  const events = [
    ["message_start", { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", content: [], model: "claude-haiku-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

const wire = []
let phase = "setup"
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/v1/models") return Response.json(catalog)
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await request.json()
      const headers = Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-") && name !== "x-api-key"))
      wire.push({ phase, headers, messageCount: body.messages?.length })
      const text = phase === "compact" ? "Summary: the user asked for short replies." : "OK"
      return new Response(sse(text), { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  },
})

const sessionId = crypto.randomUUID()
const child = Bun.spawn(
  [pi, "--mode", "rpc", "--model", "meridian/claude-haiku-5-5", "--session-id", sessionId, "--tools", ""],
  { cwd: root, env: { ...env, MERIDIAN_BASE_URL: `http://127.0.0.1:${stub.port}` }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
)
const records = []
const waiters = []
;(async () => {
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const record = JSON.parse(line)
      records.push(record)
      for (const waiter of [...waiters]) if (waiter.match(record)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(record) }
    }
  }
})()
function waitFor(match, label, timeoutMs = 60_000) {
  const existing = records.find(match)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
    waiters.push({ match, resolve: (value) => { clearTimeout(timer); resolve(value) } })
  })
}
let nextId = 0
async function command(payload, waitSettled) {
  const id = `probe-${++nextId}`
  const settledBefore = records.filter(r => r.type === "agent_settled").length
  child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
  child.stdin.flush()
  const response = await waitFor(r => r.type === "response" && r.id === id, `${payload.type} response`)
  assert.equal(response.success, true, JSON.stringify(response))
  if (waitSettled) await waitFor(() => records.filter(r => r.type === "agent_settled").length > settledBefore, `${payload.type} settle`)
  return response
}

let report
try {
  phase = "prompt-1"; await command({ type: "prompt", message: "Reply with OK." }, true)
  phase = "prompt-2"; await command({ type: "prompt", message: "Reply with OK again." }, true)
  phase = "compact"; const compacted = await command({ type: "compact" }, false)
  phase = "prompt-3"; await command({ type: "prompt", message: "One more OK." }, true)
  const state = await command({ type: "get_state" }, false)
  report = {
    pi: Bun.spawnSync([pi, "--version"], { cwd: root, env }).stdout.toString().trim(),
    sessionId,
    reportedSessionId: state.data.sessionId,
    compactSummary: compacted.data?.summary?.slice(0, 80),
    requests: wire.map(({ phase, headers, messageCount }) => {
      const attestation = verifyPriorityAttestation(headers[PRIORITY_ATTESTATION_HEADER])
      return {
        phase,
        messageCount,
        agent: headers["x-meridian-agent"],
        affinity: headers["x-session-affinity"],
        source: headers["x-meridian-source"],
        attestation: attestation && { generation: attestation.generation, sessionId: attestation.sessionId, turnId: attestation.turnId.slice(0, 12) },
        unverifiedAttestation: headers[PRIORITY_ATTESTATION_HEADER] !== undefined && attestation === undefined,
      }
    }),
  }
} finally {
  child.kill()
  await child.exited
  stub.stop(true)
  // The scratch Meridian config holds a generated attestation key.
  rmSync(root, { recursive: true, force: true })
}
console.log(JSON.stringify(report, null, 2))

const byPhase = (name) => report.requests.filter(r => r.phase === name)
assert.equal(report.reportedSessionId, sessionId)
for (const name of ["prompt-1", "prompt-2", "prompt-3"]) {
  const requests = byPhase(name)
  assert.equal(requests.length, 1, `${name}: one request`)
  const [request] = requests
  assert.equal(request.agent, "pi")
  assert.equal(request.affinity, sessionId, `${name}: keyed by the Pi session`)
  assert.equal(request.source, undefined, `${name}: primary turn carries no source`)
  assert.equal(request.unverifiedAttestation, false)
  assert.deepEqual(request.attestation && { g: request.attestation.generation, s: request.attestation.sessionId }, { g: "pi1", s: sessionId }, `${name}: signed`)
}
const turns = ["prompt-1", "prompt-2", "prompt-3"].map(name => byPhase(name)[0].attestation.turnId)
assert.equal(new Set(turns).size, 3, "each human turn has its own signed turn")
const compaction = byPhase("compact")
assert(compaction.length >= 1, "compaction sent a request")
for (const request of compaction) {
  assert.equal(request.agent, "pi")
  assert.notEqual(request.affinity, sessionId, "compaction is keyed apart from the conversation")
  assert.equal(request.source, "fork-side-call", "compaction is marked independent")
  assert.equal(request.attestation, undefined, "compaction is never signed")
  assert.equal(request.unverifiedAttestation, false)
}
console.error("side-call probe: all assertions passed")
