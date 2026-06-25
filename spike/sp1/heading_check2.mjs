import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
import { readFileSync } from "node:fs";
const data = readFileSync("/tmp/claude-pty-dump.txt", "utf8");
const term = new Terminal({ cols: 160, rows: 60, scrollback: 20000, allowProposedApi: true });
await new Promise((r) => term.write(data, r));
const buf = term.buffer.active; const cell = buf.getNullCell?.();
// last region: find the final "Heading 1" then show the 3 heading lines fully
let lastH1 = -1;
for (let y = 0; y < buf.length; y++) { const s = buf.getLine(y)?.translateToString(true) || ""; if (/Heading 1\b/.test(s)) lastH1 = y; }
console.log("last 'Heading 1' at row", lastH1);
for (let y = lastH1; y < lastH1 + 6 && y < buf.length; y++) {
  const line = buf.getLine(y); const s = (line?.translateToString(true) || "").trim();
  if (!s) continue;
  // summarize: any bold? any italic? any underline? any dim? across the whole line
  let bold=false, ital=false, und=false, dim=false;
  for (let x = 0; x < 60; x++) { const c = line.getCell(x, cell); if (!c) continue; const ch=c.getChars(); if(!ch||ch===" ")continue; if(c.isBold())bold=true; if(c.isItalic())ital=true; if(c.isUnderline())und=true; if(c.isDim())dim=true; }
  console.log(`  "${s.slice(0,30)}" -> bold=${bold} italic=${ital} underline=${und} dim=${dim}`);
}
