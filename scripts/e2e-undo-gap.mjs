#!/usr/bin/env bun
/**
 * #817: a shortened history with edited intermediate turns must replay them.
 * Uses real SDK queries to establish a source with valid historical rollback
 * UUIDs, then installs its matching Meridian mapping (a persisted-session
 * fixture). This matters: recent proxy forks invalidate old UUIDs and would
 * mask the defective rollback path by falling back to fresh replay already.
 * All transcript inspection uses the supported getSessionMessages API.
 * Run: bun scripts/e2e-undo-gap.mjs [--stream]
 */
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-undo-gap-")))
// Isolate Meridian state without replacing the operator's SDK auth context.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
  MERIDIAN_PASSTHROUGH: "1",
})
const { resolveClaudeExecutableAsync } = await import("../src/proxy/models.ts")
const { storeSession } = await import("../src/proxy/session/cache.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const { startProxyServer } = await import("../src/proxy/server.ts")
const executable = await resolveClaudeExecutableAsync()
const originalMarker = `ORIGINAL_${randomUUID()}`
const changedMarker = `REVISED_${randomUUID()}`
const secondaryMarker = `SECONDARY_${randomUUID()}`
const history = []
const uuids = []
let sourceId
for (let turn = 0; turn < 4; turn++) {
  const prompt = turn === 0
    ? `The marker is ${originalMarker}. Remember it and reply only ACK.`
    : turn === 1
      ? `The secondary marker is ${secondaryMarker}. Remember both markers and reply only ACK1.`
      : `Keep remembering both markers. Reply only ACK${turn}.`
  let assistant
  let result
  for await (const event of query({ prompt, options: {
    model, cwd: root, resume: sourceId, tools: [], settingSources: [],
    pathToClaudeCodeExecutable: executable, maxTurns: 1,
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
  } })) {
    if (event.type === "assistant") assistant = event
    if (event.type === "result") result = event
  }
  assert.equal(result?.subtype, "success", `SDK fixture turn ${turn} did not succeed`)
  assert(assistant?.uuid && assistant.session_id, "SDK fixture lacks a real rollback point")
  if (sourceId) assert.equal(assistant.session_id, sourceId, "fixture unexpectedly forked")
  sourceId = assistant.session_id
  history.push({ role: "user", content: prompt }, { role: "assistant", content: assistant.message.content })
  uuids.push(null, assistant.uuid)
}
const sourceMessages = await getSessionMessages(sourceId, { dir: root })
assert(sourceMessages.some(row => row.uuid === uuids[1]), "historical rollback UUID missing from real source")
const storedHistory = history.slice(0, -1) // last request's seven supplied messages
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
const problems = []
try {
  for (const mode of ["ordinary", "gap", "missing-adjacent"]) {
    const gap = mode === "gap"
    const missingAdjacent = mode === "missing-adjacent"
    const rollbackUuids = [...uuids]
    if (missingAdjacent) rollbackUuids[3] = null
    const key = `e2e-undo-${mode}-${randomUUID()}`
    assert(storeSession(key, storedHistory, sourceId, root, rollbackUuids, undefined, null, null, {
      sessionId: sourceId,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      projectDir: root,
    }), "could not publish SDK fixture mapping")
    const messages = gap
      ? [...history.slice(0, 2),
        { role: "user", content: `Correction: the marker is now ${changedMarker}.` },
        { role: "assistant", content: "I acknowledge the corrected marker." },
        { role: "user", content: "What is the marker now? Reply only with the marker." }]
      : missingAdjacent
        ? [...history.slice(0, 4), { role: "user", content: "What is the secondary marker? Reply only with that marker." }]
        : [...history.slice(0, 2),
          { role: "user", content: "What is the marker? Reply only with the marker." }]
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session": key, "x-meridian-agent": "opencode" },
      body: JSON.stringify({ model, max_tokens: 256, stream, messages }),
      signal: AbortSignal.timeout(90_000),
    })
    const raw = await response.text()
    assert.equal(response.status, 200, raw)
    let answer
    if (stream) {
      const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
      assert(!events.some(event => event.type === "error"), raw)
      assert.equal(events.filter(event => event.type === "message_stop").length, 1)
      assert.equal(events.filter(event => event.type === "message_delta").length, 1)
      answer = events.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join("")
    } else {
      answer = JSON.parse(raw).content.filter(block => block.type === "text").map(block => block.text).join("")
    }
    const metric = telemetryStore.getRecent({ limit: 1 })[0]
    const active = readSessionStoreSnapshot()[key]
    assert(active?.claudeSessionId, "response did not publish a durable mapping")
    assert.notEqual(active.claudeSessionId, sourceId, "source transcript was reused in place")
    const activeMessages = await getSessionMessages(active.claudeSessionId, { dir: root })
    assert(activeMessages.length > 0, "supported SDK history is empty")
    if (mode === "ordinary") assert(activeMessages.filter(row => row.type === "user").length >= 2, "ordinary undo fell back to a fresh replay; rollback control is invalid")
    const marker = gap ? changedMarker : missingAdjacent ? secondaryMarker : originalMarker
    const inputHasMarker = activeMessages.some(row => row.type === "user" && JSON.stringify(row.message).includes(marker))
    const expectedLineage = gap ? "new" : "undo"
    console.log(JSON.stringify({ case: mode, stream,
      lineage: metric?.lineageType, inputHasMarker, answerHasMarker: answer.includes(marker), answer }))
    if (metric?.lineageType !== expectedLineage || !inputHasMarker || !answer.includes(marker)) {
      problems.push(`${mode}: expected ${expectedLineage} with supplied marker in both SDK input and answer`)
    }
  }
  assert.deepEqual(await getSessionMessages(sourceId, { dir: root }), sourceMessages, "rollback mutated the source")
  assert.deepEqual(problems, [], "undo history regression")
  console.log(`PASS: ordinary undo, edited intermediate history, and missing adjacent checkpoint (stream=${stream})`)
} finally {
  await instance.close()
}
