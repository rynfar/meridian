#!/usr/bin/env node
/**
 * Live E2E: an Oh My Pi history that lost a reminder-only user message
 * resumes instead of replaying (session spec, *Regrouped user messages*).
 *
 * Reproduces the 2026-11-07 incident with the real omp client: an idle rebuild
 * put a user message holding only a <system-reminder> on the wire that the
 * session file never kept, so after a restart it was gone and every later
 * message shifted by one.
 *
 *   1. omp -p: the first turn.
 *   2. A reminder-only user message is inserted into the scratch session file
 *      after the reply, and omp -c sends the second turn: Meridian stores a
 *      history that holds it, as it did from the live wire.
 *   3. The message is removed again (the restart), and omp -c sends the third
 *      turn, which must resume the stored SDK session.
 *
 * Needs a running Meridian (a dev build on a spare port, with its own
 * MERIDIAN_CONFIG_DIR / MERIDIAN_SESSION_DIR) whose stdout+stderr go to
 * --log, and an omp agent dir whose models.yml points the anthropic provider
 * at it with `x-meridian-agent: pi`. Uses real credentials and the model you
 * name; asserts on Meridian's request lines, never on model wording alone.
 *
 * Run: node scripts/e2e-lineage-regroup-omp.mjs --omp=<omp> --agent-dir=<dir>
 *        --log=<meridian log> [--model=opus] [--expect=resume|replay]
 * `--expect=replay` asserts the pre-fix behaviour, for a before run on main.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const arg = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const omp = arg("omp", "omp")
const agentDir = arg("agent-dir")
const logPath = arg("log")
const model = arg("model", "opus")
const expectation = arg("expect", "resume")
assert.ok(agentDir && logPath, "--agent-dir and --log are required")

const root = mkdtempSync(join(tmpdir(), "meridian-regroup-omp-"))
const sessionDir = join(root, "sessions")
const marker = `MARKER_${randomBytes(4).toString("hex").toUpperCase()}`

function turn(prompt, resume) {
  const args = ["-p", "--no-extensions", "--session-dir", sessionDir, "--model", model, ...(resume ? ["-c"] : []), prompt]
  const output = execFileSync(omp, args, {
    cwd: root, encoding: "utf8", timeout: 300_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  })
  return output.trim()
}

function sessionFile() {
  const files = readdirSync(sessionDir).filter(name => name.endsWith(".jsonl"))
  assert.equal(files.length, 1, "expected one omp session file")
  return join(sessionDir, files[0])
}

const readEntries = path => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))
const writeEntries = (path, entries) => writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n")

/** Request lines Meridian printed after `offset` bytes of its log. */
function requestLines(offset) {
  return readFileSync(logPath, "utf8").slice(offset).split("\n")
}

// The main conversation request carries omp's tools; side requests do not.
const mainRequest = lines => lines.filter(line => / adapter=pi .* tools=[1-9]\d* /.test(line)).at(-1)

turn(`The marker is ${marker}. Remember it and reply only ACK1.`, false)

// 2. Put the reminder-only message on the wire, after the first reply.
const path = sessionFile()
const entries = readEntries(path)
const reply = entries.findLast(entry => entry.type === "message" && entry.message?.role === "assistant")
assert.ok(reply, "first turn left no assistant message")
const note = {
  type: "message", id: randomBytes(4).toString("hex"), parentId: reply.id,
  timestamp: new Date().toISOString(), runtime: reply.runtime,
  message: { role: "user", content: [{ type: "text", text: "<system-reminder>\neval kernel state: x = 1\n</system-reminder>" }],
    attribution: "agent", timestamp: Date.now() },
}
for (const entry of entries) if (entry.parentId === reply.id) entry.parentId = note.id
entries.splice(entries.indexOf(reply) + 1, 0, note)
writeEntries(path, entries)
turn("Reply only ACK2.", true)

// 3. The restart: the note is gone from the file omp reloads.
const reloaded = readEntries(path)
for (const entry of reloaded) if (entry.parentId === note.id) entry.parentId = note.parentId
writeEntries(path, reloaded.filter(entry => entry.id !== note.id))
const before = readFileSync(logPath, "utf8").length
const answer = turn("What is the marker? Reply with the marker only.", true)
// Usage lines arrive after the response completes.
await new Promise(resolve => setTimeout(resolve, 1500))
const lines = requestLines(before)
const main = mainRequest(lines)
assert.ok(main, "no main omp request reached Meridian on the third turn")
const id = main.match(/\[PROXY\] (\S+) adapter=/)[1]
const usage = lines.find(line => line.includes(`${id} usage:`))
const regrouped = lines.find(line => line.includes("Regrouped user messages"))
const stale = lines.find(line => line.includes("Stale session detected"))
console.log(JSON.stringify({ answer, request: main.replace(/ msgs=.*/, ""), usage, regrouped, stale }, null, 2))

assert.match(answer, new RegExp(marker))
if (expectation === "resume") {
  assert.match(main, / lineage=continuation /)
  assert.ok(regrouped?.includes("; resuming."), "Meridian did not report the regroup")
  assert.equal(stale, undefined)
} else {
  assert.match(main, / lineage=new /)
  assert.ok(stale, "expected the pre-fix stale-session replay")
}
console.log(`PASS (${expectation})`)
