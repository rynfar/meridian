// Render the captured dump and run the REAL extractAssistantFromRows logic, then
// compare the final extracted text to the streamed "committed" text to find the
// exact divergence that makes commitFlush bail.
import pkg from "@xterm/headless";
const { Terminal } = pkg;
import { readFileSync } from "node:fs";

const BULLET = /^\s*⏺\s?/u;
const INPUT_BOX = /^\s*❯/u;
const SPINNER = /^\s*[✻✽✶✳✢✷✸✺✹❋✦]/u;
const FOOTER = /^\s*(?:\[(?:Opus|Sonnet|Claude|Haiku)\b|(?:Context|Usage|Weekly)\s+[░▁▂▃▄▅▆▇█])/u;
const RULE_ONLY = /^[─\s]*$/u;
const isBoundary = (r) => INPUT_BOX.test(r) || SPINNER.test(r) || FOOTER.test(r);

function extract(rows) {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (BULLET.test(rows[i])) { start = i; break; }
  if (start === -1) return "";
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (i > start && isBoundary(row)) break;
    out.push(i === start ? row.replace(BULLET, "") : row.replace(/^ {1,2}/, ""));
  }
  while (out.length && RULE_ONLY.test(out[out.length - 1])) out.pop();
  while (out.length && out[0].trim() === "") out.shift();
  return out.join("\n").replace(/[ \t]+$/gm, "").trimEnd();
}

const data = readFileSync("/tmp/claude-real-capture.txt", "utf8");
const term = new Terminal({ cols: 160, rows: 50, scrollback: 8000, allowProposedApi: true });
await new Promise((r) => term.write(data, r));
const buf = term.buffer.active;
const rows = [];
for (let y = 0; y < buf.length; y++) {
  const line = buf.getLine(y);
  rows.push(line ? line.translateToString(true) : "");
}
const finalText = extract(rows);
console.log("=== FINAL extracted text (turn 3, the authoritative reply) ===");
console.log(JSON.stringify(finalText));
console.log("\n=== char length:", finalText.length, "===");
