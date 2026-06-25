// src/proxy/acp/jsonrpc.ts
function parseFrames(buf) {
  const parts = buf.split(`
`);
  const rest = parts.pop() ?? "";
  const messages = parts.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  return { messages, rest };
}
function encodeMessage(msg) {
  return JSON.stringify(msg) + `
`;
}

// src/proxy/drivers/claudePty/pty.ts
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
var require2 = createRequire(import.meta.url);
function loadPty() {
  try {
    const pkg = require2.resolve("node-pty/package.json");
    const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper))
      chmodSync(helper, 493);
  } catch {}
  return require2("node-pty");
}
function spawnClaude(opts) {
  const pty = loadPty();
  const p = pty.spawn(opts.claudePath, [], {
    name: "xterm-256color",
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 50,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: "xterm-256color" }
  });
  return {
    onData: (cb) => p.onData(cb),
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onExit: (cb) => p.onExit(({ exitCode }) => cb(exitCode))
  };
}

// src/proxy/drivers/claudePty/titleState.ts
var OSC_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
function titleState(title) {
  const t = title.trim();
  if (t.length === 0)
    return "idle";
  const code = t.codePointAt(0);
  if (code === undefined)
    return "idle";
  return code >= 10240 && code <= 10495 ? "working" : "idle";
}
function lastTitle(chunk) {
  OSC_TITLE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = OSC_TITLE.exec(chunk)) !== null) {
    if (m[1] !== undefined)
      last = m[1];
  }
  return last;
}

// src/proxy/drivers/claudePty/turnFsm.ts
function initTurn() {
  return { phase: "idle", sawWorking: false };
}
function reduceTurn(s, e) {
  switch (s.phase) {
    case "idle":
      return e.type === "send" ? { ...s, phase: "sent" } : s;
    case "sent":
      if (e.type === "title" && e.state === "working")
        return { phase: "working", sawWorking: true };
      if (e.type === "timeout")
        return { ...s, phase: "error" };
      return s;
    case "working":
      if (e.type === "title" && e.state === "idle")
        return { ...s, phase: "done" };
      return s;
    default:
      return s;
  }
}

// src/proxy/drivers/claudePty/extractText.ts
var CURSOR_FWD = /\x1b\[(\d*)C/g;
var ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
function clean(s) {
  const spaced = s.replace(CURSOR_FWD, (_m, n) => " ".repeat(n ? parseInt(n, 10) : 1));
  return spaced.replace(ANSI, "");
}
var UI_BOUNDARY = /[✽✻✶✳✢✷✸✺✹❋✦⎿❯─]|\s·\s|\bTip:/u;
function extractAssistant(turnRaw) {
  const c = clean(turnRaw);
  const idx = c.lastIndexOf("⏺");
  if (idx === -1)
    return "";
  const tail = c.slice(idx + 1);
  const cut = tail.split(UI_BOUNDARY)[0] ?? "";
  return cut.replace(/\s+/g, " ").trim();
}

// src/proxy/drivers/claudePty/streamDelta.ts
function streamDelta(prev, current) {
  if (current.startsWith(prev)) {
    return { delta: current.slice(prev.length), emitted: current };
  }
  return { delta: "", emitted: current };
}

// src/proxy/drivers/claudePty/permissionDialog.ts
var CONFIRM = /Enter to confirm.*Esc to cancel/;
var OPTION = /^(❯?)\s*(\d+)\.\s+(.*\S)\s*$/;
function parsePermission(screen) {
  if (!CONFIRM.test(screen))
    return null;
  const options = [];
  let defaultIndex = 0;
  for (const line of screen.split(`
`)) {
    const m = OPTION.exec(line);
    if (m && m[2] !== undefined && m[3] !== undefined) {
      const index = Number(m[2]) - 1;
      if (m[1] === "❯")
        defaultIndex = index;
      options.push({ index, name: m[3] });
    }
  }
  return options.length >= 2 ? { options, defaultIndex } : null;
}

// src/proxy/drivers/claudePty/session.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ClaudeSession {
  pty;
  raw = "";
  state = "idle";
  spawnAt = Date.now();
  lastByteAt = Date.now();
  exited = false;
  answeredSig = "";
  constructor(claudePath, cwd) {
    this.pty = spawnClaude({ claudePath, cwd });
    this.pty.onExit(() => this.exited = true);
    this.pty.onData((chunk) => {
      this.raw += chunk;
      this.lastByteAt = Date.now();
      const t = lastTitle(chunk);
      if (t !== null)
        this.state = titleState(t);
    });
  }
  async waitFor(pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred())
        return true;
      if (this.exited)
        return pred();
      await sleep(40);
    }
    return pred();
  }
  async ready() {
    await this.waitFor(() => /trust this folder/i.test(this.raw), 15000);
    await sleep(600);
    this.pty.write("\r");
    return this.waitFor(() => this.state === "idle" && Date.now() - this.spawnAt > 4500 && Date.now() - this.lastByteAt > 1200 && this.raw.includes("Claude Code"), 40000);
  }
  async turn(prompt, onUpdate, onPermission) {
    const t0 = Date.now();
    const startOff = this.raw.length;
    this.answeredSig = "";
    let fsm = reduceTurn(initTurn(), { type: "send" });
    this.pty.write(prompt);
    await sleep(200);
    this.pty.write("\r");
    await this.waitFor(() => {
      if (this.state === "working")
        fsm = reduceTurn(fsm, { type: "title", state: "working" });
      return fsm.phase === "working";
    }, 20000);
    if (fsm.phase !== "working")
      fsm = reduceTurn(fsm, { type: "timeout" });
    let emitted = "";
    if (fsm.phase === "working") {
      await this.waitFor(() => {
        if (onPermission) {
          const dlg = parsePermission(clean(this.raw.slice(startOff)));
          if (dlg) {
            const sig = dlg.options.map((o) => o.name).join("|");
            if (sig !== this.answeredSig) {
              this.answeredSig = sig;
              onPermission(dlg).then((choice) => this.pty.write(String(choice + 1) + "\r"));
            }
          }
        }
        if (onUpdate) {
          const current = extractAssistant(this.raw.slice(startOff));
          const d = streamDelta(emitted, current);
          emitted = d.emitted;
          if (d.delta)
            onUpdate({ text: emitted, delta: d.delta });
        }
        if (this.state === "idle")
          fsm = reduceTurn(fsm, { type: "title", state: "idle" });
        return fsm.phase === "done";
      }, 180000);
    }
    return {
      text: extractAssistant(this.raw.slice(startOff)),
      startedDetected: fsm.sawWorking,
      doneDetected: fsm.phase === "done",
      latencyMs: Date.now() - t0
    };
  }
  cancel() {
    this.pty.write("\x1B");
  }
  async close() {
    try {
      this.pty.write("\x03");
      await sleep(150);
      this.pty.write("/exit\r");
      await sleep(400);
    } finally {
      this.pty.kill();
    }
  }
}

// src/proxy/acp/types.ts
function textFromPrompt(blocks) {
  return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(`
`);
}
function toStopReason(done) {
  return done ? "Completed" : "Error";
}

// src/proxy/acp/server.ts
function createAcpServer(opts) {
  let buffer = "";
  let driver = null;
  const sessionId = "sp1-0";
  const reply = (id, result) => opts.write(encodeMessage({ jsonrpc: "2.0", id, result }));
  const notify = (method, params) => opts.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  async function handle(msg) {
    switch (msg.method) {
      case "initialize":
        return reply(msg.id, {
          protocolVersion: 1,
          agentInfo: { name: "claude-pty" },
          agentCapabilities: {}
        });
      case "session/new": {
        const cwd = String(msg.params?.cwd ?? process.cwd());
        driver = new ClaudeSession(opts.claudePath, cwd);
        await driver.ready();
        return reply(msg.id, { sessionId });
      }
      case "session/prompt": {
        if (!driver)
          return reply(msg.id, { stopReason: "Error" });
        const blocks = msg.params?.prompt ?? [];
        const r = await driver.turn(textFromPrompt(blocks), (u) => {
          notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "ContentChunk",
              content: { type: "text", text: u.delta }
            }
          });
        }, async (p) => p.defaultIndex);
        return reply(msg.id, { stopReason: toStopReason(r.doneDetected) });
      }
      case "session/cancel":
        driver?.cancel();
        return reply(msg.id, {});
      default:
        return reply(msg.id, { error: `unknown method ${String(msg.method)}` });
    }
  }
  return async (chunk) => {
    buffer += chunk;
    const { messages, rest } = parseFrames(buffer);
    buffer = rest;
    for (const m of messages)
      await handle(m);
  };
}

// spike/sp1/integration.run.ts
import { homedir, tmpdir } from "node:os";
import { join as join2 } from "node:path";
import { mkdtempSync } from "node:fs";
async function main() {
  const claudePath = join2(homedir(), ".local/bin/claude");
  const msgs = [];
  const handle = createAcpServer({
    claudePath,
    write: (s) => {
      for (const line of s.trim().split(`
`)) {
        if (line)
          msgs.push(JSON.parse(line));
      }
    }
  });
  const cwd = mkdtempSync(join2(tmpdir(), "sp1-int-"));
  const sessionId = "sp1-0";
  const send = (id, method, params) => handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + `
`);
  await send(1, "initialize");
  await send(2, "session/new", { cwd, mcpServers: [] });
  await send(3, "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Remember this secret number: 73. Reply with exactly: OK" }]
  });
  await send(4, "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "What was the secret number? Reply with just the number." }]
  });
  const chunks = msgs.filter((m) => m.method === "session/update").map((m) => m.params?.update?.content?.text ?? "").join("");
  const completed = msgs.filter((m) => m.result?.stopReason === "Completed").length;
  for (const m of msgs)
    console.log(JSON.stringify(m));
  const ok = completed >= 2 && chunks.includes("73");
  console.log(ok ? "SP1_INTEGRATION: PASS" : `SP1_INTEGRATION: FAIL (completed=${completed}, streamed=${JSON.stringify(chunks)})`);
  process.exit(ok ? 0 : 1);
}
main();
