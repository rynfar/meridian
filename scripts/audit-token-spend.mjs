#!/usr/bin/env node
/**
 * Where did the tokens actually go?
 *
 * Reads the Claude Code subprocess transcripts Meridian's SDK sessions leave
 * behind and reports spend by cause. This is GROUND TRUTH: every assistant
 * message in a transcript carries the `usage` of the upstream API call that
 * produced it, so the totals here are what the account was billed — not what
 * Meridian's telemetry attributed per HTTP request, and not what a client's
 * cost display shows.
 *
 * Written for one question that telemetry cannot answer: when a user reports
 * "Meridian costs more", is it cold starts, discarded turns, or nothing at all?
 * Point it at their config dir and the answer is one command.
 *
 *   node scripts/audit-token-spend.mjs [configDir ...]
 *
 * With no arguments it scans ~/.claude plus every profile dir in
 * ~/.config/meridian/profiles. Pass explicit dirs to scope it (a profile, or a
 * single project's transcripts).
 *
 * The four causes it separates, and why each is worth a line of its own:
 *
 *   cold starts     The FIRST API call of an SDK session pays a full cache
 *                   write at 1.25x. Unavoidable once per session — so a high
 *                   share here means too many sessions, i.e. resume is failing.
 *   digest turns    Passthrough only. After Meridian's PreToolUse deny, the CLI
 *                   calls the model again so it can react to the deny. Meridian
 *                   forks past that turn at `resumeSessionAt`, so its output is
 *                   discarded — and billed.
 *   nudge turns     Passthrough only. A digest turn that produced no text trips
 *                   the CLI's thinking-only nudge ("[Your previous response had
 *                   no visible output…]"), costing one more full-prefix call.
 *   uncached        Calls that read and wrote no cache at all. Expected below
 *                   Anthropic's minimum cacheable prefix; a surprise above it.
 *
 * Costs are reported in INPUT-EQUIVALENT tokens — uncached input at 1x, cache
 * read at 0.1x, cache write at 1.25x, output at 5x — so one number ranks causes
 * across models without hardcoding prices. Multiply by a model's input rate for
 * dollars.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const DENY_MARK = "forwarded to the client for execution"
const NUDGE_MARK = "no visible output"

/** Anthropic's price ratios relative to uncached input. */
const W = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }
const equiv = (u) =>
  (u.input ?? 0) * W.input + (u.cr ?? 0) * W.cacheRead + (u.cw ?? 0) * W.cacheWrite + (u.out ?? 0) * W.output

function defaultRoots() {
  const roots = [join(homedir(), ".claude", "projects")]
  const profiles = join(homedir(), ".config", "meridian", "profiles")
  try {
    for (const p of readdirSync(profiles)) roots.push(join(profiles, p, "projects"))
  } catch { /* no profiles configured */ }
  return roots
}

function* transcripts(roots) {
  for (const root of roots) {
    // Accept either a `projects` root or a single project dir.
    const dirs = []
    try {
      if (!statSync(root).isDirectory()) continue
      const entries = readdirSync(root)
      if (entries.some((e) => e.endsWith(".jsonl"))) dirs.push(root)
      for (const e of entries) {
        const d = join(root, e)
        try { if (statSync(d).isDirectory()) dirs.push(d) } catch { /* unreadable */ }
      }
    } catch { continue }
    for (const d of dirs) {
      let files = []
      try { files = readdirSync(d).filter((f) => f.endsWith(".jsonl")) } catch { continue }
      for (const f of files) {
        try { yield readFileSync(join(d, f), "utf8") } catch { /* unreadable */ }
      }
    }
  }
}

const zero = () => ({ calls: 0, input: 0, cr: 0, cw: 0, out: 0 })
const add = (a, u) => { a.calls++; a.input += u.input; a.cr += u.cr; a.cw += u.cw; a.out += u.out }

const all = zero()
const cold = zero()
const digest = zero()
const nudge = zero()
const uncached = zero()
let sessions = 0, passthroughSessions = 0

for (const raw of transcripts(process.argv.slice(2).length ? process.argv.slice(2) : defaultRoots())) {
  const isPassthrough = raw.includes(DENY_MARK)
  let sawCall = false
  // One API call writes several JSONL rows (one per content block); requestId
  // is what identifies the call. Counting rows would multiply usage by 2-3x.
  const seen = new Set()
  let pending = null
  for (const line of raw.split("\n")) {
    if (!line) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === "user") {
      const c = o.message?.content
      if (typeof c === "string" && c.includes(NUDGE_MARK)) { pending = "nudge"; continue }
      if (Array.isArray(c) && c.some((b) => b?.type === "tool_result" && typeof b.content === "string" && b.content.includes(DENY_MARK))) {
        pending = "digest"; continue
      }
      pending = null
      continue
    }
    if (o.type !== "assistant" || !o.message?.usage) continue
    if (o.requestId) {
      if (seen.has(o.requestId)) continue
      seen.add(o.requestId)
    }
    const raw_u = o.message.usage
    const u = {
      input: raw_u.input_tokens ?? 0,
      cr: raw_u.cache_read_input_tokens ?? 0,
      cw: raw_u.cache_creation_input_tokens ?? 0,
      out: raw_u.output_tokens ?? 0,
    }
    add(all, u)
    if (!sawCall) { add(cold, u); sawCall = true }
    else if (pending === "digest") add(digest, u)
    else if (pending === "nudge") add(nudge, u)
    if (u.cr === 0 && u.cw === 0) add(uncached, u)
    pending = null
  }
  if (sawCall) { sessions++; if (isPassthrough) passthroughSessions++ }
}

if (all.calls === 0) {
  console.log("No transcripts found. Pass a config dir explicitly, e.g.:")
  console.log("  node scripts/audit-token-spend.mjs ~/.config/meridian/profiles/personal/projects")
  process.exit(0)
}

const total = equiv(all)
const pct = (n) => (100 * n / total).toFixed(1).padStart(5) + "%"
const num = (n) => n.toLocaleString().padStart(14)
const row = (label, a) =>
  console.log(`${label.padEnd(16)}${String(a.calls).padStart(7)}${num(Math.round(equiv(a)))}   ${pct(equiv(a))}`)

console.log(`sessions: ${sessions} (${passthroughSessions} passthrough)   api calls: ${all.calls}`)
console.log()
console.log(`raw totals   uncached input ${all.input.toLocaleString()}  cache read ${all.cr.toLocaleString()}  cache write ${all.cw.toLocaleString()}  output ${all.out.toLocaleString()}`)
console.log()
console.log("cause             calls  input-equiv    share")
console.log("-".repeat(52))
row("ALL SPEND", all)
row("cold starts", cold)
row("digest turns", digest)
row("nudge turns", nudge)
row("uncached calls", uncached)
console.log("-".repeat(52))
const wasted = equiv(digest) + equiv(nudge)
console.log(`discarded passthrough turns: ${Math.round(wasted).toLocaleString()} input-equiv (${(100 * wasted / total).toFixed(1)}%)`)
console.log(`cold-start share of cache writes: ${all.cw ? (100 * cold.cw / all.cw).toFixed(1) : "0.0"}%`)
console.log()
console.log("A high cold-start share means resume is failing — check /telemetry for")
console.log("lineage=new on a client that should be continuing a conversation.")
