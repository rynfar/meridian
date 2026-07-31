#!/usr/bin/env bun
/**
 * Live E2E: what each installed client actually sends, and which adapter that
 * resolves to.
 *
 * Meridian picks an adapter from request headers. A client changing what it
 * sends silently reroutes it — and nothing fails:
 *
 *   Crush 0.87 added `x-session-affinity`, which detection checked ahead of the
 *   User-Agent chain, so every Crush request resolved to the OpenCode adapter.
 *   OpenCode's transforms, tool config and session semantics were applied to a
 *   client that has its own. Then fixing the detection made it WORSE, because
 *   `openCodeAdapter.getSessionId` falls back to that same header, so Crush had
 *   been getting keyed sessions by accident (#733).
 *
 * That was found by upgrading a client and running one turn. No user would
 * connect "sessions feel wrong" to header precedence, and no unit test can see
 * a client change its headers. This script makes that check repeatable.
 *
 * `client-detection-fixtures.test.ts` covers the other half — it pins detection
 * against the captured sets, so a change to detection ORDERING fails in CI.
 * This script catches a change on the CLIENT side.
 *
 * Requires the clients under test to be installed. Costs no tokens: requests
 * are answered by a local stub, never forwarded upstream.
 *
 *   bun scripts/e2e-client-detection.mjs            # check for drift
 *   bun scripts/e2e-client-detection.mjs --update   # rewrite the fixture
 *
 * Run after upgrading any client, and before releases touching detect.ts.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { detectAdapter } from "../src/proxy/adapters/detect.ts"

const FIXTURE = join(import.meta.dir, "..", "src", "__tests__", "fixtures", "client-headers.json")
const UPDATE = process.argv.includes("--update")
const PORT = Number(process.env.CLIENT_DETECT_PORT ?? 3995)

/** Headers that are per-request noise, not identity. Dropped before diffing. */
const VOLATILE = new Set([
  "host", "content-length", "connection", "accept-encoding", "authorization",
  "x-api-key", "x-stainless-retry-count", "x-stainless-timeout", "cookie",
])
/** Header values that change every run; keep the KEY, normalize the value. */
const VOLATILE_VALUES = new Set(["x-session-affinity", "x-session-id", "x-opencode-session"])

/**
 * How to drive each client headlessly. `configFor` writes a project-local
 * config pointing at the capture server; `argv` runs one non-interactive turn.
 *
 * Adding a client is a new entry here plus `--update`.
 */
const CLIENTS = [
  {
    name: "opencode",
    bin: "opencode",
    versionArgs: ["--version"],
    configFor: (dir, url) => [["opencode.json", JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet-5",
      provider: { anthropic: { options: { apiKey: "dummy", baseURL: url } } },
    }, null, 2)]],
    argv: (dir) => ["run", "--dir", dir, "hi"],
  },
  {
    name: "crush",
    bin: "crush",
    versionArgs: ["--version"],
    configFor: (dir, url) => [["crush.json", JSON.stringify({
      $schema: "https://crush.charm.sh/schema.json",
      providers: {
        capture: {
          id: "capture", name: "Capture", type: "anthropic",
          base_url: url, api_key: "dummy",
          models: [{ id: "claude-sonnet-4-6", name: "s", context_length: 200000, max_output: 512 }],
        },
      },
      models: {
        large: { provider: "capture", model: "claude-sonnet-4-6" },
        small: { provider: "capture", model: "claude-sonnet-4-6" },
      },
    }, null, 2)]],
    argv: () => ["run", "hi"],
  },
]

let failures = 0
const fail = (m) => { failures++; console.error(`  ✗ ${m}`) }
const pass = (m) => console.log(`  ✓ ${m}`)
const note = (m) => console.log(`  · ${m}`)

async function which(bin) {
  return new Promise((res) => {
    const p = spawn("which", [bin], { stdio: "ignore" })
    p.on("close", (code) => res(code === 0))
    p.on("error", () => res(false))
  })
}

async function versionOf(client) {
  return new Promise((res) => {
    let out = ""
    const p = spawn(client.bin, client.versionArgs)
    p.stdout.on("data", (d) => { out += d })
    p.on("close", () => res(out.trim().split("\n")[0]?.replace(/^\D*/, "") || "unknown"))
    p.on("error", () => res("unknown"))
  })
}

/** Run one client turn against a capture server; resolve with its headers. */
async function capture(client, dir) {
  return new Promise((resolve) => {
    let captured = null
    const server = createServer((req, res) => {
      if (!captured) {
        captured = {}
        for (const [k, v] of Object.entries(req.headers)) captured[k.toLowerCase()] = String(v)
      }
      const body = JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "x",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(body)
    })
    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${PORT}`
      for (const [file, content] of client.configFor(dir, url)) {
        writeFileSync(join(dir, file), content)
      }
      const proc = spawn(client.bin, client.argv(dir), { cwd: dir, stdio: "ignore" })
      // Clients differ wildly in startup cost (MCP servers, model probes);
      // resolve as soon as a request lands rather than waiting for exit.
      const deadline = setTimeout(() => { proc.kill(); server.close(); resolve(captured) }, 90_000)
      const poll = setInterval(() => {
        if (captured) {
          clearInterval(poll); clearTimeout(deadline)
          proc.kill(); server.close(); resolve(captured)
        }
      }, 500)
      proc.on("error", () => {
        clearInterval(poll); clearTimeout(deadline); server.close(); resolve(null)
      })
    })
  })
}

/** Strip per-request noise so two runs of the same client compare equal. */
function normalize(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (VOLATILE.has(k)) continue
    out[k] = VOLATILE_VALUES.has(k) ? "<session>" : v
  }
  return out
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"))
const results = []

for (const client of CLIENTS) {
  console.log(`\n${client.name}`)
  if (!(await which(client.bin))) {
    // Not a failure — a machine without the client installed can still run this.
    note(`${client.bin} not installed, skipping`)
    continue
  }
  const version = await versionOf(client)
  const dir = mkdtempSync(join(tmpdir(), `client-detect-${client.name}-`))
  let headers
  try {
    headers = await capture(client, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (!headers) {
    // Silence is not success: a client that never reached us tells us nothing.
    fail(`${client.name} ${version}: no request captured (startup failure or timeout)`)
    continue
  }

  const adapter = detectAdapter({
    req: { header: (n) => (n ? headers[n.toLowerCase()] : { ...headers }) },
  })

  const prior = fixture.captures.filter(c => c.client === client.name)
  const expected = prior[0]?.expectedAdapter
  if (!expected) {
    note(`${client.name} ${version}: no fixture yet — detected "${adapter.name}". Re-run with --update to record it.`)
  } else if (adapter.name !== expected) {
    fail(`${client.name} ${version}: detected "${adapter.name}", fixture expects "${expected}" — did this client change its headers?`)
  } else {
    pass(`${client.name} ${version} -> ${adapter.name}`)
  }

  // Report header drift even when detection still happens to be right: a new
  // header is exactly how #733 started, one release before it did damage.
  const now = normalize(headers)
  const before = prior.find(c => !c.headers["x-opencode-session"])
  if (before) {
    const beforeNorm = normalize(before.headers)
    const added = Object.keys(now).filter(k => !(k in beforeNorm))
    const removed = Object.keys(beforeNorm).filter(k => !(k in now))
    const uaChanged = now["user-agent"] !== beforeNorm["user-agent"]
    if (added.length) note(`new headers since ${before.version}: ${added.join(", ")}`)
    if (removed.length) note(`headers gone since ${before.version}: ${removed.join(", ")}`)
    if (uaChanged) note(`User-Agent changed: "${beforeNorm["user-agent"]}" -> "${now["user-agent"]}"`)
  }

  results.push({
    client: client.name,
    version,
    capturedAt: new Date().toISOString().slice(0, 10),
    expectedAdapter: adapter.name,
    headers: now,
  })
}

if (UPDATE) {
  // Keep entries this run could not re-capture (uninstalled clients, and the
  // plugin-variant sets that need a configured plugin to reproduce).
  const kept = fixture.captures.filter(c =>
    !results.some(r => r.client === c.client) || c.headers["x-opencode-session"])
  fixture.captures = [...kept, ...results].sort((a, b) =>
    a.client.localeCompare(b.client) || a.version.localeCompare(b.version))
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n")
  console.log(`\nfixture updated: ${FIXTURE}`)
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — client detection`)
process.exit(failures === 0 ? 0 : 1)
