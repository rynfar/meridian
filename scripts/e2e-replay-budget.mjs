#!/usr/bin/env bun
/** Live proof that a fresh replay is bounded to the model's window (#1169).
 *
 *  The production failure needs a six-figure-token conversation, which no gate
 *  can afford, so `MERIDIAN_REPLAY_BUDGET_TOKENS` drives the same code path from
 *  a handful of turns. What is proven here is the behaviour, not the constant:
 *  oldest turns are dropped, an omission marker is inserted, the live tail
 *  always survives, and the request succeeds instead of failing forever.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-replay-budget-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
const budget = Number(process.env.E2E_REPLAY_BUDGET ?? 900)
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
  MERIDIAN_REPLAY_BUDGET_TOKENS: String(budget),
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "haiku"
// One token per turn. The oldest must be dropped and the newest must survive, so
// the model's answer distinguishes "history was trimmed" from "history was lost".
const oldest = `OLDEST-${randomUUID().slice(0, 8)}`
const newest = `NEWEST-${randomUUID().slice(0, 8)}`
const filler = "The project uses an ordinary layout and conventional tooling throughout. "
const history = [
  { role: "user", content: `Project note: the archive code is ${oldest}. ${filler.repeat(20)}` },
  { role: "assistant", content: "Noted the archive code." },
]
// Enough middle turns to blow a small budget several times over.
for (let i = 0; i < 6; i++) {
  history.push({ role: "user", content: `Background item ${i}. ${filler.repeat(25)}` })
  history.push({ role: "assistant", content: `Recorded background item ${i}.` })
}
const messages = [...history,
  { role: "user", content: `Project note: the release code is ${newest}. What is the release code? Reply with the code only.` }]

const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
const key = `replay-budget-${randomUUID()}`
try {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model, max_tokens: 128, stream, messages }),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  let blocks
  if (!stream) {
    blocks = JSON.parse(raw).content
  } else {
    const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
    assert(!events.some(event => event.type === "error"), raw)
    blocks = []
    for (const event of events) {
      if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block }
      if (event.delta?.type === "text_delta") blocks[event.index].text += event.delta.text
    }
    blocks = blocks.filter(Boolean)
  }
  const answer = blocks.filter(block => block.type === "text").map(block => block.text).join("").trim()

  const session = Object.values(readSessionStoreSnapshot()).find(row => row)
  assert(session?.claudeSessionId, "No durable mapping for the replayed turn")
  const rows = await getSessionMessages(session.claudeSessionId, { dir: root })
  const sdkText = rows.flatMap(row => {
    const content = row.message?.content
    if (typeof content === "string") return [content]
    if (!Array.isArray(content)) return []
    return content.filter(block => block?.type === "text").map(block => block.text ?? "")
  }).join("\n")

  // The live tail is never droppable: the turn being answered must be intact.
  assert(sdkText.includes(newest), "The live tail was dropped from the replay")
  // The oldest turn is past a budget this small, so it must have been trimmed.
  assert(!sdkText.includes(oldest), "The oldest turn survived a budget it cannot fit")
  // Trimming must be declared rather than silent.
  const marker = /\[Meridian: (\d+) earlier messages \(~(\d+) tokens\) were omitted/.exec(sdkText)
  assert(marker, `No omission marker in the trimmed replay. Prompt began: ${sdkText.slice(0, 200)}`)
  assert(Number(marker[1]) > 0, "The marker claimed zero omitted messages")
  // The answer comes from the surviving tail, so the turn is usable, not merely admitted.
  assert(answer.includes(newest), `The model could not answer from the kept tail: ${JSON.stringify(answer)}`)

  console.log(JSON.stringify({
    result: "PASS", stream, model, budget,
    omittedMessages: Number(marker[1]), omittedTokens: Number(marker[2]),
    liveTailKept: true, oldestTrimmed: true, answer,
  }))
} finally {
  await instance.close()
}
