// Faithful to the USER'S real session: NO --settings override, so global
// settings (verbose:true, alwaysThinkingEnabled:true) apply. ultrathink prompt,
// capture EVERYTHING, snapshot during generation, then Ctrl+O after to expand.
import { createRequire } from "node:module";
import { chmodSync, existsSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
const require = createRequire(import.meta.url);
try {
  const pkg = require.resolve("node-pty/package.json");
  const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}
const pty = require("node-pty");
const CLAUDE = join(process.env.HOME, ".local/bin/claude");
const DUMP = "/tmp/claude-think-dump4.txt";
writeFileSync(DUMP, "");
const PROMPT = "ultrathink: Is 1009 prime? Reason carefully step by step, then answer.";
const cwd = mkdtempSync(join(tmpdir(), "sp1-think4-"));
// NO --settings override — use the real global settings (verbose, alwaysThinking)
const p = pty.spawn(CLAUDE, [], {
  name: "xterm-256color", cols: 160, rows: 50, cwd, env: { ...process.env, TERM: "xterm-256color" },
});
let raw = "", lastByteAt = Date.now(), state = "idle";
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
p.onData((d) => {
  raw += d; appendFileSync(DUMP, d); lastByteAt = Date.now();
  OSC.lastIndex = 0; let m, last = null; while ((m = OSC.exec(d)) !== null) last = m[1];
  if (last) { const c = last.trim().codePointAt(0); state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(40); } return pred(); };
function renderRows(bytes) {
  const term = new Terminal({ cols: 160, rows: 50, scrollback: 8000, allowProposedApi: true });
  return new Promise((res) => term.write(bytes, () => {
    const buf = term.buffer.active, rows = [];
    for (let y = 0; y < buf.length; y++) { const l = buf.getLine(y); rows.push(l ? l.translateToString(true) : ""); } res(rows);
  }));
}
const SKIP = ["Tips","What's","Welcome","▐▛","▝▜","╭─","╰─","release-notes","Context ","Usage ","Weekly ","[Opus","remote-control","claude.ai/code"];
function printRows(rows, label) {
  console.log(`\n===== ${label} =====`);
  rows.forEach((r, y) => { if (r.trim() && !SKIP.some((s) => r.includes(s))) console.log(String(y).padStart(3), "|", r.slice(0, 158)); });
}
async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000);
  await sleep(600); p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - lastByteAt > 1500 && raw.includes("Claude Code"), 35000);
  p.write(PROMPT); await sleep(300); p.write("\r");
  await waitFor(() => state === "working", 25000);
  const t = Date.now(); let n = 0;
  while (state === "working" && Date.now() - t < 70000 && n < 4) { await sleep(2500); printRows(await renderRows(raw), `DURING #${++n}`); }
  await waitFor(() => state === "idle" && Date.now() - lastByteAt > 1500, 90000);
  await sleep(400);
  printRows(await renderRows(raw), "FINAL");
  console.log("\n>>> Ctrl+O after turn");
  p.write("\x0f"); await sleep(1500);
  printRows(await renderRows(raw), "AFTER Ctrl+O");
  const clean = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
  console.log("\n=== markers in FULL stream ===");
  for (const kw of ["Thinking","✻ Thinking","✻","Let me","I need","Let's","First","thinking with high effort","Thought for","gray","italic"]) {
    console.log(`  ${JSON.stringify(kw)}: ${clean.split(kw).length - 1}`);
  }
  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill(); process.exit(0);
}
main();
