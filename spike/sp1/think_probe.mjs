// Does the interactive TUI render extended-thinking / reasoning to the PTY —
// and is it just COLLAPSED by default? Drive the REAL claude binary over the
// SAME node-pty setup the ACP agent uses (160x50, xterm-256color, same args),
// so the rendering is byte-identical to Zed. Capture a strong-reasoning prompt,
// render ALL rows, then send the expand keystroke (Ctrl+O) and render again.
//
//   node spike/sp1/think_probe.mjs
import { createRequire } from "node:module";
import { chmodSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;

const require = createRequire(import.meta.url);
// node-pty's prebuilt spawn-helper loses its exec bit on install (pty.ts heals this).
try {
  const pkg = require.resolve("node-pty/package.json");
  const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}
const pty = require("node-pty");

const CLAUDE = join(process.env.HOME, ".local/bin/claude");
const DUMP = "/tmp/claude-think-dump2.txt";
writeFileSync(DUMP, "");
const PROMPT =
  "ultrathink: A frog is at the bottom of a 30-foot well. Each day it climbs up 3 feet but slips back 2 feet at night, except on any day it reaches the top it stops. Reason through it carefully, then give the number of days.";

const cwd = mkdtempSync(join(tmpdir(), "sp1-think-"));
const p = pty.spawn(CLAUDE, ["--settings", '{"remoteControlAtStartup":false}'], {
  name: "xterm-256color",
  cols: 160,
  rows: 50,
  cwd,
  env: { ...process.env, TERM: "xterm-256color" },
});

let raw = "";
let lastByteAt = Date.now();
const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
let state = "idle";
p.onData((d) => {
  raw += d;
  appendFileSync(DUMP, d);
  lastByteAt = Date.now();
  OSC.lastIndex = 0;
  let m, last = null;
  while ((m = OSC.exec(d)) !== null) last = m[1];
  if (last) {
    const c = last.trim().codePointAt(0);
    state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle";
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(40); }
  return pred();
};

function renderRows(bytes) {
  const term = new Terminal({ cols: 160, rows: 50, scrollback: 8000, allowProposedApi: true });
  return new Promise((resolve) => {
    term.write(bytes, () => {
      const buf = term.buffer.active;
      const rows = [];
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        rows.push(line ? line.translateToString(true) : "");
      }
      resolve(rows);
    });
  });
}

const SKIP = ["│ Tips", "│ What's", "│ Welcome", "│  ", "▐▛", "▝▜", "╭─", "╰─", "release-notes"];
function printRows(rows, label) {
  console.log(`\n========== ${label} ==========`);
  rows.forEach((r, y) => {
    if (r.trim() !== "" && !SKIP.some((s) => r.includes(s))) {
      console.log(String(y).padStart(3), "|", r.slice(0, 150));
    }
  });
}

async function main() {
  await waitFor(() => /trust this folder/i.test(raw), 15000);
  await sleep(600);
  p.write("\r");
  await waitFor(() => state === "idle" && Date.now() - lastByteAt > 1200 && raw.includes("Claude Code"), 30000);

  p.write(PROMPT);
  await sleep(250);
  p.write("\r");
  // wait for working then for the turn to settle (idle + quiet)
  await waitFor(() => state === "working", 20000);
  await waitFor(() => state === "idle" && Date.now() - lastByteAt > 1500, 120000);
  await sleep(500);

  console.log("=== markers in cleaned dump ===");
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
  const clean = raw.replace(ANSI, "");
  for (const kw of ["✻ Thinking", "Thinking…", "Thinking", "✻", "Reasoning", "Thought for", "ctrl+o", "Ctrl+O", "ctrl+r", "expand", "to expand", "show thinking"]) {
    console.log(`  ${JSON.stringify(kw)}: ${clean.split(kw).length - 1}`);
  }

  printRows(await renderRows(raw), "COLLAPSED (as-rendered)");

  // Now try to EXPAND thinking. Ctrl+O is the historical expand toggle.
  console.log("\n>>> sending Ctrl+O (0x0f) to expand thinking...");
  p.write("\x0f");
  await sleep(1500);
  printRows(await renderRows(raw), "AFTER Ctrl+O");

  // Also try Tab (tab-toggle-thinking) and Ctrl+R as alternates.
  console.log("\n>>> sending Ctrl+E (0x05) show-all...");
  p.write("\x05");
  await sleep(1500);
  printRows(await renderRows(raw), "AFTER Ctrl+E");
  console.log("\n>>> sending Tab (0x09)...");
  p.write("\x09");
  await sleep(1200);
  printRows(await renderRows(raw), "AFTER Tab");

  try { p.write("\x03"); await sleep(150); p.write("/exit\r"); await sleep(400); } catch {}
  p.kill();
  process.exit(0);
}
main();
