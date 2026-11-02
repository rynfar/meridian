#!/usr/bin/env node
/**
 * Claude Code's own tool search through passthrough Meridian (#1478).
 *
 * Runs the REAL Claude Code client against a built Meridian (`dist/cli.js`)
 * with a stdio MCP server exposing 22 tools, ENABLE_TOOL_SEARCH on or off, and
 * asserts the MCP server's own call log, never model wording.
 *
 *   --upstream=scripted  (default) Meridian's SDK child talks to a scripted
 *                        Messages API that applies the API's tool_reference
 *                        rule; no model call, no credentials.
 *   --upstream=live      the default Claude login, read-only
 *                        (MERIDIAN_CREDENTIALS_READONLY=1, no profile
 *                        configuration). Requires E2E_ALLOW_LIVE_MODEL=1.
 *   --expect=pass|fail   pass: every target tool was called with the fixture
 *                        arguments. fail: none was (unchanged-baseline proof).
 *   --mode=single|chain|parallel|bare-name   bare-name is scripted only: the
 *                        scripted model copies the name from a
 *                        "[Tool reference: X]" note verbatim (#1107).
 *   --tool-search=true|false  --model=<id>  --port=<n> (upstream uses n+1)
 *
 * Env: E2E_CLAUDE_BIN (absolute Claude Code executable, required),
 * E2E_NODE_BIN (Node for dist/cli.js, default `node`), E2E_EVIDENCE_DIR
 * (optional report copy). Exit 0 on the expected outcome, 1 otherwise, 2 on a
 * usage/billing/auth refusal (stop; do not retry on another account).
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "..")
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback
const UPSTREAM = arg("upstream", "scripted")
const EXPECT = arg("expect", "pass")
const MODE = arg("mode", "single")
const TOOL_SEARCH = arg("tool-search", "true")
const MODEL = arg("model", "claude-sonnet-5-5")
const PORT = Number(arg("port", "3534"))
const CLAUDE = process.env.E2E_CLAUDE_BIN
assert(CLAUDE && CLAUDE.startsWith("/"), "Set E2E_CLAUDE_BIN to an absolute Claude Code executable")
assert(["scripted", "live"].includes(UPSTREAM) && ["pass", "fail"].includes(EXPECT))
assert(["single", "chain", "parallel", "bare-name"].includes(MODE) && ["true", "false"].includes(TOOL_SEARCH))
if (UPSTREAM === "live") {
  assert.equal(process.env.E2E_ALLOW_LIVE_MODEL, "1", "Live runs need E2E_ALLOW_LIVE_MODEL=1")
  assert.notEqual(MODE, "bare-name", "bare-name scripts the model; use --upstream=scripted")
}
assert(existsSync(join(repo, "dist", "cli.js")), "Build first: npm run build")

const portBusy = async port => fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false)
assert(!(await portBusy(PORT)) && !(await portBusy(PORT + 1)), `Ports ${PORT} and ${PORT + 1} must be free`)
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-tool-search-")))
for (const d of ["config", "sessions", "workdir", "home", "client-config", "client-home", "work"]) mkdirSync(join(root, d), { mode: 0o700 })
const callLog = join(root, "mcp-calls.jsonl"), upstreamLog = join(root, "upstream.jsonl")
writeFileSync(callLog, ""); writeFileSync(upstreamLog, "")
const children = []
const start = (cmd, args, env, out) => {
  const child = spawn(cmd, args, { env, cwd: join(root, "workdir"), stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", c => { log += c }); child.stderr.on("data", c => { log += c })
  children.push(child)
  return { child, log: () => log, save: () => writeFileSync(join(root, out), log) }
}
// Inherit only PATH and identity; never the caller's Claude/Anthropic/Meridian variables.
const baseEnv = { PATH: process.env.PATH, USER: process.env.USER, LANG: "en_US.UTF-8" }
const node = process.env.E2E_NODE_BIN ?? "node"
const targets = MODE === "chain" || MODE === "parallel" ? ["ledger_update", "ledger_audit"] : ["ledger_update"]
let upstream
if (UPSTREAM === "scripted") {
  upstream = start(node, [join(here, "fixtures", "tool-search", "scripted-upstream.mjs"), String(PORT + 1), upstreamLog], baseEnv, "upstream.log")
  writeFileSync(join(root, "config", "profiles.json"), JSON.stringify([{ id: "scripted", type: "api", apiKey: "scripted-not-a-key", baseUrl: `http://127.0.0.1:${PORT + 1}` }]), { mode: 0o600 })
}
const proxy = start(node, [join(repo, "dist", "cli.js")], {
  ...baseEnv,
  // Live: the real HOME, so the SDK child finds the default login. Scripted: none.
  HOME: UPSTREAM === "live" ? process.env.HOME : join(root, "home"),
  MERIDIAN_PORT: String(PORT), MERIDIAN_HOST: "127.0.0.1",
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: join(root, "workdir"), MERIDIAN_TELEMETRY_PERSIST: "0",
  MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_UPDATE_CHECK_PATH: join(root, "update-check.json"),
  MERIDIAN_DESIGN_TOKEN_PATH: join(root, "design-token.json"), MERIDIAN_CREDENTIALS_READONLY: "1",
  // Opus's default [1m] variant can bill Extra Usage silently; the fix does not depend on it.
  MERIDIAN_OPUS_MODEL: "opus",
}, "proxy.log")
const report = { upstream: UPSTREAM, expect: EXPECT, mode: MODE, toolSearch: TOOL_SEARCH, model: MODEL, root }
try {
  for (let i = 0; ; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.ok, () => false)
    if (ok) break
    assert(i < 120, "Meridian did not become healthy")
    await new Promise(r => setTimeout(r, 500))
  }
  report.meridianBuild = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).build?.sha
  const tool = targets.length === 1 ? `the MCP tool ${targets[0]}` : `the MCP tools ${targets.join(" and ")}`
  const marker = { single: "", chain: "CHAIN-MODE: ", parallel: "PARALLEL-MODE: ", "bare-name": "BARE-NAME: " }[MODE]
  const prompt = `${marker}Call ${tool}, each with realm "r1" and node_id "7". Then reply with exactly the text the tool calls returned, nothing else.`
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { ledger: { type: "stdio", command: node,
    args: [join(here, "fixtures", "tool-search", "mcp-ledger-server.mjs")], env: { MCP_CALL_LOG: callLog } } } }))
  const client = spawn(CLAUDE, ["-p", prompt, "--model", MODEL, "--strict-mcp-config", "--mcp-config", join(root, "mcp.json"),
    "--allowedTools", [...targets.map(t => `mcp__ledger__${t}`), "ToolSearch"].join(","), "--output-format", "stream-json", "--verbose"], {
    cwd: join(root, "work"), stdio: ["ignore", "pipe", "pipe"],
    env: { ...baseEnv, HOME: join(root, "client-home"), CLAUDE_CONFIG_DIR: join(root, "client-config"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`, ANTHROPIC_API_KEY: "dummy-not-a-key", ENABLE_TOOL_SEARCH: TOOL_SEARCH,
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
  })
  children.push(client)
  let stream = ""
  client.stdout.on("data", c => { stream += c })
  const exit = await new Promise(resolve => {
    const timer = setTimeout(() => { client.kill("SIGTERM"); resolve("timeout") }, 300000)
    client.on("close", code => { clearTimeout(timer); resolve(code) })
  })
  writeFileSync(join(root, "client-stream.jsonl"), stream)
  const events = stream.split("\n").flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
  report.clientExit = exit
  report.clientToolUses = events.filter(e => e.type === "assistant").flatMap(e => e.message?.content ?? []).filter(b => b.type === "tool_use").map(b => b.name)
  report.clientModels = [...new Set(events.filter(e => e.type === "assistant").map(e => e.message?.model).filter(Boolean))]
  report.finalResult = String(events.find(e => e.type === "result")?.result ?? "").slice(0, 200)
  const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
  report.mcpCalls = calls.map(c => ({ name: c.name, args: c.args }))
  const called = t => calls.some(c => c.name === t && c.args?.realm === "r1" && c.args?.node_id === "7")
  report.refusal = (proxy.log().match(/.*(weekly limit|usage limit|rate limit reached|extra usage|billing_error|\b402\b|revoked|overage).*/i) ?? [])[0]?.slice(0, 200)
  if (UPSTREAM === "scripted") {
    const rows = readFileSync(upstreamLog, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.messages)
    report.upstreamReferenceNotes = [...new Set(rows.flatMap(r => r.reference_notes ?? []))]
    report.upstreamRemovedReferences = rows.some(r => JSON.stringify(r.messages).includes("Tool references removed"))
  }
  report.ASSERT = EXPECT === "pass"
    ? exit === 0 && targets.every(called) && (MODE !== "chain" || calls.findIndex(c => c.name === "ledger_update") < calls.findIndex(c => c.name === "ledger_audit"))
    : !targets.some(called)
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  // Join every child so a following run never reaches a server still shutting down.
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined
    : new Promise(resolve => { const t = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 10000); child.once("close", () => { clearTimeout(t); resolve() }) })))
  proxy.save(); upstream?.save()
}
const text = JSON.stringify(report, null, 1)
console.log(text)
if (process.env.E2E_EVIDENCE_DIR) writeFileSync(join(process.env.E2E_EVIDENCE_DIR, `tool-search-${UPSTREAM}-${MODE}-${TOOL_SEARCH}-${EXPECT}.json`), text)
process.exit(report.refusal ? 2 : report.ASSERT ? 0 : 1)
