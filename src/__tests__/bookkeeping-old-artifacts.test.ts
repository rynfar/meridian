import { afterAll, beforeAll, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"

const root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-old-artifacts-")))
const artifacts: Array<{ name: string; module: string }> = []
const unavailable = new Map<string, string>()
const tarballs: Array<[string, string]> = []
const pack = spawnSync("npm", ["pack", "@rynfar/meridian@1.78.0", "--pack-destination", root,
  "--fetch-retries=0", "--fetch-timeout=10000"], { encoding: "utf8", timeout: 20000 })
if (pack.status === 0) tarballs.push(["npm", join(root, "rynfar-meridian-1.78.0.tgz")])
else unavailable.set("npm", `npm 1.78.0 unavailable (network/cache/tool): ${pack.error?.message ?? pack.stderr.slice(-200)}`)
const compat = process.env.BOOKKEEPING_COMPAT_TARBALL
if (compat && existsSync(compat)) tarballs.push(["compat", compat])
else unavailable.set("compat", "BOOKKEEPING_COMPAT_TARBALL is unset, empty or does not exist")
for (const [name, reason] of unavailable) console.warn(`SKIP ${name}: ${reason}`)
if (tarballs.length === 0) rmSync(root, { recursive: true, force: true })

function artifactTest(name: string, title: string, body: () => void | Promise<void>, timeout: number) {
  const reason = unavailable.get(name)
  if (reason) it.skip(`${title} — ${reason}`, body)
  else it(title, body, timeout)
}
beforeAll(async () => {
  if (!tarballs.length) return
  for (const [name, tarball] of tarballs) {
    const directory = join(root, name!)
    mkdirSync(directory)
    const unpack = spawnSync("tar", ["-xzf", tarball!, "-C", directory], { encoding: "utf8" })
    expect(unpack.status, unpack.stderr).toBe(0)
    const dist = join(directory, "package", "dist")
    symlinkSync(resolve("node_modules"), join(directory, "package", "node_modules"), "junction")
    const chunks = readdirSync(dist).filter((file) => file.endsWith(".js")
      && readFileSync(join(dist, file), "utf8").includes("function storeSharedSession("))
    expect(chunks).toHaveLength(1)
    const module = join(dist, "bookkeeping-probe.mjs")
    // Published bundles have no public storage export. Expose existing lexical bindings only;
    // do not rewrite any implementation or substitute current source for the old artifact.
    writeFileSync(module, readFileSync(join(dist, chunks[0]!), "utf8") + "\nexport { storeSharedSession, "
      + "prepareForkForPublication, acquireLock, releaseLock, createSdkProcessGate, attachActiveTranscriptExecutor, "
      + "ensureTranscriptJournaled, acquireActiveTranscriptLease };\n")
    artifacts.push({ name: name!, module: pathToFileURL(module).href })
  }
  const build = await buildNodeFixture("bookkeeping-transition.ts", "transition.mjs", root)
  expect(build.success).toBe(true)
  const cli = await Bun.build({ entrypoints: [resolve("bin/session-bookkeeping.ts")], target: "node",
    naming: "cli.mjs", outdir: root, external: ["libsql"] })
  expect(cli.success, String(cli.logs)).toBe(true)
}, 150000)
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function oldChild(module: string, directory: string, action: "store" | "lifecycle" | "sdk" | "sdk-control") {
  const script = `
    const old = await import(${JSON.stringify(module)});
    const directory = ${JSON.stringify(directory)};
    const options = { storeDir: directory, lockWaitMs: 80, lockRetryMs: 5, lockStaleMs: 1 };
    try {
      if (${JSON.stringify(action)} === 'store') old.storeSharedSession('probe', 'probe', 1);
      else if (${JSON.stringify(action)} === 'lifecycle')
        await old.prepareForkForPublication({ configDir: directory, sessionId: 'probe' }, options);
      else {
        let lease = { token: 'probe', resourceKeys: ['probe'] };
        if (${JSON.stringify(action)} === 'sdk-control') {
          const locator = await old.ensureTranscriptJournaled({ configDir: directory, sessionId: 'probe' }, options);
          lease = await old.acquireActiveTranscriptLease([locator], options);
        }
        const gate = await old.createSdkProcessGate(directory + '/sdk-process-gates',
          (executor, recoverable) => old.attachActiveTranscriptExecutor(
            lease, executor, options, recoverable));
        try {
          // Outlast closeAndJoin's grace and await natural completion before cleanup.
          const child = gate.spawnClaudeCodeProcess({ command: process.execPath,
             args: ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "started"), 400)', directory + '/physical-sdk-writer'],
             env: process.env, signal: new AbortController().signal });
          await new Promise((resolve, reject) => {
            if (child.exitCode !== null) {
              if (child.exitCode === 0) resolve();
              else reject(new Error('SDK writer exited ' + child.exitCode));
              return;
            }
            const timer = setTimeout(() => reject(new Error('SDK writer did not exit within 5s')), 5000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => {
              clearTimeout(timer);
              if (code === 0 && signal === null) resolve();
              else reject(new Error('SDK writer exit=' + code + ' signal=' + signal));
            });
          });
        } finally { await gate.closeAndJoin(); }
      }
      process.exit(0);
    } catch (error) { console.error(error); process.exit(17); }
  `
  return spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000,
    env: { ...process.env, HOME: root, MERIDIAN_SESSION_DIR: directory, MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "80" } })
}

for (const name of ["npm", "compat"]) artifactTest(name, `${name} physical SDK gate positive control really executes the writer`, () => {
  const artifact = artifacts.find((item) => item.name === name)!
  const directory = realpathSync(mkdtempSync(join(root, "sdk-control-")))
  const result = oldChild(artifact.module, directory, "sdk-control")
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(readFileSync(join(directory, "physical-sdk-writer"), "utf8")).toBe("started")
}, 20000)

const cuts = [undefined, ...["PREPARED", "staged:session-gc.json", "staged:sessions.json", "STAGED",
  "linked:session-gc.json", "moved:session-gc.json", "linked:sessions.json", "moved:sessions.json", "INSTALLED",
  "checkpoint", "closed", "CHECKPOINTED", "linked:session-bookkeeping.sqlite", "moved:session-bookkeeping.sqlite",
  "linked:session-bookkeeping.sqlite-wal", "moved:session-bookkeeping.sqlite-wal",
  "linked:session-bookkeeping.sqlite-shm", "moved:session-bookkeeping.sqlite-shm", "ARCHIVED", "EXPORTED"]
  .map((point) => `export:${point}`)]
for (const name of ["npm", "compat"]) for (const cut of cuts) {
  artifactTest(name, `${name} actual old bundle cannot write beyond stale TTL at ${cut ?? "READY"}`, async () => {
    const artifact = artifacts.find((item) => item.name === name)!
    const directory = realpathSync(mkdtempSync(join(root, "data-")))
    await migrateBookkeeping(directory, { writersStopped: true })
    if (cut) {
      const result = spawnSync("node", [join(root, "transition.mjs"), "export", directory], {
        encoding: "utf8", timeout: 15000, env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: cut },
      })
      expect(result.signal, result.stdout + result.stderr).toBe("SIGKILL")
    }
    const baseline = new Map(["sessions.json", "session-gc.json"].map((file) => [file,
      existsSync(join(directory, file)) ? readFileSync(join(directory, file), "utf8") : undefined]))
    for (const file of ["sessions.json.lock", "session-gc.json.lock"]) {
      utimesSync(join(directory, file), new Date(0), new Date(0))
    }
    for (const action of ["store", "lifecycle", "sdk"] as const) {
      const result = oldChild(artifact.module, directory, action)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(17)
      expect(result.stderr).toContain("timed out waiting for")
      for (const [file, bytes] of baseline) {
        if (bytes === undefined) expect(existsSync(join(directory, file))).toBe(false)
        else expect(readFileSync(join(directory, file), "utf8")).toBe(bytes)
      }
      expect(existsSync(join(directory, "physical-sdk-writer"))).toBe(false)
    }
  }, 60000)
}

for (const name of ["npm", "compat"]) artifactTest(name, `${name} old process holding its lock refuses migration with 3`, async () => {
  const artifact = artifacts.find((item) => item.name === name)!
  const directory = realpathSync(mkdtempSync(join(root, "held-")))
  const child = spawn("node", ["--input-type=module", "-e", `
    const old = await import(${JSON.stringify(artifact.module)});
    const lock = old.acquireLock(${JSON.stringify(join(directory, "sessions.json.lock"))});
    process.send('locked');
    process.on('disconnect', () => { old.releaseLock(lock); process.exit(0); });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, HOME: root } })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`old holder exited before acquiring lock: ${code}`)
    })])
    const result = spawnSync("node", [join(root, "cli.mjs"), "migrate", "--session-dir", directory,
      "--writers-stopped", "--json"], { encoding: "utf8", timeout: 15000,
      env: { ...process.env, MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "80" } })
    expect(result.status, result.stdout + result.stderr).toBe(3)
    expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }
  }
}, 20000)

// Release is intentionally the end of fencing, not another negative-write window.
for (const name of ["npm", "compat"]) for (const cut of ["barrier:releasing:session-gc.json",
  "export:released:session-gc.json", "barrier:releasing:sessions.json", "export:released:sessions.json"]) {
  artifactTest(name, `${name} old writes follow each per-file release boundary at ${cut}`, async () => {
    const artifact = artifacts.find((item) => item.name === name)!
    const directory = realpathSync(mkdtempSync(join(root, "release-")))
    await migrateBookkeeping(directory, { writersStopped: true })
    const result = spawnSync("node", [join(root, "transition.mjs"), "export", directory], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: cut },
    })
    expect(result.signal, result.stdout + result.stderr).toBe("SIGKILL")
    expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
    for (const action of ["store", "lifecycle"] as const) {
      const path = join(directory, action === "store" ? "sessions.json.lock" : "session-gc.json.lock")
      const protectedPath = existsSync(path)
      if (protectedPath) utimesSync(path, new Date(0), new Date(0))
      const result = oldChild(artifact.module, directory, action)
      expect(result.status, result.stdout + result.stderr).toBe(protectedPath ? 17 : 0)
      if (protectedPath) expect(result.stderr).toContain("timed out waiting for")
    }
  }, 30000)
}
