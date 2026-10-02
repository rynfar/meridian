#!/usr/bin/env node
// Independently installed artifacts only. This is a storage/server smoke, not a live model E2E.
import assert from "node:assert/strict"
import { fork, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { lstatSync } from "node:fs"
import { fileURLToPath } from "node:url"

const argument = process.argv.indexOf("--package")
if (argument < 0 || !process.argv[argument + 1]) throw new Error("usage: --package <fresh.tgz>")
const tarball = resolve(process.argv[argument + 1])
const baselineArgument = process.argv.indexOf("--baseline-package")
const baselineSpec = baselineArgument >= 0 ? resolve(process.argv[baselineArgument + 1]) : "@rynfar/meridian@1.78.0"
const root = mkdtempSync(join(tmpdir(), "meridian-packaged-bookkeeping-"))
const children = []
const home = join(root, "home")
mkdirSync(home, { mode: 0o700 })
const env = {
  PATH: process.env.PATH, HOME: home, TMPDIR: root, SystemRoot: process.env.SystemRoot,
  MERIDIAN_CREDENTIALS_READONLY: "1", MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_SESSION_GC_INTERVAL_MS: "0",
}
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 })
  assert.equal(result.status, expected, `${command}: ${result.stderr}\n${result.stdout}`)
  return result.stdout
}
function install(name, spec) {
  const directory = join(root, name)
  mkdirSync(directory)
  writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}')
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", spec], directory)
  return join(directory, "node_modules", "@rynfar", "meridian")
}
const childFile = fileURLToPath(new URL("./fixtures/bookkeeping-package-server.mjs", import.meta.url))
const legacyWriter = fileURLToPath(new URL("./fixtures/bookkeeping-package-legacy-writer.mjs", import.meta.url))
async function start(packageRoot, sessionDirectory, mode, instances = "1", extraEnv = {}) {
  const child = fork(childFile, [packageRoot, sessionDirectory, mode, instances], {
    env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  children.push(child)
  let stderr = ""
  child.stderr.on("data", bytes => { stderr += bytes })
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => { throw new Error(`package child exited ${code}: ${stderr}`) }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`package child startup timed out: ${stderr}`)), 30_000)
      timer.unref()
    }),
  ])
  assert.equal(ready.type, "ready")
  return { child, url: ready.url }
}
async function stop(child) {
  const exit = once(child, "exit")
  child.send({ type: "close" })
  const [code] = await exit
  assert.equal(code, 0)
}
async function usage(url, expected) {
  const response = await fetch(`${url}/v1/sessions/packaged-session/context-usage`)
  assert.equal(response.status, expected)
  if (expected === 200) assert.equal((await response.json()).context_usage.input_tokens, 77)
}
try {
  const candidate = install("candidate", tarball)
  const baseline = install("baseline", baselineSpec)
  const directory = join(root, "sessions")
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({ packaged: {
    claudeSessionId: "packaged-session", createdAt: 1, lastUsedAt: Date.now(), messageCount: 1,
    contextUsage: { input_tokens: 77, output_tokens: 11 },
  } }), { mode: 0o600 })
  const cli = join(candidate, "dist", "session-bookkeeping.js")
  const legacy = await start(baseline, directory, "json")
  await usage(legacy.url, 200)
  await stop(legacy.child)
  await assert.rejects(start(candidate, directory, "sqlite"), /offline migration/)
  run(process.execPath, [cli, "migrate", "--session-dir", directory, "--writers-stopped", "--json"], root)
  const first = await start(candidate, directory, "sqlite")
  const second = await start(candidate, directory, "sqlite")
  await usage(first.url, 200)
  await usage(second.url, 200)
  // Real maintenance exclusivity while two actual runtime processes hold the shared guard.
  run(process.execPath, [cli, "export-json", "--session-dir", directory, "--json"], root, 4)
  await stop(first.child)
  await usage(second.url, 200)
  await stop(second.child)
  const restarted = await start(candidate, directory, "sqlite")
  await usage(restarted.url, 200)
  await stop(restarted.child)
  run(process.execPath, [cli, "export-json", "--session-dir", directory, "--json"], root)
  const rollback = await start(baseline, directory, "json")
  await usage(rollback.url, 200)
  await stop(rollback.child)
  const freshDirectory = join(root, "fresh")
  const fresh = await start(candidate, freshDirectory, "sqlite")
  assert.equal((await fetch(`${fresh.url}/health`)).status, 200)
  await usage(fresh.url, 404)
  const legacyControl = join(root, "legacy-writer-control")
  mkdirSync(legacyControl, { mode: 0o700 })
  run(process.execPath, [legacyWriter, baseline, legacyControl], root)
  assert(existsSync(join(legacyControl, "sessions.json")), "old writer control must actually write JSON")
  run(process.execPath, [legacyWriter, baseline, freshDirectory], root, 73)
  assert(!existsSync(join(freshDirectory, "sessions.json")), "old writer bypassed fresh SQL barriers")
  const inspected = JSON.parse(run(process.execPath, [cli, "inspect", "--session-dir", freshDirectory, "--json"], root))
  assert.equal(inspected.phase, "ready")
  await stop(fresh.child)
  run(process.execPath, [cli, "export-json", "--session-dir", freshDirectory, "--json"], root)
  const sameBuildJson = await start(candidate, freshDirectory, "json")
  assert.equal((await fetch(`${sameBuildJson.url}/health`)).status, 200)
  await stop(sameBuildJson.child)
  for (const [key, createdAt, messageCount] of [["bad\u0000key", 1, 0], ["key", 1.5, 0], ["key", 1, 1.5]]) {
    const invalid = join(root, `invalid-${createdAt}-${messageCount}-${key.length}`)
    mkdirSync(invalid, { mode: 0o700 })
    const bytes = JSON.stringify({ [key]: { claudeSessionId: "sdk", createdAt, lastUsedAt: 2, messageCount } })
    writeFileSync(join(invalid, "sessions.json"), bytes, { mode: 0o600 })
    run(process.execPath, [cli, "migrate", "--session-dir", invalid, "--writers-stopped", "--json"], root, 3)
    assert.equal(readFileSync(join(invalid, "sessions.json"), "utf8"), bytes)
    for (const name of ["session-bookkeeping.sqlite", "session-bookkeeping-migration.json", "session-gc.json.lock", "sessions.json.lock"])
      assert(!existsSync(join(invalid, name)), `invalid import changed authority: ${name}`)
  }
  for (const sharedDirectory of ["default", join(root, "explicit-two")]) {
    const two = await start(candidate, sharedDirectory, "sqlite", "2")
    assert.equal((await fetch(`${two.url}/health`)).status, 200)
    await stop(two.child)
  }
  const recoveryDirectory = join(root, "recovery")
  const recovery = await start(candidate, recoveryDirectory, "sqlite")
  await stop(recovery.child)
  const guardPath = join(realpathSync(recoveryDirectory), "session-bookkeeping-maintenance.sqlite")
  const identity = lstatSync(guardPath), intentId = randomUUID()
  writeFileSync(`${guardPath}.deletion-intent.releasing-${intentId}-${randomUUID()}`, JSON.stringify({
    source: guardPath, id: intentId, dev: identity.dev, ino: identity.ino,
    private: `${guardPath}.releasing-${intentId}-${randomUUID()}`,
  }), { mode: 0o600 })
  run(process.execPath, [cli, "inspect", "--session-dir", recoveryDirectory, "--json"], root, 4)
  await assert.rejects(start(candidate, recoveryDirectory, "sqlite"), /unsafe legacy maintenance-guard retirement/)
  run(process.execPath, [cli, "recover-guard-retirement", "--session-dir", recoveryDirectory, "--json"], root, 2)
  run(process.execPath, [cli, "recover-guard-retirement", "--session-dir", recoveryDirectory, "--writers-stopped", "--json"], root)
  assert.equal(lstatSync(guardPath).ino, identity.ino, "recovery replaced the published coordination inode")
  mkdirSync(join(recoveryDirectory, "deletion-gates"), { mode: 0o700 })
  const gateName = `deletion-gates/${randomUUID()}.go`
  writeFileSync(join(recoveryDirectory, gateName), "go\n", { mode: 0o600 })
  run(process.execPath, [cli, "export-json", "--session-dir", recoveryDirectory, "--json"], root, 4)
  run(process.execPath, [cli, "export-json", "--session-dir", recoveryDirectory, "--writers-stopped", "--json"], root)
  const recoveryJournal = JSON.parse(readFileSync(join(recoveryDirectory, "session-bookkeeping-migration.json"), "utf8"))
  assert(!existsSync(join(recoveryDirectory, gateName)))
  assert.equal(readFileSync(join(recoveryDirectory, "bookkeeping-cycles", recoveryJournal.id, "residue", gateName), "utf8"), "go\n")
  for (const [kind, name] of [["guard", "session-bookkeeping-maintenance.sqlite"], ["main", "session-bookkeeping.sqlite"], ["fresh", "session-bookkeeping.sqlite"]]) {
    const interrupted = join(root, `bootstrap-${kind}`)
    mkdirSync(interrupted, { mode: 0o700 })
    const point = `bootstrap:linked:${name}`
    if (kind === "fresh") {
      await assert.rejects(start(candidate, interrupted, "sqlite", "1", { MERIDIAN_BOOKKEEPING_TEST_CRASH: point }), /exited/)
    } else {
      writeFileSync(join(interrupted, "sessions.json"), "{}", { mode: 0o600 })
      const killed = spawnSync(process.execPath, [cli, "migrate", "--session-dir", interrupted, "--writers-stopped", "--json"],
        { cwd: root, env: { ...env, MERIDIAN_BOOKKEEPING_TEST_CRASH: point }, encoding: "utf8", timeout: 30_000 })
      assert.equal(killed.signal, "SIGKILL")
    }
    const pub = join(interrupted, name), before = lstatSync(pub)
    assert.equal(before.nlink, 2)
    const classified = JSON.parse(run(process.execPath, [cli, "inspect", "--session-dir", interrupted, "--json"], root))
    assert(classified.temporary.some(row => row.kind === "bootstrap-alias"))
    assert.equal(lstatSync(pub).nlink, 2, "inspection mutated bootstrap residue")
    run(process.execPath, [cli, "recover-bootstrap", "--session-dir", interrupted, "--writers-stopped", "--json"], root)
    run(process.execPath, [cli, "migrate", "--session-dir", interrupted, "--writers-stopped", "--json"], root)
    assert.equal(lstatSync(pub).ino, before.ino)
    assert.equal(lstatSync(pub).nlink, 1)
    assert.equal(JSON.parse(run(process.execPath, [cli, "inspect", "--session-dir", interrupted, "--json"], root)).phase, "ready")
  }
  console.log(JSON.stringify({ verdict: "PASS", node: process.version, platform: process.platform,
    architecture: process.arch, surface: "packaged runtime, migration, two HTTP processes, restart, export and baseline read",
    liveSdk: false }))
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit")
      child.kill("SIGKILL")
      await exit
    }
  }
  rmSync(root, { recursive: true, force: true })
}
