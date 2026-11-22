// Opt-in. Needs no credentials, network or model: it starts a real Meridian
// server in disposable directories with two Claude profiles signed in with
// synthetic logins, and lets the idle transcript sweep run the installed
// Claude Code CLI in them.
//
//   bun scripts/e2e-transcript-sweep.mjs
//
// Profile "idle": 200 transcripts 40 days old, one 40-day-old transcript the
// session store still maps (with a sidecar file), one fresh transcript. The
// real CLI must delete the 200, keep the other two and leave the login file
// untouched, and its process must have exited before its SDK permit is free.
//
// Profile "stuck": its "CLI" ignores SIGTERM and leaves a grandchild holding
// its output pipe for STUCK_SECONDS. close() runs while it lives. It must
// not succeed while that process lives: past Meridian's shutdown deadline it
// rejects with ownership retained, and the sweep keeps its SDK permit until
// the process is joined. The sweep this replaces resolved close() at once,
// with the process still running and its permit already free.
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STUCK_SECONDS = 20
const DAY = 86_400_000
const fixtureRoot = mkdtempSync(join(tmpdir(), "meridian-transcript-sweep-e2e-"))
const realClaude = process.env.E2E_CLAUDE ?? execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim()
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
process.env.HOME = join(fixtureRoot, "home")
process.env.MERIDIAN_CONFIG_DIR = join(fixtureRoot, "meridian")
process.env.MERIDIAN_SESSION_DIR = join(fixtureRoot, "sessions")
process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "30"
process.env.MERIDIAN_TRANSCRIPT_SWEEP_INTERVAL_MS = "3000"
for (const dir of [process.env.HOME, process.env.MERIDIAN_CONFIG_DIR, process.env.MERIDIAN_SESSION_DIR]) mkdirSync(dir, { recursive: true })

const pidLog = join(fixtureRoot, "pids")
const wrapper = join(fixtureRoot, "claude")
writeFileSync(wrapper, `#!/usr/bin/env bash
if [ "$1" != "--version" ] && [ "$(basename "$CLAUDE_CONFIG_DIR")" = stuck ]; then
  echo "$$ stuck" >> "${pidLog}"
  trap '' TERM
  sleep ${STUCK_SECONDS} &
  echo "$! grandchild" >> "${pidLog}"
  wait
  exit 0
fi
[ "$1" != "--version" ] && echo "$$ cli" >> "${pidLog}"
exec "${realClaude}" "$@"
`)
chmodSync(wrapper, 0o755)
process.env.MERIDIAN_CLAUDE_PATH = wrapper

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const pids = (kind) => existsSync(pidLog)
  ? readFileSync(pidLog, "utf8").trim().split("\n").map((line) => line.split(" ")).filter(([, k]) => k === kind).map(([pid]) => Number(pid))
  : []
async function until(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function profileRoot(name) {
  const root = join(fixtureRoot, name)
  mkdirSync(join(root, "projects", "-e2e"), { recursive: true })
  writeFileSync(join(root, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: `synthetic-access-${name}`, refreshToken: `synthetic-refresh-${name}`, expiresAt: Date.now() + 6 * 3_600_000 },
  }), { mode: 0o600 })
  return root
}
function transcript(root, sessionId, ageDays) {
  const path = join(root, "projects", "-e2e", `${sessionId}.jsonl`)
  writeFileSync(path, JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "synthetic" } }) + "\n")
  const at = (Date.now() - ageDays * DAY) / 1000
  utimesSync(path, at, at)
  return path
}

const idle = profileRoot("idle")
const stuck = profileRoot("stuck")
for (let i = 0; i < 200; i++) transcript(idle, crypto.randomUUID(), 40)
const pinnedId = crypto.randomUUID()
const pinned = transcript(idle, pinnedId, 40)
const sidecar = join(idle, "projects", "-e2e", pinnedId, "subagents", "agent-1.jsonl")
mkdirSync(join(sidecar, ".."), { recursive: true })
writeFileSync(sidecar, "{}\n")
utimesSync(sidecar, (Date.now() - 40 * DAY) / 1000, (Date.now() - 40 * DAY) / 1000)
const fresh = transcript(idle, crypto.randomUUID(), 1)
const loginBefore = readFileSync(join(idle, ".credentials.json"))

const { startProxyServer } = await import("../src/proxy/server.ts")
const { storeSession } = await import("../src/proxy/session/cache.ts")
const { getProcessSdkSemaphore } = await import("../src/proxy/concurrency.ts")
await storeSession("e2e-conversation", [{ role: "user", content: "synthetic" }], pinnedId, join(fixtureRoot, "project"),
  undefined, undefined, undefined, undefined, { sessionId: pinnedId, configDir: idle })

const semaphore = getProcessSdkSemaphore()
let permitFreedAt
let stuckGoneAt
const permitWatch = setInterval(() => {
  if (pids("stuck").length === 0) return
  if (permitFreedAt === undefined && semaphore.snapshot.active === 0) permitFreedAt = Date.now()
  if (stuckGoneAt === undefined && ![...pids("stuck"), ...pids("grandchild")].some(alive)) stuckGoneAt = Date.now()
}, 20)

const instance = await startProxyServer({
  port: 0, host: "127.0.0.1", silent: true,
  profiles: [{ id: "idle", claudeConfigDir: idle }, { id: "stuck", claudeConfigDir: stuck }],
  defaultProfile: "idle",
})
let report
try {
  // The first pass starts three seconds in; the real CLI cleans within ~10 s.
  await until(() => pids("stuck").length > 0, 120_000, "the sweep to reach the stuck profile")
  const cliPid = pids("cli").at(-1)
  const kept = readdirSync(join(idle, "projects", "-e2e")).filter((name) => name.endsWith(".jsonl"))
  const idleResult = {
    cliProcessesStarted: pids("cli").length,
    cliExitedBeforeNextRoot: cliPid !== undefined && !alive(cliPid),
    lastCleanupWritten: existsSync(join(idle, ".last-cleanup")),
    transcriptsLeft: kept.length,
    pinnedKept: existsSync(pinned),
    pinnedSidecarKept: existsSync(sidecar),
    freshKept: existsSync(fresh),
    pinnedMtimeAgeSeconds: existsSync(pinned) ? Math.round((Date.now() - statSync(pinned).mtimeMs) / 1000) : null,
    loginUntouched: readFileSync(join(idle, ".credentials.json")).equals(loginBefore),
  }
  const stuckPid = pids("stuck")[0]
  const grandchild = pids("grandchild")[0]
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const closeStarted = Date.now()
  const closeOutcome = await instance.close().then(() => "resolved", (error) => `rejected: ${error.message}`)
  const closeSettled = Date.now()
  const aliveWhenCloseSettled = [stuckPid, grandchild].some(alive)
  await until(() => permitFreedAt !== undefined && stuckGoneAt !== undefined, (STUCK_SECONDS + 60) * 1000, "the stuck process to be joined")
  clearInterval(permitWatch)
  const seconds = (at) => Math.round((at - closeStarted) / 100) / 10
  report = {
    idle: idleResult,
    stuck: {
      closeOutcome,
      closeSettledAfterSeconds: seconds(closeSettled),
      processAliveWhenCloseSettled: aliveWhenCloseSettled,
      processGoneAfterSeconds: seconds(stuckGoneAt),
      permitFreedAfterSeconds: seconds(permitFreedAt),
    },
  }
  console.log(JSON.stringify(report, null, 2))
  assert.equal(idleResult.cliExitedBeforeNextRoot, true, "the real CLI must have exited before the sweep moved on")
  assert.equal(idleResult.lastCleanupWritten, true, "the real CLI's cleanup must have run")
  assert.equal(idleResult.transcriptsLeft, 2, "only the pinned and the fresh transcript may remain")
  assert.equal(idleResult.pinnedKept && idleResult.pinnedSidecarKept && idleResult.freshKept, true)
  assert.equal(idleResult.loginUntouched, true, "the idle CLI must not touch the stored login")
  assert.ok(!(closeOutcome === "resolved" && aliveWhenCloseSettled), "close() must not succeed with the sweep's process alive")
  if (aliveWhenCloseSettled) assert.match(closeOutcome, /ownership retained/, "an unjoined process must be reported as retained ownership")
  assert.ok(permitFreedAt >= stuckGoneAt - 100, "the permit must stay held until the process is joined")
  console.log("PASS: idle profile cleaned with its pinned transcript kept; the stuck process kept its permit until joined, and close() did not succeed before")
} finally {
  clearInterval(permitWatch)
  for (const pid of [...pids("stuck"), ...pids("grandchild"), ...pids("cli")]) if (alive(pid)) process.kill(pid, "SIGKILL")
  rmSync(fixtureRoot, { recursive: true, force: true })
}
process.exit(0)
