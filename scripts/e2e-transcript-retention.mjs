// Opt-in. Needs no credentials, network or running proxy: it drives the
// installed Claude Code CLI through the Agent SDK with the options Meridian
// builds, in disposable directories, and never sends the model a message.
//
//   MERIDIAN_TRANSCRIPT_RETENTION_DAYS=30 \
//     bun scripts/e2e-transcript-retention.mjs   # opted in: the cleanup runs
//   bun scripts/e2e-transcript-retention.mjs     # default, off: nothing is deleted
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"

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
const expectKept = retention.days === 0
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
  if (expectKept) assert.equal(report.cleanupPeriodDays, null, "retention is off, yet a period was passed")
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

  console.log(JSON.stringify(report, null, 2))
  console.log(expectKept ? "PASS: nothing was deleted" : "PASS: the sweep ran and the swept session reads as unresumable")
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
