#!/usr/bin/env bun
// Credentialless Linux gate. Run in a fresh container with --network none.
// The same row-preservation assertion must fail before #1328 and pass after.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir, networkInterfaces } from "node:os"
import { join, resolve } from "node:path"
import Database from "libsql"

const root = resolve(process.argv[2] ?? ".")
if (process.platform !== "linux" || Object.values(networkInterfaces()).flat().some(address => !address.internal)) {
  throw new Error("Run in an isolated Linux network namespace with loopback only")
}
const output = resolve(process.argv[3] ?? "telemetry-busy-evidence")
mkdirSync(output, { recursive: true })
const state = mkdtempSync(join(tmpdir(), "meridian-telemetry-busy-"))
for (const name of ["home", "config", "work", "tmp"]) mkdirSync(join(state, name))
const dbPath = join(state, "telemetry.db")
const port = 3467
const env = {
  PATH: process.env.PATH,
  HOME: join(state, "home"),
  CLAUDE_CONFIG_DIR: join(state, "config"),
  TMPDIR: join(state, "tmp"),
  MERIDIAN_PORT: String(port),
  MERIDIAN_TELEMETRY_PERSIST: "1",
  MERIDIAN_TELEMETRY_DB: dbPath,
}
const service = Bun.spawn([process.execPath, "run", join(root, "bin/cli.ts")], {
  cwd: join(state, "work"), env, stdout: "pipe", stderr: "pipe",
})
const serviceOutput = Promise.all([new Response(service.stdout).text(), new Response(service.stderr).text()])
let holder
let holderOutput
let lockWitness
let failure
const gapMs = Number(process.env.HOLDER_GAP_MS ?? 100)
if (!Number.isInteger(gapMs) || gapMs < 0) throw new Error("Invalid HOLDER_GAP_MS")
const result = { platform: process.platform, arch: process.arch, bun: Bun.version, lockMs: 400, gapMs, phases: [] }
async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function stop(child, pipes) {
  if (child.exitCode === null) child.kill("SIGTERM")
  try { await bounded(child.exited, 20_000, "child shutdown") }
  catch (error) {
    child.kill("SIGKILL")
    await bounded(child.exited, 5_000, "child kill")
    throw error
  }
  return await bounded(pipes, 5_000, "child pipe EOF")
}
function rows() {
  const db = new Database(dbPath)
  try { return db.prepare("SELECT count(*) AS count FROM metrics").get().count }
  finally { db.close() }
}
async function requests(count) {
  const statuses = []
  for (let i = 0; i < count; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-api-key": "fixture", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, messages: [{ role: "user", content: "telemetry fixture" }] }),
    })
    statuses.push(response.status)
    await response.text()
  }
  if (statuses.some(status => status !== 401)) throw new Error(`Expected credentialless 401: ${statuses}`)
  return statuses
}
try {
  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline && service.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      await response.text()
      ready = true
      break
    } catch { /* wait for the real server socket */ }
    await Bun.sleep(100)
  }
  if (!ready || !existsSync(dbPath)) throw new Error("Real server or SQLite telemetry did not start")
  const statusesA = await requests(2)
  const rowsA = rows()
  result.phases.push({ name: "uncontended", sent: 2, statuses: statusesA, rows: rowsA })
  if (rowsA !== 2) throw new Error("Uncontended negative control lost telemetry")
  holder = Bun.spawn([process.execPath, "-e", `
    const Database = require(${JSON.stringify(Bun.resolveSync("libsql", root))});
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma("busy_timeout = 10000");
    const deadline = Date.now() + 120000;
    let cycles = 0;
    while (!require("fs").existsSync(${JSON.stringify(join(state, "stop"))}) && Date.now() < deadline) {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO diagnostic_logs (timestamp, level, category, message) VALUES (1, 'info', 'fixture', 'held')").run();
      if (cycles === 0) console.log("locked");
      Bun.sleepSync(400); db.exec("COMMIT"); cycles++; Bun.sleepSync(${gapMs});
    }
    db.close(); console.log(JSON.stringify({cycles}));
  `], { env, stdout: "pipe", stderr: "pipe" })
  let sawLock
  lockWitness = new Promise(resolve => { sawLock = resolve })
  const reader = holder.stdout.getReader()
  const stderr = new Response(holder.stderr).text()
  holderOutput = Promise.all([(async () => {
    const chunks = []
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; const text = new TextDecoder().decode(chunk.value); chunks.push(text); if (text.includes("locked")) sawLock() }
    reader.releaseLock()
    return chunks.join("")
  })(), stderr])
  // Admit contention only after the holder reports actual lock acquisition.
  await bounded(lockWitness, 10_000, "holder lock witness")
  if (holder.exitCode !== null) throw new Error("Lock holder exited before contention")
  const statusesB = await requests(6)
  writeFileSync(join(state, "stop"), "stop")
  await bounded(holder.exited, 12_000, "holder release")
  // An HTTP response can precede its final telemetry observer. Join server
  // shutdown before reading durable rows, so no producer is still writing.
  await stop(service, serviceOutput)
  result.serverJoinedBeforeFinalCount = true
  const rowsB = rows() - rowsA
  result.phases.push({ name: "contended", sent: 6, statuses: statusesB, rows: rowsB })
  if (rowsB !== 6) throw new Error(`Contended request telemetry lost ${6 - rowsB} rows`)
} catch (error) { failure = error; result.failure = String(error) }
finally {
  if (holder) writeFileSync(join(state, "stop"), "stop")
  // Attempt both joins even if one child or pipe fails; preserve the first cause.
  const cleanup = await Promise.allSettled([
    holder ? stop(holder, holderOutput) : Promise.resolve(null),
    stop(service, serviceOutput),
  ])
  for (const [index, item] of cleanup.entries()) {
    if (item.status === "rejected") {
      if (!failure) failure = item.reason
      result.cleanupFailure = String(item.reason)
      continue
    }
    if (!item.value) continue
    const logs = item.value.join("\n")
    writeFileSync(join(output, index === 0 ? "holder.log" : "service.log"), logs)
    if (index === 0 && !logs.includes("locked")) {
      if (!failure) failure = new Error("No holder lock witness")
    }
    if (index === 1) result.writeFailures = (logs.match(/SQLite write failed, skipping/g) ?? []).length
  }
  result.directChildrenJoined = cleanup.every(item => item.status === "fulfilled")
  result.pass = !failure
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result))
}
process.exitCode = failure ? 1 : 0
