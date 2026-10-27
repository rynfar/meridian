#!/usr/bin/env node
/**
 * Real SDK/model gate for the Zed adapter: detection by User-Agent, session
 * identity from prompt_cache_key, a forwarded tool call and its result, the
 * neutral SDK working directory, and a title one-shot that must not disturb
 * the thread's session.
 *
 * Runs against an isolated proxy instance (ephemeral port, temp config dir)
 * using the host's Claude credentials. Runs under node (dist/) or bun (src/).
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const meridianRoot = process.env.E2E_MERIDIAN_ROOT ?? fileURLToPath(new URL("..", import.meta.url))
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-zed-client-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_TELEMETRY_PERSIST: "0",
  MERIDIAN_CREDENTIALS_READONLY: "1",
})
const underBun = typeof globalThis.Bun !== "undefined"
const sourceModule = join(meridianRoot, "src/proxy/server.ts")
const serverModule = underBun && existsSync(sourceModule) ? sourceModule : join(meridianRoot, "dist/server.js")
assert(existsSync(serverModule), `Missing Meridian server module: ${serverModule}`)
const { startProxyServer } = await import(pathToFileURL(serverModule).href)
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
// Under node the server is returned before it listens; wait for the bind.
if (!instance.server.address()) await new Promise(resolve => instance.server.once("listening", resolve))
const address = instance.server.address()
assert(address && typeof address === "object")
const base = `http://127.0.0.1:${address.port}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const model = process.env.E2E_MODEL ?? "claude-sonnet-5"
const threadId = `thread-${randomUUID()}`
const ZED_UA = "Zed/1.25.3 (windows; x86_64)"
// Padded like Zed's real prompt so a continuation can show prompt-cache reuse.
const agentSystem = "You are a terse coding agent in Zed.\n\n" +
  `[nonce ${randomUUID()}] ` + "Keep the same conversation across turns and reuse the prior prompt cache. ".repeat(480) +
  "\n\nThe current project contains the following root directories:\n\n- `C:\\workspaces\\project`"
const terminalTool = {
  type: "function",
  function: {
    name: "terminal",
    description: "Executes a shell one-liner in the project and returns its output.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "The one-liner command to execute." },
        cd: { type: "string", description: "Working directory for the command: a project root or a subdirectory of one." },
        timeout_ms: { type: ["integer", "null"], format: "uint64", minimum: 0, description: "Optional maximum runtime in milliseconds." },
      },
      required: ["command", "cd"],
    },
  },
}

async function chat(label, body, { stream = false } = {}) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ZED_UA },
    body: JSON.stringify({ model, max_tokens: 200, stream, ...body }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, `${label}: ${raw}`)
  const telemetryResponse = await fetch(`${base}/telemetry/requests?limit=1&hops=1`)
  assert.equal(telemetryResponse.status, 200)
  const row = (await telemetryResponse.json())[0]
  assert(row, `${label}: missing proxy telemetry`)
  let message, usage, finish
  if (stream) {
    message = { content: "", tool_calls: [] }
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const chunk = JSON.parse(line.slice(6))
      assert(!chunk.error, `${label}: in-stream error ${JSON.stringify(chunk.error)}`)
      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.delta?.content) message.content += choice.delta.content
      for (const call of choice.delta?.tool_calls ?? []) {
        const slot = (message.tool_calls[call.index] ??= { id: "", function: { name: "", arguments: "" } })
        if (call.id) slot.id = call.id
        if (call.function?.name) slot.function.name = call.function.name
        if (call.function?.arguments) slot.function.arguments += call.function.arguments
      }
      if (choice.finish_reason) finish = choice.finish_reason
      if (chunk.usage) usage = chunk.usage
    }
  } else {
    const parsed = JSON.parse(raw)
    message = parsed.choices?.[0]?.message ?? {}
    finish = parsed.choices?.[0]?.finish_reason
    usage = parsed.usage
  }
  // The proxy's own row is the reliable source: a streamed OpenAI usage chunk
  // carries no cache breakdown.
  const cached = row.cacheReadTokens ?? row.cacheReadInputTokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
  console.log(JSON.stringify({ label, adapter: row.adapter, lineage: row.lineageType, session: row.sdkSessionId,
    passthrough: row.isPassthrough, finish, cached, answer: (message.content ?? "").slice(0, 120),
    toolCalls: (message.tool_calls ?? []).map(c => ({ name: c.function?.name, args: c.function?.arguments })) }))
  return { message, finish, cached, row }
}

try {
  // Turn 1: a thread turn (agent system prompt + thread id). Zed advertises
  // its tools on every thread turn; adding them later would change the
  // cached prefix and hide the cache reuse the continuation checks below.
  const turn1 = await chat("turn-1", {
    prompt_cache_key: threadId,
    tools: [terminalTool],
    messages: [
      { role: "system", content: agentSystem },
      { role: "user", content: "Reply with exactly ALPHA." },
    ],
  })
  assert.equal(turn1.row.adapter, "zed")
  assert.equal(turn1.row.lineageType, "new")
  assert.equal(turn1.row.isPassthrough, true)
  assert(turn1.message.content.includes("ALPHA"), "turn 1 gave the wrong answer")
  const workdir = join(root, "config", "workdir")
  assert(existsSync(join(workdir, ".git", "HEAD")), "neutral SDK working directory was not created under the config dir")

  // A title one-shot: same thread id, the thread's messages, no agent system prompt.
  await sleep(2000)
  const title = await chat("title-one-shot", {
    prompt_cache_key: threadId,
    messages: [
      { role: "user", content: "Reply with exactly ALPHA." },
      { role: "assistant", content: turn1.message.content },
      { role: "user", content: "Generate a concise 3-7 word title for this conversation, omitting punctuation. Go straight to the title." },
    ],
  })
  assert.equal(title.row.adapter, "zed")
  assert.notEqual(title.row.lineageType, "continuation", "the title one-shot resumed a session")
  assert.notEqual(title.row.sdkSessionId, turn1.row.sdkSessionId, "the title one-shot ran inside the thread's session")

  // Turn 2 (streamed, as Zed streams): the thread resumes its own session and the model calls the tool.
  await sleep(2000)
  const turn2 = await chat("turn-2-tool-call", {
    prompt_cache_key: threadId,
    tools: [terminalTool],
    messages: [
      { role: "system", content: agentSystem },
      { role: "user", content: "Reply with exactly ALPHA." },
      { role: "assistant", content: turn1.message.content },
      { role: "user", content: "Run `echo hi` in the project root with the terminal tool, with a 5 second timeout. Call the tool now; do not answer in prose." },
    ],
  }, { stream: true })
  // Every resumed turn runs as a managed fork with its own SDK session id, so
  // continuity shows as `continuation` plus prompt-cache reuse, not as one id.
  assert.equal(turn2.row.adapter, "zed")
  assert.equal(turn2.row.lineageType, "continuation", "turn 2 did not resume the thread")
  assert(turn2.cached > 1000, "the continuation did not reuse the prompt cache")
  assert.equal(turn2.finish, "tool_calls", "the model did not call the tool")
  const call = turn2.message.tool_calls[0]
  assert.equal(call?.function?.name, "terminal")
  const args = JSON.parse(call.function.arguments)
  assert.equal(typeof args.command, "string")
  assert.equal(typeof args.cd, "string")
  if (args.timeout_ms !== undefined && args.timeout_ms !== null) {
    assert.equal(typeof args.timeout_ms, "number", `timeout_ms was sent as ${typeof args.timeout_ms} — the nullable schema was not advertised with its type`)
  }

  // Turn 3: Zed returns the tool result as a `tool` message; the model answers.
  await sleep(2000)
  const turn3 = await chat("turn-3-tool-result", {
    prompt_cache_key: threadId,
    tools: [terminalTool],
    messages: [
      { role: "system", content: agentSystem },
      { role: "user", content: "Reply with exactly ALPHA." },
      { role: "assistant", content: turn1.message.content },
      { role: "user", content: "Run `echo hi` in the project root with the terminal tool, with a 5 second timeout. Call the tool now; do not answer in prose." },
      { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: "terminal", arguments: call.function.arguments } }] },
      { role: "tool", tool_call_id: call.id, content: "hi\n" },
    ],
  })
  assert.equal(turn3.row.adapter, "zed")
  assert.equal(turn3.row.lineageType, "continuation", "turn 3 did not resume the thread")
  assert(turn3.cached > 1000, "the tool-result continuation did not reuse the prompt cache")
  assert(turn3.message.content.length > 0, "turn 3 gave no answer")

  console.log(JSON.stringify({ pass: true, model, meridianRoot, serverModule, root, threadId, session: turn1.row.sdkSessionId }))
} finally {
  await instance.close()
}
