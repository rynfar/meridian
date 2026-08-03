#!/usr/bin/env bun
/**
 * Live E2E: does the WebFetch Preflight toggle reach the subprocess, and on
 * which adapters does it actually change anything?
 *
 * Two separate claims, and the second is the one that bites:
 *
 *   1. `webFetchPreflight: false` on adapter X must emit
 *      `skipWebFetchPreflight: true` in that spawn's `--settings`, and only
 *      that adapter's. Unit tests cover buildQueryOptions; this covers the
 *      whole path — settings file, adapter resolution, six call sites in
 *      server.ts — which is where a per-adapter setting actually goes wrong.
 *
 *   2. The setting only DOES anything where the subprocess can run the SDK's
 *      built-in WebFetch, because that is where the preflight lives. Every
 *      adapter but `cherry` prevents that: passthrough modes send `--tools`
 *      empty (all built-ins off) and internal modes put WebFetch in
 *      `--disallowed-tools`. Cherry unblocks the web tools so Claude can
 *      browse for itself (#481), so it is the only adapter where flipping
 *      this changes behaviour.
 *
 * Claim 2 is asserted, not just observed, because it is what docs/configuration.md
 * promises. If a future tool-config change lets another adapter run the
 * built-in WebFetch, this fails and the docs need updating — otherwise the
 * scope note silently rots and users turn off a check that is still running.
 *
 * Costs no tokens and needs no Claude Max: `claude` is replaced by a stub that
 * records its argv and exits. HOME is redirected to a temp dir so the run
 * cannot read or write your real ~/.config/meridian/sdk-features.json.
 *
 *   bun scripts/e2e-webfetch-preflight.mjs
 *
 * Run before releases touching sdkFeatures, query.ts settings, or tool config.
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

const PORT = Number(process.env.PREFLIGHT_E2E_PORT ?? 3994)
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = join(import.meta.dir, "..")

let failures = 0
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const fail = (m) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${m}`) }
const note = (m) => console.log(`  \x1b[33m•\x1b[0m ${m}`)

/**
 * What each case configures and what the spawn must then look like.
 * `builtinWebFetch` is the documented scope claim, asserted per adapter.
 */
const CASES = [
  {
    adapter: "cherry",
    features: { webFetchPreflight: false },
    expectSkip: true,
    builtinWebFetch: true,
    why: "cherry runs the built-in WebFetch itself (#481) — the toggle bites here",
  },
  {
    adapter: "cherry",
    features: null, // leave at default
    expectSkip: false,
    builtinWebFetch: true,
    why: "default is preflight ON, matching the subprocess default",
  },
  {
    adapter: "opencode",
    features: { webFetchPreflight: false },
    expectSkip: true,
    builtinWebFetch: false,
    why: "setting still routes, but built-ins are off so nothing changes",
  },
]

const dir = mkdtempSync(join(tmpdir(), "webfetch-preflight-"))
const argvLog = join(dir, "argv.log")
const stub = join(dir, "stub-claude.js")

// The SDK spawns `node <pathToClaudeCodeExecutable>`, so the stub is a JS file.
// It records argv and exits non-zero; we never need it to speak stream-json.
writeFileSync(stub, `const fs = require("fs")
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
process.exit(1)
`)
writeFileSync(argvLog, "")

const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

/** Read the argv of the most recent spawn, or null if nothing spawned. */
function lastSpawn() {
  const lines = readFileSync(argvLog, "utf8").trim()
  if (!lines) return null
  return JSON.parse(lines.split("\n").at(-1))
}

async function waitForHealth(deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok || r.status === 503) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

const proxy = spawn("bun", ["run", "./bin/cli.ts"], {
  cwd: ROOT,
  stdio: "ignore",
  env: {
    ...process.env,
    HOME: dir,                      // isolate sdk-features.json from the real one
    MERIDIAN_CLAUDE_PATH: stub,
    CLAUDE_PROXY_PORT: String(PORT),
  },
})

const cleanup = () => {
  try { proxy.kill() } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })
}
process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(130) })

console.log("webfetch preflight scope\n")

if (!(await waitForHealth())) {
  // Silence is not success: no proxy means no evidence either way.
  fail(`proxy did not come up on ${BASE}`)
  console.log(`\nFAIL (${failures}) — webfetch preflight`)
  process.exit(1)
}
// `degraded` is expected: the stub cannot answer `claude auth status`.
note("proxy up (health degraded — the stub has no auth, expected)")

// Guard the isolation itself. If HOME were not honoured this would rewrite the
// operator's real per-adapter config, which is not an acceptable test cost.
const realConfig = join(process.env.HOME ?? "/nonexistent", ".config", "meridian", "sdk-features.json")
const realBefore = existsSync(realConfig) ? readFileSync(realConfig, "utf8") : null

for (const c of CASES) {
  const label = `${c.adapter} ${c.features ? JSON.stringify(c.features) : "(default)"}`
  console.log(`\n${label}`)

  await fetch(`${BASE}/settings/api/features/${c.adapter}`, { method: "DELETE" })
  if (c.features) {
    const r = await fetch(`${BASE}/settings/api/features/${c.adapter}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.features),
    })
    if (!r.ok) { fail(`PATCH failed: ${r.status}`); continue }
  }

  writeFileSync(argvLog, "")
  await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-meridian-agent": c.adapter },
    body: JSON.stringify({ model: "sonnet", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  }).catch(() => {}) // the stub exits 1, so an error response is the norm

  const argv = lastSpawn()
  if (!argv) { fail(`${label}: no subprocess spawned — nothing to check`); continue }

  const settingsRaw = flagValue(argv, "--settings")
  if (!settingsRaw) { fail(`${label}: no --settings flag in argv`); continue }
  const settings = JSON.parse(settingsRaw)

  if (settings.skipWebFetchPreflight === c.expectSkip) {
    pass(`skipWebFetchPreflight=${c.expectSkip} — ${c.why}`)
  } else {
    fail(`skipWebFetchPreflight=${settings.skipWebFetchPreflight}, expected ${c.expectSkip}`)
  }

  // Scope: can this spawn actually invoke the SDK's built-in WebFetch?
  // `--tools` present-but-empty is the SDK's "disable all built-ins".
  const tools = flagValue(argv, "--tools")
  const disallowed = flagValue(argv, "--disallowed-tools") ?? ""
  const builtinsOff = tools !== null && tools.trim() === ""
  const blocked = disallowed.includes("WebFetch")
  const canRun = !builtinsOff && !blocked

  if (canRun === c.builtinWebFetch) {
    pass(`built-in WebFetch reachable=${canRun} — toggle is ${canRun ? "EFFECTIVE" : "INERT"} here`)
  } else {
    fail(
      `built-in WebFetch reachable=${canRun}, expected ${c.builtinWebFetch}` +
      ` (--tools=${JSON.stringify(tools)}, WebFetch disallowed=${blocked}).` +
      ` The scope note in docs/configuration.md is now wrong — fix one or the other.`
    )
  }
}

console.log("\nisolation")
const realAfter = existsSync(realConfig) ? readFileSync(realConfig, "utf8") : null
if (realAfter === realBefore) pass("real ~/.config/meridian/sdk-features.json untouched")
else fail("the run modified the real sdk-features.json — HOME isolation broke")

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — webfetch preflight`)
process.exit(failures === 0 ? 0 : 1)
