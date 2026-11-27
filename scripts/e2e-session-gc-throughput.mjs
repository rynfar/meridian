#!/usr/bin/env bun
// How many orphaned transcripts does one session GC sweep delete, through the
// real Agent SDK in child processes, at the default settings, and how long
// does that take against a large lifecycle file? No model calls.
//
// Live, 2026-10-09: every turn leaves its fork's transcript for the GC, and
// parallel runs left 1,100-1,700 an hour. Sweeps run on the interval and
// after every managed fork publication, so under load they ran back to back,
// but a fixed 256-transcript backlog over the 11-minute grace let only about
// 23 transcripts a minute be retired. Orphaned transcripts stayed live until
// they filled the ownership ceiling, and every request that needed a new one
// was refused 503 overloaded_error ("session transcript ownership capacity is
// full").
//
// The gate makes ORPHANS live transcripts, each a real file where the SDK
// keeps sessions, none pinned by a mapping. The first REGISTERED are
// registered the way the proxy does; the rest are written straight into the
// lifecycle file in the same shape, so a store of tens of thousands is quick
// to build. A first sweep retires as many as the backlog allows; after the
// grace (1 s here) a second sweep deletes as many as it may, each with the
// SDK's deleteSession in a gated child process, every deletion rewriting the
// whole lifecycle file under its lock. The backlog is MAX_PENDING for every
// run, so only the deletion rate and the store's size differ.
//
//   bun scripts/e2e-session-gc-throughput.mjs                                  # 300 orphans
//   ORPHANS=20000 MAX_PENDING=2112 bun scripts/e2e-session-gc-throughput.mjs   # a large store
//   E2E_MERIDIAN_ROOT=<checkout> bun scripts/e2e-session-gc-throughput.mjs     # another tree's src
//
// MAX_DELETES sets MERIDIAN_SESSION_GC_MAX_DELETES and the count expected
// (64 when unset, the build's default). DRAINING=1 starts the proxy's drain
// before the deleting sweep, as close() does before its final one, and
// expects at most 16.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? ".")
const ORPHANS = Number(process.env.ORPHANS ?? 300)
const REGISTERED = Math.max(1, Math.min(ORPHANS, Number(process.env.REGISTERED ?? 300)))
const MAX_PENDING = process.env.MAX_PENDING ?? "1000"
const DRAINING = process.env.DRAINING === "1"
const EXPECTED_DELETES = DRAINING ? Math.min(16, Number(process.env.MAX_DELETES ?? 64)) : Number(process.env.MAX_DELETES ?? 64)
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-gc-throughput-")))
const profileDir = join(root, "profile")
const projectDir = join(root, "project")
const storeDir = join(root, "sessions")
const lifecycleFile = join(storeDir, "session-gc.json")
mkdirSync(projectDir, { recursive: true })
const sessionsDir = join(profileDir, "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"))
mkdirSync(sessionsDir, { recursive: true })

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: storeDir, MERIDIAN_WORKDIR: projectDir,
  MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_SESSION_GC_GRACE_MS: "1000", MERIDIAN_SESSION_GC_MAX_PENDING: MAX_PENDING,
  ...(process.env.MAX_DELETES ? { MERIDIAN_SESSION_GC_MAX_DELETES: process.env.MAX_DELETES } : {}),
})

const { createProxyServer } = await import(pathToFileURL(join(repo, "src/proxy/server.ts")).href)
const { getTranscriptResourceKey, registerLiveTranscript } = await import(pathToFileURL(join(repo, "src/proxy/sessionLifecycle.ts")).href)
const { setSessionStoreDir } = await import(pathToFileURL(join(repo, "src/proxy/sessionStore.ts")).href)
setSessionStoreDir(storeDir)

const failures = []
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

function writeTranscript(sessionId) {
  const file = join(sessionsDir, `${sessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "orphan" } })}\n`)
  return file
}

// The shape registerLiveTranscript leaves: one live record per transcript, its
// generation drawn from the key's fence slot (the key's first four hex digits).
// A lifecycle file the build cannot read fails the first sweep loudly.
function writeBulkTranscripts(count, files) {
  const sidecar = JSON.parse(readFileSync(lifecycleFile, "utf8"))
  const seed = Object.values(sidecar.resources)[0]
  const now = Date.now()
  for (let i = 0; i < count; i++) {
    const sessionId = randomUUID()
    files.push(writeTranscript(sessionId))
    const locator = { ...seed.locator, sessionId }
    const key = getTranscriptResourceKey(locator)
    const slot = key.slice(0, 4)
    const counter = (sidecar.meta.fenceSlots[slot] ?? 0) + 1
    sidecar.meta.fenceSlots[slot] = counter
    sidecar.resources[key] = {
      key, generation: `r:${key}:${counter}`, locator, state: "live", createdAt: now, updatedAt: now, attempts: 0,
    }
  }
  writeFileSync(lifecycleFile, `${JSON.stringify(sidecar)}\n`, { mode: 0o600 })
}

function stateCounts() {
  const counts = {}
  for (const resource of Object.values(JSON.parse(readFileSync(lifecycleFile, "utf8")).resources)) {
    counts[resource.state] = (counts[resource.state] ?? 0) + 1
  }
  return counts
}

try {
  console.log(`${ORPHANS} orphaned transcripts (${REGISTERED} registered, ${ORPHANS - REGISTERED} written in bulk), backlog ${MAX_PENDING}${DRAINING ? ", draining" : ""}, proxy ${repo}`)
  const files = []
  for (let i = 0; i < REGISTERED; i++) {
    const sessionId = randomUUID()
    files.push(writeTranscript(sessionId))
    await registerLiveTranscript({ sessionId, configDir: profileDir, projectDir })
  }
  if (ORPHANS > REGISTERED) writeBulkTranscripts(ORPHANS - REGISTERED, files)
  console.log(`  note  lifecycle file ${(statSync(lifecycleFile).size / 1_048_576).toFixed(1)} MB`)

  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", defaultProfile: "p", profiles: [{ id: "p", claudeConfigDir: profileDir }] })
  let startedAt = Date.now()
  await proxy.sweepSessionGc()
  const retireSeconds = (Date.now() - startedAt) / 1000
  console.log(`  note  the first sweep retired ${stateCounts().retired ?? 0} in ${retireSeconds.toFixed(1)} s`)
  await new Promise(resolve => setTimeout(resolve, 1_500))
  if (DRAINING) proxy.beginDrain()
  startedAt = Date.now()
  await proxy.sweepSessionGc()
  const seconds = (Date.now() - startedAt) / 1000
  const deleted = files.filter(file => !existsSync(file)).length
  console.log(`  note  the second sweep deleted ${deleted} transcript file(s) in ${seconds.toFixed(1)} s` +
    (deleted ? `, ${(seconds / deleted * 1000).toFixed(0)} ms each` : "") +
    `; lifecycle file now ${JSON.stringify(stateCounts())}`)
  check(deleted === EXPECTED_DELETES, `one sweep deletes ${EXPECTED_DELETES} orphaned transcripts through the SDK`, `${deleted}`)
  check(seconds < 30, "within the sweep's 30-second budget", `${seconds.toFixed(1)} s`)
} finally {
  setSessionStoreDir(null)
  rmSync(root, { recursive: true, force: true })
}
console.log(failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED: ${failures.join("; ")}`)
process.exit(failures.length === 0 ? 0 : 1)
