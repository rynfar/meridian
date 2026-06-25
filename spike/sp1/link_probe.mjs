// Does Claude Code's TUI render a markdown link's URL as VISIBLE TEXT (so a
// regex could recover it), or only the link text? Drive a link prompt, capture
// the PTY render, and compare to the JSONL markdown source.
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
const require = createRequire(import.meta.url);
try {
  const pkg = require.resolve("node-pty/package.json");
  const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}
const pty = require("node-pty");
const CLAUDE = join(homedir(), ".local/bin/claude");
const PROJECTS = join(homedir(), ".claude", "projects");
const sid = randomUUID();
const cwd = mkdtempSync(join(tmpdir(), "sp1-link-"));
const p = pty.spawn(CLAUDE, ["--session-id", sid, "--settings", '{"remoteControlAtStartup":false}'], {
  name: "xterm-256color", cols: 160, rows: 50, cwd, env: { ...process.env, TERM: "xterm-256color" },
});
let raw = "", last = Date.now(), state = "idle";
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
p.onData((d) => { raw += d; last = Date.now(); OSC.lastIndex = 0; let m, t = null; while ((m = OSC.exec(d)) !== null) t = m[1]; if (t) { const c = t.trim().codePointAt(0); state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(50); } return pred(); };
async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000);
  await sleep(600); p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - last > 1500 && raw.includes("Claude Code"), 30000);
  const PROMPT = "Reply with exactly this markdown and nothing else: See [the InfoWorld article](https://www.infoworld.com/article/4171274/anthropic.html) for details.";
  p.write(PROMPT); await sleep(300); p.write("\r");
  await waitFor(() => state === "working", 20000);
  await waitFor(() => state === "idle" && Date.now() - last > 2000, 60000);
  await sleep(800);

  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
  const clean = raw.replace(ANSI, "");
  console.log("=== Is the URL present as TEXT in the raw stream? ===");
  console.log("  contains 'infoworld.com':", /infoworld\.com/.test(clean));
  console.log("  contains the full path '/article/4171274':", /4171274/.test(clean));
  // show context around 'InfoWorld' in the cleaned stream
  const i = clean.indexOf("InfoWorld");
  if (i >= 0) console.log("  context:", JSON.stringify(clean.slice(i - 10, i + 120).replace(/\s+/g, " ")));

  // xterm render of the answer region
  const term = new Terminal({ cols: 160, rows: 50, scrollback: 5000, allowProposedApi: true });
  await new Promise((r) => term.write(raw, r));
  const buf = term.buffer.active;
  console.log("\n=== rendered rows mentioning the link ===");
  for (let y = 0; y < buf.length; y++) {
    const s = buf.getLine(y)?.translateToString(true) || "";
    if (/InfoWorld|infoworld|article|details/i.test(s)) console.log("  |", s.trim().slice(0, 150));
  }

  // JSONL source
  let file = null;
  for (const dd of readdirSync(PROJECTS)) { const fp = join(PROJECTS, dd, `${sid}.jsonl`); if (existsSync(fp)) { file = fp; break; } }
  console.log("\n=== JSONL markdown source (the truth) ===");
  if (file) for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try { const o = JSON.parse(line); const m = o.message; if (m?.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "text") console.log("  " + JSON.stringify(b.text)); } catch {}
  }
  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill(); process.exit(0);
}
main();
