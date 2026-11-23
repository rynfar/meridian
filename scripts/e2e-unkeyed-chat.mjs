#!/usr/bin/env node
// Shared unkeyed Chat Completions fixture for the native wire matrix and live check.
// Live: node scripts/e2e-unkeyed-chat.mjs --claude=/path/to/claude --credentials=/path/to/.credentials.json
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const chatMarkers = ["chat-fixture-amber", "chat-fixture-blue", "chat-fixture-green"]

const tools = ["read", "lookup", "describe"].map(name => ({ type: "function", function: {
  name, description: "Fixture-only " + name + ": returns a short synthetic result for a label.",
  parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
} }))

export async function runUnkeyedChat(send, { beforeRound = () => {}, afterTurn = () => {} } = {}) {
  const runId = randomUUID()
  const histories = chatMarkers.map(marker => [
    { role: "system", content: "This is a sequential client tool protocol test, not a coding task. Count receipts in the input. " +
      "With no receipt, request read for label one only. With a step 1 receipt, request read for label two only. " +
      "Never request label two before the step 1 receipt arrives. With a step 2 receipt, reply briefly and stop. " +
      "Make no other calls and never use a native tool." },
    { role: "user", content: "Conversation reference (not a file): " + marker },
    { role: "assistant", content: "Reference noted." },
    { role: "user", content: "Start the two-step read protocol now." },
  ])
  const seenCalls = new Set()
  for (let round = 1; round <= 3; round++) {
    await beforeRound(round)
    const outcomes = await Promise.allSettled(histories.map(async (messages, index) => {
      const id = [runId, index + 1, round].join("-")
      const response = await send(new Request("http://fixture.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": id, "x-meridian-profile": "personal", "user-agent": "LiteLLM" },
        body: JSON.stringify({ model: "fable[1m]", stream: true, max_tokens: 400, stream_options: { include_usage: true }, tools, messages }),
        signal: AbortSignal.timeout(90_000),
      }))
      assert.equal(response.status, 200, id + " HTTP status")
      const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6))
      assert.equal(frames.pop(), "[DONE]", id + " SSE EOF")
      const calls = new Map()
      let finish, usage, content = ""
      for (const frame of frames) {
        const chunk = JSON.parse(frame)
        const failure = chunk.error?.message ?? ""
        const cause = failure === "Shared session mapping changed before recovery publication"
          ? " (recovery publication conflict)"
          : failure.includes("You're out of usage credits") ? " (subscription usage credits exhausted)" : ""
        assert(!chunk.error, id + " SSE error: " + chunk.error?.type + cause)
        usage = chunk.usage ?? usage
        const choice = chunk.choices?.[0]
        finish = choice?.finish_reason ?? finish
        content += choice?.delta?.content ?? ""
        for (const delta of choice?.delta?.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { type: "function", function: { arguments: "" } }
          if (delta.id) call.id = delta.id
          if (delta.function?.name) call.function.name = delta.function.name
          call.function.arguments += delta.function?.arguments ?? ""
          calls.set(delta.index, call)
        }
      }
      await afterTurn({ id, round, index, usage })
      assert.equal(finish, round < 3 ? "tool_calls" : "stop", id + " finish reason")
      if (round < 3) {
        const toolCalls = [...calls.values()]
        assert(toolCalls.length > 0, id + " must return tool calls")
        for (const call of toolCalls) {
          assert(call.id && !seenCalls.has(call.id), id + " must return a unique tool ID")
          seenCalls.add(call.id)
          assert.equal(call.function.name, "read", id + " called the client tool")
          JSON.parse(call.function.arguments)
        }
        messages.push({ role: "assistant", content, tool_calls: toolCalls },
          ...toolCalls.map(call => ({ role: "tool", tool_call_id: call.id, content: "Synthetic receipt for step " + round + "." })))
      } else {
        assert.equal(calls.size, 0, id + " final round must terminate")
      }
    }))
    const failures = outcomes.filter(outcome => outcome.status === "rejected")
    if (failures.length) {
      throw new Error(`${failures.length}/${histories.length} chat turns failed: ` +
        failures.map(({ reason }) => reason instanceof assert.AssertionError ? reason.message : reason?.name ?? "unknown").join("; "))
    }
  }
}

async function live() {
  const arg = name => process.argv.find(value => value.startsWith("--" + name + "="))?.slice(name.length + 3)
  const scratch = process.env.MERIDIAN_E2E_SCRATCH
  const fable = process.env.MERIDIAN_DEFAULT_FABLE_MODEL
  assert(scratch && arg("claude") && arg("credentials"), "set MERIDIAN_E2E_SCRATCH and pass --claude and --credentials")
  const root = mkdtempSync(join(realpathSync(scratch), "live-chat-"))
  const auth = join(root, "claude")
  const originalError = console.error
  let proxy
  const lines = new Map()
  const previousPrompt = new Map()
  try {
    mkdirSync(auth, { mode: 0o700 })
    const credentials = join(auth, ".credentials.json")
    copyFileSync(resolve(arg("credentials")), credentials)
    chmodSync(credentials, 0o600)
    for (const key of Object.keys(process.env)) {
      if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|MERIDIAN_|CLAUDE_PROXY_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
    }
    Object.assign(process.env, {
      HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: auth,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
      MERIDIAN_WORKDIR: root, MERIDIAN_CLAUDE_PATH: resolve(arg("claude")), MERIDIAN_PASSTHROUGH: "1",
      MERIDIAN_CREDENTIALS_READONLY: "1", MERIDIAN_TELEMETRY_PERSIST: "0",
      ...(fable ? { MERIDIAN_DEFAULT_FABLE_MODEL: fable } : {}),
    })
    console.error = (line) => {
      if (typeof line !== "string") return
      const match = /^\[PROXY\] ([\w-]+) (.*)$/.exec(line)
      if (!match) return
      const [, id, body] = match
      if (body.startsWith("usage: ")) {
        const row = lines.get(id)
        if (row) row.usage = body
      } else if (body.startsWith("adapter=openai ") && body.includes(" lineage=")) {
        lines.set(id, { lineage: body.match(/\blineage=[\w-]+/)?.[0],
          cause: body.match(/\bdiverged=[\w:-]+/)?.[0],
          profile: body.match(/\bprofile=[\w-]+/)?.[0], model: body.match(/\bmodel=\S+/)?.[0] })
      }
    }
    const { startProxyServer } = await import("../dist/server.js")
    proxy = await startProxyServer({ host: "127.0.0.1", port: 0,
      profiles: [{ id: "personal", type: "claude-max", claudeConfigDir: auth }], defaultProfile: "personal" })
    if (!proxy.server.listening) await once(proxy.server, "listening")
    const address = proxy.server.address()
    assert(address && typeof address === "object", "loopback listener missing")
    const base = "http://127.0.0.1:" + address.port
    await runUnkeyedChat(request => fetch(new Request(new URL(new URL(request.url).pathname, base), request)), {
      afterTurn({ id, round, index, usage }) {
        const row = lines.get(id)
        assert(row?.usage, id + " missing request/usage log")
        console.log(id, row.lineage, ...(row.cause ? [row.cause] : []), row.profile, row.model, row.usage)
        assert.equal(row.lineage, round === 3 ? "lineage=continuation" : "lineage=new", id + " lineage")
        assert.equal(row.profile, "profile=personal", id + " profile")
        assert.equal(row.model, "model=fable[1m]", id + " model")
        if (round === 1) assert.equal(row.cause, "diverged=independent-request:packed-chat", id + " independent packed turn")
        if (round === 2) previousPrompt.set(index, usage?.prompt_tokens)
        if (round === 3) {
          const prior = previousPrompt.get(index)
          const read = usage?.prompt_tokens_details?.cached_tokens
          const write = usage?.prompt_tokens_details?.cache_write_tokens
          console.log(JSON.stringify({ id, chat: index + 1, previousPromptTokens: prior, cacheReadTokens: read, cacheWriteTokens: write }))
          // Same cache-hit yardstick as E58: read 90% of the previous prefix,
          // and write no more than 10% of that prefix for this short delta.
          assert(prior > 0 && read >= 0.9 * prior && write >= 0 && write <= 0.1 * prior,
            id + " cache gate (prior/read/write): " + [prior, read, write].join("/"))
        }
      },
    })
  } finally {
    try { await proxy?.close() }
    finally {
      console.error = originalError
      rmSync(root, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await live()
}
