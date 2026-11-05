// External diagnostic only. Does not change any fingerprint limit or build input.
import * as fs from "node:fs";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spyOn } from "bun:test";

const now = () => performance.now();
const nativeWrite = fs.writeFileSync;
const MAX_DETAILS = 10_000;
const REASONS = new Set(["invalid", "git", "building", "gate", "inputs-changed", "missing"]);

function safeError(error) {
  return {
    name: error?.name === "BuildProvenanceError" ? "BuildProvenanceError" : "Error",
    ...(REASONS.has(error?.reason) ? { reason: error.reason } : {}),
    ...(typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,32}$/.test(error.code) ? { code: error.code } : {}),
  };
}
function sizeOf(value, encoding) {
  if (typeof value === "string") return Buffer.byteLength(value, encoding);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 0;
}
function gitLabel(command, args) {
  if (command !== "git" || !Array.isArray(args) || args[0] !== "-C") return "other";
  const tail = args.slice(2);
  if (tail[0] === "rev-parse") {
    if (tail[1] === "--show-toplevel") return "root";
    if (tail[1] === "HEAD") return "head";
    if (tail[1] === "--abbrev-ref") return "branch";
  }
  if (tail[0] === "status") return "status";
  if (tail[0] === "ls-files") return "ls-files";
  if (tail[0] === "config") return "remote";
  if (tail[0] === "describe") return "describe";
  return "other";
}
function delta(previous, current) {
  if (!previous || !current) return null;
  const before = new Set(previous), after = new Set(current);
  return {
    added: [...after].filter(value => !before.has(value)),
    removed: [...before].filter(value => !after.has(value)),
  };
}
// Preserve identity of the original return value and thrown object. The second
// clock interval estimates recording cost; clock/dispatch overhead is excluded.
function measured(original, receiver, args, record, overhead, clock = now) {
  const started = clock();
  let value, error, failed = false;
  try { value = Reflect.apply(original, receiver, args); return value; }
  catch (caught) { failed = true; error = caught; throw caught; }
  finally {
    const ended = clock();
    record({ value, error, failed, wallMs: ended - started });
    if (overhead) overhead(clock() - ended);
  }
}
function selfTests() {
  let count = 0;
  const assert = (condition) => { count++; if (!condition) throw new Error("observer self-control failed"); };
  let tick = 0, observation;
  const receiver = { factor: 3 }, value = {};
  const returned = measured(function (arg) { assert(this === receiver && arg === value); return value; }, receiver,
    [value], entry => { observation = entry; }, null, () => tick++);
  assert(returned === value && observation.value === value && !observation.failed && observation.wallMs === 1);
  const thrown = {};
  try { measured(() => { throw thrown; }, null, [], entry => { observation = entry; }, null, () => tick++); }
  catch (error) { assert(error === thrown); }
  assert(observation.failed && observation.error === thrown);
  const changes = delta(["a", "b"], ["b", "c", "c"]);
  assert(changes.added.join() === "c" && changes.removed.join() === "a");
  assert(gitLabel("git", ["-C", "private-root", "ls-files", "-z"]) === "ls-files");
  assert(gitLabel("other", ["private-argument"]) === "other");
  assert(sizeOf("abc") === 3 && sizeOf(new Uint8Array(4)) === 4);
  assert(JSON.stringify(safeError({ name: "private", message: "private", reason: "private", code: "private" })) === '{"name":"Error"}');
  return { passed: true, assertions: count, io: false, scope: "measurement forwarding/throwing, deltas, labels, byte counts, error redaction; not Bun interception" };
}

const rootSetting = process.env.E2E_MERIDIAN_ROOT;
const outputSetting = process.env.E2E_FINGERPRINT_TRACE;
if (!rootSetting || !outputSetting) throw new Error("Observer requires E2E_MERIDIAN_ROOT and E2E_FINGERPRINT_TRACE");
const root = resolve(rootSetting), output = resolve(outputSetting);
const withinRoot = path => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)); };
if (withinRoot(output)) throw new Error("Observer output must be outside the target repository");

const trace = {
  schema: 1, purpose: "one normal certified-build diagnostic", pid: process.pid,
  bun: process.versions.bun ?? null, constantsChanged: false,
  limits: { fileDetailRowsPerPhase: MAX_DETAILS, fingerprintPolicy: "original, not replaced" },
  selfTests: null, setupError: null, uncaughtError: null, installation: {},
  certification: { calls: 0, gateCalls: 0, gatesReturned: false }, phases: [],
  interception: null, originalExitCode: null,
};
let active = null, certification = null, currentFile = null;
let outsideCounter = 0;
const outsideNames = new Map(), fds = new Map(), spies = [];
function safePath(value) {
  let path;
  if (typeof value === "string") path = resolve(value);
  else if (value instanceof URL && value.protocol === "file:") path = fileURLToPath(value);
  else if (Buffer.isBuffer(value)) path = resolve(value.toString());
  else return "<non-path>";
  if (withinRoot(path)) return relative(root, path) || ".";
  if (!outsideNames.has(path)) outsideNames.set(path, `<outside-root:${++outsideCounter}>`);
  return outsideNames.get(path);
}
function metric() { return { calls: 0, errors: 0, wallMs: 0, maxWallMs: 0 }; }
function add(target, observation) {
  target.calls++; target.wallMs += observation.wallMs;
  target.maxWallMs = Math.max(target.maxWallMs, observation.wallMs);
  if (observation.failed) target.errors++;
}
function rowFor(phase, path, role) {
  const name = safePath(path), key = role + "\0" + name;
  if (phase.rows.has(key)) return phase.rows.get(key);
  if (phase.rows.size >= MAX_DETAILS) { phase.detailCapped = true; return null; }
  const row = { path: name, role, kind: null, statSize: null,
    hashFileCalls: 0, hashFileCompleted: 0, hashFileWallMs: 0,
    reads: metric(), readBytes: 0, hashUpdates: metric(), hashBytes: 0,
    metadata: {}, error: null };
  phase.rows.set(key, row);
  return row;
}
function over(phase) { return ms => { phase.observer.recordingWallMsEstimate += ms; phase.observer.measuredCalls++; }; }
function terminal(phase, operation, error, row = currentFile) {
  const event = { operation, error: safeError(error), ...(row ? { file: row.path, role: row.role } : {}) };
  phase.terminalOperation ??= event;
  if (row) row.error ??= event.error;
}
function newPhase(label) {
  return { label, started: now(), cpuStart: process.cpuUsage(), wallMs: null, cpuMicros: null,
    outcome: "running", error: null, terminalOperation: null, rows: new Map(), detailCapped: false,
    fs: {}, readBytes: 0, git: [], budgets: [], hashCreates: metric(), hashUpdates: metric(), hashBytes: 0,
    hashFileCalls: 0, hashFileCompleted: 0, fileList: null, inputDelta: null,
    observer: { measuredCalls: 0, recordingWallMsEstimate: 0 } };
}
function install(namespace, name, implementation) {
  const original = namespace[name];
  const spy = spyOn(namespace, name).mockImplementation(implementation(original));
  spies.push(spy); trace.installation[name] = true;
}

process.on("uncaughtExceptionMonitor", error => { trace.uncaughtError = safeError(error); });
process.on("exit", code => {
  trace.originalExitCode = code;
  const snapshotPhases = trace.phases.filter(phase => phase.label !== "artifact-inventory");
  const missing = [];
  if (!trace.selfTests?.passed) missing.push("pure-controls");
  if (trace.certification.calls !== 1) missing.push("certifyBuild-boundary");
  if (snapshotPhases.length !== 3) missing.push("three-snapshot-boundaries");
  for (const phase of snapshotPhases) {
    if (!phase.budgets.length) missing.push(phase.label + ":fingerprintBudget");
    if (!phase.git.some(call => call.label === "ls-files")) missing.push(phase.label + ":git-list");
    if (!phase.hashFileCalls) missing.push(phase.label + ":hashFileInto");
    if (!phase.fs.readSync?.calls) missing.push(phase.label + ":readSync");
    if (!phase.hashUpdates.calls) missing.push(phase.label + ":hash-update");
  }
  trace.interception = { validForPostGatesDiagnosis: missing.length === 0 && !trace.setupError,
    missing, note: "Early build failure can yield useful partial data, but is not a valid post-gates comparison." };
  for (const phase of trace.phases) {
    phase.files = [...phase.rows.values()]; delete phase.rows;
    phase.fileListEntries = phase.fileList?.length ?? null;
    phase.uniqueFileListEntries = phase.fileList ? new Set(phase.fileList).size : null;
    delete phase.fileList; delete phase.started; delete phase.cpuStart;
    const fsWall = Object.values(phase.fs).reduce((sum, entry) => sum + entry.wallMs, 0);
    const gitWall = phase.git.reduce((sum, entry) => sum + entry.wallMs, 0);
    phase.accountedWallMs = fsWall + gitWall + phase.hashCreates.wallMs + phase.hashUpdates.wallMs;
    phase.unattributedWallMs = phase.wallMs === null ? null : Math.max(0, phase.wallMs - phase.accountedWallMs);
  }
  // The trace marks an unobserved successful build as invalid; do not emit a
  // green diagnostic status merely because the underlying build returned 0.
  trace.diagnosticStatus = trace.interception.validForPostGatesDiagnosis ? "OBSERVED" : "INVALID_TRACE";
  if (code === 0 && trace.diagnosticStatus === "INVALID_TRACE") process.exitCode = 78;
  try { nativeWrite(output, JSON.stringify(trace, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch { process.exitCode = code || 78; console.error("Fingerprint observer could not write its trace (destination must not exist)"); }
});

try {
  trace.selfTests = selfTests();
  for (const name of ["openSync", "fstatSync", "readSync", "closeSync", "lstatSync", "readlinkSync"]) {
    install(fs, name, original => function (...args) {
      const phase = active;
      if (!phase) return Reflect.apply(original, this, args);
      let row = null;
      if (name === "openSync") row = currentFile ?? rowFor(phase, args[0], "metadata");
      else if (name === "lstatSync" || name === "readlinkSync") row = rowFor(phase, args[0], "source");
      else row = fds.get(args[0])?.row ?? null;
      return measured(original, this, args, observation => {
        add(phase.fs[name] ??= metric(), observation);
        if (name === "readSync" && typeof observation.value === "number") phase.readBytes += observation.value;
        if (row) {
          if (name === "readSync") {
            add(row.reads, observation);
            if (typeof observation.value === "number") row.readBytes += observation.value;
          } else add(row.metadata[name] ??= metric(), observation);
          if ((name === "lstatSync" || name === "fstatSync") && !observation.failed) {
            row.statSize = observation.value.size;
            row.kind = observation.value.isFile() ? "file" : observation.value.isSymbolicLink() ? "symlink" : "other";
          }
        }
        if (name === "openSync" && !observation.failed) fds.set(observation.value, { phase, row });
        if (name === "closeSync") fds.delete(args[0]);
        if (observation.failed) terminal(phase, name, observation.error, row);
      }, over(phase));
    });
  }
  install(cp, "spawnSync", original => function (...args) {
    const phase = active;
    if (!phase) return Reflect.apply(original, this, args);
    return measured(original, this, args, observation => {
      const label = gitLabel(args[0], args[1]), result = observation.value;
      const entry = { label, wallMs: observation.wallMs, status: result?.status ?? null,
        signal: typeof result?.signal === "string" && /^SIG[A-Z0-9]+$/.test(result.signal) ? result.signal : null,
        stdoutBytes: sizeOf(result?.stdout), stderrBytes: sizeOf(result?.stderr),
        ...(observation.failed || result?.error ? { error: safeError(observation.error ?? result.error) } : {}) };
      if (label === "ls-files" && typeof result?.stdout === "string" && result.status === 0) {
        phase.fileList = result.stdout.trimEnd().split("\0").filter(Boolean).map(file => safePath(resolve(root, file)));
        const previous = trace.phases.filter(other => other !== phase && other.fileList).at(-1);
        phase.inputDelta = delta(previous?.fileList, phase.fileList);
        entry.entries = phase.fileList.length;
      }
      phase.git.push(entry);
      if (observation.failed) terminal(phase, "spawnSync:" + label, observation.error, null);
    }, over(phase));
  });
  install(crypto, "createHash", original => function (...args) {
    const phase = active;
    if (!phase) return Reflect.apply(original, this, args);
    const hash = measured(original, this, args, entry => {
      add(phase.hashCreates, entry);
      if (entry.failed) terminal(phase, "createHash", entry.error);
    }, over(phase));
    const update = hash.update;
    hash.update = function (...updateArgs) {
      const current = active;
      if (!current) return Reflect.apply(update, this, updateArgs);
      const row = currentFile;
      return measured(update, this, updateArgs, entry => {
        const bytes = sizeOf(updateArgs[0], updateArgs[1]);
        add(current.hashUpdates, entry); current.hashBytes += bytes;
        if (row) { add(row.hashUpdates, entry); row.hashBytes += bytes; }
        if (entry.failed) terminal(current, "hash.update", entry.error, row);
      }, over(current));
    };
    return hash;
  });

  const fingerprint = await import(pathToFileURL(resolve(root, "src/proxy/buildFingerprint.ts")).href);
  install(fingerprint, "fingerprintBudget", original => function (...args) {
    const value = Reflect.apply(original, this, args), phase = active;
    if (!phase) return value;
    const budget = { index: phase.budgets.length + 1, createdAtPhaseMs: now() - phase.started,
      calls: {}, successfulEntries: 0, successfulConsumedBytes: 0, declaredFileBytes: 0, failure: null };
    phase.budgets.push(budget);
    const wrapped = {};
    for (const name of ["check", "remainingMs", "entry", "file", "consume"]) {
      wrapped[name] = function (...methodArgs) {
        budget.calls[name] = (budget.calls[name] ?? 0) + 1;
        return measured(value[name], value, methodArgs, entry => {
          if (!entry.failed) {
            if (name === "entry") budget.successfulEntries++;
            if (name === "consume") budget.successfulConsumedBytes += methodArgs[0];
            if (name === "file") budget.declaredFileBytes += methodArgs[0];
          } else {
            budget.failure ??= { operation: name, elapsedMs: now() - phase.started - budget.createdAtPhaseMs,
              error: safeError(entry.error), ...(currentFile ? { file: currentFile.path } : {}) };
            terminal(phase, "budget." + name, entry.error);
          }
        }, over(phase));
      };
    }
    return wrapped;
  });
  install(fingerprint, "hashFileInto", original => function (...args) {
    const phase = active;
    if (!phase) return Reflect.apply(original, this, args);
    const previousFile = currentFile, row = rowFor(phase, args[1], "source");
    currentFile = row; phase.hashFileCalls++; if (row) row.hashFileCalls++;
    const started = now();
    try {
      const result = Reflect.apply(original, this, args);
      phase.hashFileCompleted++; if (row) row.hashFileCompleted++;
      return result;
    } catch (error) { terminal(phase, "hashFileInto", error, row); throw error; }
    finally { if (row) row.hashFileWallMs += now() - started; currentFile = previousFile; }
  });
  const snapshot = await import(pathToFileURL(resolve(root, "src/proxy/buildSnapshot.ts")).href);
  function observePhase(label, original, receiver, args) {
    const previous = active, previousFile = currentFile, phase = newPhase(label);
    trace.phases.push(phase); active = phase; currentFile = null;
    try { const result = Reflect.apply(original, receiver, args); phase.outcome = "returned"; return result; }
    catch (error) { phase.outcome = "threw"; phase.error = safeError(error); throw error; }
    finally {
      phase.wallMs = now() - phase.started; phase.cpuMicros = process.cpuUsage(phase.cpuStart);
      phase.openDescriptorsAtEnd = [...fds.values()].filter(value => value.phase === phase).length;
      active = previous; currentFile = previousFile;
    }
  }
  install(snapshot, "snapshotSource", original => function (...args) {
    const label = certification ? (certification.gatesReturned ? "post-gates" : "pre-gates") : "preflight";
    return observePhase(label, original, this, args);
  });
  const artifacts = await import(pathToFileURL(resolve(root, "src/proxy/buildArtifacts.ts")).href);
  install(artifacts, "artifactInventory", original => function (...args) {
    return observePhase("artifact-inventory", original, this, args);
  });
  install(artifacts, "certifyBuild", original => function (directory, gates) {
    trace.certification.calls++;
    const previous = certification, context = { gatesReturned: false };
    certification = context;
    try {
      return Reflect.apply(original, this, [directory, function (...args) {
        trace.certification.gateCalls++;
        const result = Reflect.apply(gates, this, args);
        context.gatesReturned = true; trace.certification.gatesReturned = true;
        return result;
      }]);
    } finally { certification = previous; }
  });
} catch (error) {
  trace.setupError = safeError(error);
  throw new Error("Fingerprint observer setup failed; inspect trace");
}
