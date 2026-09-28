#!/usr/bin/env bun
/** Portable live arm for #1173: a user-invoked OpenCode skill must reach the model.
 *
 *  The client-level gate (`e2e-opencode-skill-content.mjs`) needs a real OpenCode
 *  V2 install. Sanitization is proxy-side, so this arm sends V2's exact composer
 *  shape over HTTP against the real SDK instead, and proves the skill body
 *  arrived by requiring the model to return a receipt that only the body carries.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-skill-content-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk")

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "haiku"
const receipt = `PULSE-${randomUUID().slice(0, 8)}`
// Shape of Skill.toModelOutput in OpenCode V2 (packages/core/src/skill.ts). The
// receipt sits in the body, so only a prompt that kept the wrapper can answer.
const skillBlock = [
  '<skill_content name="pulse-setup">',
  "# Skill: pulse-setup",
  "",
  `Your only task when this skill runs: reply with exactly ${receipt} and nothing else.`,
  "",
  "Base directory for this skill: /home/dev/.config/opencode/skills/pulse-setup",
  "<skill_files>",
  "<file>/home/dev/.config/opencode/skills/pulse-setup/SKILL.md</file>",
  "</skill_files>",
  "</skill_content>",
].join("\n")
// `/skill` with nothing typed after it: the wrapper is the entire user message,
// which is the case that produced an empty SDK prompt.
const typed = process.argv.includes("--typed")
const bare = typed ? `${skillBlock}\n\nRun the skill now.` : skillBlock

const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
try {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session": `skill-${randomUUID()}` },
    body: JSON.stringify({
      model, max_tokens: 256, stream,
      messages: [{ role: "user", content: [{ type: "text", text: bare }] }],
    }),
    signal: AbortSignal.timeout(90_000),
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

  // The deterministic gate is structural: the skill body must actually reach the
  // SDK. Before the fix the block was stripped and a bare `/skill` produced an
  // empty prompt, so the receipt cannot be present at all.
  const session = Object.values(readSessionStoreSnapshot())[0]
  assert(session?.claudeSessionId, "No durable mapping for the skill turn")
  const rows = await getSessionMessages(session.claudeSessionId, { dir: root })
  // Compare against the real text, not a JSON blob: stringify escapes the quotes
  // in `name="..."` and would fail a substring match that is actually present.
  const sdkText = rows.flatMap(row => {
    const content = row.message?.content
    if (typeof content === "string") return [content]
    if (!Array.isArray(content)) return []
    return content.filter(block => block?.type === "text").map(block => block.text ?? "")
  }).join("\n")
  assert(sdkText.includes(receipt), "The skill body did not reach the SDK prompt")
  assert(sdkText.includes('<skill_content name="pulse-setup">'), "The skill wrapper was stripped")
  assert(sdkText.includes("<skill_files>"), "The nested skill_files list was stripped")

  // Whether the model acts on the skill body is its own choice and is recorded,
  // never asserted. Haiku has been observed calling an unsolicited instruction
  // block a prompt-injection attempt and declining it — while quoting the
  // receipt in the refusal, so `includes` alone cannot tell compliance from
  // refusal. Gating on it would assert model disposition, not proxy behaviour.
  const quotedReceipt = answer.includes(receipt)
  const complied = answer.replace(/\s+/g, "") === receipt
  console.log(JSON.stringify({ result: "PASS", stream, model, typed,
    receiptInPrompt: true, quotedReceipt, complied, answer }))
} finally {
  await instance.close()
}
