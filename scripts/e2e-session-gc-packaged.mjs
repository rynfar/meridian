#!/usr/bin/env node
// Packaging smoke for the session-GC deletion budgets.
//
// Extracts a real npm tarball of this package, boots the packaged
// createProxyServer(), and drives its exported sweepSessionGc() against an
// isolated temporary store seeded with one retired transcript. The deletion
// runs through the real fenced SDK child (the packaged bundle spawning a real
// node child importing the real @anthropic-ai/claude-agent-sdk shipped as a
// dependency).
//
// Scope honesty: this is a packaging + end-to-end deletion-path smoke. It does
// NOT claim fixture parity with real proxy traffic — no live model, no real
// client, no real transcripts — and it must not be cited as such.
//
// Usage: node scripts/e2e-session-gc-packaged.mjs <path-to-tarball.tgz>
// Exits 0 when the packaged sweep deletes the seeded transcript and leaves no
// stale gate; any other exit is a failure with the observed state printed.

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const tarball = resolve(process.argv[2] ?? "")
if (!tarball || !existsSync(tarball)) {
  console.error(`usage: node scripts/e2e-session-gc-packaged.mjs <path-to-tarball.tgz>`)
  process.exit(2)
}
if (!tarball.endsWith(".tgz")) {
  console.error(`expected an npm pack tarball (.tgz), got: ${tarball}`)
  process.exit(2)
}

// The extracted package resolves its external dependencies
// (@anthropic-ai/claude-agent-sdk, jsonc-parser) by walking up to a
// node_modules directory; symlink the checkout's own so the smoke runs
// offline and installs nothing.
const repoNodeModules = resolve(dirname(new URL(import.meta.url).pathname), "..", "node_modules")
if (!existsSync(repoNodeModules)) {
  console.error(`node_modules not found next to the checkout: ${repoNodeModules} — run npm ci first`)
  process.exit(2)
}

const root = await mkdtemp(join(tmpdir(), "meridian-gc-packaged-smoke-"))
const paths = {
  pkg: join(root, "pkg"),
  home: join(root, "home"),
  config: join(root, "config"),
  project: join(root, "project"),
  store: join(root, "store"),
}
for (const dir of [paths.pkg, paths.home, paths.config, paths.project, paths.store]) {
  await mkdir(dir, { recursive: true })
}

let failure = undefined
try {
  // -- Extract the real tarball ------------------------------------------------
  await execFileAsync("tar", ["-xzf", tarball, "-C", paths.pkg, "--strip-components=1"])
  await symlink(repoNodeModules, join(paths.pkg, "node_modules"), "dir")
  const packagedPackageJson = JSON.parse(await readFile(join(paths.pkg, "package.json"), "utf8"))

  // -- The fix must actually be in the bundle ---------------------------------
  // The bundle is code-split: scan every packaged chunk, not only the entry.
  const distDir = join(paths.pkg, "dist")
  const bundleText = readdirSync(distDir, { recursive: true })
    .filter((file) => String(file).endsWith(".js"))
    .map((file) => readFileSync(join(distDir, String(file)), "utf8"))
    .join("\n")
  for (const marker of [
    "SESSION_GC_HANDSHAKE_TIMEOUT_MS",
    "session deletion executor handshake timed out",
  ]) {
    if (!bundleText.includes(marker)) {
      throw new Error(`packaged dist bundles are missing the budget fix marker: ${marker}`)
    }
  }

  // -- Isolate every writable path before the module loads --------------------
  process.env.HOME = paths.home
  process.env.CLAUDE_CONFIG_DIR = paths.config
  process.env.MERIDIAN_SESSION_DIR = paths.store
  process.env.MERIDIAN_BACKEND = "claude"

  // -- Seed one retired transcript in the isolated store ----------------------
  const sessionId = "00000000-0000-4000-8000-00000000cafe"
  const locator = { sessionId, configDir: paths.config, projectDir: paths.project }
  const key = createHash("sha256")
    .update(locator.configDir)
    .update("\0")
    .update(locator.sessionId)
    .digest("hex")
  const now = Date.now()
  const sidecar = {
    version: 2,
    meta: { fenceSlots: { [key.slice(0, 4)]: 1 } },
    resources: {
      [key]: {
        key,
        generation: `r:${key}:1`,
        locator,
        state: "retired",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        nextAttemptAt: 0,
      },
    },
  }
  await writeFile(join(paths.store, "session-gc.json"), `${JSON.stringify(sidecar)}\n`, "utf8")

  // -- Boot the packaged server and sweep -------------------------------------
  const packaged = await import(pathToFileURL(join(paths.pkg, "dist", "server.js")).href)
  if (typeof packaged.createProxyServer !== "function") {
    throw new Error("packaged entrypoint does not export createProxyServer")
  }
  const server = packaged.createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  if (typeof server.sweepSessionGc !== "function") {
    throw new Error("packaged createProxyServer() does not expose sweepSessionGc")
  }
  const sweepTimeout = new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sweepSessionGc did not settle within 120s")), 120_000)
    timer.unref?.()
  })
  await Promise.race([server.sweepSessionGc(), sweepTimeout])

  // -- Assert the fenced deletion actually settled ----------------------------
  const settled = JSON.parse(await readFile(join(paths.store, "session-gc.json"), "utf8"))
  const resource = settled.resources[key]
  if (!resource) throw new Error("seeded resource vanished from the sidecar")
  if (resource.state !== "deleted") {
    throw new Error(
      `expected state "deleted", observed "${resource.state}"`
      + (resource.lastError ? ` (lastError: ${resource.lastError})` : ""),
    )
  }
  if (resource.deletionToken !== undefined || resource.deletionExecutor !== undefined) {
    throw new Error("deletion finished with a stale token or executor record")
  }
  const gatesDir = join(paths.store, "deletion-gates")
  const leftoverGates = existsSync(gatesDir) ? readdirSync(gatesDir) : []
  if (leftoverGates.length > 0) {
    throw new Error(`deletion gate files leaked: ${leftoverGates.join(", ")}`)
  }

  console.log(JSON.stringify({
    smoke: "session-gc-packaged",
    verdict: "pass",
    disclaimer: "packaging + fenced-child deletion smoke; NOT real-traffic evidence",
    tarball,
    packagedVersion: packagedPackageJson.version,
    resourceState: resource.state,
    leftoverGates: leftoverGates.length,
    root,
  }, null, 2))
} catch (error) {
  failure = error
  console.error(JSON.stringify({
    smoke: "session-gc-packaged",
    verdict: "fail",
    tarball,
    error: error instanceof Error ? error.message : String(error),
    root,
  }, null, 2))
} finally {
  if (!process.env.MERIDIAN_GC_PACKAGED_SMOKE_KEEP) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  } else {
    console.error(`kept smoke root: ${root}`)
  }
}
if (failure) process.exit(1)
