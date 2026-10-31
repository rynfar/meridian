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

async function startup({ name, cached = false, offline = false, discover = false }) {
  const root = mkdtempSync(join(tmpdir(), "meridian-pi-startup-"))
  const agent = join(root, "agent")
  const store = join(agent, "models-store.json")
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    if (discover) response.setHeader("content-type", "application/json").end(JSON.stringify({
      data: [{ id, display_name: "Startup fixture", owned_by: "anthropic", context_window: 200_000 }],
    }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  mkdirSync(agent)
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    lastChangelogVersion: "9999.0.0",
    ...(discover ? { defaultProvider: "meridian", defaultModel: id } : {}),
  }))
  if (cached) writeFileSync(store, JSON.stringify({ meridian: { checkedAt: Date.now(), models: [{
    id, name: "Startup fixture", api: "anthropic-messages", provider: "meridian", baseUrl,
    reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsMidConvoToolChanges: false },
  }] } }))
  const args = [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-approve", "-e", extension,
    ...(discover ? [] : ["--model", cached ? `meridian/${id}` : "anthropic/claude-haiku-5-5", "--api-key", "synthetic-no-generation"]),
    ...(offline ? ["--offline"] : []),
  ]
  const started = performance.now()
  const child = spawn(pi, args, {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: root, TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", MERIDIAN_BASE_URL: baseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const closed = new Promise(resolve => child.once("close", resolve))
  let stderr = ""
  let record
  let failure
  child.stderr.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-8_000) })
  child.once("error", error => { failure = error })
  child.once("exit", code => { failure = new Error(`${name}: Pi exited ${code}\n${stderr}`) })
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const message = JSON.parse(line)
      if (message.id === "startup-proof") record = { ...message, readyMs: Math.round(performance.now() - started) }
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
  try {
    child.stdin.write(`${JSON.stringify({ id: "startup-proof", type: "get_state" })}\n`)
    await waitFor(() => record, 10_000, "startup exceeded 10 seconds")
    assert.equal(record.success, true, `${name}: ${record.error ?? "get_state failed"}`)
    if (cached) assert.equal(record.data.model.id, id, `${name}: cached Meridian model not selected`)
    if (offline) assert.equal(requests, 0, `${name}: offline startup contacted Meridian`)
    assert(record.readyMs < budgetMs, `${name}: Pi waited ${record.readyMs} ms for a server that never replies`)
    if (!offline && !cached) await waitFor(() => requests > 0, 1_000, "permitted background discovery never started")
    if (discover) await waitFor(
      () => existsSync(store) && JSON.parse(readFileSync(store, "utf8")).meridian?.models?.some(model => model.id === id),
      2_000, "Pi did not persist the background catalog",
    )
    console.log(JSON.stringify({ name, readyMs: record.readyMs, budgetMs, requests }))
  } finally {
    child.kill("SIGKILL")
    await closed
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true })
  }
}

await startup({ name: "cold cache, unresponsive Meridian" })
await startup({ name: "cached Meridian model, unresponsive Meridian", cached: true })
await startup({ name: "offline cold cache", offline: true })
await startup({ name: "cold default Meridian, successful background publication", discover: true })
