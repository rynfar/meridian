#!/usr/bin/env bun
/**
 * E79: a client stops a streaming turn mid-generation, then sends its next turn.
 *
 * Meridian keeps the stopped turn's session behind the interrupted-turn check
 * (session spec, *Interrupted turns*). A client that discarded the partial
 * output must resume that session; one that kept it must replay, carrying the
 * partial. This drives both shapes against the BUILT server (`dist/cli.js`)
 * under Node in its own process, so the client's disconnect is a real socket
 * close. An in-process Bun client cannot exercise this: its aborted fetch
 * never reaches the server, the stopped turn completes and publishes, and the
 * next turn resumes output the client never received, on any build.
 *
 *   npm run build
 *   bun scripts/e2e-client-abort-resume.mjs --fixture
 *   E2E_ALLOW_LIVE_MODEL=1 bun scripts/e2e-client-abort-resume.mjs --live [--model=claude-sonnet-5-5]
 *
 * `--fixture` is model-free: an `api` profile points the real Claude Code
 * child at a scripted upstream in this process, under an isolated HOME, and
 * the checks include what that upstream received for the next turn. `--live`
 * uses the default Claude login read-only (`MERIDIAN_CREDENTIALS_READONLY=1`)
 * and adds a prompt-cache check for the resume. `--case=discard|keep` runs one
 * shape. Ports: E2E_PORT (default 3565), E2E_UPSTREAM_PORT (default 3566).
 * E2E_MERIDIAN_ROOT serves another built checkout (a before/after control),
 * E2E_SERVER_ENV adds server variables as JSON, and E2E_NODE names the Node
 * binary.
 * Writes `summary.json` (no prompts, tokens or account data) to
 * E2E_ARTIFACT_DIR or a fresh temporary directory; raw server logs stay there.
 *
 * Assertions, never model wording:
 *   discard: `lineage=continuation` resuming the turn-1 session, isResume, no
 *            partial in the published SDK history (getSessionMessages);
 *            fixture: the upstream's next-turn input holds turn 1 and the new
 *            question but not the partial; live: cache read >= 90% of turn 1's
 *            cached prefix.
 *   keep:    `diverged=interrupted-turn-kept`, no resume, the partial in the
 *            replayed history; fixture: in the upstream's next-turn input too.
 *   both:    the stop came before message_stop, every tool_use is paired, and
 *            (live) no usage refusal.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"
import { readSessionStoreSnapshot, setSessionStoreDir } from "../src/proxy/sessionStore.ts"
import { observeChildClosure, stopAndJoinChild } from "./lib/e2eProcessCustody.mjs"

const args = process.argv.slice(2)
const fixture = args.includes("--fixture")
const live = args.includes("--live")
if (fixture === live) throw new Error("Select --fixture (model-free) or --live explicitly")
if (live && process.env.E2E_ALLOW_LIVE_MODEL !== "1") throw new Error("Live generation requires E2E_ALLOW_LIVE_MODEL=1")
const argValue = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const MODEL = argValue("model") ?? process.env.E2E_MODEL ?? "claude-sonnet-5-5"
const CASES = (argValue("case") ?? "discard,keep").split(",")
for (const c of CASES) if (!["discard", "keep"].includes(c)) throw new Error(`unknown case ${c}`)
const PORT = Number(process.env.E2E_PORT ?? 3565)
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3566)
// E2E_MERIDIAN_ROOT runs another built tree's server (a before/after control).
const ROOT = resolve(process.env.E2E_MERIDIAN_ROOT ?? join(import.meta.dir, ".."))
const CLI = join(ROOT, "dist/cli.js")
if (!existsSync(CLI)) throw new Error("Build first: dist/cli.js is missing")
const NODE = process.env.E2E_NODE ?? "node"
const ARTIFACTS = realpathSync(process.env.E2E_ARTIFACT_DIR
  ? (mkdirSync(process.env.E2E_ARTIFACT_DIR, { recursive: true }), process.env.E2E_ARTIFACT_DIR)
  : mkdtempSync(join(tmpdir(), "meridian-e79-")))

const say = console.log.bind(console)
// A large first turn makes the conversation prefix dominate the prompt, so a
// replay (cache write) and a resume (cache read) are distinguishable.
const LEDGER = Array.from({ length: 600 }, (_, i) => `Ledger line ${i}: entry ${(i * 7919) % 10007} is reconciled.`).join("\n")
const U1 = { role: "user", content: `${LEDGER}\n\nAcknowledge the ledger above with the single word: noted.` }
const U2 = { role: "user", content: "Count from 1 to 400, one number per line, with no other text." }
const U3 = { role: "user", content: "Stop that. Reply with only the word: done." }
// Refusal markers only: a bare number such as 402 also occurs in timings.
const REFUSAL = /weekly limit|5-hour limit|usage limit|rate limit reached|extra usage|billing_error|"status":\s*402\b|\bHTTP 402\b|token (?:has been )?revoked|profile\.refused|isUsingOverage"?:\s*true/i

// --- Scripted upstream (fixture mode) ---
const upstreamRequests = []
let upstream
if (fixture) {
  const textOf = (content) => typeof content === "string" ? content
    : Array.isArray(content) ? content.map((b) => b?.type === "text" ? b.text ?? "" : b?.type === "tool_result" ? textOf(b.content) : "").join("\n") : ""
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method !== "POST" || path !== "/v1/messages") {
        return Response.json(path.endsWith("count_tokens") ? { input_tokens: 100 } : {})
      }
      const body = await request.json()
      const all = (body.messages ?? []).map((m) => textOf(m.content)).join("\n")
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")
      const slow = textOf(lastUser?.content).trimEnd().endsWith(U2.content)
      upstreamRequests.push({ slow, stream: body.stream === true, all })
      const usage = { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      const id = `msg_fixture_${upstreamRequests.length}`
      if (!body.stream) {
        return Response.json({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn", stop_sequence: null, usage })
      }
      const encoder = new TextEncoder()
      let cancelled = false
      return new Response(new ReadableStream({
        async start(controller) {
          const ev = (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`))
          ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } })
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
          const count = slow ? 400 : 1
          for (let n = 1; n <= count && !cancelled; n++) {
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: slow ? `${n}\n` : "ok" } })
            if (slow) await new Promise((r) => setTimeout(r, 25))
          }
          if (cancelled) return
          ev("content_block_stop", { index: 0 })
          ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })
          ev("message_stop", {})
          controller.close()
        },
        cancel() { cancelled = true },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
}

// --- One case: start an isolated server, run three turns, check, stop. ---
async function runCase(shape) {
  const dir = join(ARTIFACTS, shape)
  const workdir = join(dir, "workdir")
  const store = join(dir, "store")
  const config = join(dir, "config")
  const home = join(dir, "home")
  for (const p of [workdir, store, config, home]) mkdirSync(p, { recursive: true })
  setSessionStoreDir(store)
  const env = {
    PATH: process.env.PATH, USER: process.env.USER, LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HOME: fixture ? home : process.env.HOME,
    MERIDIAN_PORT: String(PORT), MERIDIAN_HOST: "127.0.0.1",
    MERIDIAN_CONFIG_DIR: config, MERIDIAN_SESSION_DIR: store, MERIDIAN_WORKDIR: workdir,
    MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_TELEMETRY_DB: join(dir, "telemetry.db"),
    MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_UPDATE_CHECK_PATH: join(dir, "update-check.json"),
    MERIDIAN_DESIGN_TOKEN_PATH: join(dir, "design-token.json"),
    MERIDIAN_CREDENTIALS_READONLY: "1", MERIDIAN_PASSTHROUGH: "1", OPENCODE_CLAUDE_PROVIDER_DEBUG: "1",
    // E2E_SERVER_ENV: extra server variables for a control build, as JSON.
    ...(process.env.E2E_SERVER_ENV ? JSON.parse(process.env.E2E_SERVER_ENV) : {}),
    ...(fixture ? {
      MERIDIAN_PROFILES: JSON.stringify([{ id: "fixture", type: "api", apiKey: "fixture-no-live-credential", baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}` }]),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    } : {}),
  }
  const log = []
  const child = spawn(NODE, [CLI], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] })
  const witness = observeChildClosure(child)
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf("\n")) >= 0) { log.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
  }
  const base = `http://127.0.0.1:${PORT}`
  try {
    const deadline = Date.now() + 60_000
    let health
    for (;;) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break } } catch {}
      if (Date.now() > deadline || witness.state.exitSeen) throw new Error(`server did not start: ${log.slice(-5).join(" | ")}`)
      await new Promise((r) => setTimeout(r, 500))
    }
    return { health: { version: health.version, claudeExecutable: health.claudeExecutable?.source }, ...await turns(shape, base, log, dir) }
  } finally {
    writeFileSync(join(dir, "server.log"), log.join("\n"))
    await stopAndJoinChild(child, witness)
  }
}

async function turns(shape, base, log, dir) {
  const key = `e79-${shape}-${process.pid}`
  const headers = { "Content-Type": "application/json", "x-api-key": "dummy",
    "x-meridian-agent": "pi", "x-session-affinity": key, "user-agent": "pi/1.4.0" }
  const body = (messages, stream) => JSON.stringify({ model: MODEL, max_tokens: 2048, stream, messages })
  const lastRow = async () => {
    const data = await (await fetch(`${base}/telemetry/requests?limit=50`)).json()
    const rows = Array.isArray(data) ? data : Object.values(data).find(Array.isArray) ?? []
    const row = rows.reduce((a, b) => (b.timestamp > (a?.timestamp ?? -1) ? b : a), undefined)
    return row && { status: row.status, isResume: row.isResume, lineage: row.lineageType,
      cacheRead: row.cacheReadInputTokens ?? 0, cacheCreate: row.cacheCreationInputTokens ?? 0, model: row.model }
  }
  const lineLine = (from) => log.slice(from).map((l) => l.match(/lineage=\S+ session=\S+(?: diverged=\S+)?/)?.[0]).find(Boolean) ?? ""
  const stored = () => Object.entries(readSessionStoreSnapshot()).find(([k]) => k === key || k.endsWith(`:${key}`))?.[1]

  // Turn 1: complete.
  let from = log.length
  const r1 = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: body([U1], false) })
  const j1 = await r1.json()
  if (r1.status !== 200) throw new Error(`turn 1 HTTP ${r1.status}: ${JSON.stringify(j1).slice(0, 200)}`)
  const A1 = { role: "assistant", content: j1.content }
  const turn1 = { ...await lastRow(), line: lineLine(from) }
  const source = stored()?.claudeSessionId
  upstreamRequests.length = 0

  // Turn 2: streamed, then stopped by the client after some text arrived.
  const abort = new AbortController()
  const r2 = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: body([U1, A1, U2], true), signal: abort.signal })
  if (r2.status !== 200) throw new Error(`turn 2 HTTP ${r2.status}`)
  const reader = r2.body.getReader()
  const decoder = new TextDecoder()
  let raw = "", partial = "", sawStop = false
  read: for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
    let i
    while ((i = raw.indexOf("\n\n")) >= 0) {
      const data = raw.slice(0, i).split("\n").find((l) => l.startsWith("data: "))?.slice(6)
      raw = raw.slice(i + 2)
      if (!data) continue
      let ev
      try { ev = JSON.parse(data) } catch { continue }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") partial += ev.delta.text
      if (ev.type === "message_stop") sawStop = true
      if (partial.length >= 40 || sawStop) break read
    }
  }
  abort.abort("user pressed stop")
  await reader.cancel().catch(() => {})
  const stoppedAt = Date.now()

  // Turn 3: sent at once, in the shape the client keeps.
  const history = shape === "discard"
    ? [U1, A1, U2, U3]
    : [U1, A1, U2, { role: "assistant", content: [{ type: "text", text: partial }] }, U3]
  from = log.length
  const upstreamFrom = upstreamRequests.length
  const r3 = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: body(history, false) })
  const j3 = await r3.json()
  const turn3 = { ...await lastRow(), httpStatus: r3.status, msAfterStop: Date.now() - stoppedAt, line: lineLine(from),
    ...(r3.status === 200 ? {} : { error: JSON.stringify(j3).slice(0, 200) }) }
  await new Promise((r) => setTimeout(r, 1000))

  const entry = stored()
  const previous = process.env.CLAUDE_CONFIG_DIR
  let history3 = []
  try {
    if (entry?.currentTranscript?.configDir) process.env.CLAUDE_CONFIG_DIR = entry.currentTranscript.configDir
    if (entry?.claudeSessionId) {
      history3 = await getSessionMessages(entry.claudeSessionId, { dir: entry.currentTranscript?.projectDir ?? join(dir, "workdir") })
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
  const blocks = (m) => { const c = m?.message?.content; return typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [] }
  const text = (m) => blocks(m).map((b) => b.type === "text" ? b.text : b.type === "tool_result"
    ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) : "").join("\n")
  const probe = partial.trim().slice(0, 24)
  const sdkText = history3.map(text).join("\n")
  const uses = history3.flatMap((m) => m.type === "assistant" ? blocks(m).filter((b) => b.type === "tool_use").map((b) => b.id) : [])
  const results = history3.flatMap((m) => m.type === "user" ? blocks(m).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : [])
  // The next turn's main request carries the whole conversation input.
  const nextUpstream = upstreamRequests.slice(upstreamFrom).filter((r) => !r.slow)
    .reduce((a, b) => (b.all.length > (a?.all.length ?? -1) ? b : a), undefined)
  const facts = {
    turn1, turn2: { partialChars: partial.length, stoppedBeforeMessageStop: !sawStop }, turn3,
    resumedTurn1Session: Boolean(source && turn3.line.includes(`session=${source.slice(0, 8)}`)),
    sdkHistory: { roles: history3.map((m) => m.type).join(","), holdsTurn1: sdkText.includes("Ledger line 599"),
      holdsNewQuestion: sdkText.includes("Reply with only the word"), holdsPartial: probe.length > 0 && sdkText.includes(probe),
      unpairedToolUses: uses.filter((id) => results.filter((r) => r === id).length !== 1).length },
    ...(fixture ? { upstreamNextTurn: nextUpstream && { holdsTurn1: nextUpstream.all.includes("Ledger line 599"),
      holdsNewQuestion: nextUpstream.all.includes("Reply with only the word"), holdsPartial: probe.length > 0 && nextUpstream.all.includes(probe) } } : {}),
    refusal: log.find((l) => REFUSAL.test(l))?.slice(0, 160),
  }
  const checks = []
  const check = (ok, label) => checks.push({ ok: Boolean(ok), label })
  check(facts.turn2.stoppedBeforeMessageStop && partial.length >= 40, "the client stopped turn 2 mid-stream")
  check(turn3.httpStatus === 200, "turn 3 answered")
  check(facts.sdkHistory.unpairedToolUses === 0, "every tool_use in the published history is paired")
  check(!facts.refusal, "no usage refusal")
  if (shape === "discard") {
    check(turn3.lineage === "continuation" && turn3.isResume === true, "turn 3 resumed (continuation, isResume)")
    check(facts.resumedTurn1Session, "turn 3 resumed the turn-1 session")
    check(facts.sdkHistory.holdsTurn1 && facts.sdkHistory.holdsNewQuestion && !facts.sdkHistory.holdsPartial,
      "the resumed history holds turn 1 and the new question, not the discarded partial")
    if (fixture) check(facts.upstreamNextTurn?.holdsTurn1 && facts.upstreamNextTurn.holdsNewQuestion && !facts.upstreamNextTurn.holdsPartial,
      "the upstream's next-turn input holds turn 1 and the new question, not the partial")
    if (live) {
      const prefix = (turn1.cacheRead ?? 0) + (turn1.cacheCreate ?? 0)
      check(prefix > 0 && turn3.cacheRead >= 0.9 * prefix, `the resume read >= 90% of turn 1's cached prefix (${turn3.cacheRead}/${prefix})`)
    }
  } else {
    check(turn3.isResume === false && turn3.line.includes("diverged=interrupted-turn-kept"), "turn 3 replayed (diverged=interrupted-turn-kept)")
    check(facts.sdkHistory.holdsTurn1 && facts.sdkHistory.holdsPartial, "the replayed history carries turn 1 and the kept partial")
    if (fixture) check(facts.upstreamNextTurn?.holdsPartial && facts.upstreamNextTurn.holdsTurn1, "the upstream's next-turn input carries the kept partial")
  }
  writeFileSync(join(dir, "facts.json"), JSON.stringify(facts, null, 2))
  return { facts, checks }
}

const summary = { mode: fixture ? "fixture" : "live", model: MODEL, node: NODE, cases: {} }
let failed = false
try {
  for (const shape of CASES) {
    say(`\n=== E79 ${summary.mode} ${shape} (model=${MODEL}) ===`)
    const result = await runCase(shape)
    summary.cases[shape] = result
    for (const c of result.checks) {
      say(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}`)
      if (!c.ok) failed = true
    }
    say(`  turn3: ${result.facts.turn3.line} isResume=${result.facts.turn3.isResume} cacheRead=${result.facts.turn3.cacheRead} cacheCreate=${result.facts.turn3.cacheCreate}`)
    if (result.facts.refusal) { say("  stopping: usage refusal"); break }
  }
} finally {
  upstream?.stop(true)
  writeFileSync(join(ARTIFACTS, "summary.json"), JSON.stringify(summary, null, 2))
  say(`\nsummary: ${join(ARTIFACTS, "summary.json")}`)
}
say(failed ? "FAIL" : "PASS: stopped turns resume when discarded and replay when kept")
process.exit(failed ? 1 : 0)
