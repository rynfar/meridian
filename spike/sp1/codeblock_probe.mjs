import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
const require = createRequire(import.meta.url);
try { const pkg = require.resolve("node-pty/package.json"); const h = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"); if (existsSync(h)) chmodSync(h, 0o755); } catch {}
const pty = require("node-pty");
const CLAUDE = join(homedir(), ".local/bin/claude");
const sid = randomUUID(), cwd = mkdtempSync(join(tmpdir(), "sp1-cb-"));
const p = pty.spawn(CLAUDE, ["--session-id", sid, "--settings", '{"remoteControlAtStartup":false}'], { name: "xterm-256color", cols: 160, rows: 60, cwd, env: { ...process.env, TERM: "xterm-256color" } });
let raw = "", last = Date.now(), state = "idle";
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
p.onData((d) => { raw += d; last = Date.now(); OSC.lastIndex = 0; let m, t = null; while ((m = OSC.exec(d)) !== null) t = m[1]; if (t) { const c = t.trim().codePointAt(0); state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(50); } return pred(); };
const PROMPT = "Output EXACTLY this and nothing else:\\nBefore the code.\\n```js\\nfunction add(a, b) {\\n  return a + b;\\n}\\n```\\nAfter the code.";
async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000); await sleep(600); p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - last > 1500 && raw.includes("Claude Code"), 30000);
  p.write(PROMPT); await sleep(300); p.write("\r");
  await waitFor(() => state === "working", 20000); await waitFor(() => state === "idle" && Date.now() - last > 2500, 90000); await sleep(800);
  const term = new Terminal({ cols: 160, rows: 60, scrollback: 8000, allowProposedApi: true });
  await new Promise((r) => term.write(raw, r));
  const buf = term.buffer.active; const cell = buf.getNullCell?.();
  let start = -1; for (let y = buf.length - 1; y >= 0; y--) { const s = buf.getLine(y)?.translateToString(true) || ""; if (/^\s*⏺/.test(s)) { start = y; break; } }
  for (let y = start; y < Math.min(start + 14, buf.length); y++) {
    const line = buf.getLine(y); const s = line?.translateToString(true) || "";
    if (/^\s*❯/.test(s) || /Tip:|tokens|Context /.test(s)) break;
    // detect: leftmost non-space column, any bg color, distinct fg colors present
    let leftCol = -1, bg = "def", fgs = new Set();
    for (let x = 0; x < 158; x++) { const c = line.getCell(x, cell); if (!c) continue; const ch = c.getChars(); if (ch && ch !== " ") { if (leftCol < 0) leftCol = x; if (!c.isBgDefault()) bg = String(c.getBgColor()); if (!c.isFgDefault()) fgs.add(c.getFgColor()); } }
    console.log(`R${y} leftCol=${leftCol} bg=${bg} fgColors=[${[...fgs].join(",")}] | ${JSON.stringify(s.slice(0,70))}`);
  }
  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill(); process.exit(0);
}
main();
