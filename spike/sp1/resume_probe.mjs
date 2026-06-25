// De-risk: does `claude --resume <uuid>` restore conversation context over a PTY?
// Phase 1: create a session (--session-id), teach it a fact, close.
// Phase 2: resume it (--resume), ask for the fact back.
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
try {
  const pkg = require.resolve("node-pty/package.json");
  const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}
const pty = require("node-pty");
const CLAUDE = join(homedir(), ".local/bin/claude");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args, cwd) {
  const p = pty.spawn(CLAUDE, args, { name: "xterm-256color", cols: 160, rows: 50, cwd, env: { ...process.env, TERM: "xterm-256color" } });
  const st = { raw: "", last: Date.now(), state: "idle", p };
  const OSC = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  p.onData((d) => {
    st.raw += d; st.last = Date.now();
    OSC.lastIndex = 0; let m, t = null; while ((m = OSC.exec(d)) !== null) t = m[1];
    if (t) { const c = t.trim().codePointAt(0); st.state = c >= 0x2800 && c <= 0x28ff ? "working" : "idle"; }
  });
  return st;
}
const waitFor = async (st, pred, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (pred()) return true; await sleep(50); } return pred(); };
async function ready(st) {
  await waitFor(st, () => /trust this folder/i.test(st.raw), 15000);
  await sleep(600); st.p.write("\r");
  await waitFor(st, () => st.state === "idle" && Date.now() - st.last > 1500 && st.raw.includes("Claude Code"), 30000);
}
async function ask(st, prompt) {
  const off = st.raw.length;
  st.p.write(prompt); await sleep(250); st.p.write("\r");
  await waitFor(st, () => st.state === "working", 20000);
  await waitFor(st, () => st.state === "idle" && Date.now() - st.last > 1800, 60000);
  return st.raw.slice(off);
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "sp1-resume-"));
  const sid = randomUUID();
  console.log("session id:", sid, "\ncwd:", cwd);

  console.log("\n--- PHASE 1: create + teach a fact ---");
  const a = run(["--session-id", sid, "--settings", '{"remoteControlAtStartup":false}'], cwd);
  await ready(a);
  await ask(a, "Remember this: my favorite number is 4242. Reply OK.");
  a.p.write("\x03"); await sleep(150); a.p.write("/exit\r"); await sleep(500); a.p.kill();
  console.log("phase 1 done, session closed");

  await sleep(1500);
  console.log("\n--- PHASE 2: resume + ask for the fact ---");
  const b = run(["--resume", sid, "--settings", '{"remoteControlAtStartup":false}'], cwd);
  await ready(b);
  const ans = await ask(b, "What's my favorite number? Reply with just the number.");
  const clean = ans.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
  console.log("resume drivable:", b.raw.includes("Claude Code"));
  console.log("answer contains 4242:", /4242/.test(clean));
  console.log("answer tail:", JSON.stringify(clean.replace(/\s+/g," ").slice(-120)));
  b.p.write("\x03"); await sleep(150); b.p.write("/exit\r"); await sleep(400); b.p.kill();
  process.exit(0);
}
main();
