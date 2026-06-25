// src/proxy/drivers/claudePty/pty.ts
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
var require2 = createRequire(import.meta.url);
function loadPty() {
  if (process.versions.bun) {
    throw new Error('transport:"pty" requires the Node runtime — node-pty does not work under Bun (SP1 Phase 0). ' + 'Run Meridian under Node (e.g. `node dist/cli.js`) for profiles that use transport:"pty".');
  }
  try {
    const pkg = require2.resolve("node-pty/package.json");
    const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper))
      chmodSync(helper, 493);
  } catch {}
  return require2("node-pty");
}
function mergeSpawnEnv(base, override) {
  const merged = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined)
      merged[k] = v;
  }
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined) {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }
  }
  merged["TERM"] = "xterm-256color";
  return merged;
}
function spawnClaude(opts) {
  const pty = loadPty();
  const p = pty.spawn(opts.claudePath, opts.args ?? [], {
    name: "xterm-256color",
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 50,
    cwd: opts.cwd,
    env: mergeSpawnEnv(process.env, opts.env)
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

// src/proxy/drivers/claudePty/screen.ts
import { createRequire as createRequire2 } from "node:module";
var require3 = createRequire2(import.meta.url);
var { Terminal } = require3("@xterm/headless");
var INLINE_CODE_FG = 153;

class Screen {
  term;
  constructor(cols = 160, rows = 50, scrollback = 8000) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  }
  write(data) {
    this.term.write(data);
  }
  async rows() {
    await new Promise((resolve) => this.term.write("", () => resolve()));
    const buf = this.term.buffer.active;
    const out = [];
    for (let y = 0;y < buf.length; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : "");
    }
    return out;
  }
  async styledRows() {
    await new Promise((resolve) => this.term.write("", () => resolve()));
    const buf = this.term.buffer.active;
    const reuse = buf.getNullCell();
    const out = [];
    for (let y = 0;y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) {
        out.push([]);
        continue;
      }
      const spans = [];
      let cur = null;
      for (let x = 0;x < line.length; x++) {
        const c = line.getCell(x, reuse);
        if (!c)
          continue;
        const ch = c.getChars() || " ";
        const bold = !!c.isBold();
        const italic = !!c.isItalic();
        const underline = !!c.isUnderline();
        const isDefault = c.isFgDefault();
        const code = !isDefault && c.isFgPalette() && c.getFgColor() === INLINE_CODE_FG;
        const syntax = !isDefault && !code;
        if (cur && !!cur.bold === bold && !!cur.italic === italic && !!cur.underline === underline && !!cur.code === code && !!cur.syntax === syntax) {
          cur.text += ch;
        } else {
          cur = { text: ch, bold, italic, underline, code, syntax };
          spans.push(cur);
        }
      }
      out.push(spans);
    }
    return out;
  }
  resize(cols, rows) {
    this.term.resize(cols, rows);
  }
  dispose() {
    this.term.dispose();
  }
}

// src/proxy/drivers/claudePty/extractRows.ts
var BULLET = /^\s*⏺\s?/u;
var INPUT_BOX = /^\s*❯/u;
var SPINNER = /^\s*[✻✽✶✳✢✷✸✺✹❋✦]/u;
var STATUS_LINE = /^\s*·\s.*\(\d+[smh]\b/u;
var FOOTER = /^\s*(?:\[(?:Opus|Sonnet|Claude|Haiku)\b|(?:Context|Usage|Weekly)\s+[░▁▂▃▄▅▆▇█])/u;
var RULE_ONLY = /^[─\s]*$/u;
var LIST_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/u;
function ensureBlankBeforeLists(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (LIST_ITEM.test(line) && prev !== undefined && prev.trim() !== "" && !LIST_ITEM.test(prev)) {
      out.push("");
    }
    out.push(line);
  }
  return out;
}
function isBoundary(row) {
  return INPUT_BOX.test(row) || SPINNER.test(row) || STATUS_LINE.test(row) || FOOTER.test(row);
}
var TOOL_RESULT_GLYPH = "⎿";
function looksLikeToolRender(text) {
  return text.includes(TOOL_RESULT_GLYPH);
}
function countBullets(rows) {
  let n = 0;
  for (const r of rows)
    if (BULLET.test(r))
      n++;
  return n;
}
function assistantRowRange(rows) {
  let start = -1;
  for (let i = rows.length - 1;i >= 0; i--) {
    if (BULLET.test(rows[i])) {
      start = i;
      break;
    }
  }
  if (start === -1)
    return null;
  let end = rows.length;
  for (let i = start + 1;i < rows.length; i++) {
    if (isBoundary(rows[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}
function extractAssistantFromRows(rows) {
  let start = -1;
  for (let i = rows.length - 1;i >= 0; i--) {
    if (BULLET.test(rows[i])) {
      start = i;
      break;
    }
  }
  if (start === -1)
    return "";
  const out = [];
  for (let i = start;i < rows.length; i++) {
    const row = rows[i];
    if (i > start && isBoundary(row))
      break;
    out.push(i === start ? row.replace(BULLET, "") : row.replace(/^ {1,2}/, ""));
  }
  while (out.length && RULE_ONLY.test(out[out.length - 1]))
    out.pop();
  while (out.length && out[0].trim() === "")
    out.shift();
  return ensureBlankBeforeLists(out).join(`
`).replace(/[ \t]+$/gm, "").trimEnd();
}

// src/proxy/drivers/claudePty/reconstruct.ts
var LIST_ITEM2 = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/u;
var BOX_CHARS = /[┌┐└┘├┤┬┴┼─│╭╮╰╯]/u;
var TABLE_ROW = /^\s*[│┌├└]/u;
var BRACEISH = /^[\s{}()[\];,]+$/u;
function isCodeLine(row) {
  return row.some((s) => s.syntax && s.text.trim() !== "");
}
function isBraceish(text) {
  return text.trim() !== "" && BRACEISH.test(text);
}
function wrap(text, marker) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || m[2] === "")
    return text;
  return m[1] + marker + m[2] + marker + m[3];
}
function mergeRuns(spans) {
  const out = [];
  for (const sp of spans) {
    const prev = out[out.length - 1];
    if (prev && !!prev.bold === !!sp.bold && !!prev.italic === !!sp.italic && !!prev.code === !!sp.code) {
      prev.text += sp.text;
    } else {
      out.push({ ...sp });
    }
  }
  return out;
}
function renderInline(spans, quote = false) {
  let out = "";
  for (const sp of mergeRuns(spans)) {
    if (sp.text === "")
      continue;
    const italic = sp.italic && !quote;
    if (sp.code)
      out += wrap(sp.text, "`");
    else if (sp.bold && italic)
      out += wrap(sp.text, "***");
    else if (sp.bold)
      out += wrap(sp.text, "**");
    else if (italic)
      out += wrap(sp.text, "*");
    else
      out += sp.text;
  }
  return out;
}
var plain = (spans) => spans.map((s) => s.text).join("");
function headingHashes(spans) {
  const meaningful = spans.filter((s) => s.text.trim() !== "");
  if (!meaningful.length || !meaningful.every((s) => s.bold))
    return null;
  return meaningful.some((s) => s.underline) ? "#" : "##";
}
function detectLanguage(code) {
  if (/<\/[a-z][\w-]*>|^\s*<(!doctype|html|head|body|div|span|ul|li|a)\b/im.test(code))
    return "html";
  if (/^\s*#include\b|\bstd::|\bcout\s*<</m.test(code))
    return "cpp";
  if (/\bfn\s+\w+|\blet\s+mut\b|\bimpl\s|\bprintln!|->\s*\w+\s*\{/.test(code))
    return "rust";
  if (/\bfunc\s+\w+|\bpackage\s+\w+\b|:=/.test(code))
    return "go";
  if (/\bpublic\s+(class|static)\b|\bSystem\.out\./.test(code))
    return "java";
  if (/\bdef\s+\w+\s*\(|^\s*(from|import)\s+\w|\bprint\s*\(|\bself\b/m.test(code))
    return "python";
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE)\b/i.test(code) && /\b(FROM|INTO|SET)\b/i.test(code))
    return "sql";
  if (/^\s*#!.*\b(bash|sh|zsh)\b|^\s*(echo|cd|export|sudo|mkdir)\s/m.test(code))
    return "bash";
  if (/\binterface\s+\w+|:\s*(string|number|boolean|void)\b|\bimport\b[^\n]*\bfrom\b[^\n]*['"]/.test(code))
    return "typescript";
  if (/\b(function|const|let)\b|=>|\bconsole\.\w+/.test(code))
    return "javascript";
  if (/^\s*[{[][\s\S]*"[^"]+"\s*:/.test(code))
    return "json";
  return "";
}
var QUOTE_BAR = /^(\s*)[▎▏▌▐│┃]\s?/u;
function renderTable(rows) {
  const out = [];
  let headerDone = false;
  for (const row of rows) {
    const text = plain(row).trim();
    if (!text.includes("│"))
      continue;
    const cells = text.split("│").map((c) => c.trim());
    if (cells.length && cells[0] === "")
      cells.shift();
    if (cells.length && cells[cells.length - 1] === "")
      cells.pop();
    out.push("| " + cells.join(" | ") + " |");
    if (!headerDone) {
      out.push("| " + cells.map(() => "---").join(" | ") + " |");
      headerDone = true;
    }
  }
  return out.join(`
`);
}
function reconstructMarkdown(rows) {
  const lines = [];
  for (let i = 0;i < rows.length; i++) {
    const row = rows[i];
    const text = plain(row);
    if (isCodeLine(row)) {
      const code = [];
      while (i < rows.length) {
        const t = plain(rows[i]);
        const blankThenCode = t.trim() === "" && i + 1 < rows.length && (isCodeLine(rows[i + 1]) || isBraceish(plain(rows[i + 1])));
        if (isCodeLine(rows[i]) || isBraceish(t) || blankThenCode) {
          code.push(t.replace(/[ \t]+$/, ""));
          i++;
        } else
          break;
      }
      i--;
      while (code.length && code[code.length - 1].trim() === "")
        code.pop();
      const body = code.join(`
`);
      lines.push("```" + detectLanguage(body) + `
` + body + "\n```");
      continue;
    }
    const qm = text.match(QUOTE_BAR);
    if (qm) {
      lines.push("> " + renderInline(dropLeadingChars(row, qm[0].length), true));
      continue;
    }
    if (TABLE_ROW.test(text) && BOX_CHARS.test(text)) {
      const block = [];
      while (i < rows.length && BOX_CHARS.test(plain(rows[i])))
        block.push(rows[i++]);
      i--;
      lines.push(renderTable(block));
      continue;
    }
    const listMatch = text.match(LIST_ITEM2);
    if (listMatch) {
      const marker = /\d/.test(listMatch[2]) ? listMatch[2] : "-";
      const contentSpans = stripPrefix(row, listMatch[1].length + listMatch[2].length + 1);
      lines.push(`${listMatch[1]}${marker} ${renderInline(contentSpans)}`);
      continue;
    }
    const hashes = headingHashes(row);
    if (hashes) {
      lines.push(`${hashes} ${plain(row).trim()}`);
      continue;
    }
    lines.push(renderInline(row));
  }
  const trimmed = lines.map((l) => l.replace(/[ \t]+$/, ""));
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === "")
    trimmed.pop();
  return trimmed.join(`
`);
}
function dropLeadingChars(spans, n) {
  return stripPrefix(spans, n);
}
function stripPrefix(spans, n) {
  const out = [];
  let dropped = 0;
  for (const sp of spans) {
    if (dropped >= n) {
      out.push(sp);
      continue;
    }
    const take = Math.min(n - dropped, sp.text.length);
    dropped += take;
    const rest = sp.text.slice(take);
    if (rest)
      out.push({ ...sp, text: rest });
  }
  return out;
}

// src/proxy/drivers/claudePty/streamCommit.ts
function initCommit() {
  return { committed: "" };
}
var BOX = /[│┌┐└┘├┤┬┴┼]/u;
function wholeLines(s) {
  const i = s.lastIndexOf(`
`);
  return i === -1 ? "" : s.slice(0, i + 1);
}
function firstBoxLineStart(s) {
  let lineStart = 0;
  for (let i = 0;i <= s.length; i++) {
    if (i === s.length || s[i] === `
`) {
      if (BOX.test(s.slice(lineStart, i)))
        return lineStart;
      lineStart = i + 1;
    }
  }
  return -1;
}
function commitStep(state, current) {
  let stable = wholeLines(current);
  const boxAt = firstBoxLineStart(stable);
  if (boxAt >= 0)
    stable = stable.slice(0, boxAt);
  if (stable.length > state.committed.length && stable.startsWith(state.committed)) {
    const delta = stable.slice(state.committed.length);
    state.committed = stable;
    return delta;
  }
  return "";
}
function commitFlush(state, final) {
  if (final.startsWith(state.committed)) {
    const delta = final.slice(state.committed.length);
    state.committed = final;
    return delta;
  }
  return "";
}

// src/proxy/drivers/claudePty/transcriptTail.ts
import { readdirSync, existsSync as existsSync2, readFileSync, statSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir } from "node:os";

// src/proxy/drivers/claudePty/transcript.ts
function isTerminalStop(reason) {
  return typeof reason === "string" && reason !== "" && reason !== "tool_use" && reason !== "pause_turn";
}
function isObj(v) {
  return typeof v === "object" && v !== null;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function toolResultText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content))
    return content.map((b) => isObj(b) ? str(b.text) : "").join("");
  return "";
}
function parseTranscriptLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(rec) || !isObj(rec.message))
    return [];
  const msg = rec.message;
  const content = msg.content;
  if (!Array.isArray(content))
    return [];
  const out = [];
  for (const b of content) {
    if (!isObj(b))
      continue;
    switch (b.type) {
      case "text":
        out.push({ kind: "text", text: str(b.text) });
        break;
      case "thinking":
        out.push({ kind: "thinking", text: str(b.thinking) });
        break;
      case "tool_use":
        out.push({ kind: "tool_use", id: str(b.id), name: str(b.name), input: b.input });
        break;
      case "tool_result":
        out.push({ kind: "tool_result", toolUseId: str(b.tool_use_id), text: toolResultText(b.content) });
        break;
    }
  }
  if (msg.role === "assistant" && isTerminalStop(msg.stop_reason)) {
    out.push({ kind: "turn_end", reason: msg.stop_reason });
  }
  return out;
}

// src/proxy/drivers/claudePty/transcriptTail.ts
var DEFAULT_PROJECTS = join2(homedir(), ".claude", "projects");
function findSessionFile(sessionId, projectsDir = DEFAULT_PROJECTS) {
  const target = `${sessionId}.jsonl`;
  let dirs;
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const fp = join2(projectsDir, d, target);
    if (existsSync2(fp))
      return fp;
  }
  return null;
}

class TranscriptTail {
  sessionId;
  projectsDir;
  file = null;
  linesConsumed = 0;
  lastSize = -1;
  cachedLines = [];
  constructor(sessionId, projectsDir = DEFAULT_PROJECTS) {
    this.sessionId = sessionId;
    this.projectsDir = projectsDir;
  }
  located() {
    if (this.file)
      return true;
    this.file = findSessionFile(this.sessionId, this.projectsDir);
    return this.file !== null;
  }
  markBaseline() {
    this.linesConsumed = this.lines().length;
  }
  read() {
    const lines = this.lines();
    if (lines.length <= this.linesConsumed)
      return [];
    const fresh = lines.slice(this.linesConsumed);
    this.linesConsumed = lines.length;
    return fresh.flatMap(parseTranscriptLine);
  }
  lines() {
    if (!this.located() || !this.file)
      return [];
    let size;
    try {
      size = statSync(this.file).size;
    } catch {
      return this.cachedLines;
    }
    if (size === this.lastSize)
      return this.cachedLines;
    try {
      this.cachedLines = readFileSync(this.file, "utf8").split(`
`).filter(Boolean);
      this.lastSize = size;
    } catch {}
    return this.cachedLines;
  }
}

// src/proxy/drivers/claudePty/permissionDialog.ts
var FOOTER2 = /Esc to cancel/;
var OPTION_G = /(❯)?\s*\b(\d+)\.\s+([^\n❯]*?)(?=\s{2,}|\n|$)/g;
var DEFAULT_MARK = /❯\s*(\d+)\./;
function parsePermission(screen) {
  if (!FOOTER2.test(screen))
    return null;
  const options = [];
  const seen = new Set;
  OPTION_G.lastIndex = 0;
  let m;
  while ((m = OPTION_G.exec(screen)) !== null) {
    const num = Number(m[2]);
    if (!Number.isFinite(num) || seen.has(num))
      continue;
    seen.add(num);
    options.push({ index: num - 1, name: (m[3] ?? "").trim() });
  }
  if (options.length < 2)
    return null;
  const dm = DEFAULT_MARK.exec(screen);
  const defaultIndex = dm && dm[1] !== undefined ? Number(dm[1]) - 1 : 0;
  return { options, defaultIndex };
}

// src/proxy/drivers/claudePty/session.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
var DUMP_PATH = process.env.CLAUDE_PTY_DUMP;
var DEBUG = !!process.env.CLAUDE_PTY_DEBUG;
var SILENCE_LIMIT_MS = 300000;
var TURN_FAILSAFE_MS = 1800000;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ClaudeSession {
  pty;
  raw = "";
  screen = new Screen;
  sessionId;
  resuming;
  tail;
  mode;
  state = "idle";
  spawnAt = Date.now();
  lastByteAt = Date.now();
  exited = false;
  answeredSig = "";
  lastAnswerAt = 0;
  preTurnBullets = 0;
  constructor(claudePath, cwd, args = [], opts) {
    const envMode = process.env.CLAUDE_PTY_OUTPUT_MODE;
    const validEnv = envMode === "pty" || envMode === "preview" || envMode === "rich";
    this.mode = opts?.mode ?? (validEnv ? envMode : "clean");
    this.resuming = !!opts?.resumeSessionId;
    this.sessionId = opts?.resumeSessionId ?? randomUUID();
    this.tail = new TranscriptTail(this.sessionId);
    const idArgs = this.resuming ? ["--resume", this.sessionId] : ["--session-id", this.sessionId];
    this.pty = spawnClaude({ claudePath, cwd, args: [...idArgs, ...args], env: opts?.env });
    this.pty.onExit(() => this.exited = true);
    this.pty.onData((chunk) => {
      this.raw += chunk;
      this.screen.write(chunk);
      this.lastByteAt = Date.now();
      if (DUMP_PATH) {
        try {
          appendFileSync(DUMP_PATH, chunk);
        } catch {}
      }
      const t = lastTitle(chunk);
      if (t !== null) {
        const next = titleState(t);
        if (DEBUG && next !== this.state) {
          process.stderr.write(`[dbg ${Date.now() - this.spawnAt}ms] title ${this.state}->${next} ${JSON.stringify(t.slice(0, 24))}
`);
        }
        this.state = next;
      }
    });
  }
  get id() {
    return this.sessionId;
  }
  async assistantText() {
    const rows = await this.screen.rows();
    if (countBullets(rows) <= this.preTurnBullets)
      return "";
    return extractAssistantFromRows(rows);
  }
  async richText() {
    const styled = await this.screen.styledRows();
    const plainRows = styled.map((r) => r.map((s) => s.text).join(""));
    if (countBullets(plainRows) <= this.preTurnBullets)
      return "";
    const range = assistantRowRange(plainRows);
    if (!range)
      return "";
    const [start, end] = range;
    const slice = [];
    for (let i = start;i < end; i++) {
      const m = i === start ? plainRows[i].match(/^\s*⏺\s?/) : plainRows[i].match(/^ {1,2}/);
      slice.push(dropLeadingChars(styled[i], m ? m[0].length : 0));
    }
    const ruleOrBlank = (r) => /^[─\s]*$/u.test(r.map((s) => s.text).join(""));
    while (slice.length && ruleOrBlank(slice[slice.length - 1]))
      slice.pop();
    return reconstructMarkdown(slice);
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
    if (this.resuming) {
      if (await this.waitFor(() => /trust this folder/i.test(this.raw), 4000)) {
        await sleep(600);
        this.pty.write("\r");
      }
      return this.waitFor(() => this.state === "idle" && Date.now() - this.spawnAt > 3000 && Date.now() - this.lastByteAt > 1500, 40000);
    }
    await this.waitFor(() => /trust this folder/i.test(this.raw), 15000);
    await sleep(600);
    this.pty.write("\r");
    return this.waitFor(() => this.state === "idle" && Date.now() - this.spawnAt > 4500 && Date.now() - this.lastByteAt > 1200 && this.raw.includes("Claude Code"), 40000);
  }
  handlePermission(startOff, onPermission) {
    if (!onPermission)
      return false;
    const recent = clean(this.raw.slice(startOff)).slice(-800);
    const dlg = parsePermission(recent);
    if (!dlg)
      return false;
    const sig = dlg.options.map((o) => o.name).join("|");
    if (sig !== this.answeredSig) {
      this.answeredSig = sig;
      this.lastAnswerAt = Date.now();
      onPermission(dlg).then((choice) => this.pty.write(String(choice + 1) + "\r"));
    }
    return true;
  }
  settled(quietMs, blocking) {
    const justAnswered = Date.now() - this.lastAnswerAt < 1500;
    return this.state === "idle" && !blocking && !justAnswered && Date.now() - this.lastByteAt > quietMs;
  }
  async turn(prompt, onUpdate, onPermission) {
    const t0 = Date.now();
    const startOff = this.raw.length;
    this.answeredSig = "";
    this.preTurnBullets = countBullets(await this.screen.rows());
    if (this.mode !== "pty")
      this.tail.markBaseline();
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
    const streamingPty = this.mode === "pty" || this.mode === "rich";
    const text = streamingPty ? await this.runPty(t0, startOff, () => fsm, (f) => fsm = f, onUpdate, onPermission) : await this.runClean(t0, startOff, () => fsm, (f) => fsm = f, onUpdate, onPermission);
    return {
      text,
      startedDetected: fsm.sawWorking,
      doneDetected: fsm.phase === "done",
      latencyMs: Date.now() - t0
    };
  }
  async runClean(t0, startOff, getFsm, setFsm, onUpdate, onPermission) {
    let fullText = "";
    let turnEnded = false;
    const emit = (events) => {
      for (const ev of events) {
        if (ev.kind === "text" && ev.text.trim()) {
          const delta = (fullText ? `

` : "") + ev.text;
          fullText += delta;
          onUpdate?.({ type: "text", delta, text: fullText });
        } else if (ev.kind === "tool_use") {
          onUpdate?.({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.kind === "tool_result") {
          onUpdate?.({ type: "tool_result", id: ev.toolUseId, output: ev.text });
        } else if (ev.kind === "thinking" && ev.text.trim() && this.mode !== "preview") {
          onUpdate?.({ type: "thought", delta: ev.text });
        } else if (ev.kind === "turn_end") {
          turnEnded = true;
        }
      }
    };
    let previewEmitted = "";
    const streamPreview = async () => {
      if (this.mode !== "preview" || !onUpdate)
        return;
      const preview = await this.assistantText();
      if (preview.length > previewEmitted.length && preview.startsWith(previewEmitted)) {
        const delta = preview.slice(previewEmitted.length);
        previewEmitted = preview;
        onUpdate({ type: "thought", delta });
      } else if (!preview.startsWith(previewEmitted)) {
        previewEmitted = preview;
      }
    };
    if (getFsm().phase === "working") {
      const failsafe = Date.now() + TURN_FAILSAFE_MS;
      while (getFsm().phase !== "done" && Date.now() < failsafe) {
        const blocking = this.handlePermission(startOff, onPermission);
        await streamPreview();
        emit(this.tail.read());
        if (turnEnded || !this.tail.located() && this.settled(900, blocking)) {
          if (DEBUG)
            process.stderr.write(`[dbg ${Date.now() - t0}ms] CLEAN done (turnEnd=${turnEnded}) textLen=${fullText.length}
`);
          setFsm(reduceTurn(getFsm(), { type: "title", state: "idle" }));
        }
        if (this.exited || Date.now() - this.lastByteAt > SILENCE_LIMIT_MS)
          break;
        await sleep(50);
      }
    }
    const graceEnd = Date.now() + 2500;
    let quietSince = Date.now();
    while (Date.now() < graceEnd && Date.now() - quietSince < 600) {
      const events = this.tail.read();
      if (events.length) {
        emit(events);
        quietSince = Date.now();
      }
      await sleep(80);
    }
    if (!fullText.trim()) {
      const fallback = await this.assistantText() || extractAssistant(this.raw.slice(startOff));
      if (fallback.trim()) {
        fullText = fallback;
        onUpdate?.({ type: "text", delta: fallback, text: fullText });
      }
    }
    return fullText;
  }
  async runPty(t0, startOff, getFsm, setFsm, onUpdate, onPermission) {
    const rich = this.mode === "rich";
    const getText = () => rich ? this.richText() : this.assistantText();
    const commit = initCommit();
    let lastLen = 0;
    let lastGrowAt = Date.now();
    if (getFsm().phase === "working") {
      const failsafe = Date.now() + TURN_FAILSAFE_MS;
      while (getFsm().phase !== "done" && Date.now() < failsafe) {
        const blocking = this.handlePermission(startOff, onPermission);
        if (rich && onUpdate)
          this.emitToolEvents(this.tail.read(), onUpdate, commit);
        const current = await getText();
        if (current.length > lastLen) {
          lastLen = current.length;
          lastGrowAt = Date.now();
        }
        if (onUpdate && !(rich && looksLikeToolRender(current))) {
          const delta = commitStep(commit, current);
          if (delta)
            onUpdate({ type: "text", delta, text: commit.committed });
        }
        const justAnswered = Date.now() - this.lastAnswerAt < 1500;
        const settled = Date.now() - lastGrowAt > 900;
        if (this.state === "idle" && !blocking && !justAnswered && settled) {
          setFsm(reduceTurn(getFsm(), { type: "title", state: "idle" }));
        }
        if (this.exited || Date.now() - this.lastByteAt > SILENCE_LIMIT_MS)
          break;
        await sleep(40);
      }
    }
    if (rich && onUpdate)
      this.emitToolEvents(this.tail.read(), onUpdate, commit);
    let text = await getText();
    if (rich && looksLikeToolRender(text))
      text = commit.committed;
    else if (!text)
      text = commit.committed || extractAssistant(this.raw.slice(startOff));
    if (onUpdate) {
      const delta = commitFlush(commit, text);
      if (delta)
        onUpdate({ type: "text", delta, text: commit.committed });
    }
    return text;
  }
  emitToolEvents(events, onUpdate, commit) {
    for (const ev of events) {
      if (ev.kind === "tool_use") {
        onUpdate({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        commit.committed = "";
      } else if (ev.kind === "tool_result") {
        onUpdate({ type: "tool_result", id: ev.toolUseId, output: ev.text });
      } else if (ev.kind === "thinking" && ev.text.trim()) {
        onUpdate({ type: "thought", delta: ev.text });
      }
    }
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

// spike/sp1/sysprompt_debug.ts
var claudePath = process.env.CLAUDE_PATH || "/Users/rynfar/repos/meridian/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
async function main() {
  const useSys = process.argv.includes("--sys");
  const big = process.argv.includes("--big");
  const promptText = big ? "You are an expert coding assistant operating inside a harness. ".repeat(60) : "You are a terse assistant. Reply with exactly what is asked.";
  const args = useSys ? ["--append-system-prompt", promptText] : [];
  if (useSys)
    console.log(`[sysprompt len] ${promptText.length} chars`);
  const cwdIdx = process.argv.indexOf("--cwd");
  const cwd = cwdIdx >= 0 ? process.argv[cwdIdx + 1] : process.cwd();
  console.log(`[spawn] sys=${useSys} cwd=${cwd} args=${JSON.stringify(args).slice(0, 80)}`);
  const t0 = Date.now();
  const s = new ClaudeSession(claudePath, cwd, args, { mode: "clean" });
  const ready = await s.ready();
  console.log(`[ready] ${ready} (${Date.now() - t0}ms)`);
  const t1 = Date.now();
  const tr = await Promise.race([
    s.turn("Reply with exactly: DEBUG-OK"),
    new Promise((r) => setTimeout(() => r({ text: "<<TURN TIMEOUT 45s>>", doneDetected: false }), 45000))
  ]);
  console.log(`[turn] (${Date.now() - t1}ms) done=${tr.doneDetected} text=${JSON.stringify((tr.text || "").slice(0, 200))}`);
  await s.close();
  process.exit(0);
}
main().catch((e) => {
  console.error("[ERR]", e);
  process.exit(1);
});
