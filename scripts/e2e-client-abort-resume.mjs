#!/usr/bin/env bun
/**
 * E79: a client stops a streaming turn mid-generation, then sends its next turn.
 *
 * Meridian keeps the stopped turn's session behind the interrupted-turn check
 * (session spec, *Interrupted turns*). A client that discarded the partial
 * output must resume that session; one that kept it must replay, carrying the
 * partial. The gate drives the BUILT server (`dist/cli.js`) under Node in its
 * own process, so the client's disconnect is a real socket close. An
 * in-process Bun client cannot exercise this: its aborted fetch never reaches
 * the server, the stopped turn completes and publishes, and the next turn
 * resumes output the client never received, on any build.
 *
 *   npm run build
 *   bun scripts/e2e-client-abort-resume.mjs --fixture
 *   E2E_PI_BIN=<pi> E2E_OPENCODE_BIN=<opencode> bun scripts/e2e-client-abort-resume.mjs --fixture --case=pi,opencode
 *   E2E_ALLOW_LIVE_MODEL=1 bun scripts/e2e-client-abort-resume.mjs --live [--model=claude-sonnet-5-5]
 *
 * Cases (`--case=` a comma list; the four HTTP cases by default, `all` adds
 * the real clients):
 *   discard, keep               direct HTTP client with Pi's headers
 *                               (concurrent turns allowed), next turn sent
 *                               after the stop;
 *   strict-discard, strict-keep direct HTTP client with Prime Agent's headers
 *                               (no concurrent turns), next turn sent while
 *                               the stopped turn still holds the session, so
 *                               it waits out the stop's cleanup and marking;
 *   pi                          real Pi 1.4.0 (E2E_PI_BIN) with the Meridian
 *                               extension from `meridian setup --client pi`,
 *                               stopped with its RPC `abort` (discards);
 *   opencode                    real OpenCode 2.2.0 (E2E_OPENCODE_BIN) with the
 *                               Meridian V2 plugin from `meridian setup --v2`,
 *                               stopped with `POST /api/session/:id/interrupt`
 *                               (keeps). E2E.md's plugin preflight applies: the
 *                               case asserts exactly one configured and active
 *                               Meridian plugin and records its headers.
 *
 * `--fixture` is model-free: an `api` profile points the real Claude Code
 * child at a scripted upstream in this process, under an isolated HOME, and
 * the checks include what that upstream received for the next turn; the real
 * clients run only in this mode. `--live` uses the default Claude login
 * read-only (`MERIDIAN_CREDENTIALS_READONLY=1`) and adds a prompt-cache check
 * for the resume. The default login lives in the real Claude config, so live
 * mode keeps the real HOME: its SDK child writes the run's transcripts under
 * that config's projects directory, for the isolated workdir. The script never
 * edits or deletes them.
 *
 * Ports: E2E_PORT (Meridian, 3565), E2E_UPSTREAM_PORT (3566), E2E_RELAY_PORT
 * (3567), E2E_CLIENT_PORT (OpenCode server, 3568). E2E_MERIDIAN_ROOT serves
 * another built checkout (a before/after control), E2E_SERVER_ENV adds server
 * variables as JSON, and E2E_NODE names the Node binary. Writes `summary.json`
 * (no prompts, tokens or account data; /health's build identity per case) to
 * E2E_ARTIFACT_DIR or a fresh temporary directory; raw logs stay there.
 *
 * Assertions, never model wording:
 *   discard, strict-discard, pi:
 *            `lineage=continuation` resuming the turn-1 session; the resumed
 *            history holds turn 1, the stopped question and the new one but
 *            not the partial (published SDK history via getSessionMessages for
 *            HTTP cases, the upstream's next-turn input in fixture mode); live:
 *            cache read >= 90% of turn 1's cached prefix.
 *   keep, strict-keep, opencode:
 *            `diverged=interrupted-turn-kept:kept-assistant`, no resume, the
 *            partial in the replayed history.
 *   strict:  the next turn waited for the session (sessionWait > 0) and was
 *            answered (no conflict refusal).
 *   pi:      `meridian setup --client pi` reported the version E2E_PI_BIN
 *            prints (its directory leads the PATH setup's `pi --version` reads).
 *   all:     the stop came before the turn finished, and (live) no usage
 *            refusal.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"
import { readSessionStoreSnapshot, setSessionStoreDir } from "../src/proxy/sessionStore.ts"
import { observeChildClosure, stopAndJoinChild } from "./lib/e2eProcessCustody.mjs"
import { scriptedUpstreamEnv, startMeridianServer, startRecordingRelay, startScriptedUpstream } from "./lib/stoppedTurnFixture.mjs"

const args = process.argv.slice(2)
const fixture = args.includes("--fixture")
const live = args.includes("--live")
if (fixture === live) throw new Error("Select --fixture (model-free) or --live explicitly")
if (live && process.env.E2E_ALLOW_LIVE_MODEL !== "1") throw new Error("Live generation requires E2E_ALLOW_LIVE_MODEL=1")
const argValue = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const MODEL = argValue("model") ?? process.env.E2E_MODEL ?? "claude-sonnet-5-5"
const HTTP_CASES = ["discard", "keep", "strict-discard", "strict-keep"]
const CLIENT_CASES = ["pi", "opencode"]
const requested = argValue("case") ?? HTTP_CASES.join(",")
const CASES = requested === "all" ? [...HTTP_CASES, ...CLIENT_CASES] : requested.split(",")
for (const c of CASES) if (![...HTTP_CASES, ...CLIENT_CASES].includes(c)) throw new Error(`unknown case ${c}`)
if (live && CASES.some((c) => CLIENT_CASES.includes(c))) throw new Error("The real-client cases run in --fixture mode only")
const PORT = Number(process.env.E2E_PORT ?? 3565)
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3566)
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 3567)
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 3568)
const ROOT = resolve(process.env.E2E_MERIDIAN_ROOT ?? join(import.meta.dir, ".."))
if (!existsSync(join(ROOT, "dist/cli.js"))) throw new Error("Build first: dist/cli.js is missing")
const NODE = process.env.E2E_NODE ?? "node"
const SERVER_ENV = process.env.E2E_SERVER_ENV ? JSON.parse(process.env.E2E_SERVER_ENV) : {}
const ARTIFACTS = realpathSync(process.env.E2E_ARTIFACT_DIR
  ? (mkdirSync(process.env.E2E_ARTIFACT_DIR, { recursive: true }), process.env.E2E_ARTIFACT_DIR)
  : mkdtempSync(join(tmpdir(), "meridian-e79-")))

const say = console.log.bind(console)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A large first turn makes the conversation prefix dominate the prompt, so a
// replay (cache write) and a resume (cache read) are distinguishable.
const LEDGER = Array.from({ length: 600 }, (_, i) => `Ledger line ${i}: entry ${(i * 7919) % 10007} is reconciled.`).join("\n")
const U1 = `${LEDGER}\n\nAcknowledge the ledger above with the single word: noted. Do not call any tools.`
const U2 = "Count from 1 to 400, one number per line, with no other text. Do not call any tools."
const U3 = "Stop that. Reply with only the word: done. Do not call any tools."
// Refusal markers only: a bare number such as 402 also occurs in timings.
const REFUSAL = /weekly limit|5-hour limit|usage limit|rate limit reached|extra usage|billing_error|"status":\s*402\b|\bHTTP 402\b|token (?:has been )?revoked|profile\.refused|isUsingOverage"?:\s*true/i
// The scripted upstream streams the stopped question slowly, everything else at once.
const upstream = fixture ? startScriptedUpstream({ port: UPSTREAM_PORT, slowWhen: (text) => text.includes(U2) && !text.includes(U3) }) : undefined
const looksPartial = (text, partial) => partial.length > 0 && text.includes(partial)
const lineOf = (lines) => lines.map((l) => l.match(/lineage=\S+ session=\S+(?: rollback=\S+)?(?: diverged=\S+)?(?: replay=\S+)?/)?.[0]).find(Boolean) ?? ""
const sessionWaitOf = (lines) => Number(lines.map((l) => l.match(/lineage=\S+ session=.* sessionWait=(\d+)ms/)?.[1]).find(Boolean) ?? -1)
const upstreamFacts = (from, partial) => {
  if (!upstream) return undefined
  // The next turn's main request carries the whole conversation input.
  const next = upstream.requests.slice(from).filter((r) => !r.slow).reduce((a, b) => (b.all.length > (a?.all.length ?? -1) ? b : a), undefined)
  return next && { holdsTurn1: next.all.includes("Ledger line 599"), holdsStoppedQuestion: next.all.includes(U2),
    holdsNewQuestion: next.all.includes(U3), holdsPartial: looksPartial(next.all, partial) }
}

async function startServer(dir) {
  const home = join(dir, "home")
  mkdirSync(home, { recursive: true })
  return startMeridianServer({ root: ROOT, node: NODE, port: PORT, dir, env: {
    MERIDIAN_PASSTHROUGH: "1",
    ...(fixture ? scriptedUpstreamEnv({ upstreamPort: UPSTREAM_PORT, home }) : {}),
    ...SERVER_ENV,
  } })
}

// --- Direct HTTP client cases ---
async function httpCase(shape, dir) {
  const server = await startServer(dir)
  setSessionStoreDir(server.paths.store)
  try {
    return { health: server.health, ...await httpTurns(shape, server) }
  } finally {
    await server.stop()
  }
}

async function httpTurns(shape, { base, log, paths }) {
  const key = `e79-${shape}-${process.pid}`
  const strict = shape.startsWith("strict-")
  const kept = shape.endsWith("keep")
  // Pi runs concurrent turns under one key by protocol; Prime Agent does not,
  // so a request that lost a commit race while waiting is refused for it.
  const headers = strict
    ? { "Content-Type": "application/json", "x-api-key": "dummy", "x-meridian-agent": "prime", "x-session-affinity": key }
    : { "Content-Type": "application/json", "x-api-key": "dummy",
      "x-meridian-agent": "pi", "x-session-affinity": key, "user-agent": "pi/1.4.0" }
  const body = (messages, stream) => JSON.stringify({ model: MODEL, max_tokens: 2048, stream, messages })
  const lastRow = async () => {
    const data = await (await fetch(`${base}/telemetry/requests?limit=50`)).json()
    const rows = Array.isArray(data) ? data : Object.values(data).find(Array.isArray) ?? []
    const row = rows.reduce((a, b) => (b.timestamp > (a?.timestamp ?? -1) ? b : a), undefined)
    return row && { status: row.status, isResume: row.isResume, lineage: row.lineageType,
      cacheRead: row.cacheReadInputTokens ?? 0, cacheCreate: row.cacheCreationInputTokens ?? 0, model: row.model }
  }
  const stored = () => Object.entries(readSessionStoreSnapshot()).find(([k]) => k === key || k.endsWith(`:${key}`))?.[1]

  // Turn 1: complete.
  let from = log.length
  const r1 = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: body([{ role: "user", content: U1 }], false) })
  const j1 = await r1.json()
  if (r1.status !== 200) throw new Error(`turn 1 HTTP ${r1.status}: ${JSON.stringify(j1).slice(0, 200)}`)
  const A1 = { role: "assistant", content: j1.content }
  const turn1 = { ...await lastRow(), line: lineOf(log.slice(from)) }
  const source = stored()?.claudeSessionId

  // Turn 2: streamed, then stopped by the client after some text arrived.
  const abort = new AbortController()
  const turn2Messages = [{ role: "user", content: U1 }, A1, { role: "user", content: U2 }]
  const r2 = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: body(turn2Messages, true), signal: abort.signal })
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
  // Turn 3, in the shape the client keeps. A strict client's arrives while
  // turn 2 still holds the session, so it waits out the stop's cleanup.
  const history = kept
    ? [...turn2Messages, { role: "assistant", content: [{ type: "text", text: partial }] }, { role: "user", content: U3 }]
    : [...turn2Messages, { role: "user", content: U3 }]
  from = log.length
  const upstreamFrom = upstream?.requests.length ?? 0
  const send3 = () => fetch(`${base}/v1/messages`, { method: "POST", headers, body: body(history, false) })
  let pending3
  if (strict) {
    pending3 = send3()
    await sleep(500)
  }
  abort.abort("user pressed stop")
  await reader.cancel().then(() => undefined, () => undefined)
  const stoppedAt = Date.now()
  const r3 = await (pending3 ?? send3())
  const j3 = await r3.json()
  const turn3 = { ...await lastRow(), httpStatus: r3.status, msAfterStop: Date.now() - stoppedAt, line: lineOf(log.slice(from)),
    sessionWaitMs: sessionWaitOf(log.slice(from)), ...(r3.status === 200 ? {} : { error: JSON.stringify(j3).slice(0, 200) }) }
  await sleep(1000)

  const entry = stored()
  const previous = process.env.CLAUDE_CONFIG_DIR
  let history3 = []
  try {
    if (entry?.currentTranscript?.configDir) process.env.CLAUDE_CONFIG_DIR = entry.currentTranscript.configDir
    if (entry?.claudeSessionId) {
      history3 = await getSessionMessages(entry.claudeSessionId, { dir: entry.currentTranscript?.projectDir ?? paths.workdir })
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
  const facts = {
    turn1, turn2: { partialChars: partial.length, stoppedBeforeMessageStop: !sawStop }, turn3,
    resumedTurn1Session: Boolean(source && turn3.line.includes(`session=${source.slice(0, 8)}`)),
    sdkHistory: { roles: history3.map((m) => m.type).join(","), holdsTurn1: sdkText.includes("Ledger line 599"),
      holdsStoppedQuestion: sdkText.includes(U2), holdsNewQuestion: sdkText.includes(U3),
      holdsPartial: looksPartial(sdkText, probe), unpairedToolUses: uses.filter((id) => results.filter((r) => r === id).length !== 1).length },
    upstreamNextTurn: upstreamFacts(upstreamFrom, probe),
    refusal: log.find((l) => REFUSAL.test(l))?.slice(0, 160),
  }
  const checks = []
  const check = (ok, label) => checks.push({ ok: Boolean(ok), label })
  check(facts.turn2.stoppedBeforeMessageStop && partial.length >= 40, "the client stopped turn 2 mid-stream")
  check(turn3.httpStatus === 200, "turn 3 answered")
  check(facts.sdkHistory.unpairedToolUses === 0, "every tool_use in the published history is paired")
  check(!facts.refusal, "no usage refusal")
  if (strict) check(turn3.sessionWaitMs > 0, `turn 3 waited for the stopped turn's session (${turn3.sessionWaitMs}ms)`)
  if (!kept) {
    check(turn3.lineage === "continuation" && turn3.isResume === true, "turn 3 resumed (continuation, isResume)")
    check(facts.resumedTurn1Session, "turn 3 resumed the turn-1 session")
    check(facts.sdkHistory.holdsTurn1 && facts.sdkHistory.holdsStoppedQuestion && facts.sdkHistory.holdsNewQuestion
      && !facts.sdkHistory.holdsPartial,
      "the resumed history holds turn 1, the stopped question and the new one, not the discarded partial")
    if (fixture) check(facts.upstreamNextTurn?.holdsTurn1 && facts.upstreamNextTurn.holdsStoppedQuestion
      && facts.upstreamNextTurn.holdsNewQuestion && !facts.upstreamNextTurn.holdsPartial,
      "the upstream's next-turn input holds turn 1, the stopped question and the new one, not the partial")
    if (live) {
      const prefix = (turn1.cacheRead ?? 0) + (turn1.cacheCreate ?? 0)
      check(prefix > 0 && turn3.cacheRead >= 0.9 * prefix, `the resume read >= 90% of turn 1's cached prefix (${turn3.cacheRead}/${prefix})`)
    }
  } else {
    check(turn3.isResume === false && turn3.line.includes("diverged=interrupted-turn-kept:kept-assistant"),
      "turn 3 replayed (diverged=interrupted-turn-kept:kept-assistant)")
    check(facts.sdkHistory.holdsTurn1 && facts.sdkHistory.holdsPartial, "the replayed history carries turn 1 and the kept partial")
    if (fixture) check(facts.upstreamNextTurn?.holdsPartial && facts.upstreamNextTurn.holdsTurn1, "the upstream's next-turn input carries the kept partial")
  }
  return { facts, checks }
}

// --- Real-client cases (fixture only) ---
const lines = (stream, sink) => {
  let buffer = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf("\n")) >= 0) { sink(buffer.slice(0, index).replace(/\r$/, "")); buffer = buffer.slice(index + 1) }
  })
}
const clientEnvBase = (dir) => ({ PATH: process.env.PATH, USER: process.env.USER, LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR,
  HOME: join(dir, "home"), MERIDIAN_CONFIG_DIR: join(dir, "meridian-config") })
const requestLine = (log) => (log.map((l) => l.match(/adapter=\S+ .*?lineage=\S+ session=\S+(?: rollback=\S+)?(?: diverged=\S+)?(?: replay=\S+)?/)?.[0]).filter(Boolean))
const resolvedResume = (log) => log.map((l) => l.match(/"event":"session\.interrupted_turn_resolved".*?"resume":(true|false)/)?.[1]).filter(Boolean).at(-1)

/** Drive one real client through turn 1, a stopped turn 2 and turn 3. */
async function clientCase(client, dir) {
  const bin = client === "pi" ? process.env.E2E_PI_BIN : process.env.E2E_OPENCODE_BIN
  if (!bin) throw new Error(`Set ${client === "pi" ? "E2E_PI_BIN" : "E2E_OPENCODE_BIN"} for the ${client} case`)
  const server = await startServer(join(dir, "meridian"))
  const relay = startRecordingRelay({ port: RELAY_PORT, target: server.base })
  const clientDir = join(dir, "client")
  for (const d of ["home", "meridian-config", "project"]) mkdirSync(join(clientDir, d), { recursive: true })
  const run = client === "pi" ? runPi : runOpenCode
  let driven
  try {
    driven = await run(bin, clientDir, `http://127.0.0.1:${RELAY_PORT}`, server, relay)
  } finally {
    writeFileSync(join(dir, "relay.json"), JSON.stringify(relay.relayed, null, 2))
    relay.stop()
    await server.stop()
  }
  const { facts: clientFacts, marks } = driven
  const turn2Lines = requestLine(server.log.slice(marks.turn2Log, marks.turn3Log))
  const turn3Lines = requestLine(server.log.slice(marks.turn3Log))
  const main3 = relay.relayed.slice(marks.turn3Relay).filter((r) => r.shape).sort((a, b) => b.shape.length - a.shape.length)[0]
  const shape = main3?.shape ?? []
  const lastStopped = shape.findLastIndex((role, i) => role.startsWith("user") && i < shape.length - 1 && shape.slice(i + 1).some((r) => r.startsWith("user")))
  const facts = {
    ...clientFacts,
    health: server.health,
    turn2Line: turn2Lines.at(-1), turn3Line: turn3Lines.at(-1), resolvedResume: resolvedResume(server.log),
    turn3RequestShape: shape, turn3Headers: main3?.headers,
    assistantAfterStoppedQuestion: lastStopped >= 0 && shape.slice(lastStopped + 1).some((r) => r.startsWith("assistant")),
    upstreamNextTurn: upstreamFacts(marks.turn3Upstream, "1\n2\n3\n"),
  }
  const checks = []
  const check = (ok, label) => checks.push({ ok: Boolean(ok), label })
  check(clientFacts.stopped, `the client stopped turn 2 (${client === "pi" ? "RPC abort, agent_settled aborted" : "interrupt returned interrupted"})`)
  // Pi's extension shows itself in the headers its provider adds; OpenCode's
  // plugin is witnessed by OpenCode's own plugin listing.
  const loaded = client === "pi"
    ? clientFacts.integrationLoaded && facts.turn3Headers?.["x-meridian-agent"] === "pi" && Boolean(facts.turn3Headers?.["x-session-affinity"])
    : clientFacts.integrationLoaded
  check(loaded, `the Meridian ${client === "pi" ? "extension is installed and keys the requests" : "V2 plugin is configured once and active"}`)
  if (client === "pi") {
    const resumed = facts.turn2Line?.match(/session=(\S+)/)?.[1]
    check(Boolean(clientFacts.piVersion) && clientFacts.setupPiVersion === clientFacts.piVersion,
      `setup's version gate checked the Pi under test (${clientFacts.setupPiVersion ?? "none"})`)
    check(!facts.assistantAfterStoppedQuestion, "Pi sent no assistant content after the stopped question")
    check(facts.turn3Line?.includes("lineage=continuation") && resumed && facts.turn3Line.includes(`session=${resumed}`) && facts.resolvedResume === "true",
      "turn 3 resumed the session turn 2 resumed (continuation, interrupted resume)")
    check(facts.upstreamNextTurn?.holdsTurn1 && facts.upstreamNextTurn.holdsStoppedQuestion && facts.upstreamNextTurn.holdsNewQuestion
      && !facts.upstreamNextTurn.holdsPartial, "the upstream's next-turn input holds turn 1, the stopped question and the new one, not the partial")
  } else {
    check(facts.assistantAfterStoppedQuestion, "OpenCode sent its partial back as an assistant message")
    check(facts.turn3Line?.includes("diverged=interrupted-turn-kept:kept-assistant") && facts.resolvedResume === "false",
      "turn 3 replayed (diverged=interrupted-turn-kept:kept-assistant)")
    check(facts.upstreamNextTurn?.holdsPartial && facts.upstreamNextTurn.holdsTurn1, "the upstream's next-turn input carries the kept partial")
  }
  return { facts, checks }
}

async function runPi(bin, dir, baseUrl, server, relay) {
  // `meridian setup --client pi` gates on `pi --version` from PATH, so the Pi
  // under test goes first: another `pi` on PATH (a version-manager shim, say)
  // would be the one checked, and would run under the isolated HOME.
  const path = bin.includes("/") ? `${dirname(resolve(bin))}${delimiter}${process.env.PATH}` : process.env.PATH
  const env = { ...clientEnvBase(dir), PATH: path, PI_CODING_AGENT_DIR: join(dir, "agent"), MERIDIAN_BASE_URL: baseUrl, PWD: join(dir, "project") }
  mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true })
  const version = spawnSync(bin, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout.trim()
  const setup = spawnSync(NODE, [join(ROOT, "dist/cli.js"), "setup", "--client", "pi"], { cwd: env.PWD, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (setup.status !== 0) throw new Error(`setup --client pi failed: ${setup.stderr}`)
  // Setup names the version it checked: "installed for Pi <version>".
  const setupPiVersion = setup.stdout.match(/for Pi (\d+\.\d+\.\d+)/)?.[1]
  const installed = existsSync(join(env.PI_CODING_AGENT_DIR, "extensions", "meridian"))
  const pi = spawn(bin, ["--mode", "rpc", "--model", `meridian/${MODEL}`, "--no-tools", "--session-dir", join(dir, "sessions")],
    { cwd: env.PWD, env, stdio: ["pipe", "pipe", "pipe"] })
  const witness = observeChildClosure(pi)
  const events = []
  let stderr = ""
  lines(pi.stdout, (line) => {
    if (!line.startsWith("{")) return
    try { events.push(JSON.parse(line)) } catch (error) { events.push({ type: "unparsed", error: String(error) }) }
  })
  pi.stderr.setEncoding("utf8")
  pi.stderr.on("data", (chunk) => { stderr += chunk })
  let seq = 0
  const send = (command) => pi.stdin.write(`${JSON.stringify({ id: `c${++seq}`, ...command })}\n`)
  const waitFor = async (from, predicate, label) => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const hit = events.slice(from).find(predicate)
      if (hit) return hit
      if (Date.now() > deadline || witness.state.exitSeen) throw new Error(`Pi: no ${label}; stderr: ${stderr.slice(-300)}`)
      await sleep(50)
    }
  }
  const marks = {}
  try {
    let from = events.length
    send({ type: "prompt", message: U1 })
    await waitFor(from, (e) => e.type === "agent_settled", "turn 1 settle")
    from = events.length
    marks.turn2Log = server.log.length
    send({ type: "prompt", message: U2 })
    await waitFor(from, (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta", "turn 2 text")
    await sleep(1500)
    send({ type: "abort" })
    const settled = await waitFor(from, (e) => e.type === "agent_settled", "turn 2 settle")
    await sleep(1500)
    marks.turn3Log = server.log.length
    marks.turn3Relay = relay.relayed.length
    marks.turn3Upstream = upstream.requests.length
    from = events.length
    send({ type: "prompt", message: U3 })
    await waitFor(from, (e) => e.type === "agent_settled", "turn 3 settle")
    await sleep(1000)
    return { marks, facts: { client: `pi ${version}`, piVersion: version, setupPiVersion, integrationLoaded: installed,
      stopped: settled.aborted === true } }
  } finally {
    writeFileSync(join(dir, "pi-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"))
    pi.stdin.end()
    await stopAndJoinChild(pi, witness, { graceMs: 5000, forceMs: 3000 })
  }
}

async function runOpenCode(bin, dir, baseUrl, server, relay) {
  const config = join(dir, "opencode-config")
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", model: `anthropic/${MODEL}`,
    providers: { anthropic: { settings: { apiKey: "local-e2e", baseURL: `${baseUrl}/v1` }, models: { [MODEL]: { limit: { output: 4096 } } } } },
  }, null, 2))
  const project = join(dir, "project")
  const env = { ...clientEnvBase(dir), XDG_CONFIG_HOME: join(dir, "xdg-config"), XDG_DATA_HOME: join(dir, "xdg-data"),
    XDG_CACHE_HOME: join(dir, "xdg-cache"), XDG_STATE_HOME: join(dir, "xdg-state"), OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PASSWORD: "local-e2e", PWD: project }
  const version = spawnSync(bin, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout.trim()
  const setup = spawnSync(NODE, [join(ROOT, "dist/cli.js"), "setup", "--v2", "--opencode-bin", bin], { cwd: project, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (setup.status !== 0) throw new Error(`setup --v2 failed: ${setup.stderr}`)
  const pluginPath = realpathSync(join(ROOT, "dist/meridian-v2"))
  const configured = (JSON.parse(readFileSync(join(config, "opencode.json"), "utf8")).plugins ?? []).map((p) => realpathSync(p))
  const base = `http://127.0.0.1:${CLIENT_PORT}`
  const headers = { authorization: `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`, "content-type": "application/json" }
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    return { status: response.status, json: text ? JSON.parse(text) : undefined }
  }
  const serve = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(CLIENT_PORT)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  const witness = observeChildClosure(serve)
  lines(serve.stdout, () => undefined)
  lines(serve.stderr, () => undefined)
  try {
    for (let i = 0; i < 150; i++) {
      if (await fetch(`${base}/api/info`, { headers }).then((r) => r.ok, () => false)) break
      if (witness.state.exitSeen) throw new Error("OpenCode server exited")
      await sleep(200)
    }
    const directory = `?directory=${encodeURIComponent(project)}`
    let loaded = []
    for (let i = 0; i < 100 && loaded.length === 0; i++) {
      loaded = ((await api("GET", `/api/plugin${directory}`)).json?.data ?? []).filter((e) => e.id === "meridian")
      if (loaded.length === 0) await sleep(100)
    }
    const integrationLoaded = configured.length === 1 && configured[0] === pluginPath && loaded.length === 1
      && loaded[0].state?.status === "active" && realpathSync(loaded[0].source.path) === pluginPath
    const created = await api("POST", `/api/session${directory}`, { model: { id: MODEL, providerID: "anthropic" } })
    const session = created.json?.data?.id ?? created.json?.id
    if (!session) throw new Error(`OpenCode session.create ${created.status}`)
    const prompt = async (text) => { await api("POST", `/api/session/${session}/prompt`, { text }); await api("POST", `/api/experimental/session/${session}/wait`) }
    await prompt(U1)
    const marks = { turn2Log: server.log.length }
    const slowBefore = upstream.requests.filter((r) => r.slow).length
    await api("POST", `/api/session/${session}/prompt`, { text: U2 })
    for (let i = 0; i < 300 && upstream.requests.filter((r) => r.slow).length === slowBefore; i++) await sleep(50)
    await sleep(1500)
    const interrupt = await api("POST", `/api/session/${session}/interrupt`)
    await api("POST", `/api/experimental/session/${session}/wait`)
    await sleep(1500)
    marks.turn3Log = server.log.length
    marks.turn3Relay = relay.relayed.length
    marks.turn3Upstream = upstream.requests.length
    await prompt(U3)
    await sleep(1000)
    return { marks, facts: { client: version, integrationLoaded,
      stopped: (interrupt.json?.data?.interrupted ?? interrupt.json?.interrupted) === true } }
  } finally {
    await stopAndJoinChild(serve, witness, { graceMs: 5000, forceMs: 3000 })
  }
}

const summary = { mode: fixture ? "fixture" : "live", model: MODEL, node: NODE, cases: {} }
let failed = false
try {
  for (const name of CASES) {
    say(`\n=== E79 ${summary.mode} ${name} (model=${MODEL}) ===`)
    const dir = join(ARTIFACTS, name)
    mkdirSync(dir, { recursive: true })
    const result = CLIENT_CASES.includes(name) ? await clientCase(name, dir) : await httpCase(name, dir)
    summary.cases[name] = result
    writeFileSync(join(dir, "facts.json"), JSON.stringify(result.facts, null, 2))
    for (const c of result.checks) {
      say(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}`)
      if (!c.ok) failed = true
    }
    const line = result.facts.turn3?.line ?? result.facts.turn3Line
    say(`  turn3: ${line}${result.facts.turn3 ? ` isResume=${result.facts.turn3.isResume} cacheRead=${result.facts.turn3.cacheRead} cacheCreate=${result.facts.turn3.cacheCreate} sessionWait=${result.facts.turn3.sessionWaitMs}ms` : ""}`)
    if (result.facts.refusal) { say("  stopping: usage refusal"); break }
  }
} finally {
  upstream?.stop()
  writeFileSync(join(ARTIFACTS, "summary.json"), JSON.stringify(summary, null, 2))
  say(`\nsummary: ${join(ARTIFACTS, "summary.json")}`)
}
say(failed ? "FAIL" : "PASS: stopped turns resume when discarded and replay when kept")
process.exit(failed ? 1 : 0)
