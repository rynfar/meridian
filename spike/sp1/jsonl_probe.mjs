// SPIKE: prove JSONL ingestion end-to-end. Spawn the real claude over node-pty
// (same as the broker), discover its session JSONL, drive a code-snippet turn,
// tail the JSONL, and surface clean raw-markdown text + structured tool calls —
// with timing relative to prompt send (to see how live it is).
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
try {
  const pkg = require.resolve("node-pty/package.json");
  const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}
const pty = require("node-pty");
const CLAUDE = join(homedir(), ".local/bin/claude");
const PROJECTS = join(homedir(), ".claude", "projects");
const PROMPT = "Show me a TypeScript debounce function in a fenced code block. Just the code, no explanation.";

const cwd = mkdtempSync(join(tmpdir(), "sp1-jsonl-"));
// Control the session id → the JSONL path is deterministic, no mtime race.
const sessionId = randomUUID();
const p = pty.spawn(CLAUDE, ["--session-id", sessionId, "--settings", '{"remoteControlAtStartup":false}'], {
  name: "xterm-256color", cols: 160, rows: 50, cwd, env: { ...process.env, TERM: "xterm-256color" },
});
let raw = "", lastByteAt = Date.now(), state = "idle";
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
p.onData((d) => {
  raw += d; lastByteAt = Date.now();
  OSC.lastIndex = 0; let m, last = null; while ((m = OSC.exec(d)) !== null) last = m[1];
  if (last) { const c = last.trim().codePointAt(0); state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(40); } return pred(); };

// Deterministic discovery: find OUR session id's file (claude writes it under
// the cwd-encoded project dir; we don't need to guess the encoding — just match
// the uuid filename). No race against other live sessions.
function findSession() {
  const target = `${sessionId}.jsonl`;
  for (const dir of readdirSync(PROJECTS)) {
    const fp = join(PROJECTS, dir, target);
    if (existsSync(fp)) return fp;
  }
  return null;
}

let sessionFile = null;
let linesSeen = 0;
function drainJsonl(label) {
  if (!sessionFile || !existsSync(sessionFile)) return;
  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  for (let i = linesSeen; i < lines.length; i++) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const msg = o.message || {};
    if (msg.role !== "assistant") continue;
    const dt = ((Date.now() - sendAt) / 1000).toFixed(1);
    for (const b of (msg.content || [])) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") console.log(`\n[+${dt}s] TEXT block (raw markdown):\n${b.text}`);
      else if (b.type === "tool_use") console.log(`\n[+${dt}s] TOOL_USE: ${b.name} input=${JSON.stringify(b.input).slice(0,120)}`);
      else if (b.type === "thinking") console.log(`\n[+${dt}s] THINKING block (${(b.thinking||"").length} plaintext chars)`);
    }
  }
  linesSeen = lines.length;
}

let sendAt = 0;
async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000);
  await sleep(600); p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - lastByteAt > 1500 && raw.includes("Claude Code"), 35000);

  sendAt = Date.now();
  p.write(PROMPT); await sleep(300); p.write("\r");
  // The JSONL is created once the turn starts — discover by our session id.
  await waitFor(() => (sessionFile = findSession()) !== null, 20000);
  console.log("discovered session JSONL:", sessionFile ? sessionFile.replace(homedir(), "~") : "(NOT FOUND)");
  await waitFor(() => state === "working", 25000);
  // tail during the turn (fresh session → baseline 0, read all assistant records)
  while (state === "working" && Date.now() - sendAt < 60000) { drainJsonl("during"); await sleep(300); }
  await waitFor(() => state === "idle" && Date.now() - lastByteAt > 1500, 60000);
  await sleep(800);
  drainJsonl("final");
  console.log("\n=== done. total assistant records this turn surfaced above. ===");
  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill(); process.exit(0);
}
main();
