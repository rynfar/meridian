#!/usr/bin/env bun
// Native wire gate for concurrent packed Chat Completions. The Claude CLI
// makes real HTTP requests to a scripted Anthropic endpoint on loopback only.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chatMarkers, runUnkeyedChat } from "./e2e-unkeyed-chat.mjs"

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const scratch = process.env.MERIDIAN_E2E_SCRATCH
assert(arg("claude") && scratch, "set MERIDIAN_E2E_SCRATCH and pass --claude=/absolute/path/to/claude")
const sourceRoot = resolve(arg("source-root") ?? fileURLToPath(new URL("..", import.meta.url)))
const loadSource = path => import(pathToFileURL(join(sourceRoot, path)).href)
const cli = realpathSync(arg("claude"))
const version = execFileSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim()
const sdk = JSON.parse(readFileSync(join(sourceRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version

// R1 compares the upstream prompt sections in their original order. The CLI
// moves cache_control as the prompt grows and represents a marked singleton
// text message as an array. Neither changes the text. Do not normalize any
// text, reorder a field, or drop other blocks from the witness.
const stripCache = value => Array.isArray(value) ? value.map(stripCache)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control").map(([key, item]) => [key,
      key === "content" && typeof item === "string" ? [{ type: "text", text: item }] : stripCache(item)])) : value

function prefixWitness(before, prefix, label) {
  const previousBytes = Buffer.from(JSON.stringify(stripCache(before)))
  const prefixBytes = Buffer.from(JSON.stringify(stripCache(prefix)))
  assert(previousBytes.equals(prefixBytes), `R1: ${label} prefix changed`)
  return { bytes: previousBytes.length, previousSha256: createHash("sha256").update(previousBytes).digest("hex"),
    prefixSha256: createHash("sha256").update(prefixBytes).digest("hex") }
}

async function runParallelPackedChat() {
  const root = mkdtempSync(join(realpathSync(scratch), "wire-chat-"))
  let upstream, proxy
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|MERIDIAN_|CLAUDE_PROXY_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
    }
    Object.assign(process.env, {
      HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
      MERIDIAN_WORKDIR: root, MERIDIAN_CLAUDE_PATH: cli, MERIDIAN_PASSTHROUGH: "1", MERIDIAN_TELEMETRY_PERSIST: "0",
    })
    const wires = chatMarkers.map(() => [])
    const firstTurns = Promise.withResolvers()
    let round = 0
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/messages")
      const body = await request.json()
      assert.equal(body.stream, true)
      assert(body.tools.some(tool => tool.name === "mcp__oc__read"), "missing native client tool")
      const prompt = JSON.stringify([body.system, body.messages])
      const chats = chatMarkers.flatMap((marker, index) => prompt.includes(marker) ? [index] : [])
      assert.equal(chats.length, 1, "each prompt must carry only its own conversation marker")
      const [chat] = chats
      wires[chat].push(body)
      assert.equal(wires[chat].length, round, "expected one native request per chat round")
      if (round === 1) {
        // All turns must already have read their expected mapping generation
        // when the concurrent tool boundaries arrive.
        if (wires.every(wire => wire.length === 1)) firstTurns.resolve()
        await firstTurns.promise
      }
      const useTool = round < 3
      const events = [
        ["message_start", { message: { id: `msg_chat_${chat}_${round}`, type: "message", role: "assistant", model: body.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ["content_block_start", { index: 0, content_block: useTool
          ? { type: "tool_use", id: `toolu_chat_${chat}_${round}`, name: "mcp__oc__read", input: {} }
          : { type: "text", text: "" } }],
        ["content_block_delta", { index: 0, delta: useTool
          ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: String(round) }) }
          : { type: "text_delta", text: "complete" } }],
        ["content_block_stop", { index: 0 }],
        ["message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }],
        ["message_stop", {}],
      ]
      return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } })
    } })
    const { createProxyServer } = await loadSource("src/proxy/server.ts")
    const { readSessionStoreSnapshot } = await loadSource("src/proxy/sessionStore.ts")
    const { telemetryStore } = await loadSource("src/telemetry/index.ts")
    proxy = createProxyServer({ silent: true, profiles: [
      { id: "personal", type: "api", apiKey: "offline-test-key", baseUrl: upstream.url.origin },
    ], defaultProfile: "personal" })
    await runUnkeyedChat(request => proxy.app.fetch(request), {
      beforeRound(next) {
        round = next
        if (round === 2) assert.deepEqual(Object.keys(readSessionStoreSnapshot()), [], "packed turns must not publish a fingerprint")
        if (round === 3) {
          const keys = Object.keys(readSessionStoreSnapshot())
          assert.equal(keys.length, wires.length, "each first tool-loop round must publish its own key")
          assert(keys.every(key => key.startsWith("personal:tool-loop:")), "only derived tool-loop keys can be published")
        }
      },
      afterTurn({ id, round }) {
        const row = telemetryStore.getRecent({ limit: 20 }).find(metric => metric.requestId === id)
        assert.equal(row?.lineageType, round === 3 ? "continuation" : "new", `round ${round} lineage`)
      },
    })
    const prefixes = wires.map((wire, index) => {
      assert.equal(wire.length, 3)
      // Round 2 is a keyed replay, not a continuation of the packed request.
      const [, previous, continuation] = wire
      assert(continuation.messages.length > previous.messages.length, "the continuation must append messages")
      return { chat: index + 1, fromRound: 2, toRound: 3,
        system: prefixWitness(previous.system, continuation.system, "system"),
        tools: prefixWitness(previous.tools, continuation.tools, "tools"),
        messages: prefixWitness(previous.messages, continuation.messages.slice(0, previous.messages.length), "messages") }
    })
    return { prefixes, upstreamCalls: wires.flat().length, liveModelCalls: 0 }
  } finally {
    try { await proxy?.closeBackend() }
    finally {
      upstream?.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const rows = [["unkeyed-chat-parallel", runParallelPackedChat]]
for (const [shape, run] of rows) {
  const report = await run()
  console.log(JSON.stringify({ shape, cli: version, sdk, ...report }))
  console.log(`PASS ${shape}: R1 for all continuing tool loops; no shared mapping for packed first turns`)
}
console.log(`pass ${rows.length}/${rows.length}`)
