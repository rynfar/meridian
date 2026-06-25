// Feed the REAL captured PTY dump to @xterm/headless and print the rendered
// buffer rows. This tells us the TRUTH: does a real terminal emulator render
// the assistant's lists/tables/reasoning as clean, separate rows (so we can
// extract them), or do box rules bleed into content (as the pyte sandbox showed)?
import pkg from "@xterm/headless";
const { Terminal } = pkg;
import { readFileSync } from "node:fs";

const data = readFileSync("/tmp/claude-real-capture.txt", "utf8");

const term = new Terminal({
  cols: 160,
  rows: 50,
  scrollback: 5000,
  allowProposedApi: true,
});

await new Promise((resolve) => term.write(data, resolve));

const buf = term.buffer.active;
const rows = [];
for (let y = 0; y < buf.length; y++) {
  const line = buf.getLine(y);
  rows.push(line ? line.translateToString(true) : "");
}

// Print every non-blank row with its index so we can see structure.
console.log(`=== buffer.length=${buf.length} baseY=${buf.baseY} cursorY=${buf.cursorY} ===`);
rows.forEach((r, y) => {
  if (r.trim() !== "") console.log(String(y).padStart(4), "|", r);
});
