// Headless pi E2E via --mode rpc (exactly how Pylon drives pi).
// Drives pi -> Meridian (:3456, pty) -> real claude, multi-turn.
//   node spike/sp1/pi_rpc_e2e.mjs
import { spawn } from "node:child_process"

const PI = "/Users/rynfar/repos/pylon-orchestrator/node_modules/.bin/pi"
const ARGS = [
  "--mode", "rpc", "--approve",
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-tools", "--no-context-files",
  "--provider", "anthropic", "--model", "anthropic/claude-sonnet-4", "--api-key", "x",
]
const PROMPTS = [
  "Remember this number: 8383. Reply only with OK.",
  "What number did I ask you to remember? Reply with ONLY the number.",
]

const child = spawn("node", [PI, ...ARGS], {
  env: { ...process.env, ANTHROPIC_API_KEY: "x" },
  stdio: ["pipe", "pipe", "pipe"],
})

let buf = ""
let assistantText = ""
let turnIdx = 0
let promptSent = false
const seenTypes = new Set()

const send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n") } catch {} }

function textFrom(m) {
  if (!m) return ""
  const c = m.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("")
  return ""
}

let currentTurnDone = false
function onEvent(ev) {
  if (!seenTypes.has(ev.type)) { seenTypes.add(ev.type); console.log(`  [event seen: ${ev.type}]`) }
  if (ev.type === "turn_start" || ev.type === "agent_start") currentTurnDone = false
  if (ev.type === "message_update" || ev.type === "message_end") {
    const t = textFrom(ev.message)
    if (t) assistantText = t
  }
  // Complete on the FIRST of (turn_end, agent_end); ignore the trailing one.
  if ((ev.type === "turn_end" || ev.type === "agent_end") && !currentTurnDone) {
    currentTurnDone = true
    console.log(`=== turn ${turnIdx + 1} answer: ${JSON.stringify(assistantText).slice(0, 140)}`)
    turnIdx++
    assistantText = ""
    if (turnIdx < PROMPTS.length) {
      console.log(`--- sending turn ${turnIdx + 1}: ${JSON.stringify(PROMPTS[turnIdx])}`)
      setTimeout(() => send({ type: "prompt", message: PROMPTS[turnIdx] }), 600)
    } else {
      console.log("\n=== DONE ===")
      setTimeout(() => { child.kill(); process.exit(0) }, 300)
    }
  }
}

child.stdout.on("data", (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (line.trim()) { try { onEvent(JSON.parse(line)) } catch {} }
  }
  // Send first prompt once pi has emitted anything (it's alive/ready).
  if (!promptSent) {
    promptSent = true
    console.log(`--- sending turn 1: ${JSON.stringify(PROMPTS[0])}`)
    setTimeout(() => send({ type: "prompt", message: PROMPTS[0] }), 800)
  }
})

child.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) console.error("[pi stderr]", s.slice(0, 200)) })
child.on("exit", (c) => console.log(`[pi exited ${c}]`))

// Fallback: if pi emits nothing on stdout within 4s, still send the first prompt.
setTimeout(() => { if (!promptSent) { promptSent = true; console.log("--- (no stdout yet) sending turn 1"); send({ type: "prompt", message: PROMPTS[0] }) } }, 4000)
setTimeout(() => { console.log("[GLOBAL TIMEOUT 150s]"); child.kill(); process.exit(2) }, 150000)
