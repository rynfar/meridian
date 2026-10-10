#!/usr/bin/env bun
/**
 * Live: does a long client tool call reach Meridian while the model writes it?
 *
 * Without fine-grained tool streaming the API holds each tool-input value back
 * until the model has finished it, so a long `write` arrives in one burst after
 * a silence as long as its generation. Past MERIDIAN_UPSTREAM_IDLE_MS (90 s)
 * the upstream idle guard ends such a turn as `Upstream stalled`.
 *
 * This drives the real Claude executable through the Agent SDK with the options
 * `buildQueryOptions` produces for a streaming passthrough turn with one client
 * `write` tool, in two concurrent arms: as built, and the same options without
 * CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING. For each arm it reports the
 * longest gap between stream events inside the write's tool_use block, and it
 * asserts that the as-built arm streamed. On an unchanged checkout both arms
 * send the same request; `--expect-baseline` then asserts the silence instead.
 *
 *   E2E_PROFILE_CLAUDE_DIR=/absolute/owned/claude-config bun scripts/e2e-tool-input-streaming.mjs
 *
 * Two model calls of roughly 12k output tokens each (E2E_MODEL, default Opus
 * 5.5). Logs numbers only; the generated file is never written or printed.
 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { buildQueryOptions } from "../src/proxy/query.ts"
import { createPassthroughMcpServer } from "../src/proxy/passthroughTools.ts"

const FLAG = "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"
const expectBaseline = process.argv.includes("--expect-baseline")
const credentialDir = process.env.E2E_PROFILE_CLAUDE_DIR
assert.ok(credentialDir, "E2E_PROFILE_CLAUDE_DIR must name an owned Claude config directory")
const claudeConfigDir = realpathSync(credentialDir)
const model = process.env.E2E_MODEL ?? "claude-opus-5-5"
const lines = Number(process.env.E2E_LINES ?? 600)
const maxGapMs = Number(process.env.E2E_MAX_GAP_MS ?? 15_000)
const minInputChars = 20_000
const silentMs = 60_000
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 360_000)

// buildQueryOptions reads MERIDIAN_* switches from this process, and the
// subprocess gets only the env it builds from cleanEnv below. Clear inherited
// Meridian, Claude and provider settings so each run uses the defaults and the
// owned config directory, whatever the shell it starts from.
const inheritedPath = process.env.PATH
for (const key of Object.keys(process.env)) {
  if (/^(MERIDIAN_|CLAUDE_|ANTHROPIC_|OPENCODE_)/.test(key)) delete process.env[key]
}

const claudeExecutable = new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url).pathname
const versionOf = async (pkg) =>
  JSON.parse(await readFile(new URL(`../node_modules/${pkg}/package.json`, import.meta.url), "utf8")).version
const root = await mkdtemp(join(tmpdir(), "meridian-tool-input-streaming-"))
const project = join(root, "project")
await mkdir(project)

const prompt = "Call the write tool exactly once, with filePath first. filePath: " + join(project, "inventory.py") +
  `. content: a complete, self-contained Python 3 module of about ${lines} lines implementing an in-memory ` +
  "inventory management system: dataclasses, a docstring on every function, input validation, and a unittest " +
  "suite at the bottom. Do not write any prose before or after the tool call."

const writeTool = {
  name: "write",
  description: "Write a file to disk.",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path" },
      content: { type: "string", description: "File content" },
    },
    required: ["filePath", "content"],
  },
}

function buildArm(withFlag, abortController) {
  // One MCP server instance per query: an instance accepts one connection.
  const passthroughMcp = createPassthroughMcpServer([writeTool])
  const config = buildQueryOptions({
    prompt, model, workingDirectory: project, systemContext: "You write code files using the provided tool.",
    claudeExecutable, passthrough: true, stream: true, sdkAgents: {}, passthroughMcp,
    hasDeferredTools: passthroughMcp.hasDeferredTools, isUndo: false,
    blockedTools: [], incompatibleTools: [], mcpServerName: "oc", allowedMcpTools: [],
    settingSources: [], memory: false, dreaming: false, thinking: { type: "disabled" },
    cleanEnv: { PATH: inheritedPath, HOME: root, CLAUDE_CONFIG_DIR: claudeConfigDir },
  }, abortController)
  if (!withFlag) delete config.options.env[FLAG]
  return config
}

async function runArm(withFlag) {
  const abortController = new AbortController()
  const config = buildArm(withFlag, abortController)
  const arm = {
    flag: config.options.env[FLAG] ?? null,
    servedModel: null, toolBlock: false, deltas: 0, inputChars: 0, pings: 0,
    firstDeltaMs: null, longestGapMs: 0, toolBlockMs: null, stopReason: null, error: null,
  }
  const startedAt = Date.now()
  const timer = setTimeout(() => abortController.abort(), timeoutMs)
  const sdkQuery = query(config)
  let toolIndex = null
  let toolStartAt = 0
  let lastEventAt = 0
  try {
    for await (const message of sdkQuery) {
      if (message.type !== "stream_event") continue
      const event = message.event
      const now = Date.now()
      if (event.type === "ping") {
        arm.pings++
        continue
      }
      if (event.type === "message_start") arm.servedModel = event.message?.model ?? null
      if (toolIndex !== null) {
        arm.longestGapMs = Math.max(arm.longestGapMs, now - lastEventAt)
        lastEventAt = now
      }
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && toolIndex === null) {
        arm.toolBlock = true
        toolIndex = event.index
        toolStartAt = lastEventAt = now
      }
      if (event.type === "content_block_delta" && event.index === toolIndex && event.delta?.type === "input_json_delta") {
        arm.deltas++
        arm.inputChars += event.delta.partial_json.length
        arm.firstDeltaMs ??= now - toolStartAt
      }
      if (event.type === "content_block_stop" && event.index === toolIndex) arm.toolBlockMs = now - toolStartAt
      if (event.type === "message_delta") arm.stopReason = event.delta?.stop_reason ?? null
      if (event.type === "message_stop") break
    }
  } catch (error) {
    arm.error = String(error).slice(0, 200)
  } finally {
    clearTimeout(timer)
    sdkQuery.close()
  }
  arm.totalMs = Date.now() - startedAt
  return arm
}

try {
  const [asBuilt, withoutFlag] = await Promise.all([runArm(true), runArm(false)])
  console.log(JSON.stringify({
    sdk: await versionOf("@anthropic-ai/claude-agent-sdk"),
    claudeCode: await versionOf("@anthropic-ai/claude-code"),
    model, lines, asBuilt, withoutFlag,
  }, null, 1))

  for (const [name, arm] of [["as-built", asBuilt], ["without-flag", withoutFlag]]) {
    assert.equal(arm.error, null, `${name}: query failed: ${arm.error}`)
    assert.ok(arm.toolBlock, `${name}: the model did not call write`)
    assert.equal(arm.stopReason, "tool_use", `${name}: the turn did not end at the tool call`)
    assert.ok(arm.inputChars >= minInputChars, `${name}: only ${arm.inputChars} characters of tool input`)
  }
  if (expectBaseline) {
    assert.ok(asBuilt.longestGapMs >= silentMs,
      `baseline: expected a silence of at least ${silentMs} ms inside the tool call, longest gap ${asBuilt.longestGapMs} ms`)
    console.log(`baseline reproduced: the tool input arrived after ${asBuilt.longestGapMs} ms of silence`)
  } else {
    assert.ok(asBuilt.longestGapMs < maxGapMs,
      `as-built: tool input went silent for ${asBuilt.longestGapMs} ms (limit ${maxGapMs} ms)`)
    console.log(`as-built streamed its tool input: longest gap ${asBuilt.longestGapMs} ms; ` +
      `without ${FLAG}: ${withoutFlag.longestGapMs} ms`)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
