import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
import { readFileSync } from "node:fs";
const data = readFileSync("/tmp/claude-pty-dump.txt", "utf8");
const term = new Terminal({ cols: 160, rows: 60, scrollback: 20000, allowProposedApi: true });
await new Promise((r) => term.write(data, r));
const buf = term.buffer.active; const cell = buf.getNullCell?.();
// find the LAST occurrences of Heading 1/2/3 (the most recent showcase)
for (let y = 0; y < buf.length; y++) {
  const line = buf.getLine(y); const s = line?.translateToString(true) || "";
  if (!/^\s*Heading [123]\b/.test(s)) continue;
  let runs = [], cur = null;
  for (let x = 0; x < 40; x++) {
    const c = line.getCell(x, cell); if (!c) continue;
    const ch = c.getChars(); if (ch === "" && x > 2) break;
    const key = `${c.isFgDefault()?"-":(c.isFgPalette()?"p"+c.getFgColor():"rgb"+c.getFgColor())}${c.isBold()?"B":""}${c.isItalic()?"I":""}${c.isUnderline()?"U":""}${c.isDim()?"d":""}`;
    if (!cur || cur.key !== key) { cur = { key, txt: ch || " " }; runs.push(cur); } else cur.txt += (ch || " ");
  }
  console.log(`y${y}: ` + runs.filter(r => r.txt.trim()).map(r => `"${r.txt}"{${r.key}}`).join(" "));
}
