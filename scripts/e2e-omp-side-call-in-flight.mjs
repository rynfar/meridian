#!/usr/bin/env node
/**
 * Live E2E: an Oh My Pi side call sent while a turn is in flight forks the
 * conversation's session instead of replaying it fresh (docs/agents.md, Oh My
 * Pi; src/proxy/session/SPEC.md, auxiliary fork).
 *
 * omp's completion probes and `/btw` start at once, whatever the conversation
 * is doing. This harness makes the real omp client run one through
 * `runEphemeralTurn` from a scratch hook at two points of a resumed turn:
 *
 *   1. omp -p: the first turn, which stores the conversation's SDK session.
 *   2. omp -c with the hook: a turn that runs one bash tool and then writes a
 *      short reply. When the tool starts, the hook sends side call A: the
 *      stored session waits on that tool call and omp fills in a result for
 *      it (`auxiliary=fork:checkpoint`). When the reply after the tool starts
 *      streaming, it sends side call B: the tool result has reached Meridian,
 *      the reply has not (`auxiliary=fork:checkpoint+in-flight` or
 *      `auxiliary=fork:in-flight`, depending on whether the turn had already
 *      published its checkpoint).
 *   3. omp -c: the next turn, which must still resume the stored session.
 *
 * Needs a running Meridian (a built tree on a spare port, with its own
 * MERIDIAN_CONFIG_DIR / MERIDIAN_SESSION_DIR) whose stdout+stderr go to
 * --log, and an omp agent dir whose models.yml points the anthropic provider
 * at it with `x-meridian-agent: pi`. Uses real credentials and the model you
 * name; asserts on Meridian's request and usage lines, never on model wording
 * alone.
 *
 * Run: node scripts/e2e-omp-side-call-in-flight.mjs --omp=<omp>
 *        --agent-dir=<dir> --log=<meridian log> [--model=opus]
 *        [--expect=fork|replay]
 * `fork` (default): both side calls fork without publishing, read most of
 * their input from the conversation's cache, and the next turn continues.
 * `replay`: both are answered from a fresh replay (the behaviour before).
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
assert.ok(["fork", "replay"].includes(expectation), `unknown --expect=${expectation}`)
assert.ok(agentDir && logPath, "--agent-dir and --log are required")

const root = mkdtempSync(join(tmpdir(), "meridian-omp-in-flight-"))
const sessionDir = join(root, "sessions")
const marker = `MARKER_${randomBytes(4).toString("hex").toUpperCase()}`

// Side call A when the tool starts, side call B when the reply after it
// starts streaming. Neither is awaited inside the event, so the turn keeps
// running while they are answered; agent_end waits for both before omp exits.
// Each outcome goes to a file the harness checks: omp must get an answer.
const hook = join(root, "in-flight-hook.ts")
const outcomes = join(root, "side-calls.jsonl")
writeFileSync(hook, `import { appendFileSync } from "node:fs"
const pending = []
let toolSeen = false, toolDone = false, sentA = false, sentB = false
const record = (label, outcome) => appendFileSync(${JSON.stringify(outcomes)}, JSON.stringify({ label, ...outcome }) + "\\n")
const side = (ctx, label) => pending.push(
  ctx.runEphemeralTurn({ promptText: "In three words, what is happening right now?" })
    .then(r => record(label, { reply: r.replyText }))
    .catch(e => record(label, { error: String(e) })))
export default function (pi) {
  pi.on("tool_execution_start", async (_event, ctx) => {
    toolSeen = true
    if (sentA) return
    sentA = true
    side(ctx, "A")
  })
  pi.on("tool_execution_end", async () => { toolDone = true })
  // Side call B once the reply after the tool has streamed some text, so the
  // client's copy of the conversation holds a partial assistant message.
  pi.on("message_update", async (event, ctx) => {
    if (!toolDone || sentB) return
    const text = (event.message?.content ?? []).filter(b => b?.type === "text").map(b => b.text).join("")
    if (text.length < 40) return
    sentB = true
    side(ctx, "B")
  })
  pi.on("agent_end", async () => {
    await Promise.all(pending)
    console.error("SIDE_CALLS " + pending.length + " tool=" + toolSeen)
  })
}
`)

function turn(prompt, { resume, withHook }) {
  const args = ["-p", "--no-extensions", ...(withHook ? [`--hook=${hook}`] : []),
    "--session-dir", sessionDir, "--model", model, ...(resume ? ["-c"] : []), prompt]
  return execFileSync(omp, args, {
    cwd: root, encoding: "utf8", timeout: 400_000, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  }).trim()
}

const logLines = offset => readFileSync(logPath, "utf8").slice(offset).split("\n")
// The conversation's requests, and its side calls, carry omp's tools; omp's
// tool-less one-message requests (titles) are other conversations.
const isConversationRequest = line => line.includes("[PROXY]") && / adapter=pi .* tools=[1-9]\d* /.test(line) && line.includes("msgCount=")
const isSide = line => / auxiliary=/.test(line) || / diverged=independent-request:auxiliary-request /.test(line)
const requestId = line => line.match(/\[PROXY\] (\S+) /)?.[1]
const brief = line => line.replace(/ sdkActive=\S+ sdkQueued=\S+/, "").replace(/ msgs=.*/, "")

try {
  turn(`The marker is ${marker}. Remember it and reply only ACK1.`, { resume: false, withHook: false })

  const start = readFileSync(logPath, "utf8").length
  turn("Run the bash command `sleep 12 && echo slept` once, then reply with a paragraph of about 80 words on what `sleep` does.",
    { resume: true, withHook: true })
  const run = logLines(start)
  const requests = run.filter(isConversationRequest)
  const sides = requests.filter(isSide)
  const mains = requests.filter(line => !isSide(line))
  assert.equal(sides.length, 2, `expected two side calls, got ${sides.length}`)

  const before = readFileSync(logPath, "utf8").length
  const answer = turn("What is the marker? Reply with the marker only.", { resume: true, withHook: false })
  const next = logLines(before).filter(isConversationRequest).at(-1)
  assert.ok(next, "no main omp request reached Meridian on the last turn")

  const all = logLines(start)
  const usageOf = line => {
    const usage = all.find(l => l.includes(`[PROXY] ${requestId(line)} usage:`))
    // The usage line omits a counter that is zero.
    const tokens = name => {
      const hit = usage?.match(new RegExp(` ${name}=([\\d.]+)(k?)`))
      return hit ? Number(hit[1]) * (hit[2] ? 1000 : 1) : 0
    }
    return usage ? { read: tokens("cache_read"), write: tokens("cache_write") } : undefined
  }
  const report = {
    answer,
    mains: mains.map(brief),
    sides: sides.map(line => ({ line: brief(line), cache: usageOf(line) })),
    next: brief(next),
  }
  console.log(JSON.stringify(report, null, 2))

  assert.match(answer, new RegExp(marker))
  const replies = readFileSync(outcomes, "utf8").trim().split("\n").map(line => JSON.parse(line))
  for (const label of ["A", "B"]) {
    const outcome = replies.find(r => r.label === label)
    assert.ok(outcome?.reply?.trim(), `side call ${label} gave omp no answer: ${JSON.stringify(outcome)}`)
  }
  assert.match(next, / lineage=continuation /)
  const [a, b] = sides
  if (expectation === "fork") {
    assert.match(a, / auxiliary=fork:checkpoint /, "side call A did not fork over the pending tool call")
    assert.match(b, / auxiliary=fork:(checkpoint\+)?in-flight /, "side call B did not fork over the streaming reply")
    for (const side of sides) {
      const lines = all.filter(line => line.includes(`[PROXY] ${requestId(side)} `))
      assert.ok(!lines.some(line => / resume refused | session unusable /.test(line)), `side call ${requestId(side)} was refused and replayed fresh`)
      const cache = usageOf(side)
      assert.ok(cache, `no usage line for side call ${requestId(side)}`)
      assert.ok(cache.read > cache.write, `side call wrote more cache than it read: ${JSON.stringify(cache)}`)
    }
    // Neither fork published: the next turn continues right after the hooked
    // turn's last request, with its reply and the new prompt added.
    const count = line => Number(line.match(/ msgCount=(\d+)/)?.[1])
    assert.equal(count(next), count(mains.at(-1)) + 2)
  } else {
    for (const side of sides) assert.match(side, / auxiliary=replay:/)
  }
  console.log(`PASS (${expectation})`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
