#!/usr/bin/env bun
/**
 * Live E2E: does the passthrough turn cap actually stop the billed digest turn,
 * and is the capped session still resumable?
 *
 * In passthrough the PreToolUse hook denies every client tool call, and the SDK
 * then runs one more model turn to digest that denial. The proxy discards that
 * turn; Anthropic bills it. #609 removed it by aborting the query at the deny;
 * #837 replaced the abort with a drain (the abort lost the transcript), which
 * silently reintroduced the cost. The fix caps `maxTurns` at 1 so the SDK stops
 * at the tool boundary instead — the digest never generates, and the terminal
 * result still arrives to commit the transcript.
 *
 * Four claims, and the last two are what make the cap safe rather than merely
 * cheap:
 *
 *   1. Capped, a tool turn yields NO second assistant turn. This is the cost
 *      claim; everything else is the safety envelope around it.
 *   2. Capped costs materially less than uncapped on the same prompt. Asserted
 *      as a ratio, not a fixed number, because absolute tokens move with the
 *      model and the CLI's own context.
 *   3. A capped session RESUMES at the captured assistant UUID and answers from
 *      the client's real tool_result. This is the claim #837 was defending; if
 *      it ever fails, the cap must come off, because a lost transcript costs a
 *      full cold replay per tool call — far worse than the digest turn.
 *   4. A text-only turn is unaffected. It never asks for a second turn, so it
 *      must return a normal success, not error_max_turns. If this regresses,
 *      every non-tool passthrough turn starts 500ing.
 *
 * Costs a few cents of real tokens and needs Claude Max: it drives the actual
 * Agent SDK, because the thing under test is the SDK's own turn accounting.
 *
 * Run before any release touching the passthrough tool loop, maxTurns, or the
 * early-stop checkpoint.
 *
 *   bun scripts/e2e-digest-turn-cap.mjs
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveClaudeExecutableAsync } from "../src/proxy/models.ts"

const WORKDIR = mkdtempSync(join(tmpdir(), "meridian-digest-cap-"))
const DATA = join(WORKDIR, "data.txt")
const CONTENT = "hello from data.txt"
writeFileSync(DATA, CONTENT + "\n")

const claudeExecutable = await resolveClaudeExecutableAsync()
const failures = []
function check(ok, label, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

function mkServer() {
  const server = createSdkMcpServer({ name: "oc" })
  server.instance.registerTool(
    "read",
    { description: "Read a file from disk", inputSchema: { file_path: z.string() } },
    async () => ({ content: [{ type: "text", text: "passthrough" }] }),
  )
  return server
}

/** Mirrors the passthrough shape buildQueryOptions produces. */
function options(maxTurns, extra = {}) {
  return {
    executable: "node",
    maxTurns,
    cwd: WORKDIR,
    model: "sonnet",
    pathToClaudeCodeExecutable: claudeExecutable,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: [],
    allowedTools: ["mcp__oc__read"],
    mcpServers: { oc: mkServer() },
    settingSources: [],
    plugins: [],
    systemPrompt: "",
    hooks: {
      PreToolUse: [{
        matcher: "",
        hooks: [async (input) => {
          if (input.tool_name === "ToolSearch" || input.tool_name === "StructuredOutput") return {}
          return { decision: "block", reason: "forwarded to client — end your turn now." }
        }],
      }],
    },
    ...extra,
  }
}

async function drive(prompt, maxTurns, extra) {
  const out = { assistantTurns: 0, toolCalls: [], subtype: null, cost: 0, outputTokens: 0, text: "", sessionId: "", toolUuid: "", toolUseId: "" }
  try {
    for await (const m of query({ prompt, options: options(maxTurns, extra) })) {
      if (m.session_id && !out.sessionId) out.sessionId = m.session_id
      if (m.type === "assistant") {
        out.assistantTurns++
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") {
            out.toolCalls.push(b.input?.file_path ?? b.id)
            out.toolUuid = m.uuid
            out.toolUseId = b.id
          }
          if (b.type === "text") out.text += b.text
        }
      }
      if (m.type === "result") {
        out.subtype = m.subtype
        out.cost = m.total_cost_usd ?? 0
        out.outputTokens = m.usage?.output_tokens ?? 0
      }
    }
  } catch (e) {
    out.threw = e instanceof Error ? e.message : String(e)
  }
  return out
}

const TOOL_PROMPT = `Read the file ${DATA} using the read tool. Use the tool, do not guess.`

console.log("\n1. capped tool turn generates no digest turn")
const capped = await drive(TOOL_PROMPT, 1)
check(capped.toolCalls.length > 0, "the tool call still reaches the client", `${capped.toolCalls.length} call(s)`)
check(capped.subtype === "error_max_turns", "the SDK stops at the turn cap", `subtype=${capped.subtype}`)
check(capped.text.trim() === "", "no digest text was generated", JSON.stringify(capped.text.slice(0, 60)))

console.log("\n2. capped costs materially less than uncapped")
const uncapped = await drive(TOOL_PROMPT, 3)
// Not an assistant-message count: the SDK splits ONE turn across several
// assistant messages (a thinking message, then one per parallel tool call), so
// the count moves with the model's phrasing and says nothing about turns. The
// digest turn's signature is that it produces TEXT after the tool call — that
// is the thing being billed and discarded.
check(uncapped.text.trim() !== "" && capped.text.trim() === "",
  "uncapped generates the digest text the cap removes",
  `uncapped=${JSON.stringify(uncapped.text.slice(0, 50))} vs capped=${JSON.stringify(capped.text)}`)
check(capped.cost < uncapped.cost,
  "capped is cheaper on an identical prompt",
  `$${capped.cost.toFixed(5)} vs $${uncapped.cost.toFixed(5)} (${(uncapped.cost / Math.max(capped.cost, 1e-9)).toFixed(1)}x)`)
check(capped.outputTokens < uncapped.outputTokens,
  "capped emits fewer output tokens",
  `${capped.outputTokens} vs ${uncapped.outputTokens}`)

console.log("\n3. the capped session resumes at its checkpoint")
const delta = (async function* () {
  yield {
    type: "user",
    session_id: capped.sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: capped.toolUseId, content: CONTENT }] },
  }
})()
const resumed = await drive(delta, 1, { resume: capped.sessionId, resumeSessionAt: capped.toolUuid })
check(!resumed.threw || resumed.subtype != null, "the resume is accepted", resumed.threw ?? "no error")
check(resumed.text.includes(CONTENT),
  "the model answers from the client's real tool_result",
  JSON.stringify(resumed.text.slice(0, 80)))

console.log("\n4. a text-only turn is untouched by the cap")
const textOnly = await drive("Reply with exactly the word: pong. Nothing else.", 1)
check(textOnly.subtype === "success", "text-only returns success, not error_max_turns", `subtype=${textOnly.subtype}`)
check(textOnly.text.toLowerCase().includes("pong"), "the answer still arrives", JSON.stringify(textOnly.text.slice(0, 40)))

console.log("\n5. parallel tool calls survive the cap")
writeFileSync(join(WORKDIR, "a.txt"), "a\n")
writeFileSync(join(WORKDIR, "b.txt"), "b\n")
const parallel = await drive(
  `Read both ${join(WORKDIR, "a.txt")} and ${join(WORKDIR, "b.txt")} using the read tool, in parallel in a single step.`,
  1,
)
check(parallel.toolCalls.length >= 2,
  "every parallel call is still forwarded",
  `${parallel.toolCalls.length} call(s): ${JSON.stringify(parallel.toolCalls)}`)

console.log(`\n${failures.length === 0 ? "OK — all checks passed" : `FAILED (${failures.length}): ${failures.join("; ")}`}`)
process.exit(failures.length === 0 ? 0 : 1)
