// Opt-in. Needs no credentials, network or running proxy: it drives the
// installed Claude Code CLI through the Agent SDK with the options Meridian
// builds, in disposable directories, and never sends the model a message.
//
//   bun scripts/e2e-transcript-retention.mjs                 # the sweep runs
//   MERIDIAN_TRANSCRIPT_RETENTION_DAYS=0 \
//     bun scripts/e2e-transcript-retention.mjs --expect-kept # nothing is deleted
//
// The first run also drives the idle sweep (transcriptSweep.ts) against
// synthetic config roots holding synthetic logins, on Linux, where Claude Code
// keeps its OAuth login in a file this script can fingerprint.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"

const expectKept = process.argv.includes("--expect-kept")
const retentionDays = process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS
const fixtureRoot = mkdtempSync(join(tmpdir(), "meridian-transcript-retention-e2e-"))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
if (retentionDays !== undefined) process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = retentionDays
process.env.MERIDIAN_CONFIG_DIR = join(fixtureRoot, "meridian")

const { buildQueryOptions } = await import("../src/proxy/query.ts")
const { resolveTranscriptRetention } = await import("../src/proxy/transcriptRetention.ts")
const { classifyResumeRefusal } = await import("../src/proxy/errors.ts")
const { resolveClaudeExecutableAsync } = await import("../src/proxy/models.ts")
const { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } = await import("../src/proxy/tools.ts")
const { createTranscriptSweep, runIdleSweepChild } = await import("../src/proxy/transcriptSweep.ts")

const configDir = join(fixtureRoot, "claude-config")
const workingDirectory = join(fixtureRoot, "project")
const transcripts = join(configDir, "projects", "-e2e-project")
for (const dir of [configDir, workingDirectory, transcripts]) mkdirSync(dir, { recursive: true })
const oldSession = "11111111-1111-4111-8111-111111111111"
const freshSession = "22222222-2222-4222-8222-222222222222"
const transcriptPath = (sessionId) => join(transcripts, `${sessionId}.jsonl`)
for (const sessionId of [oldSession, freshSession]) {
  writeFileSync(transcriptPath(sessionId), JSON.stringify({
    type: "user", sessionId, uuid: "33333333-3333-4333-8333-333333333333",
    timestamp: new Date().toISOString(), message: { role: "user", content: "synthetic" },
  }) + "\n")
}
const fortyDaysAgo = (Date.now() - 40 * 86_400_000) / 1000
utimesSync(transcriptPath(oldSession), fortyDaysAgo, fortyDaysAgo)

const retention = resolveTranscriptRetention(configDir)
const claudeExecutable = await resolveClaudeExecutableAsync()

/** Run one SDK child that never receives a message, for at most `windowMs`. */
async function runChild(windowMs, extra = {}, until = () => false) {
  const { options } = buildQueryOptions({
    prompt: "", model: "sonnet", workingDirectory, systemContext: "", claudeExecutable,
    passthrough: true, stream: false, sdkAgents: {}, hasDeferredTools: false, isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS, incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME, allowedMcpTools: ALLOWED_MCP_TOOLS,
    cleanEnv: { PATH: process.env.PATH, HOME: join(fixtureRoot, "home"), CLAUDE_CONFIG_DIR: configDir },
    transcriptRetentionDays: retention.days,
    ...extra,
  })
  const abortController = new AbortController()
  const idle = (async function* () { await new Promise((resolve) => setTimeout(resolve, windowMs + 5_000)) })()
  let error
  const drain = (async () => {
    try { for await (const _ of query({ prompt: idle, options: { ...options, abortController, stderr: () => {} } })) { /* idle */ } }
    catch (caught) { error = caught }
  })()
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline && error === undefined && !until()) await new Promise((resolve) => setTimeout(resolve, 250))
  abortController.abort()
  await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 3_000))])
  return { options, error }
}

const fortyDaysOld = (path) => utimesSync(path, fortyDaysAgo, fortyDaysAgo)
const credentialDigest = (path) => {
  const stat = statSync(path)
  return `${stat.ino}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
}

/** A config root last cleaned two days ago, with one 40-day-old transcript and a synthetic login. */
function idleRoot(name, login) {
  const configDir = join(fixtureRoot, "idle", name)
  const project = join(configDir, "projects", "-e2e-idle")
  mkdirSync(project, { recursive: true })
  const oldTranscript = join(project, `${oldSession}.jsonl`)
  writeFileSync(oldTranscript, JSON.stringify({ type: "user", sessionId: oldSession, message: { role: "user", content: "synthetic" } }) + "\n")
  fortyDaysOld(oldTranscript)
  const credentials = join(configDir, ".credentials.json")
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: login }), { mode: 0o600 })
  writeFileSync(join(configDir, ".last-cleanup"), "then")
  const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000
  utimesSync(join(configDir, ".last-cleanup"), twoDaysAgo, twoDaysAgo)
  return { root: { configDir, explicitConfigDir: true, profileIds: [name] }, oldTranscript, credentials, digest: credentialDigest(credentials) }
}

/** One idle-sweep pass over `fixtures`, through the real module and the real CLI. */
async function idleSweep(fixtures, minTokenValidityMs) {
  const sweep = createTranscriptSweep({
    listRoots: () => fixtures.map((fixture) => fixture.root),
    isRootBusy: () => false,
    isDraining: () => false,
    credentialsReadOnly: () => false,
    tryAcquireSlot: () => ({ release: () => undefined }),
    readCredentials: async (root) => JSON.parse(readFileSync(join(root.configDir, ".credentials.json"), "utf8")),
    runChild: (root, days, signal) => runIdleSweepChild({
      root, retentionDays: days, claudeExecutable, signal,
      processEnv: { PATH: process.env.PATH, HOME: join(fixtureRoot, "home") },
    }),
    log: () => undefined,
    ...(minTokenValidityMs === undefined ? {} : { minTokenValidityMs }),
  })
  const results = await sweep.runPass()
  return fixtures.map((fixture, index) => {
    const outcome = results[index]?.outcome
    return {
      root: fixture.root.profileIds[0],
      outcome: outcome?.kind === "skipped" ? `skipped:${outcome.reason}` : outcome?.kind,
      refusedConnections: outcome && "refusedConnections" in outcome ? outcome.refusedConnections : null,
      oldTranscriptKept: existsSync(fixture.oldTranscript),
      loginUnchanged: credentialDigest(fixture.credentials) === fixture.digest,
    }
  })
}

try {
  // Claude Code starts its background housekeeping five seconds after launch.
  const sweep = await runChild(20_000, {}, () => !existsSync(transcriptPath(oldSession)))
  const report = {
    retention,
    cleanupPeriodDays: typeof sweep.options.settings === "object" ? sweep.options.settings.cleanupPeriodDays ?? null : null,
    settingSources: sweep.options.settingSources,
    oldTranscriptKept: existsSync(transcriptPath(oldSession)),
    freshTranscriptKept: existsSync(transcriptPath(freshSession)),
  }
  assert.deepEqual(report.settingSources, [], "no settings file may be loaded")
  assert.equal(report.freshTranscriptKept, true, "a fresh transcript must survive the sweep")
  assert.equal(report.oldTranscriptKept, expectKept, expectKept
    ? "the 40-day-old transcript was deleted although no period was passed"
    : "the 40-day-old transcript survived although a period was passed")

  if (!expectKept) {
    // Meridian still maps a conversation to the swept session: resuming it
    // must be refused in a way Meridian answers with a fresh-session replay.
    const resume = await runChild(15_000, { resumeSessionId: oldSession })
    report.resumeRefusal = classifyResumeRefusal(resume.error) ?? null
    assert.equal(report.resumeRefusal, "unresumable", `unexpected resume outcome: ${resume.error}`)
  }

  if (!expectKept && process.platform !== "darwin") {
    const now = Date.now()
    const synthetic = (kind) => `e2e-synthetic-${kind}-${"x".repeat(40)}`
    const login = (expiresAt) => ({ accessToken: synthetic("access"), refreshToken: synthetic("refresh"), expiresAt })
    // Every safeguard on: a dead login and a valid one are cleaned; an expired
    // one, which Claude Code would try to refresh, is not even started.
    report.idleSweep = await idleSweep([
      idleRoot("dead-login", { accessToken: "", refreshToken: "", expiresAt: 0 }),
      idleRoot("valid-login", login(now + 6 * 3_600_000)),
      idleRoot("expired-login", login(now - 3_600_000)),
    ])
    assert.deepEqual(report.idleSweep.map((row) => [row.root, row.outcome, row.oldTranscriptKept, row.loginUnchanged]), [
      ["dead-login", "swept", false, true],
      ["valid-login", "swept", false, true],
      ["expired-login", "skipped:refresh-due", true, true],
    ])
    assert.ok(report.idleSweep[1].refusedConnections > 0, "the valid login's outbound connections should have been refused")
    // The token check overridden: the refusing proxy alone keeps an expired
    // login's refresh from reaching Anthropic, and the file from changing.
    report.idleSweepNetworkGateOnly = await idleSweep([idleRoot("expired-network-only", login(now - 3_600_000))], Number.NEGATIVE_INFINITY)
    const [networkOnly] = report.idleSweepNetworkGateOnly
    assert.equal(networkOnly.outcome, "swept")
    assert.equal(networkOnly.oldTranscriptKept, false)
    assert.equal(networkOnly.loginUnchanged, true, "an expired login changed although no connection could leave the machine")
    assert.ok(networkOnly.refusedConnections > 0, "the expired login's refresh attempts should have been refused")
  }
  console.log(JSON.stringify(report, null, 2))
  console.log(expectKept ? "PASS: nothing was deleted" : "PASS: the sweep ran, the swept session reads as unresumable, and the idle sweep cleaned without touching a login")
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
