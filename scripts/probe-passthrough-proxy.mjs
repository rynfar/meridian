#!/usr/bin/env bun
/**
 * Phase 3 measurement: does the REAL proxy produce a clean transcript ordering?
 *
 * probe-passthrough-ordering.mjs proved the rule against the raw SDK: with N
 * parallel calls the session JSONL interleaves (A U A U A U) and resumeSessionAt
 * replays the first N-1 denials to the model, unless the denials are held until
 * generation ends, which reorders it to A A A U U U.
 *
 * Meridian holds denials already (holdDenyUntilTurnEnd), but only the streaming
 * path releases on the turn boundary. Non-stream releases on the FIRST assistant
 * message and clears turnGenerating with it, so every later parallel block skips
 * the hold. This drives the actual proxy on both paths and reads the SDK session
 * JSONL it produced, so the answer is measured rather than reasoned about.
 *
 *   bun scripts/probe-passthrough-proxy.mjs
 */
import {
  snapshotSessionFiles as snapshot,
  readRows,
  blocksOf,
  isDenyResult as isDeny,
  denyDetectionWarning,
} from "./lib/passthrough-jsonl.mjs"

process.env.MERIDIAN_PASSTHROUGH = "1"
const { startProxyServer } = await import("../src/proxy/server.ts")

const PORT = Number(process.env.PROBE_PORT ?? 3521)
const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-5"

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Absolute path" } },
    required: ["file_path"],
  },
}

// plog is the only place the checkpoint decision is observable, and it is
// gated by `silent`, so run the server loud and divert its output here.
const proxyLog = []
console.error = (...args) => { proxyLog.push(args.map(String).join(" ")) }
const inst = await startProxyServer({ port: PORT, host: "127.0.0.1" })

/**
 * Replay the tracker's own checkpoint rule over the log.
 *
 * NOT "the last assistant row with a tool_use": shouldEarlyStop freezes the
 * checkpoint the moment every CURRENTLY known call is resolved, and after that
 * noteAssistantMessage is no longer called. A later parallel call therefore
 * lands past the checkpoint and is dropped from the client-facing set rather
 * than replayed. Both failures matter and they are different:
 *
 *   survivors > 0  a deny sits inside the slice and is replayed to the model
 *   dropped   > 0  the model called N tools and the client was handed fewer
 */
function analyze(file) {
  const rows = readRows(file)
  const shape = []
  const expected = new Set()
  const resolved = new Set()
  const turnOfCall = new Map()
  let checkpointIndex = -1
  let checkpointTurnId
  let frozen = false
  let dropped = 0

  for (const [i, r] of rows.entries()) {
    const bs = blocksOf(r)
    const calls = bs.filter(b => b.type === "tool_use" && String(b.name ?? "").startsWith("mcp__oc__"))
    const denies = bs.filter(b => b.type === "tool_result" && isDeny(b))
    if (r.type === "assistant" && calls.length > 0) {
      shape.push("A")
      const fresh = calls.filter(b => !expected.has(b.id))
      // Calls of ONE model turn share an API message id. A call carrying a
      // different id belongs to a later turn, so excluding it is correct, not a
      // drop — without this the two are indistinguishable in the totals.
      const msgId = r.message?.id
      for (const b of fresh) turnOfCall.set(b.id, msgId)
      if (frozen) { dropped += fresh.length; continue }
      for (const b of fresh) expected.add(b.id)
      if (fresh.length > 0) { checkpointIndex = i; checkpointTurnId = msgId }
    } else if (r.type === "user" && denies.length > 0) {
      shape.push("U")
      if (frozen) continue
      for (const b of denies) resolved.add(b.tool_use_id)
      if (expected.size > 0 && [...expected].every(id => resolved.has(id))) frozen = true
    }
  }
  if (expected.size === 0 && dropped === 0) return null

  const kept = checkpointIndex >= 0 ? rows.slice(0, checkpointIndex + 1) : []
  const survivors = kept.flatMap(r => blocksOf(r).filter(b => b.type === "tool_result" && isDeny(b)))
  // Of the calls left out, how many belonged to the checkpoint's own turn?
  // Those are the real drops; the rest are later-turn calls, correctly excluded.
  const sameTurnDropped = [...turnOfCall.entries()]
    .filter(([id, mid]) => !expected.has(id) && mid !== undefined && mid === checkpointTurnId)
    .length
  const turnIds = new Set([...turnOfCall.values()].filter(Boolean))
  const allDenies = rows.flatMap(r => blocksOf(r).filter(isDeny))
  return {
    warning: denyDetectionWarning({ forwardedCalls: expected.size + dropped, denyResults: allDenies }),
    file,
    calls: expected.size + dropped,
    delivered: expected.size,
    dropped,
    sameTurnDropped,
    turns: turnIds.size,
    shape: shape.join(""),
    checkpointIndex,
    survivors: survivors.length,
  }
}

async function drive(label, stream) {
  const before = snapshot()
  const sessionId = `probe-${stream ? "stream" : "nonstream"}-${process.pid}`
  const body = {
    model: MODEL,
    max_tokens: 2048,
    stream,
    tools: [READ_TOOL],
    messages: [{
      role: "user",
      content:
        "Read all three of /tmp/a.txt, /tmp/b.txt and /tmp/c.txt using the read tool, " +
        "in parallel in a single step. Use the tool, do not guess.",
    }],
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": sessionId,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const toolCalls = (text.match(/"type":"tool_use"/g) ?? []).length

  // The CLI flushes the transcript as the query settles; give it a beat.
  await new Promise(r => setTimeout(r, 1500))
  const after = snapshot()
  const touched = [...after.entries()]
    .filter(([p, m]) => !before.has(p) || before.get(p) !== m)
    .map(([p]) => p)

  console.log(`\n=== ${label} (stream=${stream}) ===`)
  console.log(`  http ${res.status}  tool_use blocks in response: ${toolCalls}`)
  if (touched.length === 0) console.log("  no session JSONL was written or updated")
  const results = []
  for (const f of touched) {
    const a = analyze(f)
    if (!a) continue
    results.push(a)
    console.log(`  ${a.file}`)
    console.log(`    model called ${a.calls}  order=${a.shape}  checkpoint=row ${a.checkpointIndex}`)
    if (a.warning) console.log(`    !! ${a.warning}`)
    console.log(`    denials surviving the slice: ${a.survivors}${a.survivors > 0 ? "   <-- REPLAYED TO THE MODEL" : a.warning ? "   (UNPROVEN)" : "   (clean)"}`)
    console.log(`    calls delivered to client:  ${a.delivered} of ${a.calls} across ${a.turns} model turn(s)`)
    if (a.dropped > 0) {
      console.log(`      left out: ${a.dropped} (${a.sameTurnDropped} from the checkpoint's OWN turn${a.sameTurnDropped > 0 ? " <-- REAL DROP" : ", i.e. none — the rest are later-turn calls, correctly excluded"})`)
    }
  }
  return results
}

const streamed = await drive("streaming path", true)
const nonStreamed = await drive("non-streaming path", false)

console.log("\n=== verdict ===")
const worst = rs => rs.reduce((n, r) => Math.max(n, r.survivors), 0)
const parallel = rs => rs.some(r => r.calls > 1)
for (const [label, rs] of [["stream    ", streamed], ["non-stream", nonStreamed]]) {
  if (rs.length === 0) { console.log(`  ${label}  no forwarded calls captured — inconclusive`); continue }
  if (!parallel(rs)) { console.log(`  ${label}  only ${rs[0].calls} call(s) — the defect needs parallelism, inconclusive`); continue }
  const drops = rs.reduce((n, r) => n + r.sameTurnDropped, 0)
  const issues = []
  if (worst(rs) > 0) issues.push(`${worst(rs)} denial(s) replayed`)
  if (drops > 0) issues.push(`${drops} same-turn call(s) dropped`)
  console.log(`  ${label}  ${issues.length === 0 ? "CLEAN" : "LEAKS — " + issues.join(", ")}`)
}

await inst.stop?.()
process.exit(0)
