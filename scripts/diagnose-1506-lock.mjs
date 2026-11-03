import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const directory = resolve(process.env.BOOKKEEPING_LOCK_DIAGNOSTIC_DIR ?? "");
if (!process.env.BOOKKEEPING_LOCK_DIAGNOSTIC_DIR) throw new Error("Missing diagnostic output directory");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const log = join(directory, "npm-test.log");
const receiptPath = join(directory, "runner-receipt.json");
const receipt = { schema: 1, purpose: "one contextual hosted diagnostic, not acceptance", head: process.env.GITHUB_SHA ?? null,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  deadlineMs: 35 * 60_000, maxOutputBytes: 16 * 1024 * 1024, outputBytes: 0,
  timedOut: false, outputCapped: false, closed: false, groupJoined: false,
  originalCode: null, originalSignal: null, elapsedMs: null, traceFiles: [], sourceHashes: {} };
const files = ["package.json", "bun.lock", "src/__tests__/bookkeeping-crash-process.test.ts",
  "src/__tests__/fixtures/store-lock-diagnostic.ts", "scripts/diagnose-1506-lock.mjs", ".github/workflows/diagnose-1506-lock.yml"];
for (const file of files) receipt.sourceHashes[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
const expected = JSON.parse(readFileSync("scripts/fixtures/store-lock-diagnostic-hashes.json", "utf8"));
for (const [file, hash] of Object.entries(expected)) {
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== hash) throw new Error("Frozen diagnostic source hash mismatch: " + file);
}
receipt.expectedHashesVerified = true;
const helperSource = "src/__tests__/fixtures/store-lock-diagnostic.ts";
const helperHash = receipt.sourceHashes[helperSource];
const helperFile = resolve("src/__tests__/fixtures/store-lock-diagnostic-" + helperHash + ".ts");
writeFileSync(helperFile, readFileSync(helperSource), { flag: "wx", mode: 0o444 });
chmodSync(helperFile, 0o444);
if (createHash("sha256").update(readFileSync(helperFile)).digest("hex") !== helperHash) throw new Error("Runtime helper copy hash mismatch");
receipt.runtimeHelper = { sha256: helperHash, mode: "0444", verified: true };
const childEnv = { ...process.env, BOOKKEEPING_LOCK_DIAGNOSTIC_HELPER_FILE: helperFile };
writeFileSync(log, "", { flag: "wx", mode: 0o600 });
const started = performance.now();
const child = spawn("npm", ["test"], { cwd: process.cwd(), env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
receipt.pid = child.pid;
let escalation;
function signalGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") receipt.groupSignalError = error.code ?? "UNKNOWN"; }
}
function terminate() { signalGroup("SIGTERM"); escalation ??= setTimeout(() => signalGroup("SIGKILL"), 5000); }
const deadline = setTimeout(() => { receipt.timedOut = true; terminate(); }, receipt.deadlineMs);
const watchdog = setTimeout(() => { signalGroup("SIGKILL"); receipt.watchdogExpired = true; finish(124); }, receipt.deadlineMs + 15000);
function output(data) {
  receipt.outputBytes += data.length;
  if (receipt.logWriteError) return;
  if (receipt.outputBytes <= receipt.maxOutputBytes) {
    try { appendFileSync(log, data); }
    catch (error) { receipt.logWriteError = error.code ?? "UNKNOWN"; terminate(); }
  } else if (!receipt.outputCapped) { receipt.outputCapped = true; terminate(); }
}
child.stdout.on("data", output);
child.stderr.on("data", output);
child.on("error", error => { receipt.spawnError = error.code ?? "UNKNOWN"; });
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline); clearTimeout(escalation); clearTimeout(watchdog);
  receipt.elapsedMs = performance.now() - started;
  receipt.traceFiles = readdirSync(directory).filter(name => name.endsWith(".json") && name !== "runner-receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(receipt));
  // Stop even if a pipe failed to join; the receipt must not call that a clean close.
  process.exit(code);
}
child.on("close", (code, signal) => {
  receipt.closed = true; receipt.originalCode = code; receipt.originalSignal = signal;
  try { process.kill(-child.pid, 0); }
  catch (error) { if (error.code === "ESRCH") receipt.groupJoined = true; else receipt.groupProbeError = error.code ?? "UNKNOWN"; }
  if (!receipt.groupJoined) signalGroup("SIGKILL");
  const tracePath = join(directory, "store-lock-diagnostic.json");
  let trace;
  if (existsSync(tracePath) && statSync(tracePath).size <= 4 * 1024 * 1024) {
    try { trace = JSON.parse(readFileSync(tracePath, "utf8")); }
    catch { receipt.traceReadError = "malformed-json"; }
  }
  receipt.tracePresent = !!trace;
  receipt.traceQualified = trace?.schema === 1 && trace.case === "SIGKILL migration 2/1 PREPARED"
    && trace.valid === true && Array.isArray(trace.invalid) && trace.invalid.length === 0
    && trace.limits?.capped === false && trace.limits?.maxEvents === 10000
    && trace.limits?.maxBytes === 4 * 1024 * 1024
    && trace.child?.status === null && trace.child?.signal === "SIGKILL"
    && trace.before?.journalPhase === "PREPARED";
  // A qualified observed pass is still not acceptance of the earlier failed gate.
  finish(code === 0 && receipt.groupJoined && !receipt.timedOut && !receipt.outputCapped
    && !receipt.logWriteError && receipt.traceQualified ? 0 : 1);
});
