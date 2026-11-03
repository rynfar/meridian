#!/usr/bin/env bun
// Live E2E for opt-in partial replay (rollback-tail), real SDK and account.
//
// Drives a running Meridian through the Pi adapter with Oh My Pi's request
// shape (`x-meridian-agent: pi`, conversation key in `metadata.user_id`),
// pinned to one profile with `x-meridian-profile`. Every case runs on two
// conversations built the same way, one with `partialReplay` on and one with
// it off, so each rewrite is measured against today's fresh replay:
//
//   undo-gap          9 turns of a few thousand tokens each, then user message
//                     8 is rewritten, the stored trailing turn is dropped and a
//                     new prompt is added (the production 444/443 shape);
//   modified-history  continuing that conversation, an earlier user message
//                     loses its reference notes while the history grows;
//   thinking-filled   with extended thinking on, an assistant reply goes back
//                     as thinking only, then returns with thinking + tool_use
//                     and its tool_result in place of the later turns.
//
// It prints lineage and cache read/write for every request and asserts that
// each rewrite is a rollback-tail with the setting on and a fresh replay with
// it off. The setting is toggled in the instance's settings.json, which
// Meridian re-reads per turn; the file is restored at the end.
//
// Run a second instance beside a production one with its own config, session
// and telemetry state and MERIDIAN_CREDENTIALS_READONLY=1 (see E2E.md, E5):
//
//   E2E_MERIDIAN_URL=http://127.0.0.1:3457 E2E_SETTINGS_FILE=$B/config/settings.json \
//   E2E_PROFILE=<profile> bun scripts/e2e-partial-replay.mjs
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

const base = process.env.E2E_MERIDIAN_URL
const settingsFile = process.env.E2E_SETTINGS_FILE
const profile = process.env.E2E_PROFILE
if (!base || !settingsFile || !profile) {
  throw new Error("Set E2E_MERIDIAN_URL, E2E_SETTINGS_FILE (the instance's settings.json) and E2E_PROFILE")
}
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5"
const padWords = Number(process.env.E2E_PAD_WORDS ?? 2500)
const cases = new Set((process.env.E2E_CASES ?? "undo-gap,modified-history,thinking-filled").split(","))
const run = randomUUID().slice(0, 8)
const SYSTEM = "You are a terse assistant in an automated test. Answer in at most one short sentence. Do not use tools unless the user asks."
const READ_TOOL = {
  name: "read",
  description: "Read a file and return its contents.",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

const originalSettings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : undefined
function setPartialReplay(on) {
  const settings = originalSettings ? JSON.parse(readFileSync(settingsFile, "utf8")) : {}
  settings.partialReplay = on
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
}

async function json(path, init) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(180_000) })
  const text = await response.text()
  assert(response.ok, `${path} -> ${response.status} ${text}`)
  return JSON.parse(text)
}

const steps = []
async function turn(label, conversation, messages, { thinking } = {}) {
  setPartialReplay(conversation.partial)
  const requestId = `${conversation.key}-${steps.length + 1}`
  const body = await json("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-meridian-agent": "pi",
      "x-meridian-profile": profile,
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      model,
      max_tokens: thinking ? 3000 : 200,
      stream: false,
      system: SYSTEM,
      tools: [READ_TOOL],
      ...(thinking ? { thinking: { type: "enabled", budget_tokens: 1024 } } : {}),
      messages,
      metadata: { user_id: JSON.stringify({ session_id: conversation.key }) },
    }),
  })
  const rows = await json("/telemetry/requests?limit=500")
  const row = rows.find(candidate => candidate.requestId === requestId)
  assert(row, `no telemetry row for ${requestId}`)
  const step = {
    case: conversation.name,
    partialReplay: conversation.partial ? "on" : "off",
    step: label,
    messages: messages.length,
    lineage: row.lineageType,
    profile: row.profileId,
    input: body.usage?.input_tokens ?? 0,
    cacheRead: body.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: body.usage?.cache_creation_input_tokens ?? 0,
  }
  steps.push(step)
  console.log(JSON.stringify(step))
  return { role: "assistant", content: body.content }
}

const user = text => ({ role: "user", content: [{ type: "text", text }] })
const nouns = ["colour", "fruit", "animal", "city", "metal", "tree", "planet", "instrument", "fish", "bird"]
// Ordinary words, so the history costs about what Meridian's replay estimate
// expects: synthetic tokens like `ab12w7` cost ~25 tokens a word, push a
// 200k-window model into the CLI's own auto-compaction and invalidate the run.
const VOCABULARY = ("the river crossed a quiet valley where farmers kept old stone houses near the forest edge and "
  + "children walked to school along narrow paths under tall trees while the market opened early every morning with bread "
  + "fresh fruit warm soup and simple tools for the season ahead").split(" ")
function notes(seed, turnIndex) {
  // A per-conversation seed leads each turn, so caches never cross conversations.
  let state = [...`${seed}:${turnIndex}`].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7)
  const words = Array.from({ length: padWords }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return VOCABULARY[state % VOCABULARY.length]
  })
  return `[${seed} notes ${turnIndex}] ${words.join(" ")}`
}
const question = (seed, i, withNotes = true) =>
  `Turn ${i}.${withNotes ? ` Reference notes, no need to read them: ${notes(seed, i)}` : ""}\n\nName a ${nouns[i % nouns.length]} in one word.`

async function build(conversation, turns, options) {
  const history = []
  for (let i = 1; i <= turns; i++) {
    const prompt = user(question(conversation.key, i))
    const reply = await turn(`build ${i}`, conversation, [...history, prompt], options)
    assert(reply.content.every(block => block.type !== "tool_use"), `build turn ${i} called a tool`)
    history.push(prompt, reply)
  }
  return history
}

function expectRewrite(step, partial) {
  assert.equal(step.lineage, partial ? "rollback-tail" : "new", `${step.case} ${step.step} (${step.partialReplay})`)
}

const twins = name => [true, false].map(partial => ({ name, partial, key: `partial-replay-e2e-${run}-${name}-${partial ? "on" : "off"}` }))

const skipped = []
try {
  if (cases.has("undo-gap") || cases.has("modified-history")) {
    for (const conversation of twins("undo-gap")) {
      const history = await build(conversation, 9)
      // Stored: 17 messages, u9 last. Rewrite u8 (index 14), keep a8, drop
      // u9 and add a new prompt: the shape of the 444/443 production replay.
      const undoGap = [...history.slice(0, 14), user("Turn 8, rewritten: name a river in one word."), history[15], user("Now name a mountain in one word.")]
      const undoReply = await turn("undo-gap", conversation, undoGap)
      expectRewrite(steps.at(-1), conversation.partial)
      if (!cases.has("modified-history")) continue
      // The last stored message (the new prompt, index 16) is rewritten and
      // the history grows past it. An edit earlier in the history that keeps
      // the stored tail is a compaction resume instead, as before this change.
      // Messages 14-16 were delivered as rendered tail and carry no SDK UUID,
      // so the fork falls back to the last native assistant, a7 (index 13).
      const modified = [...undoGap.slice(0, 16), user("Now name a mountain in one word, in lowercase."), undoReply, user("Name a desert in one word.")]
      await turn("modified-history", { ...conversation, name: "modified-history" }, modified)
      expectRewrite(steps.at(-1), conversation.partial)
    }
  }

  if (cases.has("thinking-filled")) {
    for (const conversation of twins("thinking-filled")) {
      const options = { thinking: true }
      const history = await build(conversation, 6, options)
      const reply6 = history[11]
      const thinkingOnly = reply6.content.filter(block => block.type === "thinking" || block.type === "redacted_thinking")
      if (thinkingOnly.length === 0) {
        console.log(JSON.stringify({ case: conversation.name, skipped: "the model returned no thinking block to keep alone" }))
        skipped.push(`${conversation.name} (${conversation.partial ? "on" : "off"})`)
        continue
      }
      // Turn 7 keeps reply 6 as thinking only, as a client that dropped the
      // rest of a reply does; the stored history now holds that empty reply.
      const prompt7 = user(question(conversation.key, 7))
      await turn("thinking-only kept", conversation, [...history.slice(0, 11), { role: "assistant", content: thinkingOnly }, prompt7], options)
      assert.equal(steps.at(-1).lineage, "continuation")
      // Then reply 6 comes back filled in with a tool call, and its result
      // replaces the later turns.
      const toolUseId = `toolu_e2e_${run}`
      const filled = [
        ...history.slice(0, 11),
        { role: "assistant", content: [...thinkingOnly, { type: "tool_use", id: toolUseId, name: "read", input: { path: "/etc/hostname" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "e2e-host" }] },
      ]
      await turn("thinking-only filled", conversation, filled, options)
      expectRewrite(steps.at(-1), conversation.partial)
    }
  }
  // A case the model could not set up exercised nothing, so it is not a pass.
  console.log(skipped.length === 0 ? "PASS" : `INCOMPLETE: skipped ${skipped.join(", ")}`)
  if (skipped.length > 0) process.exitCode = 1
} finally {
  if (originalSettings === undefined) unlinkSync(settingsFile)
  else writeFileSync(settingsFile, originalSettings)
}
