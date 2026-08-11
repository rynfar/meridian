#!/usr/bin/env bun
/**
 * Live check: does `onSession` actually reach a plugin, and does the report
 * distinguish the two cases that matter?
 *
 * Three turns against a real model, cheapest tier:
 *
 *   1. establish a session
 *   2. extend the trailing message with a late parallel tool result
 *      → must CONTINUE (this is the #767 shape, fixed in 1.61.0)
 *   3. rewrite an earlier message
 *      → must DIVERGE, and lineage-doctor must name the index
 *
 * Requires Claude Max auth. Two turns of Haiku plus one short one.
 */
import { startProxyServer } from "../src/proxy/server.ts"

const PORT = Number(process.env.E2E_PORT ?? 3530)
const MODEL = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"

process.env.MERIDIAN_PASSTHROUGH = "1"

const reports = []
const realError = console.error
console.error = (...args) => {
  const line = args.map(String).join(" ")
  if (line.includes("lineage-doctor")) reports.push(line)
  realError(...args)
}

// pluginConfigPath must be passed explicitly: MERIDIAN_PLUGIN_CONFIG is read
// by the CLI, not by startProxyServer, so a programmatic instance otherwise
// silently loads whatever the user has in ~/.config/meridian/plugins.json.
const inst = await startProxyServer({
  port: PORT,
  host: "127.0.0.1",
  silent: true,
  pluginConfigPath: process.env.E2E_PLUGIN_CONFIG,
})

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
}

async function send(messages, sessionId) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": sessionId,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, stream: false, tools: [READ_TOOL], messages }),
  })
  return res.status
}

const session = `lineage-doctor-${Date.now()}`
const ask = { role: "user", content: "Read /etc/hostname and tell me what it contains." }

console.log("turn 1: establish the session")
console.log("  status", await send([ask], session))

// Turn 2 — the #767 shape: the trailing user message gains a second tool
// result while the conversation grows. Must continue, not replay.
const assistantParallel = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "call-a", name: "read", input: { file_path: "/etc/hostname" } },
    { type: "tool_use", id: "call-b", name: "read", input: { file_path: "/etc/shells" } },
  ],
}
const firstResultOnly = { role: "user", content: [
  { type: "tool_result", tool_use_id: "call-a", content: "e2e-test-host\n" },
] }

console.log("turn 2: seed a trailing tool_result message")
console.log("  status", await send([ask, assistantParallel, firstResultOnly], session))

console.log("turn 3: late sibling result extends that SAME message (#767 shape)")
console.log("  status", await send([
  ask,
  assistantParallel,
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "call-a", content: "e2e-test-host\n" },
    { type: "tool_result", tool_use_id: "call-b", content: "/bin/zsh\n" },
  ] },
], session))

// Turn 4 — the same trailing message, but REWRITTEN rather than extended,
// while the history grows. That must still diverge (the safety property the
// append path deliberately does not relax) and is now explained.
console.log("turn 4: rewrite the trailing message — must diverge and be explained")
console.log("  status", await send([
  ask,
  assistantParallel,
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "call-a", content: "REWRITTEN-result\n" },
    { type: "tool_result", tool_use_id: "call-b", content: "/bin/zsh\n" },
  ] },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  { role: "user", content: "and now?" },
], session))

console.log("\n--- lineage-doctor reports ---")
if (reports.length === 0) console.log("(none — the hook never reached the plugin)")
for (const r of reports) console.log(r)

console.log("\n--- verdict ---")
const named = reports.some(r => r.includes("first mismatch at index"))
console.log(named
  ? "OK: the plugin received onSession and named the diverging message"
  : "FAIL: no mismatch detail reached the plugin")

await inst.close()
process.exit(named ? 0 : 1)
