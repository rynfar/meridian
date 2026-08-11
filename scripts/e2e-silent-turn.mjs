#!/usr/bin/env bun
/**
 * Live E2E: the silent-turn invariant — a terminal envelope must carry text or
 * a tool call.
 *
 * WHY THIS EXISTS
 *
 * Three defects have ended in the same shape: `stop_reason: "end_turn"`, HTTP
 * 200, `error: null`, nothing the client can act on. Each was found by reading
 * a transcript after the fact, and each mocked suite went green while the field
 * kept breaking — the trigger is a model choosing between two instructions,
 * which no mock reproduces.
 *
 * So this measures the OUTCOME rather than any one cause. It runs the real CLI
 * through the real proxy and asks a single question of every turn: did the
 * client receive something actionable? A cause we have not found yet fails this
 * the same way the three known ones did.
 *
 * WHAT IT DOES
 *
 * Drives the exact shape all three incidents took — a tool call, then the
 * follow-up turn that must answer its result — because every observed silence
 * landed on a session's SECOND turn, where the deny is the largest thing in a
 * still-short context. Each attempt is a fresh session, so each gets its own
 * second turn.
 *
 *   bun scripts/e2e-silent-turn.mjs
 *   E2E_ATTEMPTS=10 bun scripts/e2e-silent-turn.mjs
 *   MERIDIAN_SILENT_TURN_RECOVERY=0 bun scripts/e2e-silent-turn.mjs   # baseline
 *
 * Requires Claude Max auth (`claude login`). Costs real tokens: two turns per
 * attempt, plus one more for every silence the recovery catches.
 *
 * READING THE RESULT
 *
 * - `silent: 0` with recovery ON says the client always got an answer. It does
 *   NOT say no turn came back empty upstream — check `recovered` for that.
 * - `recovered: n` is the interesting number: n silences happened and n were
 *   repaired. That is the guard doing its job, and the only direct evidence
 *   the mechanism engages on a live model.
 * - Run with the kill switch to measure the underlying rate. Comparing a
 *   recovery-ON run against nothing tells you little; comparing ON against OFF
 *   tells you both the rate and the repair.
 */
import { startProxyServer } from "../src/proxy/server.ts"

const PORT = Number(process.env.E2E_PORT ?? 3497)
const ATTEMPTS = Number(process.env.E2E_ATTEMPTS ?? 3)
const MODEL = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"

process.env.MERIDIAN_PASSTHROUGH = "1"
process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = "1"

const diag = []
console.debug = (...args) => { diag.push(args.map(String).join(" ")) }

const inst = await startProxyServer({ port: PORT, host: "127.0.0.1", silent: true })

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Absolute path" } },
    required: ["file_path"],
  },
}

/** Parse an SSE body into events, keeping order. */
function parseSSE(body) {
  const out = []
  for (const chunk of body.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(chunk)
    const data = /^data: (.+)$/m.exec(chunk)
    if (!ev) continue
    let parsed
    try { parsed = data ? JSON.parse(data[1]) : undefined } catch { parsed = undefined }
    out.push({ event: ev[1], data: parsed })
  }
  return out
}

async function send(messages, sessionId) {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": sessionId,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, stream: true, tools: [READ_TOOL], messages }),
  })
  return { status: response.status, events: parseSSE(await response.text()) }
}

/**
 * Session-category diagnostic lines recorded since `since`.
 *
 * The guard reports itself through `diagnosticLog.session()`, which writes to
 * an in-memory ring buffer surfaced at /telemetry/logs — it never reaches
 * stdout. Reading it here is what makes `recovered` a real number instead of a
 * constant zero.
 */
async function sessionLogsSince(since) {
  const res = await fetch(
    `http://127.0.0.1:${PORT}/telemetry/logs?category=session&since=${since}&limit=500`
  )
  if (!res.ok) throw new Error(`telemetry/logs returned ${res.status}`)
  const body = await res.json()
  const rows = Array.isArray(body) ? body : (body.logs ?? [])
  return rows.map((r) => String(r.message ?? ""))
}

/**
 * What did the client actually receive? Mirrors classifyTurnOutcome — text
 * DELTAS, not text blocks, because an empty text block is the defect's shape.
 */
function inspect(events) {
  let textDeltas = 0
  const toolUses = []
  let stopReason
  let errorEvent
  let messageStops = 0
  let sawErrorBeforeStop = false

  for (const { event, data } of events) {
    if (event === "content_block_delta" && data?.delta?.type === "text_delta") textDeltas += 1
    if (event === "content_block_start" && data?.content_block?.type === "tool_use") {
      toolUses.push({ id: data.content_block.id, name: data.content_block.name })
    }
    if (event === "message_delta" && data?.delta?.stop_reason) stopReason = data.delta.stop_reason
    if (event === "message_stop") messageStops += 1
    if (event === "error") {
      errorEvent = data?.error
      if (messageStops === 0) sawErrorBeforeStop = true
    }
  }
  return {
    textDeltas,
    toolUses,
    stopReason,
    errorEvent,
    messageStops,
    sawErrorBeforeStop,
    actionable: textDeltas > 0 || toolUses.length > 0,
  }
}

const results = []
let failures = 0

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const session = `e2e-silent-${Date.now()}-${attempt}`
  const sinceTs = Date.now()

  // Turn 1 — provoke a tool call. Fresh session every attempt, so the answer
  // below is always a second turn.
  const first = await send(
    [{ role: "user", content: "Read /etc/hostname and then tell me what it contains." }],
    session,
  )
  const t1 = inspect(first.events)

  if (t1.toolUses.length === 0) {
    // Not a pass or a fail of the invariant — the attempt never reached the
    // shape under test. Reported rather than silently averaged away.
    results.push({ attempt, verdict: "no-tool-call", t1, t2: null })
    console.log(`  ${attempt}: skipped — the model answered without calling a tool`)
    continue
  }

  // Turn 2 — the shape that broke. Client executed the tool; its result comes
  // back and MUST be answered.
  const assistantBlocks = t1.toolUses.map((tu) => ({
    type: "tool_use", id: tu.id, name: tu.name, input: { file_path: "/etc/hostname" },
  }))
  const second = await send(
    [
      { role: "user", content: "Read /etc/hostname and then tell me what it contains." },
      { role: "assistant", content: assistantBlocks },
      {
        role: "user",
        content: t1.toolUses.map((tu) => ({
          type: "tool_result", tool_use_id: tu.id, content: "e2e-test-host\n",
        })),
      },
    ],
    session,
  )
  const t2 = inspect(second.events)

  // The guard's own account of the turn. These lines go to the diagnostic ring
  // buffer, NOT to console.debug — reading stdout here counted zero forever,
  // which made the run look clean while measuring nothing.
  const lines = await sessionLogsSince(sinceTs)
  const silentLines = lines.filter((l) => l.includes("silent_turn reason="))
  const announceLines = lines.filter((l) => l.includes("announce_turn chars="))
  const silences = silentLines.length
  const announces = announceLines.length
  const recovered = [...silentLines, ...announceLines]
    .filter((l) => l.includes("recovery=succeeded")).length

  const verdict = t2.actionable ? "pass" : "FAIL"
  if (!t2.actionable) failures += 1
  results.push({ attempt, verdict, t1, t2, silences, announces, recovered })

  console.log(
    `  ${attempt}: ${verdict} — turn2 text=${t2.textDeltas} tools=${t2.toolUses.length} ` +
    `stop=${t2.stopReason} silent=${silences} announce=${announces} recovered=${recovered}`,
  )
}

// Envelope hygiene across every turn: exactly one message_stop, and any error
// ahead of it. An error behind message_stop is unreachable — that is how a
// failed turn came to look successful.
const envelopeProblems = []
for (const r of results) {
  for (const [label, t] of [["turn1", r.t1], ["turn2", r.t2]]) {
    if (!t) continue
    if (t.messageStops !== 1) {
      envelopeProblems.push(`attempt ${r.attempt} ${label}: ${t.messageStops} message_stop events`)
    }
    if (t.errorEvent && !t.sawErrorBeforeStop) {
      envelopeProblems.push(`attempt ${r.attempt} ${label}: error queued after message_stop (unreachable)`)
    }
    // A turn with no text must not claim it finished speaking.
    if (t.errorEvent && t.textDeltas === 0 && t.stopReason === "end_turn") {
      envelopeProblems.push(`attempt ${r.attempt} ${label}: failed turn claims stop_reason=end_turn`)
    }
  }
}

const attempted = results.filter((r) => r.verdict !== "no-tool-call").length
const skipped = results.length - attempted
const totalSilences = results.reduce((n, r) => n + (r.silences ?? 0), 0)
const totalRecovered = results.reduce((n, r) => n + (r.recovered ?? 0), 0)
const totalAnnounces = results.reduce((n, r) => n + (r.announces ?? 0), 0)

console.log("")
console.log(`attempts:   ${attempted}${skipped ? ` (${skipped} skipped — no tool call)` : ""}`)
console.log(`silent:     ${failures}   (client received nothing actionable)`)
console.log(`upstream:   ${totalSilences} silent turns detected, ${totalRecovered} recovered`)
console.log(`announce:   ${totalAnnounces} turns classified announce (recovery spent on a turn that already answered)`)
console.log(`recovery:   ${process.env.MERIDIAN_SILENT_TURN_RECOVERY === "0" ? "OFF (baseline)" : "ON"}`)

if (envelopeProblems.length > 0) {
  console.log("")
  console.log("envelope problems:")
  for (const p of envelopeProblems) console.log(`  - ${p}`)
}

await inst.close()

if (failures > 0 || envelopeProblems.length > 0) {
  console.log("")
  console.log("FAILED — a turn reached the client with nothing to act on, or its envelope hid a failure.")
  process.exit(1)
}
console.log("")
console.log("OK — every turn under test carried text or a tool call.")
