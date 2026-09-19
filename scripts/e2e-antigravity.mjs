// Opt-in: real official agy CLI, account quota, and an actual Pi client.
// Run with node after npm run build. No API keys are sent to a model service.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { once } from "node:events"
import { startProxyServer } from "../dist/server.js"

const model = process.env.E2E_AGY_MODEL || "gemini-3.8-flash-low"
const root = await mkdtemp(join(tmpdir(), "meridian-agy-e2e-"))
const config = join(root, "pi-config"), project = join(root, "client")
await mkdir(config); await mkdir(project)
console.log(`Artifacts: ${root}`)
const externalUrl = process.env.E2E_MERIDIAN_URL
const proxy = externalUrl ? undefined : await startProxyServer({ backend: "antigravity", port: 0, silent: true, antigravity: { allowToolBridge: true, executable: process.env.MERIDIAN_AGY_PATH } })
if (proxy && !proxy.server.listening) await once(proxy.server, "listening")
const address = proxy?.server.address()
assert(externalUrl || (address && typeof address !== "string"))
const url = externalUrl || `http://127.0.0.1:${address.port}`
const report = { model, cli: spawnSync(process.env.MERIDIAN_AGY_PATH || "agy", ["--version"], { encoding: "utf8" }).stdout.trim(), platform: process.platform, passed: [] }
let relay
try {
  const healthResponse = await fetch(url + "/health")
  const health = await healthResponse.json()
  await writeFile(join(root, "health.json"), JSON.stringify({ status: healthResponse.status, body: health }, null, 2))
  assert.equal(healthResponse.status, 200, JSON.stringify(health))
  assert.equal(health.backend, "antigravity", JSON.stringify(health))
  assert.equal(health.auth.provider, "agy-account")
  const send = async body => {
    const response = await fetch(url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 1024, ...body }), signal: AbortSignal.timeout(90000) })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  const first = await send({ messages: [{ role: "user", content: "Reply with exactly READY. Do not use tools." }] })
  assert(first.content.some(b => b.type === "text" && b.text.includes("READY")))
  report.passed.push("live text")
  console.log("PASS live text")
  const prompt = { role: "user", content: "Use the lookup_receipt tool with key probe. Report the exact returned receipt. Do not use other tools." }
  const tools = [{ name: "lookup_receipt", description: "Get a receipt from the client", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }]
  const tool = await send({ messages: [prompt], tools })
  assert.equal(tool.stop_reason, "tool_use")
  const call = tool.content.find(b => b.type === "tool_use")
  assert.equal(call.name, "lookup_receipt")
  const receipt = `RECEIPT_${randomUUID()}`
  const messages = [prompt, { role: "assistant", content: tool.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: receipt }] }]
  const result = await send({ messages, tools })
  assert.equal(result.stop_reason, "end_turn")
  assert(JSON.stringify(result.content).includes(receipt))
  report.passed.push("HTTP client-owned tool roundtrip")
  console.log("PASS HTTP tool roundtrip")
  const replay = await send({ messages: [...messages, { role: "assistant", content: result.content }, { role: "user", content: "Without using tools, repeat the receipt." }], tools })
  assert(JSON.stringify(replay.content).includes(receipt))
  report.passed.push("completed history replay")
  console.log("PASS history replay")

  const secret = `PI_ONLY_${randomUUID()}`
  await writeFile(join(project, "receipt.txt"), secret)
  const observed = []
  relay = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      observed.push(body)
      const response = await fetch(url + req.url, { method: "POST", headers: { "content-type": "application/json" }, body: raw })
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") })
      Readable.fromWeb(response.body).pipe(res)
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve))
  const clientUrl = `http://127.0.0.1:${relay.address().port}`
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { "meridian-agy": { baseUrl: clientUrl, apiKey: "local-fixture", api: "anthropic-messages", models: [{ id: model, name: model, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  const env = { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0" }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
  const args = ["--provider", "meridian-agy", "--model", model, "--thinking", "off", "--tools", "read,write", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--system-prompt", "You are a test assistant. Use the client's read and write tools for the requested file operations. Report the receipt after completing both operations.", "-p", `Read ${join(project, "receipt.txt")} using your read tool, then write its exact contents to ${join(project, "copied.txt")} using your write tool. Finally report the receipt. Do not guess it or use other tools.`]
  const child = spawn(process.env.E2E_PI_BIN || "pi", args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", data => { stdout += data }); child.stderr.on("data", data => { stderr += data })
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000)
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) }).finally(() => clearTimeout(timer))
  await writeFile(join(root, "pi.stdout"), stdout); await writeFile(join(root, "pi.stderr"), stderr)
  assert.equal(code, 0, stderr)
  assert(stdout.includes(secret), stdout + stderr)
  assert.equal(await readFile(join(project, "copied.txt"), "utf8"), secret)
  assert(observed.length >= 3, "Actual client must complete both read and write tool rounds")
  assert(observed.some(body => body.stream === true))
  assert(observed.some(body => body.messages.at(-1).content.some?.(b => b.type === "tool_result" && JSON.stringify(b.content).includes(secret))), "Receipt must enter through the real client's tool result")
  const piVersion = spawnSync(process.env.E2E_PI_BIN || "pi", ["--version"], { encoding: "utf8" })
  assert.equal(piVersion.status, 0)
  report.piVersion = (piVersion.stdout || piVersion.stderr).trim()
  report.passed.push("actual Pi client: streaming read and write tool rounds, exact client-local file copy, final answer")
  report.piRequests = observed.length
  report.cliAtEnd = spawnSync(process.env.MERIDIAN_AGY_PATH || "agy", ["--version"], { encoding: "utf8" }).stdout.trim()
  assert.equal(report.cliAtEnd, report.cli, "CLI changed during live verification")
  console.log(JSON.stringify(report, null, 2))
} finally {
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2))
  await proxy?.close()
  if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)) }
}
