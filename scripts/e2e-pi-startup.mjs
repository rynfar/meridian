import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pi = process.argv.find(arg => arg.startsWith("--pi="))?.slice(5) ?? "pi"
const extension = resolve(process.argv.find(arg => arg.startsWith("--extension="))?.slice(12) ?? join(repo, "plugin/pi/index.ts"))
const budgetMs = 2_000
const id = "claude-startup-fixture"
// In the extension's built-in catalog, so Pi can select it with nothing stored.
const builtIn = "claude-haiku-5-5"
// The extension abandons discovery after DISCOVERY_TIMEOUT_MS (3 s, plugin/pi/index.ts).
const discoveryAbandonedWithinMs = 6_000

const sse = [
  ["message_start", { type: "message_start", message: { id: "msg_startup", type: "message", role: "assistant", content: [], model: builtIn, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "STARTUP_OK" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")

/**
 * A loopback Meridian. `silent` accepts connections and never replies;
 * `catalog` serves a one-model catalog; `chat` serves the built-in model in
 * its catalog, as a real Meridian would, and answers /v1/messages.
 */
async function meridianStub(mode) {
  const requests = []
  const server = createServer((request, response) => {
    const entry = { method: request.method, url: request.url, closed: false }
    requests.push(entry)
    request.socket.once("close", () => { entry.closed = true })
    if (mode === "silent") return
    if (mode === "catalog") return response.setHeader("content-type", "application/json").end(JSON.stringify({
      data: [{ id, display_name: "Startup fixture", owned_by: "anthropic", context_window: 200_000 }],
    }))
    let body = ""
    request.setEncoding("utf8").on("data", text => { body += text }).on("end", () => {
      if (request.method === "POST" && request.url.startsWith("/v1/messages")) {
        entry.model = JSON.parse(body).model
        response.setHeader("content-type", "text/event-stream").end(sse)
      } else if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json").end(JSON.stringify({
          data: [{ id: builtIn, display_name: "Claude Haiku 5.5", owned_by: "anthropic", context_window: 1_000_000 }],
        }))
      } else {
        response.statusCode = 404
        response.end()
      }
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise(done => server.close(done))
    },
  }
}

function workspace(baseUrl, { cached = false, settings = {}, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "meridian-pi-startup-"))
  const agent = join(root, "agent")
  const store = join(agent, "models-store.json")
  mkdirSync(agent)
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ lastChangelogVersion: "9999.0.0", ...settings }))
  // A fresh entry stops Pi refreshing its own Anthropic catalog from pi.dev, so
  // no case needs the internet; Pi keeps its bundled Anthropic models.
  const entries = { anthropic: { models: [], checkedAt: Date.now(), lastModified: 0 } }
  if (cached) entries.meridian = { checkedAt: Date.now(), models: [{
    id, name: "Startup fixture", api: "anthropic-messages", provider: "meridian", baseUrl,
    reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsMidConvoToolChanges: false },
  }] }
  writeFileSync(store, JSON.stringify(entries))
  return {
    root,
    store,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: root, TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", MERIDIAN_BASE_URL: baseUrl, ...env,
    },
  }
}

const isolation = ["--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "-e", extension]
const modelName = model => `${model.provider}/${model.id}`

async function startup({ name, cached = false, offline = false, discover = false, model, settings, env, expectModel, keepsBuiltIn = false }) {
  const server = await meridianStub(discover ? "catalog" : "silent")
  const defaults = settings ?? (discover ? { defaultProvider: "meridian", defaultModel: id } : undefined)
  const { root, store, env: childEnv } = workspace(server.baseUrl, { cached, settings: defaults, env })
  const selected = model ?? (defaults ? undefined : cached ? `meridian/${id}` : "anthropic/claude-haiku-5-5")
  const args = [
    "--mode", "rpc", ...isolation,
    ...(selected ? ["--model", selected] : []),
    // Pi needs a key for its own Anthropic provider; Meridian's needs none.
    ...(selected?.startsWith("anthropic/") ? ["--api-key", "synthetic-no-generation"] : []),
    ...(offline ? ["--offline"] : []),
  ]
  const started = performance.now()
  const child = spawn(pi, args, { cwd: root, env: childEnv, stdio: ["pipe", "pipe", "pipe"] })
  const closed = new Promise(resolve => child.once("close", resolve))
  let stderr = ""
  const records = new Map()
  let failure
  child.stderr.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-8_000) })
  child.once("error", error => { failure = error })
  child.once("exit", code => { failure = new Error(`${name}: Pi exited ${code}\n${stderr}`) })
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const message = JSON.parse(line)
      if (typeof message.id === "string") records.set(message.id, { ...message, readyMs: Math.round(performance.now() - started) })
    } catch (cause) {
      failure = new Error(`${name}: invalid RPC output`, { cause })
    }
  })
  const waitFor = async (check, ms, message) => {
    for (const end = performance.now() + ms; performance.now() < end; await new Promise(done => setTimeout(done, 20))) {
      if (failure) throw failure
      if (check()) return
    }
    throw new Error(`${name}: ${message}\n${stderr}`)
  }
  let commands = 0
  const command = async (type, ms = 10_000) => {
    const requestId = `${type}-${++commands}`
    child.stdin.write(`${JSON.stringify({ id: requestId, type })}\n`)
    await waitFor(() => records.has(requestId), ms, `${type} did not answer within ${ms} ms`)
    const record = records.get(requestId)
    assert.equal(record.success, true, `${name}: ${record.error ?? `${type} failed`}`)
    return record
  }
  try {
    const record = await command("get_state")
    if (cached) assert.equal(record.data.model.id, id, `${name}: cached Meridian model not selected`)
    if (expectModel) assert.equal(modelName(record.data.model), expectModel, `${name}: started on the wrong model`)
    if (offline) assert.equal(server.requests.length, 0, `${name}: offline startup contacted Meridian`)
    assert(record.readyMs < budgetMs, `${name}: Pi waited ${record.readyMs} ms for a server that never replies`)
    if (!offline && !cached) await waitFor(() => server.requests.length > 0, 1_000, "permitted background discovery never started")
    if (discover) await waitFor(
      () => existsSync(store) && JSON.parse(readFileSync(store, "utf8")).meridian?.models?.some(model => model.id === id),
      2_000, "Pi did not persist the background catalog",
    )
    if (keepsBuiltIn) {
      const discovery = () => server.requests.filter(request => request.url === "/v1/models")
      await waitFor(() => discovery().length > 0 && discovery().every(request => request.closed), discoveryAbandonedWithinMs, "the extension never abandoned discovery")
      // Pi rebuilds its model list while a refresh runs, so poll until it settles.
      const deadline = performance.now() + 5_000
      for (let available = []; !available.includes(`meridian/${builtIn}`);) {
        if (performance.now() > deadline) throw new Error(`${name}: Meridian models gone after the failed discovery: ${available.join(", ")}`)
        await new Promise(done => setTimeout(done, 100))
        available = (await command("get_available_models")).data.models.map(modelName)
      }
      assert.equal(modelName((await command("get_state")).data.model), expectModel, `${name}: model changed after the failed discovery`)
      assert(!JSON.parse(readFileSync(store, "utf8")).meridian, `${name}: the built-in catalog was persisted`)
    }
    return { name, readyMs: record.readyMs, budgetMs, requests: server.requests.length }
  } finally {
    child.kill("SIGKILL")
    await closed
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Print mode never discovers, so a cold catalog must still route a turn to Meridian. */
async function printTurn({ name }) {
  const server = await meridianStub("chat")
  const { root, env } = workspace(server.baseUrl)
  const child = spawn(pi, ["-p", ...isolation, "--model", `meridian/${builtIn}`, "Reply with STARTUP_OK."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.setEncoding("utf8").on("data", text => { output += text })
  child.stderr.setEncoding("utf8").on("data", text => { output += text })
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
  try {
    const [code] = await once(child, "close")
    assert.equal(code, 0, `${name}: Pi exited ${code}\n${output.slice(-4_000)}`)
    const turns = server.requests.filter(request => request.method === "POST" && request.url.startsWith("/v1/messages"))
    assert.equal(turns.length, 1, `${name}: expected one Meridian turn, saw ${JSON.stringify(server.requests)}`)
    assert.equal(turns[0].model, builtIn, `${name}: Meridian received the wrong model`)
    const discoveries = server.requests.filter(request => request.url === "/v1/models").length
    assert.equal(discoveries, 0, `${name}: print mode requested Meridian's catalog ${discoveries} time(s)`)
    assert(output.includes("STARTUP_OK"), `${name}: Pi did not print Meridian's answer`)
    return { name, requests: server.requests.length }
  } finally {
    clearTimeout(timer)
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const cases = [
  () => startup({ name: "cold cache, unresponsive Meridian" }),
  () => startup({ name: "cached Meridian model, unresponsive Meridian", cached: true }),
  () => startup({ name: "offline cold cache", offline: true }),
  () => startup({ name: "cold default Meridian, successful background publication", discover: true }),
  () => startup({
    name: "cold cache, Meridian model selected from the built-in catalog",
    model: `meridian/${builtIn}`, expectModel: `meridian/${builtIn}`,
  }),
  () => startup({
    name: "cold defaultProvider meridian beside an Anthropic key, kept after discovery fails",
    settings: { defaultProvider: "meridian", defaultModel: builtIn },
    env: { ANTHROPIC_API_KEY: "synthetic-no-generation" },
    expectModel: `meridian/${builtIn}`, keepsBuiltIn: true,
  }),
  () => printTurn({ name: "cold print mode reaches Meridian" }),
]

let failed = 0
for (const run of cases) {
  try {
    console.log(JSON.stringify({ ok: true, ...await run() }))
  } catch (error) {
    failed++
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).split("\n")[0] }))
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} startup cases failed`)
  process.exit(1)
}
