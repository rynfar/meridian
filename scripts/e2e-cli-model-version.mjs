#!/usr/bin/env bun
// Real CLI model compatibility through Meridian HTTP and SSE.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as sdk from "@anthropic-ai/claude-agent-sdk"
import { spyOn } from "bun:test"

const stream = process.argv.includes("--stream")
const expectRejection = process.argv.includes("--expect-rejection")
const override = process.env.E2E_CLAUDE_PATH
const model = process.env.E2E_MODEL ?? "fable"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-cli-version-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0",
  ...(override ? { MERIDIAN_CLAUDE_PATH: override } : {}),
})
const { resolveClaudeExecutableAsync } = await import("../src/proxy/models.ts")
const cli = await resolveClaudeExecutableAsync()
const versionProcess = Bun.spawn([cli, "--version"], { stdout: "pipe", stderr: "pipe" })
const versionTimer = setTimeout(() => versionProcess.kill(), 10_000)
const [versionCode, versionOut, versionError] = await Promise.all([
  versionProcess.exited, new Response(versionProcess.stdout).text(), new Response(versionProcess.stderr).text(),
])
clearTimeout(versionTimer)
assert.equal(versionCode, 0, versionError)
const version = versionOut.trim()
let queryCount = 0
const realQuery = sdk.query
const querySpy = spyOn(sdk, "query").mockImplementation(input => {
  queryCount++
  return realQuery(input)
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
try {
  const address = instance.server.address()
  assert(address && typeof address === "object")
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session": `cli-model-${randomUUID()}` },
    body: JSON.stringify({ model, max_tokens: 128, stream,
      messages: [{ role: "user", content: "Reply with exactly READY. Do not use tools." }] }),
    signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  const events = stream ? raw.split("\n").filter(line => line.startsWith("data:"))
    .map(line => JSON.parse(line.slice(5))) : []
  const body = stream ? undefined : JSON.parse(raw)
  console.log(JSON.stringify({ root, cli, version, model, stream, expectRejection, status: response.status, queryCount }))
  assert.equal(queryCount, 1, "A permanent model rejection must not cause a proxy SDK retry")
  if (expectRejection) {
    assert.equal(response.status, stream ? 200 : 400, raw)
    const errorEvents = events.filter(event => event.type === "error")
    if (stream) {
      assert.equal(errorEvents.length, 1, raw)
      assert(!events.some(event => event.type === "message_stop"), raw)
    }
    const error = stream ? errorEvents[0].error : body.error
    assert.equal(error?.type, "invalid_request_error", raw)
    assert.match(error.message, /Claude Code .* does not support this model/i)
    assert(error.message.includes(version.split(" ")[0]), "Installed version must remain actionable")
    assert.match(error.message, /version \d[\w.]* or newer is required/i)
    assert(error.message.includes("MERIDIAN_CLAUDE_PATH"))
    assert.equal(response.headers.get("Retry-After"), null)
    console.log(JSON.stringify({ error }))
  } else {
    assert.equal(response.status, 200, raw)
    assert(!events.some(event => event.type === "error"), raw)
    if (stream) assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
    const answer = stream
      ? events.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join("")
      : body.content.filter(block => block.type === "text").map(block => block.text).join("")
    assert.equal(answer.trim(), "READY", raw)
  }
  console.log(JSON.stringify({ result: "PASS", version, model, stream, expectRejection }))
} finally {
  querySpy.mockRestore()
  await instance.close()
}
