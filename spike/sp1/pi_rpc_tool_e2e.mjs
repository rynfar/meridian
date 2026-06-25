// Phase 5 live gate: headless pi (rpc mode, WITH its tools) drives a tool-using
// turn through Meridian's PTY tool BRIDGE. pi sends body.tools; Meridian spawns
// claude with native tools disabled + the bridged tools; claude calls pi's
// file-read tool; the bridge parks it; pi executes it locally and returns the
// result; claude finishes. Success = the magic value (only in the file, only
// obtainable by actually running the tool) appears in pi's final answer.
//
//   node spike/sp1/pi_rpc_tool_e2e.mjs            # expects PI_TOOL_BRIDGE: PASS
// Requires: Meridian live on :3456 with a transport:"pty" + ptyToolBridge:true
// profile, and a /tmp/bridge_probe.txt containing the magic value.
import { spawn } from "node:child_process"

const PI = "/Users/rynfar/repos/pylon-orchestrator/node_modules/.bin/pi"
const MAGIC = "BRIDGE-TOOL-PROOF-5K2Q9"
// NOTE: NO --no-tools — pi keeps its built-in file tools and sends them as
// body.tools, which is exactly what the bridge needs to register + park.
const ARGS = [
  "--mode", "rpc", "--approve",
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
  "--provider", "anthropic", "--model", "anthropic/claude-sonnet-4", "--api-key", "x",
]
const PROMPT =
  `Use your file-reading tool to read the file /tmp/bridge_probe.txt, then reply with ONLY the exact single line it contains. Do not guess — you must read the file.`

const child = spawn("node", [PI, ...ARGS], {
  env: { ...process.env, ANTHROPIC_API_KEY: "x" },
  stdio: ["pipe", "pipe", "pipe"],
})

let buf = ""
let assistantText = ""
let promptSent = false
let sawToolEvent = false
const seenTypes = new Set()
const send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n") } catch {} }

function textFrom(m) {
  if (!m) return ""
  const c = m.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("")
  return ""
}

let done = false
function finish(ok, why) {
  if (done) return
  done = true
  console.log(`\n=== event types seen: ${[...seenTypes].join(", ")}`)
  console.log(`=== saw a tool event: ${sawToolEvent}`)
  console.log(`=== final answer: ${JSON.stringify(assistantText).slice(0, 240)}`)
  console.log(ok ? "PI_TOOL_BRIDGE: PASS" : `PI_TOOL_BRIDGE: FAIL (${why})`)
  setTimeout(() => { try { child.kill() } catch {} ; process.exit(ok ? 0 : 1) }, 200)
}

let currentTurnDone = false
function onEvent(ev) {
  if (!seenTypes.has(ev.type)) { seenTypes.add(ev.type); console.log(`  [event: ${ev.type}]`) }
  if (/tool/i.test(ev.type)) {
    sawToolEvent = true
    // Log a compact view of any tool-call event so we can see WHICH tool fired.
    const name = ev.tool || ev.name || ev.toolName || (ev.toolCall && ev.toolCall.name)
    if (name) console.log(`    [tool: ${name}]`)
  }
  if (ev.type === "turn_start" || ev.type === "agent_start") currentTurnDone = false
  if (ev.type === "message_update" || ev.type === "message_end") {
    const t = textFrom(ev.message)
    if (t) assistantText = t
  }
  if ((ev.type === "turn_end" || ev.type === "agent_end") && !currentTurnDone) {
    currentTurnDone = true
    const ok = assistantText.includes(MAGIC)
    finish(ok, ok ? "" : "magic value not in answer")
  }
}

child.stdout.on("data", (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (line.trim()) { try { onEvent(JSON.parse(line)) } catch {} }
  }
  if (!promptSent) {
    promptSent = true
    console.log(`--- sending prompt: ${JSON.stringify(PROMPT).slice(0, 120)}`)
    setTimeout(() => send({ type: "prompt", message: PROMPT }), 800)
  }
})

child.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) console.error("[pi stderr]", s.slice(0, 240)) })
child.on("exit", (c) => { console.log(`[pi exited ${c}]`); finish(assistantText.includes(MAGIC), "pi exited") })

setTimeout(() => { if (!promptSent) { promptSent = true; console.log("--- (no stdout) sending prompt"); send({ type: "prompt", message: PROMPT }) } }, 4000)
setTimeout(() => { console.log("[GLOBAL TIMEOUT 180s]"); finish(false, "global timeout") }, 180000)
