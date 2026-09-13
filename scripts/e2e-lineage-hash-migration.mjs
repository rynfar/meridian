#!/usr/bin/env bun
/** Real tool-result metadata changes and migration from pre-v2 lineage hashes. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-hash-migration-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1" })
const { startProxyServer } = await import("../src/proxy/server.ts")
const { storeSession } = await import("../src/proxy/session/cache.ts")
const { storeSharedSession, readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const { normalizeContent } = await import("../src/proxy/messages.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const marker = `fixture_${randomUUID()}`
const fixturePath = join(root, "fixture.json")
writeFileSync(fixturePath, JSON.stringify({ record: marker }))
const tools = [{ name: "get_fixture", description: "Read the JavaScript test fixture record.",
  input_schema: { type: "object", properties: {}, additionalProperties: false } }]
const firstMessage = { role: "user", content: "Call get_fixture once. Then report its record identifier and execution status: SUCCEEDED for is_error=false (or absent), FAILED for is_error=true. Judge status from the tool result metadata, not the payload. Do not call it again after receiving its result." }
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")

async function request(key, messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model, max_tokens: 256, stream, tools, messages }), signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!stream) return JSON.parse(raw).content
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
  const blocks = []
  for (const event of events) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block, json: "" }
    if (event.delta?.type === "text_delta") blocks[event.index].text = (blocks[event.index].text ?? "") + event.delta.text
    if (event.delta?.type === "input_json_delta") blocks[event.index].json += event.delta.partial_json
  }
  return blocks.filter(Boolean).map(({ json, ...block }) => block.type === "tool_use"
    ? { ...block, input: json ? JSON.parse(json) : block.input } : block)
}
const answerText = blocks => blocks.filter(block => block.type === "text").map(block => block.text).join("")
const inputText = row => typeof row?.message?.content === "string" ? row.message.content
  : (row?.message?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n")
const digest = value => createHash("sha256").update(value).digest("hex").slice(0, 32)

try {
  const sourceKey = `hash-source-${randomUUID()}`
  const first = await request(sourceKey, [firstMessage])
  const calls = first.filter(block => block.type === "tool_use")
  assert.equal(calls.length, 1, JSON.stringify(first))
  assert.equal(calls[0].name, "get_fixture")
  // The client executes its real fixture read and returns the real file bytes.
  const result = { type: "tool_result", tool_use_id: calls[0].id, content: readFileSync(fixturePath, "utf8"), is_error: false }
  const history = [firstMessage, { role: "assistant", content: first }, { role: "user", content: [result] }]
  const initialAnswer = await request(sourceKey, history)
  assert(!initialAnswer.some(block => block.type === "tool_use"), JSON.stringify(initialAnswer))
  assert(answerText(initialAnswer).includes(marker) && answerText(initialAnswer).includes("SUCCEEDED"), answerText(initialAnswer))
  const source = readSessionStoreSnapshot()[sourceKey]
  assert(source?.claudeSessionId && source.currentTranscript, "source mapping was not published")
  const sourceRows = await getSessionMessages(source.claudeSessionId, { dir: root })
  assert(JSON.stringify(sourceRows).includes(marker), "real tool payload is absent from source")
  const failures = []

  for (const mode of ["changed-error-status", "legacy-hashes"]) {
    const key = `${mode}-${randomUUID()}`
    if (mode === "legacy-hashes") {
      const strings = history.map(message => `${message.role}:${normalizeContent(message.content)}`)
      assert(storeSharedSession(key, source.claudeSessionId, history.length, digest(strings.join("\n")),
        strings.map(digest), source.sdkMessageUuids, undefined,
        history.map(message => (Array.isArray(message.content) ? message.content : [message.content])
          .filter(block => !["thinking", "redacted_thinking"].includes(block?.type))
          .map(block => digest(normalizeContent([block])))),
        source.passthroughToolCallAssistantUuid, source.passthroughToolCallIds, source.currentTranscript))
    } else {
      assert(storeSession(key, history, source.claudeSessionId, root, source.sdkMessageUuids, undefined,
        source.passthroughToolCallAssistantUuid, source.passthroughToolCallIds, source.currentTranscript))
    }
    const changed = mode === "changed-error-status"
    const messages = [history[0], history[1], { role: "user", content: [{ ...result, is_error: changed }] },
      { role: "assistant", content: initialAnswer },
      { role: "user", content: "Re-evaluate the supplied get_fixture result's is_error flag. Report FAILED if true, SUCCEEDED if false, and the record identifier. Use the supplied result; do not read the fixture again." }]
    const response = await request(key, messages)
    const answer = answerText(response)
    const lineage = telemetryStore.getRecent({ limit: 1 })[0]?.lineageType
    const active = readSessionStoreSnapshot()[key]
    assert(active?.claudeSessionId, "fresh replay mapping missing")
    const rows = await getSessionMessages(active.claudeSessionId, { dir: root })
    const firstInput = inputText(rows.find(row => row.type === "user"))
    const completeInput = firstInput.includes(calls[0].id) && firstInput.includes(JSON.stringify(calls[0].input))
      && firstInput.includes(marker) && firstInput.includes(`"is_error":${changed}`)
    const expectedStatus = changed ? "FAILED" : "SUCCEEDED"
    console.log(JSON.stringify({ mode, stream, model, lineage, completeInput, answer }))
    if (lineage !== "new" || !completeInput || !answer.includes(marker) || !answer.includes(expectedStatus)
      || response.some(block => block.type === "tool_use")) failures.push(`${mode}: stale history or incomplete replay`)

    const continuation = await request(key, [...messages, { role: "assistant", content: response },
      { role: "user", content: "Repeat that execution status and record identifier without calling any tool." }])
    const nextLineage = telemetryStore.getRecent({ limit: 1 })[0]?.lineageType
    if (nextLineage !== "continuation" || !answerText(continuation).includes(marker)
      || !answerText(continuation).includes(expectedStatus) || continuation.some(block => block.type === "tool_use")) {
      failures.push(`${mode}: follow-up did not safely resume the migrated history`)
    }
    assert.deepEqual(await getSessionMessages(source.claudeSessionId, { dir: root }), sourceRows, "source transcript changed")
  }
  assert.deepEqual(failures, [], "lineage hash integrity or migration failed")
  console.log(`PASS: changed result status and legacy hashes replay completely, then resume (stream=${stream}, model=${model})`)
} finally { await instance.close() }
