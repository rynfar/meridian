#!/usr/bin/env node
/**
 * Live E2E: under priority routing an Oh My Pi conversation keeps its account
 * across a Meridian restart (src/proxy/profiles-routing.spec.md, *A restart
 * keeps a running conversation on its account*).
 *
 * omp sends no signed human-turn attestation, so its priority assignment lives
 * only in Meridian's memory. This harness starts a built Meridian twice on a
 * spare port with its own config and session dirs and read-only credentials:
 *
 *   1. order A,B: omp -p sends the first turn, which lands on A.
 *   2. restart with order B,A: omp -c sends the second turn.
 *
 * `retain` (default) asserts the second turn stays on A and resumes the first
 * turn's SDK session. `move` asserts the behaviour before the fix: the second
 * turn starts on B with no session (`lineage=new … diverged=not-found`).
 *
 * Uses real credentials of two configured, non-default profiles (the
 * profiles.json in ~/.config/meridian, or --profiles-json) and the model you
 * name; asserts on Meridian's request lines, never on model wording alone.
 * Operator MERIDIAN_* variables are not passed to the instance under test.
 *
 * Run: node scripts/e2e-priority-restart.mjs --omp=<omp> --profiles=<A>,<B>
 *        [--cli=dist/cli.js] [--port=3791] [--model=opus] [--expect=retain|move]
 *        [--profiles-json=<file>] [--log=<file, overwritten, kept after the run>]
 * A failed run keeps its scratch directory and says where it is.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { once } from "node:events"

const arg = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const omp = arg("omp", "omp")
const cli = resolve(arg("cli", "dist/cli.js"))
const port = Number(arg("port", "3791"))
const model = arg("model", "opus")
const expectation = arg("expect", "retain")
const [first, second] = (arg("profiles") ?? "").split(",")
assert.ok(["retain", "move"].includes(expectation), `unknown --expect=${expectation}`)
assert.ok(first && second && first !== second, "--profiles=<A>,<B> names two configured profiles")
assert.ok(first !== "default" && second !== "default", "the request log names no profile for `default`")
const profileOf = id => new RegExp(` profile=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(priority\\) `)

const root = mkdtempSync(join(tmpdir(), "meridian-priority-restart-"))
const logPath = arg("log", join(root, "meridian.log"))
writeFileSync(logPath, "")
// The profiles' credentials stay where they are (their claudeConfigDir is
// absolute) and are only read; the scratch config dir holds the list alone.
mkdirSync(join(root, "config"))
copyFileSync(arg("profiles-json", join(homedir(), ".config", "meridian", "profiles.json")), join(root, "config", "profiles.json"))
const agentDir = join(root, "agent")
mkdirSync(agentDir)
writeFileSync(join(agentDir, "models.yml"), `providers:
  anthropic:
    baseUrl: http://127.0.0.1:${port}
    apiKey: x
    headers:
      x-meridian-agent: pi
`)
const marker = `MARKER_${randomBytes(4).toString("hex").toUpperCase()}`

// Meridian's own environment would change what is tested (routing, failback,
// host); the instance gets only what this harness sets.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MERIDIAN_")))

async function startMeridian(order) {
  // A listener already on the port would answer /health for the child.
  assert.ok(!(await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false)), `port ${port} is in use`)
  const child = spawn(process.execPath, [cli], {
    env: {
      ...baseEnv,
      MERIDIAN_PORT: String(port),
      MERIDIAN_CONFIG_DIR: join(root, "config"),
      MERIDIAN_SESSION_DIR: join(root, "sessions-meridian"),
      MERIDIAN_CREDENTIALS_READONLY: "1",
      MERIDIAN_ROUTING: "priority",
      MERIDIAN_PROFILE_ORDER: order.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => appendFileSync(logPath, chunk))
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Meridian exited with ${child.exitCode}; see ${logPath}`)
    // A refused connection means Meridian is not listening yet.
    if (await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)) return child
    await new Promise(r => setTimeout(r, 500))
  }
  child.kill()
  throw new Error(`Meridian did not answer /health on ${port}; see ${logPath}`)
}

async function stopMeridian(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  await exited
}

// Asynchronous, so Meridian's output keeps draining while omp runs; stdin is
// closed, or omp -p waits for piped input.
async function turn(prompt, resume) {
  const child = spawn(omp, ["-p", "--no-extensions", "--session-dir", join(root, "sessions-omp"),
    "--model", model, ...(resume ? ["-c"] : []), prompt], {
    cwd: root, timeout: 300_000, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  })
  let stdout = ""
  child.stdout.on("data", chunk => { stdout += chunk })
  const [code] = await once(child, "exit")
  assert.equal(code, 0, `omp exited with ${code}`)
  return stdout.trim()
}

// The conversation's requests carry omp's tools; tool-less one-message
// requests (titles, probes) are other conversations.
const conversationRequests = offset => readFileSync(logPath, "utf8").slice(offset).split("\n")
  .filter(line => line.includes("[PROXY]") && / adapter=pi .* tools=[1-9]\d* /.test(line) && line.includes("msgCount="))
const brief = line => line.replace(/ sdkActive=\S+ sdkQueued=\S+/, "").replace(/ msgs=.*/, "")
const requestId = line => line.match(/\[PROXY\] (\S+) /)?.[1]

let meridian
let passed = false
try {
  meridian = await startMeridian([first, second])
  await turn(`The marker is ${marker}. Remember it and reply only ACK1.`, false)
  const opening = conversationRequests(0).at(-1)
  assert.ok(opening, "the first turn never reached Meridian")
  assert.match(opening, profileOf(first))
  await stopMeridian(meridian)

  const restartedAt = readFileSync(logPath, "utf8").length
  meridian = await startMeridian([second, first])
  const answer = await turn("What is the marker? Reply with the marker only.", true)
  const resumed = conversationRequests(restartedAt).at(0)
  assert.ok(resumed, "the second turn never reached Meridian")
  console.log(JSON.stringify({ answer, opening: brief(opening), resumed: brief(resumed) }, null, 2))

  assert.match(answer, new RegExp(marker))
  if (expectation === "retain") {
    assert.match(resumed, profileOf(first))
    assert.match(resumed, / lineage=continuation /)
    // The request line is logged before the SDK runs: a refused resume would
    // still replay fresh under it.
    const resumedLines = readFileSync(logPath, "utf8").slice(restartedAt).split("\n")
      .filter(line => line.includes(`[PROXY] ${requestId(resumed)} `))
    assert.ok(!resumedLines.some(line => / resume refused | session unusable /.test(line)), "the resume was refused and replayed fresh")
  } else {
    assert.match(resumed, profileOf(second))
    assert.match(resumed, / lineage=new .*diverged=not-found /)
  }
  console.log(`PASS (${expectation})`)
  passed = true
} finally {
  if (meridian) await stopMeridian(meridian)
  if (passed) rmSync(root, { recursive: true, force: true })
  else console.error(`kept ${root} for inspection; it holds a copy of profiles.json`)
}
