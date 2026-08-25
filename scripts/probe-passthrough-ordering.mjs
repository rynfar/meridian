#!/usr/bin/env bun
/**
 * Phase 1 follow-up: WHY does a deny survive resumeSessionAt truncation?
 *
 * probe-passthrough-transcript.mjs showed the mechanism is positional, not
 * random. The CLI writes per-block assistant rows and dispatches each block's
 * PreToolUse hook as soon as that block finishes streaming, so a 2-call turn
 * lands on disk interleaved:
 *
 *     [6] assistant tool_use #1
 *     [7] user      tool_result #1 = DENY      <-- inside the slice
 *     [8] assistant tool_use #2                <-- checkpoint (last tool-bearing)
 *     [9] user      tool_result #2 = DENY      <-- sliced away
 *
 * resumeSessionAt slices to (0, checkpointIndex + 1), so the first N-1 denies
 * of an N-call turn are replayed to the model and the Nth is not. Picking the
 * FIRST assistant row instead would drop forwarded tool_use blocks, which
 * dangles the client's results — so no single index is clean while the denies
 * interleave.
 *
 * This probe tests the two predictions that follow, and the one lever that
 * could already be doing the job in production:
 *
 *   A. N=1 leaves ZERO survivors (the defect needs parallelism).
 *   B. N=3 leaves TWO survivors (survivors == N-1).
 *   C. Holding the deny until the turn finishes generating — what Meridian's
 *      holdDenyUntilTurnEnd already does — reorders the log to A1,A2,U1,U2 and
 *      leaves zero survivors.
 *
 * If C holds, the production defect is confined to the paths where the hold
 * does NOT apply, and the fix is to close those gaps rather than to redesign
 * the boundary.
 *
 * Costs real tokens and needs Claude Max.
 *
 *   bun scripts/probe-passthrough-ordering.mjs
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findSessionFile, readRows, blocksOf, isDenyResult as isDeny } from "./lib/passthrough-jsonl.mjs"
import { resolveClaudeExecutableAsync } from "../src/proxy/models.ts"

const MODEL = process.env.PROBE_MODEL ?? "sonnet"
const WORKDIR = mkdtempSync(join(tmpdir(), "meridian-order-"))
const FILES = ["a.txt", "b.txt", "c.txt"].map(n => join(WORKDIR, n))
for (const [i, f] of FILES.entries()) writeFileSync(f, `content-${i}\n`)

const DENY_REASON =
  "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."

const claudeExecutable = await resolveClaudeExecutableAsync()
const sleep = ms => new Promise(r => setTimeout(r, ms))

function mkServer() {
  const server = createSdkMcpServer({ name: "oc" })
  server.instance.registerTool(
    "read",
    { description: "Read a file from disk", inputSchema: { file_path: z.string() } },
    async () => ({ content: [{ type: "text", text: "passthrough" }] }),
  )
  return server
}

/**
 * @param holdMs 0 = answer the hook immediately (today's raw shape).
 *               >0 = stall every deny, standing in for holdDenyUntilTurnEnd.
 */
function options(holdMs) {
  return {
    executable: "node",
    maxTurns: 1,
    cwd: WORKDIR,
    model: MODEL,
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
          if (holdMs > 0) await sleep(holdMs)
          return { decision: "block", reason: DENY_REASON }
        }],
      }],
    },
  }
}

async function run(label, fileCount, holdMs) {
  const targets = FILES.slice(0, fileCount)
  const prompt = fileCount === 1
    ? `Read ${targets[0]} using the read tool. Use the tool, do not guess.`
    : `Read all of ${targets.join(" and ")} using the read tool, in parallel in a single step.`

  let sessionId = ""
  let checkpointUuid = ""
  const callIds = new Set()
  // The SDK throws on the terminal error_max_turns result rather than yielding
  // it, so the cap is a normal outcome here and not a failure.
  try {
    for await (const m of query({ prompt, options: options(holdMs) })) {
      if (m.session_id && !sessionId) sessionId = m.session_id
      if (m.type === "assistant") {
        let armed = false
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") { callIds.add(b.id); armed = true }
        }
        if (armed) checkpointUuid = m.uuid ?? ""
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes("maximum number of turns")) throw e
  }

  const file = findSessionFile(sessionId)
  if (!file) return console.log(`  ${label}: no session file`), null

  const rows = readRows(file)
  // Only the conversation rows matter — the CLI also writes queue/attachment
  // bookkeeping rows that carry no content blocks.
  const shape = rows
    .map((r, i) => {
      const bs = blocksOf(r)
      if (r.type === "assistant" && bs.some(b => b.type === "tool_use")) return { i, tag: "A" }
      if (r.type === "user" && bs.some(b => b.type === "tool_result" && isDeny(b))) return { i, tag: "U" }
      return null
    })
    .filter(Boolean)

  const checkpointIndex = rows.findIndex(r => r.uuid === checkpointUuid)
  const kept = checkpointIndex >= 0 ? rows.slice(0, checkpointIndex + 1) : []
  const survivors = kept.flatMap(r => blocksOf(r).filter(b => b.type === "tool_result" && isDeny(b)))
  const keptCalls = kept.flatMap(r => blocksOf(r).filter(b => b.type === "tool_use" && callIds.has(b.id)))

  console.log(`  ${label}`)
  console.log(`    calls=${callIds.size}  log order: ${shape.map(s => s.tag).join("")}  checkpoint=row ${checkpointIndex}`)
  console.log(`    denies surviving the slice: ${survivors.length}   (expected N-1 = ${callIds.size - 1} when interleaved)`)
  console.log(`    forwarded tool_use kept:    ${keptCalls.length} of ${callIds.size}${keptCalls.length < callIds.size ? "   <-- DANGLING client result" : ""}`)
  return { calls: callIds.size, survivors: survivors.length, shape: shape.map(s => s.tag).join("") }
}

console.log(`model=${MODEL}  workdir=${WORKDIR}\n`)
console.log("A. single call, no hold — does the defect need parallelism?")
const a = await run("N=1, hold=0", 1, 0)
console.log("\nB. three calls, no hold — do survivors track N-1?")
const b = await run("N=3, hold=0", 3, 0)
console.log("\nC. three calls, deny held past generation — does the hold reorder the log?")
const c = await run("N=3, hold=2500ms", 3, 2500)

console.log("\n=== verdict ===")
if (a) console.log(`  A  N=1 survivors=${a.survivors}  ${a.survivors === 0 ? "OK — a lone call is clean" : "UNEXPECTED — the defect is not positional"}`)
if (b) console.log(`  B  N=${b.calls} survivors=${b.survivors}  ${b.survivors === b.calls - 1 ? "OK — survivors == N-1" : "UNEXPECTED"}`)
if (c) console.log(`  C  N=${c.calls} survivors=${c.survivors} order=${c.shape}  ${c.survivors === 0 ? "the hold ALREADY fixes the ordering" : "the hold does NOT fix it"}`)
console.log(`\nworkdir: ${WORKDIR}`)
