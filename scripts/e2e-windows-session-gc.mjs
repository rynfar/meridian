#!/usr/bin/env bun
// Real SDK transcript creation, pin protection and fenced deletion. Optionally
// drive the actual Pi client with PI_CLI_PATH pointing to its dist/cli.js.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const root = mkdtempSync(join(tmpdir(), "meridian-gc-e2e-"))
const storeDir = join(root, "store")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5"
const piCli = process.env.PI_CLI_PATH
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: storeDir,
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_DEFAULT_AGENT: "pi",
})
const { prepareFork, abandonFork, runGc, getSessionGcNodeExecutable } = await import("../src/proxy/sessionLifecycle.ts")
const { resolveClaudeExecutableAsync } = await import("../src/proxy/models.ts")
const options = { storeDir, preparedGraceMs: 0, retiredGraceMs: 0, runTimeoutMs: 30_000, deletionTimeoutMs: 10_000 }
let sessionId
if (piCli) {
  const { createProxyServer } = await import("../src/proxy/server.ts")
  const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: false })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: proxy.app.fetch })
  const piConfig = join(root, "pi")
  mkdirSync(piConfig)
  writeFileSync(join(piConfig, "models.json"), JSON.stringify({ providers: { anthropic: {
    baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "local-proxy", headers: { "x-meridian-agent": "pi" },
  } } }))
  try {
    const child = spawn(getSessionGcNodeExecutable(), [piCli, "--print", "--provider", "anthropic", "--model", model,
      "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline",
      "Reply with OK. Do not use tools."], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: piConfig, PI_TELEMETRY: "0" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    })
    let output = ""
    child.stdout.on("data", chunk => { output += chunk.toString() })
    child.stderr.on("data", chunk => { output += chunk.toString() })
    const timeout = setTimeout(() => child.kill(), 90_000)
    try {
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
      assert.equal(code, 0, output)
    } finally { clearTimeout(timeout) }
    const mappings = Object.values(readSessionStoreSnapshot())
    assert.equal(mappings.length, 1, "Pi must complete a real mapped session")
    sessionId = mappings[0].claudeSessionId
  } finally {
    proxy.beginDrain()
    await server.stop(true)
  }
} else {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 60_000)
  try {
    for await (const message of sdk.query({ prompt: "Reply with OK. Do not use tools.", options: {
      cwd: root, model, tools: [], maxTurns: 1, settingSources: [], abortController: controller,
      pathToClaudeCodeExecutable: await resolveClaudeExecutableAsync(),
    } })) {
      if (message.type === "system" && message.subtype === "init") sessionId = message.session_id
      if (message.type === "result") {
        assert.equal(message.subtype, "success")
        assert.equal(message.is_error, false, "The SDK returned an API refusal, not a model answer")
      }
    }
  } finally { clearTimeout(deadline) }
}
assert(sessionId)
// Exact-ID, dir-less inspection also handles Windows short/long project paths.
// Never inspect private transcript files; the SDK owns their representation.
const original = await sdk.getSessionMessages(sessionId)
assert(original.length > 0, "A real persisted transcript is required")
const locator = { sessionId, configDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), projectDir: root }
if (!piCli) await abandonFork(await prepareFork(locator, options), options)
const pinned = await runGc([locator], options)
assert.equal(pinned.deleted, 0)
assert.deepEqual(await sdk.getSessionMessages(sessionId), original, "Pinned transcript changed")
const result = await runGc([], options)
assert.equal(result.deleted, 1, JSON.stringify(result))
assert.equal(result.failed, 0)
assert.equal(result.deferred, 0)
assert(!(await sdk.listSessions()).some(session => session.sessionId === sessionId), "Retired session still exists")
console.log(JSON.stringify({ result: "PASS", root, platform: process.platform, runtime: process.version,
  model, client: piCli ? "pi" : "sdk", pinnedPreserved: true, gc: result }))
