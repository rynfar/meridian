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
 * name; asserts on Meridian's request and usage lines, never on model wording
 * alone.
 *
 * Run: node scripts/e2e-omp-side-call.mjs --omp=<omp> --agent-dir=<dir>
 *        --log=<meridian log> [--model=opus] [--expect=fork|auxiliary|turn]
 * `fork` (default): the side call forks the conversation's session without
 * publishing it and reads most of its input from the conversation's cache.
 * `auxiliary`: the side call is answered from a fresh replay. `turn`: the
 * side call is served as a turn of the conversation (no side-call support).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const expectation = arg("expect", "fork")
assert.ok(["fork", "auxiliary", "turn"].includes(expectation), `unknown --expect=${expectation}`)
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

// This run's Meridian log lines, from `offset` on.
const logLines = offset => readFileSync(logPath, "utf8").slice(offset).split("\n")
// The conversation's requests, and its side calls, carry omp's tools; omp's
// tool-less one-message requests (titles, probes) are other conversations.
const isConversationRequest = line => line.includes("[PROXY]") && / adapter=pi .* tools=[1-9]\d* /.test(line) && line.includes("msgCount=")
const requestId = line => line.match(/\[PROXY\] (\S+) /)?.[1]

try {
  const start = readFileSync(logPath, "utf8").length
  turn(`The marker is ${marker}. Remember it and reply only ACK1.`, { resume: false, withHook: true })
  const firstTurn = logLines(start).filter(isConversationRequest)
  assert.equal(firstTurn.length, 2, "expected the first turn and one side call")
  const side = firstTurn[1]

  const before = readFileSync(logPath, "utf8").length
  const answer = turn("What is the marker? Reply with the marker only.", { resume: true, withHook: false })
  const main = logLines(before).filter(isConversationRequest).at(-1)
  assert.ok(main, "no main omp request reached Meridian on the second turn")

  const run = logLines(start)
  const sideLines = run.filter(line => line.includes(`[PROXY] ${requestId(side)} `))
  // `[PROXY] <request id> usage: ... cache_read=<n>[k] cache_write=<n>[k] ...`
  const usage = sideLines.find(line => line.includes(" usage:"))
  const tokens = name => {
    const hit = usage?.match(new RegExp(` ${name}=([\\d.]+)(k?)`))
    return hit ? Number(hit[1]) * (hit[2] ? 1000 : 1) : undefined
  }
  const sideCache = { read: tokens("cache_read"), write: tokens("cache_write") }
  const brief = line => line.replace(/ sdkActive=\S+ sdkQueued=\S+/, "").replace(/ msgs=.*/, "")
  console.log(JSON.stringify({ answer, firstTurn: brief(firstTurn[0]), side: brief(side), sideCache, main: brief(main) }, null, 2))

  assert.match(answer, new RegExp(marker))
  const sessionOf = line => line.match(/ session=(\S+)/)?.[1]
  if (expectation === "fork") {
    assert.match(side, / lineage=continuation .*auxiliary=fork /)
    // The request line is logged before the SDK runs: a refused fork would
    // still replay fresh under it, so it must not have been refused.
    assert.ok(!sideLines.some(line => / resume refused | session unusable /.test(line)), "the side call's fork was refused and replayed fresh")
    assert.match(main, / lineage=continuation /)
    // The side call resumed the session the first turn published, and did not
    // publish its fork: the second turn resumes that same session.
    assert.equal(sessionOf(side), sessionOf(main))
    assert.ok(sideCache.read !== undefined && sideCache.write !== undefined, "no usage line for the side call")
    assert.ok(sideCache.read > sideCache.write, `side call wrote more cache than it read: ${JSON.stringify(sideCache)}`)
  } else if (expectation === "auxiliary") {
    assert.match(side, / diverged=independent-request:auxiliary-request /)
    assert.match(main, / lineage=continuation /)
  } else {
    // Without side-call support it resumes the conversation's own SDK session.
    assert.match(side, / lineage=continuation /)
    assert.doesNotMatch(side, /auxiliary/)
  }
  console.log(`PASS (${expectation})`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
