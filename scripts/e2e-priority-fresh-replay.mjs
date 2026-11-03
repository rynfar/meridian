#!/usr/bin/env bun
// Live E2E for `priorityFailback: fresh-replay` (real SDK, real accounts).
//
// Drives a running Meridian through the Pi adapter with Oh My Pi's request
// shape (`x-meridian-agent: pi`, conversation key in `metadata.user_id`), no
// pin and priority routing. Steps:
//   1. a new conversation lands on the head X;
//   2. the order flips to Y first, and continuations stay on X;
//   3. a summary-compacted request (a fresh replay on X) moves to Y;
//   4. the order flips back, and an identical retry of that fresh replay stays
//      on Y, whose cache holds it;
//   5. a continuation stays on Y.
// It prints the serving profile, lineage and cache read/write of every step,
// and restores the instance's profile order at the end.
//
// The instance must run with MERIDIAN_ROUTING=priority (or the setting) and
// MERIDIAN_PRIORITY_FAILBACK=fresh-replay, and have at least two profiles.
// Run a second instance beside a production one with its own config, session
// and telemetry state and MERIDIAN_CREDENTIALS_READONLY=1 (see E2E.md).
//
//   E2E_MERIDIAN_URL=http://127.0.0.1:3457 bun scripts/e2e-priority-fresh-replay.mjs
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

const base = process.env.E2E_MERIDIAN_URL
if (!base) throw new Error("Set E2E_MERIDIAN_URL to the Meridian instance under test")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5"
const key = `fresh-replay-e2e-${randomUUID()}`
const secret = randomUUID().slice(0, 8)

async function json(path, init) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  assert(response.ok, `${path} -> ${response.status} ${text}`)
  return JSON.parse(text)
}

async function setOrder(order) {
  await json("/settings/api/routing", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileOrder: order }),
  })
}

const steps = []
async function turn(label, messages) {
  const requestId = `${key}-${steps.length + 1}`
  const body = await json("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-meridian-agent": "pi", "x-request-id": requestId },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      system: "You are a terse assistant in an automated test. Answer in at most one short sentence.",
      messages,
      metadata: { user_id: JSON.stringify({ session_id: key }) },
    }),
  })
  const rows = await json("/telemetry/requests?limit=200")
  const row = rows.find(candidate => candidate.requestId === requestId)
  assert(row, `no telemetry row for ${requestId}`)
  const step = {
    step: label,
    profile: row.profileId,
    routeKind: row.routeKind,
    lineage: row.lineageType,
    cacheRead: body.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: body.usage?.cache_creation_input_tokens ?? 0,
  }
  steps.push(step)
  console.log(JSON.stringify(step))
  return { role: "assistant", content: body.content.filter(block => block.type === "text") }
}

const routing = await json("/settings/api/routing")
assert.equal(routing.routing, "priority", "the instance must use priority routing")
const originalOrder = routing.profileOrder
assert(Array.isArray(originalOrder) && originalOrder.length >= 2, "the instance needs two profiles in its order")
const [x, y] = originalOrder
const user = text => ({ role: "user", content: text })
// Reference text in a turn that survives the compaction below, so the cache
// figures show the history itself, not only the system prompt.
const padWords = Number(process.env.E2E_PAD_WORDS ?? 3000)
const notes = Array.from({ length: padWords }, (_, i) => `note${i % 97}`).join(" ")

try {
  await setOrder([x, y])
  const u1 = user(`Remember the code word ${secret}. Reply with OK.`)
  const a1 = await turn("1 new conversation", [u1])
  assert.equal(steps.at(-1).profile, x)

  await setOrder([y, x])
  const u2 = user("Name a colour.")
  const a2 = await turn("2 continuation after flip", [u1, a1, u2])
  const u3 = user(`Reference notes, no need to read them: ${notes}\n\nName a fruit.`)
  const a3 = await turn("2b continuation", [u1, a1, u2, a2, u3])
  const u4 = user("Name an animal.")
  const a4 = await turn("2c continuation", [u1, a1, u2, a2, u3, a3, u4])
  for (const step of steps.slice(1)) {
    assert.equal(step.profile, x, `${step.step} moved`)
    assert.equal(step.lineage, "continuation", `${step.step} did not resume`)
  }

  // Oh My Pi's summary compaction: the head becomes a summary, the recent
  // exchanges survive, a new turn follows.
  const compacted = [
    user(`Summary of the conversation so far: the user set the code word ${secret}; you named a colour.`),
    { role: "assistant", content: [{ type: "text", text: "Understood." }] },
    u3, a3, u4, a4,
    user("What was the code word?"),
  ]
  const a5 = await turn("3 summary compaction", compacted)
  assert.equal(steps.at(-1).profile, y, "the fresh replay did not move to the head")
  assert.equal(steps.at(-1).lineage, "new")

  await setOrder([x, y])
  await turn("4 identical retry after flip back", compacted)
  assert.equal(steps.at(-1).profile, y, "the identical retry left the account caching it")

  await turn("5 continuation", [...compacted, a5, user("Reply with OK.")])
  assert.equal(steps.at(-1).profile, y)
  assert.equal(steps.at(-1).lineage, "continuation")
  console.log("PASS")
} finally {
  await setOrder(originalOrder)
}
