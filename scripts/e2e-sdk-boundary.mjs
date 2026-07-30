#!/usr/bin/env bun
/**
 * Live E2E: the SDK boundary — the assumptions mocks cannot check.
 *
 * Three bugs shipped through this seam in one week, and every one was found by
 * watching real traffic rather than by reasoning about code:
 *
 *   #708  The SDK reports `resetsAt` in epoch SECONDS. Every fixture in the
 *         suite used milliseconds, so the mismatch was unobservable and tier 1
 *         of the priority cooldown was dead code for its entire life.
 *   #710  `thinking` blocks fell into the hash's serialize-everything
 *         fallback, folding an encrypted per-generation signature into the
 *         lineage hash. There was no thinking-block test at all.
 *   #694  The `claude_code` preset injects a gitStatus block asserting it is
 *         "the git status at the start of the conversation" and recomputes it
 *         every turn. The model read its own creations as pre-existing work and
 *         told a user it had destroyed their files.
 *
 * The unit suite now covers what can be pinned statically (see
 * sdk-block-type-coverage.test.ts, rate-limit-store-units.test.ts,
 * lineage-thinking-blocks.test.ts). This script covers what cannot: whether the
 * SDK still behaves the way those tests assume.
 *
 * Requires: Claude Max auth (`claude login`). Costs real tokens. Run before
 * releases touching session lineage, rate-limit handling, or the system prompt,
 * and after any @anthropic-ai/claude-agent-sdk bump (see E2E.md):
 *
 *   bun scripts/e2e-sdk-boundary.mjs
 *
 * Checks:
 *   1. Rate-limit reset timestamps land in a sane future window — catches a
 *      missed conversion AND a double conversion, so it stays valid if the SDK
 *      ever switches units.
 *   2. Every content-block type real traffic produces is classified for
 *      hashing — the live counterpart to the static registry.
 *   3. A conversation resumes after the client stops echoing thinking blocks.
 *   4. Reports whether the gitStatus block still refreshes mid-conversation, so
 *      we learn when upstream fixes it and the corrective note can go.
 */
import { startProxyServer } from "../src/proxy/server.ts"
import {
  HASH_HANDLED_BLOCK_TYPES,
  HASH_IGNORED_BLOCK_TYPES,
  HASH_SERIALIZED_BLOCK_TYPES,
} from "../src/proxy/messages.ts"

const PORT = Number(process.env.SDK_BOUNDARY_PORT ?? 3498)
const MODEL = process.env.SDK_BOUNDARY_MODEL ?? "claude-haiku-4-5-20251001"

// Capture the proxy's own log lines: `lineage=` is the only place the resume
// decision is observable, and there is no endpoint that exposes it. plog writes
// to console.error, so the server must NOT run silent.
const proxyLog = []
const realError = console.error.bind(console)
// plog writes via console.error and is gated by `silent`, so the server runs
// non-silent and its output is diverted here instead of to the terminal.
console.error = (...args) => { proxyLog.push(args.map(String).join(" ")) }
const inst = await startProxyServer({ port: PORT, host: "127.0.0.1" })
const BASE = `http://127.0.0.1:${PORT}`

/** Index into proxyLog, so a check only reads lines its own requests produced. */
const mark = () => proxyLog.length

/** Lineage verdicts logged since `from`, oldest first. */
function lineageSince(from) {
  return proxyLog.slice(from)
    .map(l => l.match(/lineage=([a-z-]+)/)?.[1])
    .filter(Boolean)
}

let failures = 0
// Reports go to the real stderr/stdout — console.error is the proxy's now.
const fail = (check, msg) => { failures++; realError(`  ✗ ${check}: ${msg}`) }
const pass = (check, msg) => console.log(`  ✓ ${check}: ${msg}`)
const note = (msg) => console.log(`  · ${msg}`)

async function post(sid, messages, maxTokens = 64) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session": sid },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages }),
  })
  return { status: r.status, body: await r.json() }
}

// ---------------------------------------------------------------------------
// 1. Rate-limit reset units (#708)
// ---------------------------------------------------------------------------
console.log("\n1. rate-limit reset units")
{
  await post("sdk-boundary-quota", [{ role: "user", content: "say ok" }])
  const r = await fetch(`${BASE}/v1/usage/quota`)
  const quota = await r.json()
  const withReset = (quota.buckets ?? []).filter(b => b.resetsAt != null)

  if (withReset.length === 0) {
    // Not a pass. A silent "no data" is how a units bug hides.
    fail("units", "no bucket carried a resetsAt — cannot verify units (is the SDK still emitting rate_limit_event?)")
  } else {
    const now = Date.now()
    const EIGHT_DAYS = 8 * 24 * 60 * 60_000
    for (const b of withReset) {
      // Bounded both ways on purpose: a missed *1000 lands in 1970, a double
      // *1000 lands in the year 58000. Either fails.
      if (b.resetsAt < now - 60_000) {
        fail("units", `${b.type}.resetsAt=${b.resetsAt} is in the past (${new Date(b.resetsAt).toISOString()}) — seconds treated as ms?`)
      } else if (b.resetsAt > now + EIGHT_DAYS) {
        fail("units", `${b.type}.resetsAt=${b.resetsAt} is beyond any window (${new Date(b.resetsAt).toISOString()}) — double conversion?`)
      } else {
        pass("units", `${b.type} resets ${new Date(b.resetsAt).toISOString()}`)
      }
      if (b.overageResetsAt != null && b.overageResetsAt < now - 60_000) {
        fail("units", `${b.type}.overageResetsAt=${b.overageResetsAt} is in the past — unconverted?`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Content-block types real traffic produces (#710)
// ---------------------------------------------------------------------------
console.log("\n2. content-block classification")
{
  const seen = new Set()
  const collect = (content) => {
    if (Array.isArray(content)) for (const b of content) if (b?.type) seen.add(b.type)
  }

  // A plain turn, then one likely to reason and call a tool — between them they
  // exercise the block shapes ordinary Meridian traffic carries.
  const a = await post("sdk-boundary-blocks", [{ role: "user", content: "say ok" }])
  collect(a.body?.content)
  const b = await post("sdk-boundary-blocks-2", [{
    role: "user",
    content: "Think briefly, then answer: what is 17 * 23?",
  }], 400)
  collect(b.body?.content)

  if (seen.size === 0) {
    fail("blocks", "no content blocks observed — the probe learned nothing")
  } else {
    const unclassified = [...seen].filter(t =>
      !HASH_HANDLED_BLOCK_TYPES.has(t) &&
      !HASH_IGNORED_BLOCK_TYPES.has(t) &&
      !HASH_SERIALIZED_BLOCK_TYPES.has(t))
    if (unclassified.length > 0) {
      fail("blocks", `unclassified in live traffic: ${unclassified.join(", ")} — classify in messages.ts`)
    } else {
      pass("blocks", `all classified: ${[...seen].sort().join(", ")}`)
    }
    // Not a failure — just the fact worth recording. When it flips, the
    // thinking-block hashing guard starts earning its keep on this path too.
    note(seen.has("thinking")
      ? "thinking blocks ARE present in responses"
      : "no thinking blocks in this run (model/effort dependent) — check 3 covers the hash path regardless")
  }
}

// ---------------------------------------------------------------------------
// 3. Resume survives a client dropping thinking blocks (#710)
// ---------------------------------------------------------------------------
console.log("\n3. resume across dropped thinking blocks")
{
  const sid = `sdk-boundary-lineage-${Date.now()}`
  const from = mark()
  const SIG = "ErkCCosBCBAYAipArnuwVmIJYId3EvWd4ITxDyTxhyG1oXG7l8E3OBpQo6JfDB"

  await post(sid, [{ role: "user", content: "say ok" }])
  await post(sid, [
    { role: "user", content: "say ok" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "user wants ok", signature: SIG },
      { type: "text", text: "ok" },
    ] },
    { role: "user", content: "say two" },
  ])
  // The failure mode: the client stops echoing thinking once its tool loop ends.
  const third = await post(sid, [
    { role: "user", content: "say ok" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "say two" },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
    { role: "user", content: "say three" },
  ])

  const verdicts = lineageSince(from)
  const last = verdicts[verdicts.length - 1]

  if (third.status !== 200) {
    fail("lineage", `third turn returned ${third.status}`)
  } else if (verdicts.length < 3) {
    // Do not pass on missing evidence: if the log capture broke, this check
    // proves nothing and must say so.
    fail("lineage", `expected 3 lineage verdicts, captured ${verdicts.length} (${verdicts.join(",")}) — log capture broken?`)
  } else if (last !== "continuation") {
    // `new` here means diverged: server.ts renders a diverged result with no
    // cached session as "new". That is the #710 regression.
    fail("lineage", `third turn was lineage=${last}, expected continuation — dropped thinking blocks churned the hash (#710)`)
  } else {
    pass("lineage", `verdicts ${verdicts.join(" -> ")} — resume survived the dropped thinking block`)
  }
}

// ---------------------------------------------------------------------------
// 4. Does the gitStatus block still refresh mid-conversation? (#694)
// ---------------------------------------------------------------------------
console.log("\n4. gitStatus provenance (informational)")
{
  // Meridian appends a note telling the model the block is per-turn. This check
  // reports whether that note is still NEEDED: if the SDK ever stops
  // recomputing the block, or starts labelling it honestly, the note can go.
  // Asking the model is the only way to read the rendered system prompt, so
  // this is reported rather than asserted — a model that declines to answer
  // must not fail a release.
  const sid = `sdk-boundary-gitstatus-${Date.now()}`
  const r = await post(sid, [{
    role: "user",
    content: "Do not use tools. Answer in one line: does your system prompt contain a gitStatus block, and does it claim to be from the start of the conversation? yes/no for each.",
  }], 200)
  const text = (r.body?.content ?? []).filter(b => b.type === "text").map(b => b.text).join(" ")
  if (!text) {
    note("model returned no text — cannot report on gitStatus this run")
  } else {
    note(`model reports: ${text.replace(/\s+/g, " ").slice(0, 220)}`)
    note("if it reports NO gitStatus block, or an honestly-labelled one, revisit GIT_STATUS_PROVENANCE_NOTE in query.ts (#694)")
  }
}

await inst.close()
console.error = realError

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — SDK boundary`)
process.exit(failures === 0 ? 0 : 1)
