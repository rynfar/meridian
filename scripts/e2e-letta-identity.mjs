#!/usr/bin/env bun
/** Real SDK/model wire-shape gate for Letta conversation identity (E57). */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-letta-identity-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
  MERIDIAN_CREDENTIALS_READONLY: "1",
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")

const model = process.env.E2E_MODEL ?? "claude-sonnet-5"
const conversation = `conv-${randomUUID()}`
const agentId = `agent-${randomUUID()}`
const reminder = id => `<system-reminder> This is an automated message providing information about you.\n` +
  `- **Agent ID (also stored in \`AGENT_ID\` env var)**: ${agentId}\n` +
  (id ? `- **Conversation ID (also stored in \`CONVERSATION_ID\` env var)**: ${id}\n` : "") +
  `- **Agent name**: Axiom\n</system-reminder>`
const prefixes = {
  letta: `[nonce ${randomUUID()}] ` + "The assistant maintains the same conversation across turns and reuses the prior prompt cache. ".repeat(480),
  control: `[nonce ${randomUUID()}] ` + "A generic chat client without a durable identity repacks its previous exchanges on each turn. ".repeat(480),
}

async function turn(arm, id, prefix, reply) {
  const messages = [
    { role: "system", content: `You are a terse assistant. ${prefix}` },
    { role: "user", content: `${reminder(id)}\n\nReply with exactly ALPHA.` },
    ...(reply ? [{ role: "assistant", content: reply }, { role: "user", content: "Now reply with exactly BETA." }] : []),
  ]
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 64, stream: false, messages }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  const body = JSON.parse(raw)
  const content = body.choices?.[0]?.message?.content ?? ""
  const usage = body.usage ?? {}
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0
  const row = telemetryStore.getRecent({ limit: 1 })[0]
  assert(row, "missing proxy telemetry")
  console.log(JSON.stringify({ arm, turn: reply ? 2 : 1, model, adapter: row.adapter,
    lineage: row.lineageType, cached, usage, answer: content }))
  assert(content.includes(reply ? "BETA" : "ALPHA"), `${arm} gave the wrong answer`)
  return { content, cached, row }
}

try {
  const first = await turn("letta", conversation, prefixes.letta)
  await Bun.sleep(3000)
  const second = await turn("letta", conversation, prefixes.letta, first.content)
  const controlFirst = await turn("control", undefined, prefixes.control)
  await Bun.sleep(3000)
  const controlSecond = await turn("control", undefined, prefixes.control, controlFirst.content)
  assert.equal(first.row.adapter, "letta")
  assert.equal(first.row.lineageType, "new")
  assert.equal(second.row.adapter, "letta")
  assert.equal(second.row.lineageType, "continuation")
  assert(second.cached > 1000, "Letta continuation did not reuse the prompt cache")
  assert.equal(controlFirst.row.adapter, "openai")
  assert.equal(controlSecond.row.adapter, "openai")
  assert.equal(controlSecond.row.lineageType, "new")
  console.log(JSON.stringify({ pass: true, model, root }))
} finally {
  await instance.close()
}
