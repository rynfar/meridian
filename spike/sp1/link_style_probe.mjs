// Is a markdown link's LABEL distinctly styled in the render (so we can find its
// boundary and reconstruct [label](url))? Render the answer and read per-cell
// fg-color + bold across the link line.
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
const sid = randomUUID(), cwd = mkdtempSync(join(tmpdir(), "sp1-lnk2-"));
const p = pty.spawn(CLAUDE, ["--session-id", sid, "--settings", '{"remoteControlAtStartup":false}'], { name: "xterm-256color", cols: 160, rows: 50, cwd, env: { ...process.env, TERM: "xterm-256color" } });
let raw = "", last = Date.now(), state = "idle";
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
p.onData((d) => { raw += d; last = Date.now(); OSC.lastIndex = 0; let m, t = null; while ((m = OSC.exec(d)) !== null) t = m[1]; if (t) { const c = t.trim().codePointAt(0); state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(50); } return pred(); };
async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000); await sleep(600); p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - last > 1500 && raw.includes("Claude Code"), 30000);
  p.write("Reply with EXACTLY: Visit [the docs](https://example.com/docs) and [the API](https://example.com/api) today."); await sleep(300); p.write("\r");
  await waitFor(() => state === "working", 20000); await waitFor(() => state === "idle" && Date.now() - last > 2000, 60000); await sleep(600);
  const term = new Terminal({ cols: 160, rows: 50, scrollback: 5000, allowProposedApi: true });
  await new Promise((r) => term.write(raw, r));
  const buf = term.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y); const s = line?.translateToString(true) || "";
    if (!/docs|API|Visit/i.test(s) || s.startsWith("❯")) continue;
    console.log("ROW:", s.trim().slice(0, 120));
    // per-cell: char | fgColor | bold | underline
    const cell = buf.getNullCell ? buf.getNullCell() : undefined;
    let out = [];
    for (let x = 0; x < 120; x++) {
      const c = line.getCell(x, cell); if (!c) continue;
      const ch = c.getChars() || " ";
      if (ch === " ") { out.push(" "); continue; }
      const fg = c.isFgDefault() ? "." : (c.isFgPalette() ? "p" + c.getFgColor() : "rgb");
      const b = c.isBold() ? "B" : (c.isUnderline() ? "U" : (c.isDim() ? "d" : "-"));
      out.push(`${ch}[${fg}${b}]`);
    }
    console.log("STYLED:", out.join("").slice(0, 400));
    break;
  }
  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill(); process.exit(0);
}
main();
