#!/usr/bin/env node
/**
 * Live E2E: an Oh My Pi side call leaves the conversation's mapping alone, so
 * the next real turn resumes (docs/agents.md, Oh My Pi).
 *
 * omp's idle recap and composer predictions go through `runEphemeralTurn`,
 * which keeps the conversation's `metadata.user_id` session id and sends its
 * own id, `<session>:side:<id>`, in `X-Claude-Code-Session-Id`. This harness
 * makes the real omp client run one through the same API from a scratch hook:
 *
 *   1. omp -p: the first turn; on `agent_end` the hook runs one side call.
 *   2. omp -c: the second turn, which must resume the stored SDK session.
 *
 * Needs a running Meridian (a built tree on a spare port, with its own
 * MERIDIAN_CONFIG_DIR / MERIDIAN_SESSION_DIR) whose stdout+stderr go to
 * --log, and an omp agent dir whose models.yml points the anthropic provider
 * at it with `x-meridian-agent: pi`. Uses real credentials and the model you
 * name; asserts on Meridian's request lines, never on model wording alone.
 *
 * Run: node scripts/e2e-omp-side-call.mjs --omp=<omp> --agent-dir=<dir>
 *        --log=<meridian log> [--model=opus] [--expect=resume|replay]
 * `--expect=replay` asserts the pre-fix behaviour, for a before run on main.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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

const root = mkdtempSync(join(tmpdir(), "meridian-omp-side-call-"))
const sessionDir = join(root, "sessions")
const marker = `MARKER_${randomBytes(4).toString("hex").toUpperCase()}`

// One side call through omp's own runEphemeralTurn, the path its idle recap
// and composer predictions take, after the first turn's reply.
const hook = join(root, "side-call-hook.ts")
writeFileSync(hook, `let ran = false
export default function (pi) {
  pi.on("agent_end", async (_event, ctx) => {
    if (ran) return
    ran = true
    const { replyText } = await ctx.runEphemeralTurn({ promptText: "Summarise this session in three words." })
    console.error("SIDE_CALL_REPLY " + JSON.stringify(replyText))
  })
}
`)

function turn(prompt, { resume, withHook }) {
  const args = ["-p", "--no-extensions", ...(withHook ? [`--hook=${hook}`] : []),
    "--session-dir", sessionDir, "--model", model, ...(resume ? ["-c"] : []), prompt]
  return execFileSync(omp, args, {
    cwd: root, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  }).trim()
}

// The conversation's requests, and its side calls, carry omp's tools; omp's
// tool-less one-message requests (titles, probes) are other conversations.
const conversationLines = offset => readFileSync(logPath, "utf8").slice(offset).split("\n")
  .filter(line => line.includes("[PROXY]") && / adapter=pi .* tools=[1-9]\d* /.test(line) && line.includes("msgCount="))

const start = readFileSync(logPath, "utf8").length
turn(`The marker is ${marker}. Remember it and reply only ACK1.`, { resume: false, withHook: true })
const firstTurn = conversationLines(start)
assert.equal(firstTurn.length, 2, "expected the first turn and one side call")
const side = firstTurn[1]

const before = readFileSync(logPath, "utf8").length
const answer = turn("What is the marker? Reply with the marker only.", { resume: true, withHook: false })
const main = conversationLines(before).at(-1)
assert.ok(main, "no main omp request reached Meridian on the second turn")
const brief = line => line.replace(/ sdkActive=\S+ sdkQueued=\S+/, "").replace(/ msgs=.*/, "")
console.log(JSON.stringify({ answer, firstTurn: brief(firstTurn[0]), side: brief(side), main: brief(main) }, null, 2))

assert.match(answer, new RegExp(marker))
const sessionOf = line => line.match(/ session=(\S+)/)?.[1]
if (expectation === "resume") {
  assert.match(side, / diverged=independent-request:auxiliary-request /)
  assert.match(main, / lineage=continuation /)
} else {
  // The pre-fix side call resumes the conversation's own SDK session.
  assert.match(side, / lineage=continuation /)
  assert.equal(sessionOf(side), sessionOf(main))
}
console.log(`PASS (${expectation})`)
