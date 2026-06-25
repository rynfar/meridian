// Foundation for reliable markdown reconstruction: drive ONE rich reply and read
// the EXACT per-cell styling (fg/bg/bold/italic) of every markdown element, so
// each detection rule is grounded in data.
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
const sid = randomUUID(), cwd = mkdtempSync(join(tmpdir(), "sp1-style-"));
const p = pty.spawn(CLAUDE, ["--session-id", sid, "--settings", '{"remoteControlAtStartup":false}'], { name: "xterm-256color", cols: 160, rows: 60, cwd, env: { ...process.env, TERM: "xterm-256color" } });
let raw = "", last = Date.now(), state = "idle";
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
p.onData((d) => { raw += d; last = Date.now(); OSC.lastIndex = 0; let m, t = null; while ((m = OSC.exec(d)) !== null) t = m[1]; if (t) { const c = t.trim().codePointAt(0); state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(50); } return pred(); };
const PROMPT = "Output EXACTLY this markdown and nothing else:\\n## Heading Two\\nNormal **bold** and *italic* and `inline_code` here.\\n- alpha\\n- beta\\n\\n| Col1 | Col2 |\\n|------|------|\\n| a | b |\\n\\n```js\\nconst x = 1;\\n```\\nVisit [the docs](https://example.com/docs).";
async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000); await sleep(600); p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - last > 1500 && raw.includes("Claude Code"), 30000);
  p.write(PROMPT); await sleep(300); p.write("\r");
  await waitFor(() => state === "working", 20000); await waitFor(() => state === "idle" && Date.now() - last > 2500, 90000); await sleep(800);
  const term = new Terminal({ cols: 160, rows: 60, scrollback: 8000, allowProposedApi: true });
  await new Promise((r) => term.write(raw, r));
  const buf = term.buffer.active; const cell = buf.getNullCell?.();
  // find the answer block: from last ⏺ to the next ❯/rule
  let start = -1; for (let y = buf.length - 1; y >= 0; y--) { const s = buf.getLine(y)?.translateToString(true) || ""; if (/^\s*⏺/.test(s)) { start = y; break; } }
  console.log("answer starts at row", start);
  for (let y = start; y < Math.min(start + 22, buf.length); y++) {
    const line = buf.getLine(y); const s = line?.translateToString(true) || "";
    if (/^\s*❯/.test(s) || /Tip:|tokens|Context |Usage /.test(s)) break;
    // compact style runs: group consecutive cells by (fg,bg,bold,italic)
    let runs = [], cur = null;
    for (let x = 0; x < 158; x++) {
      const c = line.getCell(x, cell); if (!c) continue;
      const ch = c.getChars(); if (ch === "" && x > (s.length||0)) break;
      const key = `${c.isFgDefault()?"def":c.getFgColor()}|${c.isBgDefault()?"def":c.getBgColor()}|${c.isBold()?"B":""}${c.isItalic()?"I":""}${c.isUnderline()?"U":""}${c.isDim()?"d":""}`;
      if (!cur || cur.key !== key) { cur = { key, txt: ch || " " }; runs.push(cur); } else cur.txt += (ch || " ");
    }
    const annot = runs.filter(r => r.txt.trim()).map(r => `"${r.txt}"{${r.key}}`).join(" ");
    console.log(`R${y}: ${annot.slice(0, 360)}`);
  }
  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill(); process.exit(0);
}
main();
