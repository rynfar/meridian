#!/usr/bin/env bun
// Real Pi 1.x with the Meridian extension → Meridian → Claude.
//
// Usage: E2E_PLUGIN_PATH=/abs/path/to/meridian-plugin-pi-scrub/dist/index.js \
//          bun scripts/e2e-pi-extension.mjs [--pi=/path/to/pi]
//
// Installs the extension with `meridian setup --client pi` into a scratch Pi
// agent directory, starts Meridian in-process on scratch state with only the
// independently installed Pi scrub server plugin, and runs Pi in
// print mode through a loopback recorder that captures the identity headers
// each request carries on the wire. Wire identity and attestation are asserted;
// each request is joined to Meridian's telemetry by its request ID. Generation
// outcomes are reported, and any that did not succeed make the exit status 1.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { configurePiScrub, resolvePiScrub, verifyPiScrub } from "./lib-pi-scrub-preflight.mjs"

const repo = resolve(import.meta.dir, "..")
const pi = process.argv.find(arg => arg.startsWith("--pi="))?.slice(5) ?? Bun.which("pi")
assert(pi, "pi not found; pass --pi=/path/to/pi")
// Claude has refused Pi's default system prompt as third-party traffic on a
// subscription unless the scrub removes its fingerprint (October 2026, Max).
const scrub = resolvePiScrub(process.env.E2E_PLUGIN_PATH, process.env.E2E_SCRUB_VERSION)

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-pi-extension-")))
const agentDir = join(root, "pi-agent")
for (const key of Object.keys(process.env)) if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "meridian-config"),
  MERIDIAN_SESSION_DIR: join(root, "meridian-sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
})

function clientEnv(extra = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PATH: `${dirname(pi)}:${process.env.PATH}`, ...extra }
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_PROXY_") || key === "PI_SUBAGENT_CHILD") delete env[key]
    if (key.startsWith("MERIDIAN_") && !(key in extra) && key !== "MERIDIAN_CONFIG_DIR") delete env[key]
  }
  return env
}

async function run(command, env, timeoutMs = 240_000) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

const version = (await run([pi, "--version"], clientEnv())).stdout.trim()
assert(Number(version.split(".")[0]) >= 1, `Pi ${version} predates the extension`)

const setup = await run(["bun", join(repo, "bin", "cli.ts"), "setup", "--client", "pi"], clientEnv())
assert.equal(setup.code, 0, setup.stderr)

const { startProxyServer } = await import("../src/proxy/server.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const { PRIORITY_ATTESTATION_HEADER, verifyPriorityAttestation } = await import("../src/proxy/priorityAttestation.ts")

const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true, ...configurePiScrub(root, scrub) })
const meridianUrl = `http://127.0.0.1:${instance.server.address().port}`

const wire = []
const recorder = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.text() : undefined
    if (url.pathname === "/v1/messages") {
      const parsed = JSON.parse(body)
      wire.push({
        headers: Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-") && name !== "x-api-key")),
        model: parsed.model,
        thinking: parsed.thinking,
        outputConfig: parsed.output_config,
      })
    }
    return fetch(meridianUrl + url.pathname + url.search, { method: request.method, headers: request.headers, body })
  },
})

const fixture = `fixture_${crypto.randomUUID()}`
writeFileSync(join(root, "fixture.txt"), fixture)

async function turn({ name, model, prompt, sessionId, tools = "read", env = {}, expect }) {
  const start = wire.length
  const result = await run(
    [pi, "-p", prompt, "--model", model, "--session-id", sessionId, "--tools", tools],
    clientEnv({ MERIDIAN_BASE_URL: `http://127.0.0.1:${recorder.port}`, ...env }),
  )
  const requests = wire.slice(start)
  const telemetry = telemetryStore.getRecent({ limit: 200 })
  const output = `${result.stdout}\n${result.stderr}`
  const generation = result.code === 0 && expect(result.stdout)
    ? "ok"
    : /extra usage/i.test(output) ? "refused: Extra Usage required for third-party apps" : "failed"
  return {
    name,
    model,
    exitCode: result.code,
    generation,
    output: generation === "ok" ? undefined : output.trim().slice(0, 400),
    requests: requests.map(({ headers, model, thinking, outputConfig }) => {
      const attestation = verifyPriorityAttestation(headers[PRIORITY_ATTESTATION_HEADER])
      const metric = telemetry.find(row => row.requestId === headers["x-request-id"])
      return {
        agent: headers["x-meridian-agent"],
        affinity: headers["x-session-affinity"],
        source: headers["x-meridian-source"],
        attestation: attestation && { generation: attestation.generation, sessionId: attestation.sessionId, turnId: attestation.turnId.slice(0, 12) },
        unverifiedAttestation: headers[PRIORITY_ATTESTATION_HEADER] !== undefined && attestation === undefined,
        foreignIdentity: ["x-opencode-session", "x-opencode-agent-mode", "x-opencode-agent-name", "x-session-id"].filter(header => header in headers),
        body: { model, thinking, outputConfig },
        meridian: metric && {
          adapter: metric.adapter,
          requestSource: metric.requestSource,
          resolvedModel: metric.resolvedModel ?? metric.model,
          lineage: metric.lineageType,
          status: metric.status,
          error: metric.error,
        },
      }
    }),
  }
}

const sessions = { primary: crypto.randomUUID(), child: crypto.randomUUID(), opus: crypto.randomUUID() }
const report = { pi: version, meridianUrl: "loopback", cases: [] }
let scrubList
try {
  verifyPiScrub(await (await fetch(`${meridianUrl}/plugins/list`)).json(), scrub)
  const { default: meridian } = await import("../plugin/pi/index.ts")
  let provider
  meridian({ on() {}, registerProvider(_id, config) { provider = config } })
  await provider.refreshModels({
    allowNetwork: true,
    baseUrl: `http://127.0.0.1:${recorder.port}`,
    signal: AbortSignal.timeout(10_000),
    publish: async ({ persist }) => writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ meridian: persist })),
  })
  report.cases.push(await turn({
    name: "primary turn with a tool loop",
    model: "meridian/claude-haiku-5-5",
    prompt: "Use the read tool to read fixture.txt, then reply with exactly its contents and nothing else.",
    sessionId: sessions.primary,
    expect: stdout => stdout.includes(fixture),
  }))
  report.cases.push(await turn({
    name: "delegated child process",
    model: "meridian/claude-haiku-5-5",
    prompt: "Reply with the word OK and nothing else.",
    sessionId: sessions.child,
    tools: "",
    env: { MERIDIAN_SOURCE: "subagent-e2e" },
    expect: stdout => /\bOK\b/.test(stdout),
  }))
  report.cases.push(await turn({
    name: "Opus 5.5 at high effort",
    model: "meridian/claude-opus-5-5:high",
    prompt: "Reply with the word OK and nothing else.",
    sessionId: sessions.opus,
    tools: "",
    expect: stdout => /\bOK\b/.test(stdout),
  }))
  scrubList = await (await fetch(`${meridianUrl}/plugins/list`)).json()
} finally {
  recorder.stop(true)
  await instance.close()
}

const store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"))
report.discovered = Object.values(store).flatMap(entry => entry?.models ?? []).map(model => model.id)
report.scrub = { ...scrub, loaded: scrubList.plugins }
console.log(JSON.stringify(report, null, 2))

const verifiedScrub = verifyPiScrub(scrubList, scrub, true)
assert(verifiedScrub.invocations >= wire.length, "the scrub must process every Pi request")

assert(report.discovered.includes("claude-haiku-5-5"), "the extension must discover Meridian's models")
for (const { name, requests } of report.cases) {
  assert(requests.length > 0, `${name}: Pi sent no request`)
  for (const request of requests) {
    assert.equal(request.agent, "pi", name)
    assert.deepEqual(request.foreignIdentity, [], name)
    assert.equal(request.unverifiedAttestation, false, name)
    if (request.meridian) assert.equal(request.meridian.adapter, "pi", name)
  }
}
const [primary, child, opus] = report.cases
for (const request of primary.requests) {
  assert.equal(request.affinity, sessions.primary)
  assert.equal(request.source, undefined)
  assert.deepEqual(request.attestation && { generation: request.attestation.generation, sessionId: request.attestation.sessionId }, { generation: "pi1", sessionId: sessions.primary })
}
assert.equal(new Set(primary.requests.map(request => request.attestation.turnId)).size, 1, "a tool loop stays on one human turn")
for (const request of child.requests) {
  assert.equal(request.affinity, sessions.child)
  assert.equal(request.source, "subagent-e2e")
  assert.equal(request.attestation, undefined)
}
for (const request of opus.requests) assert.equal(request.affinity, sessions.opus)

const failed = report.cases.filter(item => item.generation !== "ok")
if (failed.length > 0) {
  console.error(`Identity checks passed; generation did not succeed for: ${failed.map(item => item.name).join(", ")}`)
  process.exit(1)
}
