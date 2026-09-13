#!/usr/bin/env bun
/**
 * Live E2E: can a client whose tool names already carry an MCP namespace
 * actually receive, execute, and answer a forwarded passthrough call?
 *
 * Meridian nests client tools inside its own `oc` MCP server, so a client that
 * aggregates MCP servers itself — a Claude Code CLI job with an `oc` server
 * configured, for instance — declares tools like `mcp__oc__read` that collide
 * with that namespace. Before the fix the collision was fatal in two ways at
 * once, and neither is reachable from a mocked SDK:
 *
 *   - REGISTRATION. The tool was advertised as `mcp__oc__mcp__oc__read`. On SDK
 *     0.2.141 / CLI 2.1.263 the CLI lists that name but never dispatches it, so
 *     the PreToolUse hook never fired and nothing was captured (`tools=0/1`).
 *     Non-streaming returned HTTP 500; streaming ended `stop_reason: max_tokens`
 *     with an inline `error` event.
 *   - DELIVERY. The reverse translation was a blind prefix strip, so the leaked
 *     tool_use reached the client as `read` — a tool it never declared.
 *
 * Either half breaks the promise the forwarding hook makes to the model ("the
 * result will be delivered in a future turn"): a client cannot answer a call it
 * does not recognize, so that turn never comes. A coordinator watching the
 * stalled job then re-dispatches it, which is the compounding respawn loop in
 * #967.
 *
 * What this gate asserts, per tool shape and per response mode:
 *
 *   1. The call is dispatched and captured — `stop_reason: tool_use`, exactly
 *      one tool_use block, no error event. This is the registration claim.
 *   2. The delivered name is byte-identical to what the client declared, and
 *      its arguments survive. This is the delivery claim.
 *   3. Replaying that call's real tool_result gets a real answer quoting the
 *      file's content — the promised future turn actually arrives. Without this
 *      the first two could pass on a call the client still cannot complete.
 *
 * Controls run in the same process so a pass cannot come from a dead proxy: an
 * ordinary `read` and a foreign `mcp__zed__read` must keep working unchanged.
 *
 * Costs a few cents of real tokens and needs Claude Max. Run before any release
 * touching passthrough tool registration, the deny hook, or tool-name delivery.
 *
 *   bun scripts/e2e-passthrough-namespaced-tools.mjs [--stream]
 */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setSessionStoreDir } from "../src/proxy/sessionStore.ts"

process.env.MERIDIAN_PASSTHROUGH = "1"
const { startProxyServer } = await import("../src/proxy/server.ts")

const STREAM = process.argv.includes("--stream")
const PORT = Number(process.env.PROBE_PORT ?? 3524)
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4-5-20251001"

// Deliberately a SHORT isolated path, not the OS temp dir. On macOS mkdtemp
// lands under /private/var/folders/<random>/T/, and Opus truncates a path that
// long in its own tool argument ("I passed a truncated path on that call") —
// which fails the argument check for a reason that has nothing to do with what
// this gate measures. Still per-run isolated, just short enough to survive.
const WORKDIR = realpathSync(mkdtempSync("/tmp/mns-"))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, "store"))

const CONTENT = "namespaced-tool-probe-content-zeta"
const FILE = join(WORKDIR, "data.txt")
writeFileSync(FILE, CONTENT + "\n")

// Keep proxy logs out of the verdict but retain them for a failure report.
const say = console.log.bind(console)
const proxyLog = []
for (const k of ["log", "error", "debug"]) console[k] = (...a) => { proxyLog.push(a.map(String).join(" ")) }
const inst = await startProxyServer({ port: PORT, host: "127.0.0.1" })

const failures = []
function check(ok, label, detail) {
  say(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

const toolDef = name => ({
  name,
  description: "Read a file from disk and return its contents",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Absolute path" } },
    required: ["file_path"],
  },
})

async function send(sessionId, tools, messages) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": sessionId,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, stream: STREAM, tools, messages }),
  })
  const text = await res.text()
  if (!STREAM) {
    let body
    try { body = JSON.parse(text) } catch { return { status: res.status, blocks: [], stop: null, errors: 1 } }
    return {
      status: res.status,
      blocks: body.content ?? [],
      stop: body.stop_reason ?? null,
      errors: body.type === "error" ? 1 : 0,
    }
  }
  const blocks = []
  let stop = null
  let errors = 0
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    let ev
    try { ev = JSON.parse(line.slice(5)) } catch { continue }
    if (ev.type === "error") errors++
    if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason
    if (ev.type === "content_block_start") {
      blocks[ev.index] = { ...ev.content_block, ...(ev.content_block.type === "tool_use" ? { _json: "" } : {}) }
    }
    if (ev.type === "content_block_delta") {
      const b = blocks[ev.index]
      if (!b) continue
      if (ev.delta.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text
      if (ev.delta.type === "input_json_delta") b._json += ev.delta.partial_json
    }
  }
  return {
    status: res.status,
    stop,
    errors,
    blocks: blocks.filter(Boolean).map(b => {
      if (b.type !== "tool_use") return b
      const { _json, ...rest } = b
      return { ...rest, input: _json ? JSON.parse(_json) : (b.input ?? {}) }
    }),
  }
}

/** Drive one full forward → execute → answer round trip for one tool name. */
async function probe(label, toolName) {
  say(`\n=== ${label}: declared "${toolName}" (stream=${STREAM}) ===`)
  const tools = [toolDef(toolName)]
  const sessionId = `ns-tools-${STREAM ? "stream" : "nonstream"}-${toolName}-${process.pid}`
  const messages = [{
    role: "user",
    content: `Use the ${toolName} tool to read ${FILE}, then tell me its exact contents.`,
  }]

  const first = await send(sessionId, tools, messages)
  const calls = first.blocks.filter(b => b.type === "tool_use")

  // 1. Registration: the call was dispatched to the hook and captured.
  check(
    first.status === 200 && first.stop === "tool_use" && calls.length === 1 && first.errors === 0,
    "call dispatched and captured",
    `http=${first.status} stop=${first.stop} calls=${calls.length} errors=${first.errors}`,
  )
  if (calls.length !== 1) {
    say("    cannot continue this shape without exactly one forwarded call")
    return
  }

  // 2. Delivery: the client got back the name it declared, arguments intact.
  const call = calls[0]
  check(call.name === toolName, "delivered the declared tool name", `delivered="${call.name}"`)
  check(
    call.input?.file_path === FILE,
    "delivered the tool arguments intact",
    `file_path=${JSON.stringify(call.input?.file_path)}`,
  )

  // 3. The promised future turn arrives: replay the real result, get an answer.
  messages.push({ role: "assistant", content: first.blocks })
  messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: call.id, content: CONTENT }],
  })
  const second = await send(sessionId, tools, messages)
  const answer = second.blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("")
  check(
    second.status === 200 && answer.includes(CONTENT),
    "answered from the client's real tool_result",
    `http=${second.status} quoted=${answer.includes(CONTENT)} stop=${second.stop}`,
  )
  check(
    !/forwarded|no content|never returned|no result|unable to read/i.test(answer),
    "answer does not claim the call went unanswered",
    answer.slice(0, 120).replace(/\s+/g, " "),
  )
}

// The subject first, then the controls — a dead proxy cannot fake the controls.
await probe("subject: collides with our own namespace", "mcp__oc__read")
await probe("control: ordinary tool name", "read")
await probe("control: foreign MCP namespace", "mcp__zed__read")

say(`\n=== verdict (stream=${STREAM}) ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s) failed`)
  for (const f of failures) say(`    - ${f}`)
  say("\n  recent proxy diagnostics:")
  for (const line of proxyLog.filter(l => l.includes("[PROXY]")).slice(-12)) say(`    ${line}`)
} else {
  say("  PASS: every declared tool shape was dispatched, delivered by name, and answered")
}
await inst.close()
process.exit(failures.length ? 1 : 0)
