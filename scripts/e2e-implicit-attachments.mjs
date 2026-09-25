#!/usr/bin/env bun
/** Exercise the real Claude executable against a local, credential-free API. */
import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { buildQueryOptions } from "../src/proxy/query.ts"

if (!process.argv.includes("--run")) {
  console.log("Usage: bun scripts/e2e-implicit-attachments.mjs --run [--regression-control]")
  process.exit(0)
}
// The SDK merges options.env over process.env. Clear the parent too: inherited
// provider routing, proxy settings and credentials must never reach this probe.
const inheritedEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
process.env.PATH = inheritedEnv.PATH

const root = await mkdtemp(join(tmpdir(), "meridian-implicit-attachments-"))
const source = "class Middleware\n  @app = app\n  @config = config\nend"
const canaries = []
const requests = []
const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" },
}
const document = { type: "document", source: { type: "text", media_type: "text/plain", data: "explicit-document-canary" } }
const claudeExecutable = new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url).pathname
process.env.HOME = root
process.env.CLAUDE_CONFIG_DIR = join(root, "config-home")

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/messages") return Response.json({})
    const body = await request.json()
    requests.push(body)
    const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 } }
    if (!body.stream) return Response.json(message)
    const events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } })
  },
})

async function runCase({ name, passthrough, structured = false, resume, fork = false, attachmentSetting }) {
  const start = requests.length
  const blocks = [{ type: "text", text: source }, image, document]
  const prompt = structured ? (async function* () {
    yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: blocks } }
  })() : source
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 60_000)
  const config = buildQueryOptions({
    prompt, model: "claude-opus-5", workingDirectory: root, systemContext: "", claudeExecutable,
    passthrough, stream: true, sdkAgents: {}, hasDeferredTools: false, isUndo: false,
    blockedTools: [], incompatibleTools: [], mcpServerName: "oc", allowedMcpTools: [],
    settingSources: [], codeSystemPrompt: false, memory: false, dreaming: false,
    resumeSessionId: resume, forkSession: fork,
    cleanEnv: {
      PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "config-home"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: randomUUID(),
      ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
      ...(process.argv.includes("--regression-control") && passthrough
        ? { CLAUDE_CODE_DISABLE_ATTACHMENTS: "" }
        : attachmentSetting !== undefined ? { CLAUDE_CODE_DISABLE_ATTACHMENTS: attachmentSetting } : {}),
    },
  }, abortController)
  // The native-mode control must also be unable to execute a model-selected tool.
  const turn = query({ ...config, options: { ...config.options, tools: [], mcpServers: {} } })
  let result
  try {
    for await (const event of turn) if (event.type === "result") result = event
  } finally {
    clearTimeout(timer)
    turn.close()
  }
  assert.equal(result?.subtype, "success", `${name}: SDK query failed`)
  const delivered = requests.slice(start).filter(body => body.messages?.some(message => Array.isArray(message.content)
    ? message.content.some(block => block.type === "text" && block.text.includes(source))
    : typeof message.content === "string" && message.content.includes(source)))
  assert(delivered.length > 0, `${name}: no model-bound request captured`)
  for (const body of delivered) {
    const serialized = JSON.stringify(body.messages)
    const expected = !passthrough || attachmentSetting === ""
    for (const canary of canaries) {
      assert.equal(serialized.includes(canary), expected, `${name}: implicit directory attachment mismatch`)
    }
    assert(body.messages.some(message => Array.isArray(message.content)
      ? message.content.some(block => block.type === "text" && block.text.includes(source))
      : message.content.includes(source)), `${name}: Ruby source changed`)
    if (structured) {
      const contents = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      assert(contents.some(block => block.type === "image" && block.source?.media_type === image.source.media_type
        && block.source?.data === image.source.data), `${name}: explicit image bytes lost`)
      assert(contents.some(block => block.type === "document" && block.source?.type === document.source.type
        && block.source?.data === document.source.data), `${name}: explicit document bytes lost`)
    }
  }
  console.log(JSON.stringify({ name, requests: delivered.length, canaries: canaries.length,
    implicitAttachments: !passthrough || attachmentSetting === "", sourcePreserved: true, explicitMedia: structured, result: "PASS" }))
  return result.session_id
}

try {
  await access(claudeExecutable)
  for (const directory of ["app", "config"]) {
    await mkdir(join(root, directory))
    const canary = `UNREQUESTED_${randomUUID().replaceAll("-", "")}`
    canaries.push(canary)
    await writeFile(join(root, directory, canary), "harmless directory-listing canary")
  }
  await runCase({ name: "native-control", passthrough: false })
  const session = await runCase({ name: "passthrough-text", passthrough: true })
  // New filenames cannot be mistaken for attachments replayed from history.
  for (const directory of ["app", "config"]) {
    const canary = `NEW_${randomUUID().replaceAll("-", "")}`
    canaries.push(canary)
    await writeFile(join(root, directory, canary), "harmless continuation canary")
  }
  await runCase({ name: "passthrough-resume", passthrough: true, resume: session })
  const fork = await runCase({ name: "passthrough-fork", passthrough: true, resume: session, fork: true })
  assert.notEqual(fork, session, "fork must create a distinct SDK session")
  await runCase({ name: "passthrough-media", passthrough: true, structured: true })
  await runCase({ name: "process-opt-out", passthrough: true, attachmentSetting: "" })
  console.log("PASS: real Claude input expansion is isolated from passthrough source and explicit media")
} finally {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, inheritedEnv)
}
