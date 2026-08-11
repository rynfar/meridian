#!/usr/bin/env bun
/**
 * Ordering probe: where do recovery blocks land relative to the terminal frame?
 *
 * The silent-turn guard appends recovered content to the message already open
 * on the wire. If the turn's `message_delta` has already been forwarded, a
 * client that finalizes there discards everything after it — which would make
 * the recovery invisible to exactly the clients it exists to serve.
 *
 * This prints the raw event sequence for one forced-silent turn so the answer
 * is observed rather than reasoned about.
 *
 *   MERIDIAN_DEBUG_FORCE_SILENT_TURN=1 bun scripts/e2e-order-probe.mjs
 */
import { startProxyServer } from "../src/proxy/server.ts"

const PORT = Number(process.env.E2E_PORT ?? 3510)
const MODEL = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"

process.env.MERIDIAN_PASSTHROUGH = "1"

const inst = await startProxyServer({ port: PORT, host: "127.0.0.1", silent: true })

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Absolute path" } },
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
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, stream: true, tools: [READ_TOOL], messages }),
  })
  const body = await res.text()
  const events = []
  for (const chunk of body.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(chunk)
    const data = /^data: (.+)$/m.exec(chunk)
    if (!ev) continue
    let parsed
    try { parsed = data ? JSON.parse(data[1]) : undefined } catch { parsed = undefined }
    events.push({ event: ev[1], data: parsed })
  }
  return events
}

const session = `order-probe-${Date.now()}`
const t1 = await send(
  [{ role: "user", content: "Read /etc/hostname and then tell me what it contains." }],
  session,
)
const toolUses = t1
  .filter(e => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use")
  .map(e => e.data.content_block)

if (toolUses.length === 0) {
  console.log("turn 1 made no tool call — rerun")
  await inst.close()
  process.exit(2)
}

const t2 = await send(
  [
    { role: "user", content: "Read /etc/hostname and then tell me what it contains." },
    {
      role: "assistant",
      content: toolUses.map(tu => ({
        type: "tool_use", id: tu.id, name: tu.name, input: { file_path: "/etc/hostname" },
      })),
    },
    {
      role: "user",
      content: toolUses.map(tu => ({
        type: "tool_result", tool_use_id: tu.id, content: "e2e-test-host\n",
      })),
    },
  ],
  session,
)

console.log("\n--- turn 2 event sequence ---")
t2.forEach((e, i) => {
  let detail = ""
  if (e.event === "content_block_delta" && e.data?.delta?.type === "text_delta") {
    detail = ` text=${JSON.stringify(e.data.delta.text.slice(0, 40))}`
  }
  if (e.event === "content_block_start") detail = ` block=${e.data?.content_block?.type} idx=${e.data?.index}`
  if (e.event === "message_delta") detail = ` stop_reason=${e.data?.delta?.stop_reason}`
  console.log(`${String(i).padStart(3)}  ${e.event}${detail}`)
})

// The question this probe exists to answer.
const firstTerminal = t2.findIndex(e => e.event === "message_delta")
const lastText = t2.map(e => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").lastIndexOf(true)
const messageStops = t2.filter(e => e.event === "message_stop").length
const terminalDeltas = t2.filter(e => e.event === "message_delta").length

console.log("\n--- verdict ---")
console.log(`message_delta frames: ${terminalDeltas}`)
console.log(`message_stop frames:  ${messageStops}`)
console.log(`first message_delta at index ${firstTerminal}, last text_delta at index ${lastText}`)
console.log(
  lastText > firstTerminal
    ? "BUG: text arrives AFTER the terminal message_delta — a client finalizing there drops it"
    : "OK: all text precedes the terminal message_delta"
)

await inst.close()
