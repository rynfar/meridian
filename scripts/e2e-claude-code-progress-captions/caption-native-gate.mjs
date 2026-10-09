#!/usr/bin/env bun
// Source preparation: the native worker has not run for this current candidate.
// Future root invocation runs an authentic native client and authentic backend.
// --live-authorized is an invocation guard, never an auth/entitlement claim.
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { selectWorkingMapping, MappingObservationError } from './working-mapping.ts';

const SELF = fileURLToPath(import.meta.url);
const PROFILE = 'taskoauth-token';
const CASES = ['sequential', 'work-first', 'caption-first', 'natural-stop', 'caption-fault', 'disabled', 'isolation'];
const KEEP = ['HOME', 'home', 'CODEX_HOME'];
const RAW_LIMIT = 1024 * 1024;
const BODY_LIMIT = 4 * 1024 * 1024;
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const idDigest = value => typeof value === 'string' && value.length ? digest(value) : null;
const now = () => Date.now();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;

class GateError extends Error {
  constructor(code, status = 'FAIL') { super(code); this.code = code; this.status = status; }
}
function need(condition, code, status = 'FAIL') { if (!condition) throw new GateError(code, status); }
function options(argv) {
  const allowed = ['entry', 'adapter-entry', 'gate-entry', 'sdk', 'state-entry', 'tree-entry', 'native', 'node', 'model', 'task-root', 'output', 'token-file', 'provenance', 'case', 'expect', 'hints', 'deadline-ms', 'join-ms', 'hold-ms'];
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'live-authorized' || key === 'worker') { out[key] = true; continue; }
    need(argv[i].startsWith('--') && allowed.includes(key) && !Object.hasOwn(out, key), 'invalid-option');
    need(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'missing-option-value');
    out[key] = argv[++i];
  }
  for (const key of ['entry', 'adapter-entry', 'gate-entry', 'sdk', 'native', 'node', 'model', 'task-root', 'output', 'token-file', 'provenance', 'case', 'expect', 'hints']) need(out[key], `required-${key}`);
  for (const key of ['entry', 'adapter-entry', 'gate-entry', 'sdk', 'state-entry', 'tree-entry', 'native', 'node', 'task-root', 'output', 'token-file', 'provenance']) if (out[key]) need(isAbsolute(out[key]), `absolute-${key}`);
  need(CASES.includes(out.case) && ['baseline', 'fixed'].includes(out.expect) && ['0', '1'].includes(out.hints), 'invalid-arm');
  need(/^claude-[A-Za-z0-9.-]+$/.test(out.model), 'full-model-fixture-required');
  for (const [key, fallback, min, max] of [['deadline-ms', 240000, 90000, 600000], ['join-ms', 15000, 5000, 30000], ['hold-ms', 40000, 35000, 60000]]) {
    out[key] = Number(out[key] ?? fallback);
    need(Number.isSafeInteger(out[key]) && out[key] >= min && out[key] <= max, `invalid-${key}`);
  }
  need(out['live-authorized'], 'root-live-invocation-marker-required');
  if (out.worker) need(typeof process.send === 'function' && process.connected, 'worker-is-parent-ipc-only');
  return out;
}
function within(root, path) { const r = relative(root, path); return r !== '' && !r.startsWith('..') && !isAbsolute(r); }
function privatePath(root, path, directory = false) {
  need(path === root || within(root, path), 'private-path-outside-task');
  const parts = relative(root, path).split('/').filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    const stat = fs.lstatSync(current);
    need(!stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'private-path-permissions');
    if (current !== path || directory) need(stat.isDirectory(), 'private-path-directory');
    else need(stat.isFile() && stat.nlink === 1, 'private-path-file');
  }
}
function fileHash(path) {
  const fd = fs.openSync(path, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = fs.readSync(fd, chunk, 0, chunk.length, null); if (!n) break; hash.update(chunk.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function writer(path) {
  const fd = fs.openSync(path, 'wx', 0o600);
  let bytes = 0, discarded = 0, closed = false, buffered = '';
  function selectedLine(line) {
    // Never copy account/init envelopes, transcripts, token-bearing errors or
    // raw provider diagnostics into an artifact, even the private logs.
    const item = { sourceBytes: Buffer.byteLength(line), sourceDigest: digest(line) };
    try {
      const value = JSON.parse(line);
      if (plain(value)) {
        for (const key of ['type', 'subtype', 'status', 'model', 'claude_code_version']) {
          const selected = safeName(value[key]); if (selected) item[key] = selected;
        }
        if (typeof value.is_error === 'boolean') item.isError = value.is_error;
      }
    } catch (error) { item.nonJson = true; }
    const data = Buffer.from(JSON.stringify(item) + '\n');
    const take = Math.min(data.length, RAW_LIMIT - bytes);
    for (let offset = 0; offset < take;) offset += fs.writeSync(fd, data.subarray(offset, take));
    bytes += take; discarded += data.length - take;
  }
  return {
    write(value) {
      if (closed) return;
      const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      buffered += b.toString('utf8');
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) { selectedLine(buffered.slice(0, end)); buffered = buffered.slice(end + 1); }
      if (Buffer.byteLength(buffered) > 65536) { selectedLine(buffered); buffered = ''; }
    },
    close() { if (!closed) { try { if (buffered) selectedLine(buffered); buffered = ''; fs.fsyncSync(fd); } finally { fs.closeSync(fd); closed = true; } } return { bytes, discarded, flushed: closed, format: 'selected-line-metadata; raw content not retained' }; },
  };
}
function json(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function cleanEnv(o, root) {
  const env = {};
  for (const key of KEEP) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8', TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_STATE_HOME: join(root, 'xdg-state'),
  });
  return env;
}
function defer() { let resolvePromise; const promise = new Promise(r => { resolvePromise = r; }); return { promise, resolve: resolvePromise }; }
async function bounded(promise, milliseconds, code, signal) {
  let timer, onAbort;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GateError(code, 'MISSING')), milliseconds);
    onAbort = () => reject(new GateError('gate-aborted', 'MISSING'));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
async function minimumHold(startedAt, milliseconds, signal) {
  let timer;
  try { await bounded(new Promise(r => { timer = setTimeout(r, Math.max(0, startedAt + milliseconds - now())); }), milliseconds + 1000, 'minimum-history-hold', signal); }
  finally { clearTimeout(timer); }
}

async function parent(o) {
  need(process.versions.bun === '1.3.11', 'requires-reviewed-bun-1.3.11');
  privatePath(o['task-root'], o['task-root'], true);
  need(fs.realpathSync(o['task-root']) === o['task-root'], 'task-root-must-be-canonical');
  need(within(o['task-root'], o.output) && dirname(o.output) === o['task-root'], 'output-must-be-new-direct-task-arm');
  need(!fs.existsSync(o.output), 'output-already-exists');
  fs.mkdirSync(o.output, { mode: 0o700 });
  const privacy = join(o.output, 'private'); fs.mkdirSync(privacy, { mode: 0o700 });
  for (const name of ['bin', 'tmp', 'xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state']) fs.mkdirSync(join(privacy, name), { mode: 0o700 });
  need(fs.realpathSync(o.node) === o.node && fs.statSync(o.node).isFile(), 'node-exact-path');
  fs.symlinkSync(o.node, join(privacy, 'bin', 'node'));
  fs.symlinkSync(process.execPath, join(privacy, 'bin', 'bun'));
  const out = writer(join(privacy, 'parent-worker-stdout.raw'));
  const err = writer(join(privacy, 'parent-worker-stderr.raw'));
  const facts = { spawn: false, exit: false, close: false, stdoutEnd: false, stdoutClose: false, stderrEnd: false, stderrClose: false, timeout: false, signals: [], workerReport: false, scopedWorkerJoin: 'UNKNOWN', workerGrantCleanupAllowed: false, globalDescendantAbsence: 'UNKNOWN' };
  const child = cp.spawn(process.execPath, [SELF, ...process.argv.slice(2), '--worker'], {
    env: cleanEnv(o, privacy), cwd: privacy, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const done = defer();
  let abortTimer, killTimer;
  function ownedSignal(signal) {
    if (facts.exit || child.exitCode !== null || child.signalCode !== null) return;
    facts.signals.push({ signal, at: now() }); child.kill(signal);
  }
  const deadline = setTimeout(() => {
    facts.timeout = true;
    if (child.connected) child.send({ command: 'abort' }, error => { if (error) facts.abortSendError = true; });
    abortTimer = setTimeout(() => ownedSignal('SIGTERM'), o['join-ms']);
    killTimer = setTimeout(() => ownedSignal('SIGKILL'), o['join-ms'] + 5000);
  }, o['deadline-ms']);
  child.once('spawn', () => { facts.spawn = true; });
  child.once('error', () => { facts.spawnError = true; });
  child.once('exit', (code, signal) => { facts.exit = true; facts.code = code; facts.signal = signal; });
  child.once('close', () => { facts.close = true; done.resolve(); });
  child.on('message', message => {
    if (plain(message) && message.kind === 'settled') {
      facts.workerReport = true;
      facts.scopedWorkerJoin = message.scopedOwnedJoin === 'JOINED' ? 'JOINED' : 'UNKNOWN';
      facts.workerGrantCleanupAllowed = message.grantCleanupAllowed === true;
    }
  });
  child.stdout.on('data', b => out.write(b)); child.stderr.on('data', b => err.write(b));
  for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.once('end', () => { facts[`${label}End`] = true; });
    stream.once('close', () => { facts[`${label}Close`] = true; });
  }
  let parentJoin = 'JOINED';
  try { await bounded(done.promise, o['deadline-ms'] + o['join-ms'] + 12000, 'parent-child-close-deadline'); }
  catch (error) { parentJoin = 'UNKNOWN'; facts.failureCode = error instanceof GateError ? error.code : 'parent-join-exception'; }
  finally {
    clearTimeout(deadline); clearTimeout(abortTimer); clearTimeout(killTimer);
    facts.raw = { stdout: out.close(), stderr: err.close() };
    const clean = parentJoin === 'JOINED' && facts.exit && facts.close && facts.stdoutEnd && facts.stdoutClose && facts.stderrEnd && facts.stderrClose && facts.workerReport && facts.scopedWorkerJoin === 'JOINED' && facts.raw.stdout.flushed && facts.raw.stderr.flushed && !facts.timeout && !facts.spawnError && !facts.abortSendError;
    const grantCleanupAllowed = clean && facts.workerGrantCleanupAllowed;
    json(join(o.output, 'parent-settlement.json'), { ...facts, parentJoin, grantCleanupAllowed, grantCleanupScope: 'root may review removal of the preserved access-only task input after the observed source-case handles, SDK gates, iterators and local HTTP resources joined; no global descendant/config/session/history cleanup claim', grantDeleted: false });
    // No grant/config/session deletion: cleanup remains root-owned after review.
    if (child.connected) child.disconnect();
    process.stdout.write(JSON.stringify({ report: join(o.output, 'report.json'), parentJoin, scopedWorkerJoin: facts.scopedWorkerJoin, grantCleanupAllowed, globalDescendantAbsence: 'UNKNOWN' }) + '\n');
    process.exitCode = clean ? (facts.code ?? 1) : 1;
    if (parentJoin === 'UNKNOWN') process.exit(process.exitCode);
  }
}

// Read-only recognition of the actual native wire. This text is NEVER sent.
const CAPTION_PREFIX = 'Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.\n\n';
const CAPTION_SUFFIX = `Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`;
function captionShape(body) {
  if (body.stream !== true || !Array.isArray(body.tools) || !body.tools.length || !Array.isArray(body.messages)) return false;
  const last = body.messages.at(-1);
  if (last?.role !== 'user') return false;
  let text = last.content;
  if (Array.isArray(last.content)) {
    const end = last.content.at(-1); if (end?.type !== 'text') return false;
    text = end.text;
    const ids = new Set();
    for (const b of last.content.slice(0, -1)) {
      if (typeof b?.type !== 'string') return false;
      if (b.type === 'tool_result') { if (typeof b.tool_use_id !== 'string' || !b.tool_use_id || ids.has(b.tool_use_id)) return false; ids.add(b.tool_use_id); }
    }
  }
  if (typeof text !== 'string' || !text.startsWith(CAPTION_PREFIX) || !text.endsWith(CAPTION_SUFFIX)) return false;
  const middle = text.slice(CAPTION_PREFIX.length, text.length - CAPTION_SUFFIX.length);
  return middle === '' || /^Previous: "[^\r\n]*" — say something NEW\.\n\n$/.test(middle);
}
function blocks(messages) { return messages.flatMap(m => Array.isArray(m.content) ? m.content : []); }
function identity(body, headers) {
  let meta = body.metadata?.user_id;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (error) { return { parseError: true }; } }
  return {
    session: typeof meta?.session_id === 'string' && meta.session_id.length <= 512 ? meta.session_id : undefined,
    parent: typeof meta?.parent_session_id === 'string' && meta.parent_session_id.length <= 512 ? meta.parent_session_id : undefined,
    agent: /^[A-Za-z0-9_-]{1,128}$/.test(headers.get('x-claude-code-agent-id') ?? '') ? headers.get('x-claude-code-agent-id') : undefined,
  };
}
function wirePublic(r) {
  const ua = r.headers.get('user-agent') ?? '';
  return {
    n: r.n, group: r.group, arrivedAt: r.arrivedAt, forwardedAt: r.forwardedAt ?? null, settledAt: r.settledAt ?? null,
    clientAbortAt: r.clientAbortAt ?? null, status: r.status ?? null, transportFault: Boolean(r.transportFault),
    sessionDigest: idDigest(r.session), parentDigest: idDigest(r.parent), agentDigest: idDigest(r.agent),
    nativeUserAgent: /^[\x20-\x7e]{1,256}$/.test(ua) && /^claude-cli\/\d+\.\d+\.\d+/.test(ua) ? ua : null,
    nativeUserAgentDigest: digest(ua), requestClass: ['main', 'subagent', 'auxiliary'].includes(r.headers.get('x-claude-code-request-class')) ? r.headers.get('x-claude-code-request-class') : null,
    requestClassPresent: r.headers.has('x-claude-code-request-class'), clientSessionHeaderDigest: idDigest(r.headers.get('x-claude-code-session-id')),
    captionShape: r.caption, stream: r.body.stream === true, toolSchemaDigest: digest(r.body.tools ?? []),
    toolNames: (r.body.tools ?? []).map(t => safeName(t.name)), bodyDigest: r.bodyDigest,
    messages: (r.body.messages ?? []).map(m => ({ role: safeName(m.role), contentDigest: digest(m.content ?? null), blocks: Array.isArray(m.content) ? m.content.map(b => ({ type: safeName(b.type), idDigest: idDigest(b.id ?? b.tool_use_id), digest: digest(b) })) : [] })),
    productObserverSeen: Boolean(r.contextSeen), adapter: r.adapter ?? null,
    responseDigest: r.responseDigest ?? null, responseBytes: r.responseBytes ?? 0,
    responseEventCounts: r.responseEvents ?? null,
  };
}

async function worker(o) {
  const privateRoot = join(o.output, 'private');
  const bus = new EventEmitter(); bus.setMaxListeners(100);
  const control = new AbortController();
  const scopes = new AsyncLocalStorage();
  const gateScopes = new AsyncLocalStorage();
  const report = { schema: 1, status: 'PREPARING', firstFailure: null, findings: [], cases: {}, reporter: { client: 'unknown', sdk: 'unknown', model: 'unknown', platform: 'unknown' }, gatesOutsideThisInvocation: ['four E41 modes', 'existing E55', 'ordinary-history and malformed/duplicate-result unit/HTTP controls', 'other selected cases/hint arm', 'source/package counterpart'], grant: { inputRead: false, deleted: false, preserved: null }, cleanup: {} };
  const wires = [], queries = [], handles = [], clients = [], gates = [], factories = new WeakMap(), gateSpawns = new WeakMap(), spyRestores = [], pending = new Set(), sockets = new Set(), proxySockets = new Set();
  const listeners = { proxy: { started: false, closeObserved: false, accepted: 0, closed: 0 }, relay: { started: false, closeObserved: false, closeCallback: false, accepted: 0, closed: 0 } };
  let instance, relay, sdk, state, tree, adapter, Context, token, tokenStat, productConsole, overlap;
  const raw = writer(join(privateRoot, 'worker-errors.raw'));
  let serial = 0, shuttingDown = false;
  const active = new Map();
  function failure(error, fallback = 'unexpected-error') {
    const f = { code: error instanceof GateError ? error.code : fallback, status: error instanceof GateError ? error.status : 'FAIL', at: now() };
    report.findings.push(f); report.firstFailure ??= f;
    try { raw.write(`${error?.stack ?? error}\n`); } catch (writeError) { report.privateRawWriteError = true; }
    bus.emit('changed');
    return f;
  }
  function closeWriter(output) {
    try { return output.close(); }
    catch (error) { failure(error, 'private-writer-flush-close-exception'); return { flushed: false }; }
  }
  const parentAbort = message => {
    if (message?.command !== 'abort') return;
    control.abort();
    for (const c of clients) { c.controller.abort(); c.readRelease.resolve(); c.captionForward.resolve(); c.workingForward.resolve(); }
    for (const r of wires) r.abort.abort();
    overlap?.release.resolve();
  };
  process.on('message', parentAbort);
  function track(promise) { pending.add(promise); promise.finally(() => { pending.delete(promise); bus.emit('changed'); }).catch(error => { failure(error, 'tracked-operation-exception'); }); return promise; }
  function waitFor(predicate, ms, code, signal = control.signal) {
    return bounded(new Promise(resolveWait => {
      const check = () => { const value = predicate(); if (value) { bus.off('changed', check); resolveWait(value); } };
      bus.on('changed', check); check();
      // The bounded wrapper handles timeout/abort; remove the observer then too.
      const remove = () => bus.off('changed', check);
      signal.addEventListener('abort', remove, { once: true });
      setTimeout(() => { remove(); signal.removeEventListener('abort', remove); }, ms);
    }), ms, code, signal);
  }
  function attach(child, kind, callbackExpected = false) {
    const known = handles.find(h => h.child === child); if (known) return known;
    const h = { child, n: ++serial, kind, createdAt: now(), callbackExpected, callback: false, exit: false, close: false, stdinClose: false, stdoutEnd: false, stdoutClose: false, stderrEnd: false, stderrClose: false, nativeResultAt: null };
    handles.push(h);
    if (child.stdin) child.stdin.once('close', () => { h.stdinClose = true; bus.emit('changed'); });
    else h.stdinAbsent = true;
    const streams = [];
    for (const label of ['stdout', 'stderr']) {
      const stream = child[label];
      if (!stream) { h[`${label}Absent`] = true; continue; }
      const output = writer(join(privateRoot, `process-${h.n}-${label}.raw`)); streams.push(output);
      let line = '';
      stream.on('data', b => {
        output.write(b);
        if (label !== 'stdout') return;
        line += b.toString('utf8');
        if (line.length > BODY_LIMIT) { line = ''; h.parserOverflow = true; return; }
        let index;
        while ((index = line.indexOf('\n')) >= 0) {
          const part = line.slice(0, index); line = line.slice(index + 1);
          try { const e = JSON.parse(part); if (e.type === 'result') { h.nativeResultAt = now(); bus.emit('changed'); } }
          catch (error) { h.nonJsonLines = (h.nonJsonLines ?? 0) + 1; }
        }
      });
      stream.once('end', () => { h[`${label}End`] = true; bus.emit('changed'); });
      stream.once('close', () => { h[`${label}Close`] = true; bus.emit('changed'); });
    }
    h.writers = streams;
    const realKill = child.kill.bind(child);
    child.kill = signal => {
      if (h.exit || child.exitCode !== null || child.signalCode != null) { h.afterExitSignalPrevented = (h.afterExitSignalPrevented ?? 0) + 1; return false; }
      h.signals ??= []; h.signals.push({ at: now(), signal: safeName(signal) }); return realKill(signal);
    };
    child.once('exit', (code, signal) => { h.exit = true; h.exitAt = now(); h.code = code; h.signal = signal; bus.emit('changed'); });
    child.once('close', () => { h.close = true; h.closeAt = now(); bus.emit('changed'); });
    child.once('error', () => { h.processError = true; bus.emit('changed'); });
    return h;
  }
  function joined(h) { return h.exit && h.close && (h.stdinAbsent || h.stdinClose) && (h.stdoutAbsent || h.stdoutEnd && h.stdoutClose) && (h.stderrAbsent || h.stderrEnd && h.stderrClose) && (!h.callbackExpected || h.callback); }
  function gateJoined(g) {
    return g.constructed && g.creationSettledAt && !g.creationError && !g.problems.length && g.attachSettledAt && g.executor && g.handle && g.executor.pid === g.handle.child.pid && joined(g.handle) && g.closeCalls.length > 0 && g.closeCalls.every(call => call.settledAt && call.result === true && !call.error) && (!g.spawnCalls.length || g.spawnCalls.length === 1 && g.spawnCalls[0].returnedAt && g.spawnCalls[0].nativePathConfirmed && !g.spawnCalls[0].error) && g.queries.every(q => q.initAt && q.handle === g.handle && q.iteratorSettledAt && q.closeAt);
  }
  function publicGate(g) {
    return { n: g.n, wire: g.wire?.n ?? null, enteredAt: g.enteredAt, constructed: g.constructed === true, constructedAt: g.constructedAt ?? null, creationSettledAt: g.creationSettledAt ?? null, creationError: g.creationError ?? null, attachCalledAt: g.attachCalledAt ?? null, attachSettledAt: g.attachSettledAt ?? null, attachError: g.attachError ?? null, executor: g.executor ? { version: g.executor.version, pid: g.executor.pid, hostDigest: idDigest(g.executor.hostId), bootDigest: idDigest(g.executor.bootId), startDigest: idDigest(g.executor.startId), startIdKind: safeName(g.executor.startIdKind) } : null, recoverableAfterCrash: g.recoverableAfterCrash ?? null, process: g.handle?.n ?? null, queryNumbers: g.queries.map(q => q.n), spawnCalls: g.spawnCalls, closeCalls: g.closeCalls, problems: g.problems, join: gateJoined(g) ? 'JOINED' : 'UNKNOWN', scope: 'real source gate, exact observed POSIX wrapper/exec handle and publication join; no native secondary-process/global census' };
  }
  async function snapshot(wire) {
    need(state?.readSessionStoreSnapshot && state?.readSessionStoreGenerationSnapshot && adapter?.getSessionId && Context, 'owned-mapping-helper-unavailable', 'MISSING');
    need(wire?.headers instanceof Headers && wire.session && wire.agent, 'owned-working-wire-identity-missing', 'MISSING');
    // Derive identity with the selected product source, including its namespace
    // and escaping rules. Root routing/cancel identity is not working authority.
    const context = new Context(new Request('http://caption-observer.invalid/v1/messages', { headers: wire.headers }));
    const adapterSessionId = adapter.getSessionId(context, wire.body);
    let selected;
    try { selected = selectWorkingMapping(adapterSessionId, PROFILE, state.readSessionStoreSnapshot()); }
    catch (error) {
      if (error instanceof MappingObservationError) throw new GateError(error.code, 'MISSING');
      throw error;
    }
    const { key, mapping } = selected;
    need(mapping.currentTranscript?.configDir === join(privateRoot, 'config', 'profiles', PROFILE) && mapping.currentTranscript?.projectDir === join(privateRoot, 'backend-work'), 'owned-locator-scope');
    const sessions = await sdk.listSessions({ dir: join(privateRoot, 'backend-work'), includeWorktrees: false });
    need(sessions.some(s => s.sessionId === mapping.claudeSessionId), 'owned-sdk-session-not-listed', 'MISSING');
    const history = await sdk.getSessionMessages(mapping.claudeSessionId, { dir: join(privateRoot, 'backend-work') });
    need(history.length > 0, 'owned-sdk-history-empty', 'MISSING');
    const generations = state.readSessionStoreGenerationSnapshot(adapterSessionId, [PROFILE]);
    return { key, mapping: structuredClone(mapping), generations, history, public: { adapterSessionDigest: idDigest(adapterSessionId), storageKeyDigest: idDigest(key), mappingDigest: digest(mapping), generationsDigest: digest(generations), sdkSessionDigest: idDigest(mapping.claudeSessionId), lineageDigest: idDigest(mapping.lineageHash), messageCount: mapping.messageCount, checkpointDigest: idDigest(mapping.passthroughToolCallAssistantUuid), pendingIdDigests: (mapping.passthroughToolCallIds ?? []).map(idDigest), historyDigest: digest(history), historyLength: history.length } };
  }
  function exactPreserved(before, after) { return digest(before.mapping) === digest(after.mapping) && digest(before.generations) === digest(after.generations) && digest(before.history) === digest(after.history); }
  function validateProvenance() {
    const p = JSON.parse(fs.readFileSync(o.provenance, 'utf8'));
    need(p.schema === 1 && plain(p.tuple) && Array.isArray(p.inputs) && p.inputs.length <= 2000, 'invalid-provenance');
    need(p.tuple.sdk === '0.2.141' && p.tuple.client === '2.1.292' && p.tuple.backend === '2.1.292' && p.tuple.bun === '1.3.11' && p.tuple.model === o.model, 'reviewed-tuple-required');
    need(p.tuple.platform === process.platform && p.tuple.arch === process.arch && process.platform === 'darwin' && process.arch === 'arm64', 'runtime-platform-not-admitted');
    need(/^[0-9a-f]{40}$/.test(p.codeCommit) && /^[0-9a-f]{40}$/.test(p.codeTree), 'code-identity-required');
    need(p.kind === 'source', 'bundled-package-gate-observer-not-implemented', 'MISSING');
    for (const input of p.inputs) need(isAbsolute(input.path) && !within(o['task-root'], input.path) && input.path !== o['token-file'] && /^[0-9a-f]{64}$/.test(input.sha256) && fs.realpathSync(input.path) === input.path && fileHash(input.path) === input.sha256, 'input-provenance-mismatch');
    for (const key of ['entry', 'adapter-entry', 'gate-entry', 'sdk', 'native', 'node', 'state-entry', 'tree-entry']) if (o[key]) need(p.inputs.some(i => i.role === key && i.path === o[key]), `provenance-${key}-missing`);
    need(fs.realpathSync(join(dirname(o.entry), 'adapters', 'claudecode.ts')) === o['adapter-entry'], 'adapter-entry-must-be-server-source-import');
    for (const [role, name] of [['state-entry', 'sessionStore.ts'], ['tree-entry', 'sessionTree.ts']]) if (o[role]) need(fs.realpathSync(join(dirname(o.entry), name)) === o[role], `provenance-${role}-source-binding`);
    const honoEntry = fs.realpathSync(createRequire(o.entry).resolve('hono'));
    need(p.inputs.some(i => i.role === 'hono-entry' && i.path === honoEntry), 'provenance-hono-entry-missing');
    need(basename(o.entry) === 'server.ts' && fs.realpathSync(join(dirname(o.entry), 'session', 'sdkProcessGate.ts')) === o['gate-entry'], 'gate-entry-must-be-server-source-import');
    need(fs.statSync(o.native).size > 100000000 && basename(o.native) === 'claude', 'native-stub-refused');
    need(fileHash(o.native) === '97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f' && fileHash(o.sdk) === '48bde6aeabf7e71ad5528bf52c8feb1642c21f505ea2495c70f39db7df226d97', 'candidate-native-sdk-hash');
    need(fs.realpathSync(createRequire(o.entry).resolve('@anthropic-ai/claude-agent-sdk')) === o.sdk, 'entry-sdk-import-must-match-observed-sdk');
    if (o.expect === 'baseline') need(p.codeCommit === 'ae470d511f1f170168c7b95140ba0bb56d99d179' && p.codeTree === '0fef592183db00ce0bc81c988d51124b76bd374a', 'supplied-baseline-identity');
    report.provenance = { schema: p.schema, kind: p.kind, codeCommit: p.codeCommit, codeTree: p.codeTree, tuple: Object.fromEntries(['sdk', 'client', 'backend', 'bun', 'model', 'platform', 'arch'].map(k => [k, p.tuple[k]])), inputs: p.inputs.map(i => ({ role: safeName(i.role), path: i.path, sha256: i.sha256 })), closureCompleteness: 'root declaration; not inferred from entry hash', gateSha256: fileHash(SELF), observerSha256: fileHash(join(dirname(SELF), 'request-observer.mjs')), mappingObserverSha256: fileHash(join(dirname(SELF), 'working-mapping.ts')) };
  }
  function publicQuery(q) {
    return { n: q.n, role: q.role, wire: q.wire?.n ?? null, gate: q.gate?.n ?? null, createdAt: q.createdAt ?? null, creationError: q.creationError ?? null, startAt: q.startAt, initAt: q.initAt ?? null, resultAt: q.resultAt ?? null, iteratorSettledAt: q.iteratorSettledAt ?? null, closeAt: q.closeAt ?? null, abortAt: q.abortAt ?? null, resumeDigest: idDigest(q.options.resume), checkpointDigest: idDigest(q.options.resumeSessionAt), forkSession: q.options.forkSession === true, modelOption: safeName(q.options.model), nativeModel: q.nativeModel ?? null, nativeVersion: q.nativeVersion ?? null, process: q.handle?.n ?? null, mcp: q.mcp ?? null, mcpSamples: q.mcpSamples ?? [], factories: q.factoryIds, strictMcpAdded: q.strictMcpAdded, terminal: q.terminal ?? null };
  }
  async function statusWitness(q) {
    need(q.query && typeof q.query.mcpServerStatus === 'function', 'public-mcp-status-unavailable', 'MISSING');
    const statuses = await bounded(q.query.mcpServerStatus(), 10000, 'mcp-status-deadline', control.signal);
    q.mcp = statuses.map(s => ({ name: safeName(s.name), status: safeName(s.status), tools: (s.tools ?? []).map(t => safeName(t.name)), observedAt: now() }));
    q.mcpSamples ??= []; q.mcpSamples.push(q.mcp);
    return q.mcp;
  }
  async function overlapWitness() {
    if (overlap?.busy || overlap?.proved) return;
    const pair = queries.filter(q => q.role === 'backend' && q.wire && overlap?.selected.includes(q.wire.n) && q.initAt && !q.iteratorSettledAt);
    if (pair.length !== 2) return;
    overlap.busy = true;
    try {
      const samples = await Promise.all(pair.map(statusWitness));
      const at = now();
      need(pair.every(q => q.handle && !q.handle.exit && !q.handle.nativeResultAt && !q.iteratorSettledAt), 'queries-not-both-live-at-mcp-witness', 'MISSING');
      const connected = (rows, i) => pair[i].mcpNames.length > 0 && pair[i].mcpNames.every(name => rows.some(s => s.name === name && s.status === 'connected' && s.tools.some(t => /(?:^|__)Read$/.test(t ?? ''))));
      need(samples.every(connected), 'real-passthrough-mcp-not-connected', 'MISSING');
      need(pair[0].factoryIds.length && pair[1].factoryIds.length && pair[0].factoryIds.every(id => !pair[1].factoryIds.includes(id)), 'overlap-mcp-factory-shared');
      // Re-sample both while alive; mere sequential status receipts are weaker.
      const repeatedSamples = await Promise.all(pair.map(statusWitness));
      need(repeatedSamples.every(connected), 'real-passthrough-mcp-second-sample-not-connected', 'MISSING');
      need(pair.every(q => !q.handle.exit && !q.handle.nativeResultAt && !q.iteratorSettledAt), 'mcp-overlap-ended-during-witness', 'MISSING');
      overlap.proved = { at, queries: pair.map(q => q.n), nativeProcessesAlive: true, bothPublicMcpConnected: true, validatedStatusSampleCountPerQuery: 2 };
    } catch (error) { overlap.failure = failure(error, 'mcp-overlap-observer-exception'); }
    finally { overlap.release.resolve(); bus.emit('changed'); }
  }
  try {
    validateProvenance();
    // This process is already clean at launch; isolate all product import gates.
    for (const name of ['config', 'sessions', 'backend-work', 'client-work-a', 'client-config-a', 'client-work-b', 'client-config-b', 'plugins', 'empty-plugins']) fs.mkdirSync(join(privateRoot, name), { mode: 0o700 });
    const backendConfig = join(privateRoot, 'config', 'profiles', PROFILE);
    fs.mkdirSync(backendConfig, { recursive: true, mode: 0o700 });
    Object.assign(process.env, {
      MERIDIAN_CONFIG_DIR: join(privateRoot, 'config'), MERIDIAN_SESSION_DIR: join(privateRoot, 'sessions'),
      MERIDIAN_WORKDIR: join(privateRoot, 'backend-work'), CLAUDE_CONFIG_DIR: backendConfig,
      MERIDIAN_CLAUDE_PATH: o.native, MERIDIAN_DEFAULT_AGENT: 'claude-code', MERIDIAN_PASSTHROUGH: '1',
      MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_SESSION_GC_INTERVAL_MS: '0',
    });
    need(within(join(o['task-root'], 'grants'), o['token-file']), 'token-input-must-be-private-task-grant');
    privatePath(o['task-root'], o['token-file']);
    tokenStat = fs.statSync(o['token-file']); need(tokenStat.size > 20 && tokenStat.size < 4096, 'access-token-input-size');
    token = fs.readFileSync(o['token-file'], 'utf8').trim();
    need(/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token), 'single-access-only-token-required');
    report.grant.inputRead = true;
    // Capture product output privately, bounded by the parent; no public raw logs.
    productConsole = Object.fromEntries(['log', 'error', 'warn', 'debug', 'info'].map(k => [k, console[k]]));
    for (const k of Object.keys(productConsole)) console[k] = (...args) => raw.write(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    const { spyOn } = await import('bun:test');
    for (const name of ['spawn', 'execFile']) {
      const real = cp[name];
      const spy = spyOn(cp, name).mockImplementation((...args) => {
        let h;
        const callbackIndex = args.findIndex(a => typeof a === 'function');
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (...values) => { if (h) { h.callback = true; h.callbackAt = now(); } try { return callback(...values); } finally { bus.emit('changed'); } };
        }
        const kind = Array.isArray(args[1]) && args[1].includes('auth') ? 'auth-sidecheck' : Array.isArray(args[1]) && args[1].includes('--version') ? 'version-sidecheck' : name;
        const child = real(...args); h = attach(child, kind, callbackIndex >= 0);
        const constructing = gateScopes.getStore();
        if (constructing && name === 'spawn' && args[0] === '/bin/sh' && Array.isArray(args[1]) && args[1][2] === 'meridian-sdk-gate' && within(constructing.root, args[1][3] ?? '') && (args[1][3] ?? '').endsWith('.gate')) {
          if (constructing.handle) { constructing.problems.push('multiple-source-gate-wrapper-handles'); failure(new GateError('multiple-source-gate-wrapper-handles', 'MISSING')); }
          constructing.handle = h; h.kind = 'backend-source-gate-wrapper-exec'; h.gate = constructing.n;
        }
        return child;
      });
      spyRestores.push(() => spy.mockRestore());
    }
    // Import the exact namespace used by source server.ts BEFORE that product
    // module. This observes its real publication/join contract, not a copied gate.
    const gateModule = await import(pathToFileURL(o['gate-entry']).href);
    need(typeof gateModule.createSdkProcessGate === 'function', 'source-gate-export-unavailable', 'MISSING');
    const realCreateGate = gateModule.createSdkProcessGate;
    const gateSpy = spyOn(gateModule, 'createSdkProcessGate').mockImplementation(async (...args) => {
      const g = { n: gates.length + 1, wire: scopes.getStore(), root: args[0], enteredAt: now(), constructed: false, problems: [], queries: [], spawnCalls: [], closeCalls: [] };
      // Reservation precedes all acquisition; failed creations and gates whose
      // query never starts cannot disappear from the final cleanup predicate.
      gates.push(g);
      const problem = code => { g.problems.push(code); failure(new GateError(code, 'MISSING')); };
      if (!g.wire?.contextSeen) problem('source-gate-request-correlation-missing');
      if (g.root !== join(privateRoot, 'sessions', 'sdk-process-gates')) problem('source-gate-root-not-owned');
      const attachExecutor = args[1];
      need(typeof attachExecutor === 'function', 'source-gate-attach-callback-missing', 'MISSING');
      const delegated = [...args];
      delegated[1] = async (...values) => {
        g.attachCalledAt = now();
        const [executor, recoverableAfterCrash] = values;
        g.executor = structuredClone(executor); g.recoverableAfterCrash = recoverableAfterCrash;
        if (!plain(executor) || executor.version !== 1 || !Number.isSafeInteger(executor.pid) || !g.handle || executor.pid !== g.handle.child.pid || recoverableAfterCrash !== true) problem('source-gate-executor-handle-binding-missing');
        try {
          const value = await Reflect.apply(attachExecutor, undefined, values);
          g.attachSettledAt = now(); bus.emit('changed'); return value;
        } catch (error) { g.attachError = safeName(error?.name) ?? 'Error'; throw error; }
      };
      try {
        const actual = await gateScopes.run(g, () => Reflect.apply(realCreateGate, gateModule, delegated));
        g.constructed = true; g.constructedAt = now();
        if (!g.executor || digest(actual.executor) !== digest(g.executor) || actual.recoverableAfterCrash !== g.recoverableAfterCrash) problem('source-gate-returned-executor-changed');
        const realSpawn = actual.spawnClaudeCodeProcess;
        const realCloseAndJoin = actual.closeAndJoin;
        need(typeof realSpawn === 'function' && typeof realCloseAndJoin === 'function', 'source-gate-contract-methods-missing', 'MISSING');
        actual.spawnClaudeCodeProcess = function (...spawnArgs) {
          const spawnOptions = spawnArgs[0];
          const call = { enteredAt: now(), nativePathConfirmed: false, returnedAt: null, error: null };
          g.spawnCalls.push(call);
          try {
            call.nativePathConfirmed = spawnOptions?.command === o.native && fs.realpathSync(spawnOptions.command) === o.native;
            if (!call.nativePathConfirmed) problem('source-gate-command-not-pinned-native');
            // The exact options/signal/environment are passed unchanged.
            const child = Reflect.apply(realSpawn, actual, spawnArgs);
            const h = attach(child, 'backend-sdk-native');
            if (!g.handle || h !== g.handle || child.pid !== g.executor?.pid) problem('source-gate-spawn-return-handle-mismatch');
            g.handle ??= h; h.kind = 'backend-sdk-native'; h.gate = g.n;
            call.returnedAt = now(); bus.emit('changed'); return child;
          } catch (error) { call.error = safeName(error?.name) ?? 'Error'; bus.emit('changed'); throw error; }
        };
        gateSpawns.set(actual.spawnClaudeCodeProcess, g);
        actual.closeAndJoin = async function (...joinArgs) {
          const call = { enteredAt: now(), requestedTimeoutMs: joinArgs[0] ?? null, result: null, settledAt: null, error: null };
          g.closeCalls.push(call);
          try {
            const result = await Reflect.apply(realCloseAndJoin, actual, joinArgs);
            call.result = result; call.settledAt = now();
            if (result !== true) problem('source-gate-close-and-join-not-true');
            bus.emit('changed'); return result;
          } catch (error) { call.error = safeName(error?.name) ?? 'Error'; call.settledAt = now(); bus.emit('changed'); throw error; }
        };
        return actual;
      } catch (error) {
        g.creationError = safeName(error?.name) ?? 'Error';
        failure(new GateError('source-gate-construction-failed', 'MISSING')); throw error;
      } finally { g.creationSettledAt = now(); bus.emit('changed'); }
    });
    spyRestores.push(() => gateSpy.mockRestore());
    sdk = await import(pathToFileURL(o.sdk).href);
    const sdkPackage = JSON.parse(fs.readFileSync(join(dirname(o.sdk), 'package.json'), 'utf8'));
    need(sdkPackage.version === '0.2.141', 'sdk-version-mismatch');
    const realQuery = sdk.query;
    const realFactory = sdk.createSdkMcpServer;
    let factorySerial = 0;
    const factorySpy = spyOn(sdk, 'createSdkMcpServer').mockImplementation((...args) => {
      const value = realFactory(...args); factories.set(value, ++factorySerial);
      if (value?.instance) factories.set(value.instance, factorySerial);
      return value;
    });
    spyRestores.push(() => factorySpy.mockRestore());
    const querySpy = spyOn(sdk, 'query').mockImplementation(params => {
      const wire = scopes.getStore();
      const opts = params.options ?? {};
      const q = { n: queries.length + 1, role: 'backend', wire, options: { resume: opts.resume, resumeSessionAt: opts.resumeSessionAt, forkSession: opts.forkSession, model: opts.model, sessionId: opts.sessionId }, startAt: now(), factoryIds: [], mcpNames: Object.keys(opts.mcpServers ?? {}) };
      queries.push(q);
      if (!wire?.contextSeen) failure(new GateError('backend-query-request-correlation-missing', 'MISSING'));
      need(opts.pathToClaudeCodeExecutable === o.native && opts.env?.CLAUDE_CONFIG_DIR === backendConfig && opts.env?.CLAUDE_CODE_OAUTH_TOKEN === token && !opts.env?.ANTHROPIC_AUTH_TOKEN && !opts.env?.ANTHROPIC_API_KEY && !opts.env?.ANTHROPIC_BASE_URL, 'backend-private-grant-scope');
      need(opts.cwd === join(privateRoot, 'backend-work') && Array.isArray(opts.settingSources) && !opts.settingSources.length && !opts.fallbackModel, 'backend-option-isolation');
      // Identical fixture isolation in every arm. These SDK options narrow
      // configuration/tool discovery; they do not substitute model events.
      q.strictMcpAdded = opts.strictMcpConfig !== true;
      opts.strictMcpConfig = true;
      opts.settings = { ...opts.settings, autoMemoryEnabled: false, autoDreamEnabled: false };
      for (const value of Object.values(opts.mcpServers ?? {})) {
        const id = factories.get(value) ?? factories.get(value?.instance); if (id) q.factoryIds.push(id);
      }
      const originalSpawn = opts.spawnClaudeCodeProcess;
      need(typeof originalSpawn === 'function', 'product-sdk-process-gate-missing', 'MISSING');
      const actualGate = gateSpawns.get(originalSpawn);
      need(actualGate && actualGate.wire === wire && actualGate.constructed && actualGate.queries.length === 0, 'query-not-bound-to-observed-source-gate', 'MISSING');
      q.gate = actualGate; actualGate.queries.push(q);
      opts.spawnClaudeCodeProcess = spawnOptions => {
        const child = originalSpawn(spawnOptions); q.handle = attach(child, 'backend-sdk-native');
        q.handle.kind = 'backend-sdk-native';
        need(q.handle === actualGate.handle && child.pid === actualGate.executor?.pid, 'query-source-gate-process-binding', 'MISSING');
        return child;
      };
      let actual;
      try { actual = realQuery(params); q.query = actual; q.createdAt = now(); }
      catch (error) { q.creationError = safeName(error?.name) ?? 'Error'; bus.emit('changed'); throw error; }
      const realClose = actual.close.bind(actual);
      actual.close = () => { q.closeAt ??= now(); return realClose(); };
      const signal = opts.abortController?.signal;
      signal?.addEventListener('abort', () => { q.abortAt = now(); bus.emit('changed'); }, { once: true });
      const iterate = actual[Symbol.asyncIterator].bind(actual);
      actual[Symbol.asyncIterator] = async function* () {
        try {
          for await (const event of { [Symbol.asyncIterator]: iterate }) {
            if (event.type === 'system' && event.subtype === 'init') {
              q.initAt = now(); q.nativeVersion = event.claude_code_version; q.nativeModel = safeName(event.model);
              if (overlap?.selected.includes(wire?.n)) {
                bus.emit('changed'); void overlapWitness();
                await bounded(overlap.release.promise, 15000, 'overlap-init-barrier-deadline', signal ?? control.signal);
              }
            }
            if (event.type === 'result') { q.resultAt = now(); q.terminal = { subtype: safeName(event.subtype), isError: event.is_error === true }; }
            yield event; // Every authentic event, unchanged.
          }
        } finally { q.iteratorSettledAt = now(); bus.emit('changed'); }
      };
      bus.emit('changed'); return actual;
    });
    spyRestores.push(() => querySpy.mockRestore());
    ({ claudeCodeAdapter: adapter } = await import(pathToFileURL(o['adapter-entry']).href));
    ({ Context } = await import(pathToFileURL(createRequire(o.entry).resolve('hono')).href));
    need(adapter?.name === 'claude-code' && typeof adapter.getSessionId === 'function' && typeof Context === 'function', 'source-identity-adapter-unavailable', 'MISSING');
    state = o['state-entry'] ? await import(pathToFileURL(o['state-entry']).href) : null;
    tree = o['tree-entry'] ? await import(pathToFileURL(o['tree-entry']).href) : null;
    state?.setSessionStoreDir?.(join(privateRoot, 'sessions'));
    globalThis[Symbol.for('meridian.caption-native-gate.observe')] = ctx => {
      const bodyHash = digest(ctx.body);
      const wire = wires.find(r => r.bodyDigest === bodyHash && r.forwardedAt && !r.contextSeen);
      if (!wire) { failure(new GateError('observer-wire-not-unique', 'MISSING')); return; }
      wire.contextSeen = true; wire.adapter = ctx.adapter; scopes.enterWith(wire); bus.emit('changed');
    };
    const pluginPath = join(privateRoot, 'plugins', 'observer.js');
    fs.copyFileSync(join(dirname(SELF), 'request-observer.mjs'), pluginPath);
    fs.chmodSync(pluginPath, 0o600);
    json(join(privateRoot, 'plugins.json'), { plugins: [{ path: pluginPath, enabled: true }] });
    const product = await import(pathToFileURL(o.entry).href);
    need(typeof product.startProxyServer === 'function', 'public-start-proxy-unavailable');
    instance = await product.startProxyServer({ port: 0, host: '127.0.0.1', backend: 'claude', silent: true, debug: false, profiles: [{ id: PROFILE, type: 'oauth-token', oauthToken: token }], defaultProfile: PROFILE, pluginDir: join(privateRoot, 'empty-plugins'), pluginConfigPath: join(privateRoot, 'plugins.json'), installProcessErrorHandlers: false });
    const address = instance.server.address(); need(address && typeof address === 'object', 'proxy-address');
    listeners.proxy.started = true;
    instance.server.once('close', () => { listeners.proxy.closeObserved = true; bus.emit('changed'); });
    instance.server.on('connection', socket => { listeners.proxy.accepted++; proxySockets.add(socket); socket.once('close', () => { listeners.proxy.closed++; proxySockets.delete(socket); bus.emit('changed'); }); });
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const ready = await fetch(`${proxyUrl}/readyz`, { signal: AbortSignal.timeout(10000) });
    report.proxy = { port: address.port, readinessStatus: ready.status, readinessScope: 'public readyz HTTP/admission; not subscription/model completion', maxConcurrent: instance.config.maxConcurrent ?? null, slotLimitChoice: 'default process-wide budget; no claim of two available permits' };
    await ready.arrayBuffer();
    let forwardingOrder = 0;
    async function forward(req, res) {
      const chunks = []; let size = 0;
      for await (const b of req) { size += b.length; need(size <= BODY_LIMIT, 'request-body-limit'); chunks.push(b); }
      const bytes = Buffer.concat(chunks);
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      let body;
      if (/\/messages\/?(?:\?|$)/.test(req.url) && req.method === 'POST') body = JSON.parse(bytes.toString('utf8'));
      const abort = new AbortController();
      let r;
      res.once('close', () => {
        if (!res.writableFinished) { if (r) r.clientAbortAt = now(); abort.abort(); bus.emit('changed'); }
      });
      if (body) {
        need(wires.length < 128, 'native-request-count-bound');
        const identityFields = identity(body, headers);
        const clientSessionHeader = headers.get('x-claude-code-session-id');
        const ownedClients = clients.filter(c => c.sessionId === clientSessionHeader);
        need(ownedClients.length === 1, 'native-wire-owned-client-session-binding-missing', 'MISSING');
        r = { n: wires.length + 1, group: ownedClients[0].group, clientSessionId: ownedClients[0].sessionId, headers, body, bodyDigest: digest(body), ...identityFields, caption: captionShape(body), arrivedAt: now(), done: defer(), abort };
        wires.push(r);
        if (r.caption) {
          need(r.session && r.agent, 'native-caption-identity-missing', 'MISSING');
          need(o.hints === '1' ? headers.get('x-claude-code-request-class') === 'auxiliary' : !headers.has('x-claude-code-request-class'), 'gateway-hint-arm-mismatch');
        }
        bus.emit('changed');
        if (r.caption && !active.get(r.group)?.caption) active.get(r.group).caption = r;
        const c = active.get(r.group);
        if (c?.prepareOverlap && r.caption) {
          await minimumHold(c.barrierAt, o['hold-ms'], abort.signal);
          c.readRelease.resolve();
          const other = await waitFor(() => wires.find(w => w.n > r.n && !w.caption && w.agent === r.agent && w.session === r.session && w.group === r.group), 15000, 'real-next-working-request-not-arrived');
          overlap = { selected: [r.n, other.n], release: defer(), busy: false };
          c.pairReady.resolve({ caption: r, working: other });
          await bounded(c.captionForward.promise, 30000, 'caption-relay-release-deadline', abort.signal);
        } else if (c?.prepareOverlap && c.caption && !r.caption && r.n > c.caption.n && r.agent === c.caption.agent && r.session === c.caption.session) {
          c.overlapWork = r; await bounded(c.workingForward.promise, 30000, 'working-relay-release-deadline', abort.signal);
        } else if (r.caption) {
          await bounded(c.captionForward.promise, 90000, 'caption-snapshot-relay-barrier-deadline', abort.signal);
        }
      }
      try {
        if (r) { r.forwardedAt = now(); r.forwardingOrder = ++forwardingOrder; bus.emit('changed'); }
        // No manufactured count_tokens/auth/model response and no body/header edits.
        const response = await fetch(proxyUrl + req.url, { method: req.method, headers, ...(bytes.length ? { body: bytes } : {}), signal: abort.signal, redirect: 'manual' });
        if (r) r.status = response.status;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        const hash = createHash('sha256'); let responseBytes = 0, sse = '';
        if (r) r.responseEvents = {};
        if (response.body) for await (const b of response.body) {
          responseBytes += b.length; need(responseBytes <= BODY_LIMIT, 'response-body-limit'); hash.update(b);
          if (r && response.headers.get('content-type')?.includes('text/event-stream')) {
            sse += Buffer.from(b).toString('utf8');
            let end;
            while ((end = sse.indexOf('\n')) >= 0) {
              const line = sse.slice(0, end); sse = sse.slice(end + 1);
              if (line.startsWith('event: ')) { const name = safeName(line.slice(7).trim()); if (name) r.responseEvents[name] = (r.responseEvents[name] ?? 0) + 1; }
            }
          }
          if (!res.write(b)) await bounded(new Promise(rDrain => res.once('drain', rDrain)), 10000, 'relay-drain-deadline', abort.signal);
        }
        if (r) { r.responseDigest = hash.digest('hex'); r.responseBytes = responseBytes; }
        res.end();
      } catch (error) {
        if (r) r.forwardError = true;
        if (!abort.signal.aborted && !shuttingDown) failure(error, 'relay-forward-exception');
        res.destroy();
      } finally { if (r) { r.settledAt = now(); r.done.resolve(); } bus.emit('changed'); }
    }
    relay = createServer((req, res) => { track(forward(req, res)).catch(error => { failure(error, 'relay-request-exception'); res.destroy(); }); });
    relay.once('close', () => { listeners.relay.closeObserved = true; bus.emit('changed'); });
    relay.on('connection', socket => { listeners.relay.accepted++; sockets.add(socket); socket.once('close', () => { listeners.relay.closed++; sockets.delete(socket); bus.emit('changed'); }); });
    await bounded(new Promise((r, j) => { relay.once('error', j); relay.listen(0, '127.0.0.1', r); }), 10000, 'relay-listen-deadline');
    const relayAddress = relay.address(); need(relayAddress && typeof relayAddress === 'object', 'relay-address');
    listeners.relay.started = true;
    report.proxy.relayPort = relayAddress.port;
    async function launch(group, summaries) {
      const work = join(privateRoot, `client-work-${group}`), config = join(privateRoot, `client-config-${group}`);
      const files = [1, 2, 3].map(n => join(work, `fixture-${n}.txt`));
      const values = files.map(() => `caption-owned-${randomUUID()}`);
      files.forEach((p, i) => fs.writeFileSync(p, values[i] + '\n', { flag: 'wx', mode: 0o600 }));
      const c = { group, sessionId: randomUUID(), files, values, events: [], receipts: [], reads: new Map(), readRelease: defer(), pairReady: defer(), captionForward: defer(), workingForward: defer(), startedAt: now(), controller: new AbortController(), summaryEnabled: summaries, prepareOverlap: ['work-first', 'caption-first'].includes(o.case) };
      active.set(group, c); clients.push(c);
      const pre = async (input, toolId, { signal }) => {
        try {
        if (input.tool_name === 'Agent') {
          need(!input.agent_id && input.tool_input?.subagent_type === 'caption-worker' && !input.tool_input?.run_in_background, 'actual-named-foreground-agent-required');
          c.agentCall = { id: toolId, at: now() }; bus.emit('changed'); return {};
        }
        need(input.tool_name === 'Read' && input.agent_id && input.agent_type === 'caption-worker', 'read-owned-worker-required');
        const path = resolve(work, input.tool_input?.file_path ?? '');
        const index = files.indexOf(path);
        need(index >= 0 && fs.realpathSync(path) === path && !c.reads.has(index), 'read-path-or-duplicate');
        need(index === c.reads.size && (index === 0 || c.receipts.some(r => r.index === index - 1)), 'reads-must-be-real-sequential-history');
        c.reads.set(index, { id: toolId, agent: input.agent_id, at: now(), inputDigest: digest(input.tool_input) });
        if (index === 1) {
          c.barrierAt = now(); bus.emit('changed');
          await bounded(c.readRelease.promise, 100000, 'read-hook-barrier-deadline', signal);
          need(now() - c.barrierAt >= 35000, 'caption-history-hold-too-short');
        }
        bus.emit('changed'); return {}; // Never grants new paths or replaces input/output.
        } catch (error) {
          failure(error, 'client-pre-tool-validation');
          // Hook exceptions can be treated as hook errors by native Claude.
          // Explicit denial is required to keep a bad call from executing.
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Owned caption fixture gate denied this call.' } };
        }
      };
      const post = async (input, toolId) => {
        let index;
        try {
        if (input.tool_name === 'Agent') { c.agentResult = { id: toolId, at: now() }; bus.emit('changed'); return {}; }
        need(input.tool_name === 'Read', 'unexpected-post-tool');
        index = files.indexOf(resolve(work, input.tool_input?.file_path ?? ''));
        const call = c.reads.get(index);
        need(call && call.id === toolId && call.agent === input.agent_id && !c.receipts.some(r => r.id === toolId), 'real-read-call-result-pair');
        need(JSON.stringify(input.tool_response).includes(values[index]), 'real-fixture-result-not-observed');
        c.receipts.push({ index, id: toolId, agent: input.agent_id, at: now(), resultDigest: digest(input.tool_response) }); bus.emit('changed'); return {};
        } catch (error) {
          const finding = failure(error, 'client-post-tool-validation');
          finding.context = { tool: safeName(input?.tool_name), toolDigest: idDigest(toolId), agentDigest: idDigest(input?.agent_id), index: Number.isInteger(index) ? index : null };
          throw error; // Native may convert hook errors to control_response;
          // the original precise failure is retained before that conversion.
        }
      };
      const env = {
        ...cleanEnv(o, privateRoot), CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${relayAddress.port}`,
        ANTHROPIC_AUTH_TOKEN: 'meridian-caption-loopback-dummy', CLAUDE_CODE_GATEWAY_HINT_HEADERS: o.hints,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      };
      need(!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY, 'client-provider-grant-leak');
      const prompt = `Use Agent with subagent_type caption-worker exactly once, in the foreground. Tell the worker to read these files one at a time, in this order: ${files.join(', ')}. Wait for the worker to finish, then answer briefly. Do not read files yourself, do not run background tasks, and do not use any other tools.`;
      const q = realQuery({ prompt, options: {
        pathToClaudeCodeExecutable: o.native, cwd: work, sessionId: c.sessionId, model: o.model,
        env, settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
        settings: { autoMemoryEnabled: false, autoDreamEnabled: false },
        tools: ['Agent', 'Read'], allowedTools: ['Agent(caption-worker)', 'Read'], permissionMode: 'dontAsk',
        agents: { 'caption-worker': { description: 'Read the three owned caption fixtures sequentially', prompt: `Read ${files[0]} once, wait for its result; then read ${files[1]} once, wait for its result; then read ${files[2]} once. Use only Read. Do not batch calls. Do not delegate, edit, or access any other path.`, tools: ['Read'], model: 'inherit', maxTurns: 8 } },
        hooks: { PreToolUse: [{ matcher: 'Agent|Read', hooks: [pre], timeout: 110 }], PostToolUse: [{ matcher: 'Agent|Read', hooks: [post], timeout: 10 }], SubagentStart: [{ hooks: [async input => { c.worker = { agent: input.agent_id, type: input.agent_type, at: now() }; bus.emit('changed'); return {}; }] }], SubagentStop: [{ hooks: [async input => { c.workerStop = { agent: input.agent_id, at: now() }; bus.emit('changed'); return {}; }] }] },
        maxTurns: 12, agentProgressSummaries: summaries, abortController: c.controller,
        spawnClaudeCodeProcess: spawnOptions => { need(spawnOptions.command === o.native && fs.realpathSync(spawnOptions.command) === o.native, 'client-command-not-pinned-native', 'MISSING'); const child = cp.spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'pipe'] }); c.handle = attach(child, 'client-sdk-native'); c.handle.kind = 'client-sdk-native'; c.nativePathConfirmed = true; return child; },
      } });
      c.query = q;
      c.done = track((async () => {
        try {
          for await (const event of q) {
            need(c.events.length < 1024, 'client-event-count-bound');
            c.events.push({ type: safeName(event.type), subtype: safeName(event.subtype), taskDigest: idDigest(event.task_id), toolDigest: idDigest(event.tool_use_id), at: now(), summaryPresent: typeof event.summary === 'string' && event.summary.length > 0 });
            if (event.type === 'system' && event.subtype === 'init') { c.nativeVersion = event.claude_code_version; c.nativeModel = safeName(event.model); }
            if (event.type === 'result') { c.terminal = { subtype: safeName(event.subtype), isError: event.is_error === true }; }
            bus.emit('changed');
          }
        } finally { c.iteratorSettledAt = now(); q.close(); c.closeAt = now(); bus.emit('changed'); }
      })());
      c.done.catch(error => { if (!c.controller.signal.aborted) failure(error, 'client-query-exception'); });
      return c;
    }
    async function finishClient(c) {
      await bounded(c.done, 120000, 'client-query-settlement-deadline');
      need(c.agentCall && c.agentResult && c.worker?.type === 'caption-worker' && c.worker.agent === c.workerStop?.agent, 'actual-agent-lifecycle-incomplete', 'MISSING');
      need(c.events.some(e => e.subtype === 'task_started' && e.toolDigest === idDigest(c.agentCall.id)), 'actual-agent-task-binding-missing', 'MISSING');
      need(c.nativeVersion === '2.1.292' && c.nativeModel === o.model && c.terminal?.subtype === 'success' && !c.terminal.isError, 'actual-client-native-model-terminal');
      need(c.receipts.length === 3 && c.receipts.every(r => r.agent === c.worker.agent), 'three-genuine-worker-read-receipts');
    }
    const c = await launch('a', o.case !== 'disabled' && o.case !== 'isolation');
    await waitFor(() => c.barrierAt, 90000, 'second-real-read-barrier-missing');
    await minimumHold(c.barrierAt, o['hold-ms'], control.signal);
    // Time is a timer prerequisite only; emission is always separately required.
    if (['disabled', 'isolation'].includes(o.case)) {
      need(!wires.some(r => r.group === 'a' && r.caption), 'disabled-control-emitted-caption');
      c.readRelease.resolve(); await finishClient(c);
      need(!wires.some(r => r.group === 'a' && r.caption), 'disabled-control-late-caption');
      report.cases.disabled = { status: 'PASS', longGenuineWorker: true, holdMs: now() - c.barrierAt };
      if (o.case === 'isolation') {
        const aSessions = new Set(wires.filter(r => r.group === 'a' && !r.caption).map(r => r.session).filter(Boolean));
        const aSdk = new Set(queries.filter(q => q.wire?.group === 'a').flatMap(q => [q.options.resume, q.options.sessionId]).filter(Boolean));
        const second = await launch('b', false);
        await waitFor(() => second.barrierAt, 90000, 'isolated-second-read-barrier-missing');
        await minimumHold(second.barrierAt, o['hold-ms'], control.signal);
        second.readRelease.resolve(); await finishClient(second);
        need(wires.filter(r => r.group === 'b').every(r => !aSessions.has(r.session)), 'separate-client-metadata-inheritance');
        need(queries.filter(q => q.wire?.group === 'b').every(q => !q.options.resume || !aSdk.has(q.options.resume)), 'separate-client-sdk-inheritance');
        report.cases.isolation = { status: 'PASS', separateConfigWorkSession: true };
      }
    } else {
      const caption = await waitFor(() => c.caption, 45000, 'native-caption-not-emitted');
      const prior = wires.filter(r => r.n < caption.n && !r.caption && r.agent === caption.agent && r.session === caption.session && r.group === c.group);
      need(prior.length > 0 && c.worker?.agent === caption.agent && c.receipts[0]?.agent === caption.agent, 'caption-working-agent-session-binding', 'MISSING');
      const before = await snapshot(caption);
      need(before.mapping.passthroughToolCallAssistantUuid && before.mapping.passthroughToolCallIds?.includes(c.reads.get(1)?.id), 'actual-second-read-checkpoint-missing', 'MISSING');
      if (c.prepareOverlap) {
        const pair = await bounded(c.pairReady.promise, 18000, 'native-request-pair-missing');
        const first = o.case === 'work-first' ? pair.working : pair.caption;
        const firstGate = o.case === 'work-first' ? c.workingForward : c.captionForward;
        const secondGate = o.case === 'work-first' ? c.captionForward : c.workingForward;
        firstGate.resolve(); await waitFor(() => queries.find(q => q.wire === first && q.initAt), 12000, 'first-real-query-not-initialized');
        secondGate.resolve();
        await waitFor(() => overlap.proved || overlap.failure, 15000, 'real-mcp-overlap-witness-missing');
        need(overlap.proved, overlap.failure?.code ?? 'real-mcp-overlap-missing', 'MISSING');
        await finishClient(c);
        need(c.reads.get(2)?.at > overlap.proved.at && c.receipts.some(r => r.index === 2 && r.at > overlap.proved.at), 'new-genuine-read-after-overlap-missing', 'MISSING');
        report.cases[o.case] = { status: 'PASS', ...overlap.proved, genuinePostOverlapRead: true };
      } else if (o.case === 'sequential') {
        c.captionForward.resolve();
        await bounded(caption.done.promise, 90000, 'caption-http-settlement-deadline');
        need(caption.status === 200 && !caption.clientAbortAt && caption.responseEvents?.message_stop === 1 && !caption.responseEvents?.error, 'caption-http-success-required', 'MISSING');
        const after = await snapshot(caption);
        need(o.expect === 'fixed' ? exactPreserved(before, after) : !exactPreserved(before, after), o.expect === 'fixed' ? 'caption-mutated-working-state' : 'baseline-caption-mutation-not-reproduced', o.expect === 'fixed' ? 'FAIL' : 'MISSING');
        const captionQueries = queries.filter(q => q.wire === caption);
        need(captionQueries.length === 1, 'caption-backend-query-count');
        if (o.expect === 'fixed') need(!captionQueries[0].options.resume && !captionQueries[0].options.resumeSessionAt, 'caption-had-working-resume-authority');
        c.readRelease.resolve(); await finishClient(c);
        const next = wires.find(r => r.n > caption.n && !r.caption && r.agent === caption.agent && r.session === caption.session);
        need(next, 'next-real-working-request-missing', 'MISSING');
        need(blocks(next.body.messages).filter(b => b.type === 'tool_result' && b.tool_use_id === c.reads.get(1).id).length === 1, 'actual-second-read-result-wire-pair-once');
        const nextQuery = queries.find(q => q.wire === next); need(nextQuery, 'next-query-correlated-missing', 'MISSING');
        if (o.expect === 'fixed') need(nextQuery.options.resume === before.mapping.claudeSessionId && nextQuery.options.resumeSessionAt === before.mapping.passthroughToolCallAssistantUuid && nextQuery.options.forkSession, 'working-checkpoint-not-resumed');
        else need(!nextQuery.options.resume && !nextQuery.options.resumeSessionAt, 'baseline-next-working-replay-not-reproduced', 'MISSING');
        const final = await snapshot(caption);
        const sourceAgain = await sdk.getSessionMessages(before.mapping.claudeSessionId, { dir: join(privateRoot, 'backend-work') });
        need(digest(sourceAgain) === digest(before.history), 'source-history-mutated');
        for (const receipt of c.receipts) {
          const results = blocks(final.history.map(row => row.message)).filter(b => b.type === 'tool_result' && b.tool_use_id === receipt.id);
          need(results.length === 1 && JSON.stringify(results[0].content).includes(c.values[receipt.index]), 'durable-real-read-result-pair-once');
        }
        report.cases.sequential = { status: 'PASS', expectation: o.expect, before: before.public, afterCaption: after.public, afterWork: final.public, sourceHistoryUnchanged: true, nextQuery: nextQuery.n, checkpointResume: o.expect === 'fixed', baselineMutationAndReplay: o.expect === 'baseline' };
      } else {
        // These modes attempt real cancellation, but do not weaken child/recovery proof.
        c.captionForward.resolve();
        const captionQuery = await waitFor(() => queries.find(q => q.wire === caption && q.initAt && !q.iteratorSettledAt), 15000, 'caption-live-backend-query-missing');
        need(captionQuery.handle && !captionQuery.handle.exit && !captionQuery.handle.nativeResultAt, 'caption-native-generation-already-ended', 'MISSING');
        let faultAfter;
        if (o.case === 'caption-fault') {
          caption.transportFault = true; caption.abort.abort();
          await bounded(caption.done.promise, 20000, 'fault-caption-http-settlement');
          await waitFor(() => captionQuery.iteratorSettledAt && captionQuery.handle.close, 15000, 'fault-caption-query-process-join');
          faultAfter = await snapshot(caption);
          if (o.expect === 'fixed') need(exactPreserved(before, faultAfter), 'fault-caption-mutated-quiescent-working-state');
        }
        c.readRelease.resolve(); await finishClient(c);
        await bounded(caption.done.promise, 20000, 'cancelled-caption-http-settlement');
        if (o.case === 'natural-stop') need(caption.clientAbortAt && captionQuery.abortAt && (!captionQuery.handle.nativeResultAt || captionQuery.handle.nativeResultAt >= c.workerStop.at), 'native-worker-stop-did-not-abort-live-caption', 'MISSING');
        need(captionQuery.abortAt && captionQuery.iteratorSettledAt, 'caption-cancellation-query-not-settled', 'MISSING');
        report.cases[o.case] = { status: 'MISSING', cancellationObserved: true, faultInjected: o.case === 'caption-fault', workingFinishedWithRealReads: true, before: before.public, afterFaultWhileQuiescent: faultAfter?.public ?? null, missing: [...(o.case === 'natural-stop' ? ['caption-only state snapshot while working quiescent'] : []), 'live declared working children retained', 'one-shot tool-recovery cache observer'] };
        throw new GateError('cancellation-working-children-recovery-observer-missing', 'MISSING');
      }
      const ancestry = wires.filter(r => r.parent);
      report.actualParentArm = { status: 'MISSING', declaredParentObserved: ancestry.length > 0, reason: ancestry.length ? 'declared native ancestor abort arm not executed' : 'native metadata declares no parent; no invented ancestry', separateUnitProof: 'root-owned HTTP/unit gate' };
    }
    need(queries.length && queries.every(q => q.wire?.contextSeen && q.wire.adapter === 'claude-code'), 'product-request-observer-or-sdk-export-not-connected', 'MISSING');
    need(queries.every(q => q.nativeVersion === '2.1.292' && q.nativeModel === o.model), 'backend-native-version-model-confirmation', 'MISSING');
    report.status = report.firstFailure?.status ?? 'PASS';
  } catch (error) { failure(error); report.status = report.firstFailure.status; }
  finally {
    shuttingDown = true; control.abort();
    for (const c of clients) {
      c.controller.abort(); c.readRelease.resolve(); c.captionForward.resolve(); c.workingForward.resolve();
      try { c.query?.close(); } catch (error) { failure(error, 'client-query-close-exception'); }
    }
    overlap?.release.resolve();
    for (const q of queries) { try { q.query?.close(); } catch (error) { failure(error, 'backend-query-close-exception'); } }
    for (const r of wires) r.abort.abort();
    try { await bounded(Promise.allSettled([...pending]), o['join-ms'], 'pending-query-http-join-deadline'); report.cleanup.queryHttpSettlement = 'JOINED'; }
    catch (error) { failure(error); report.cleanup.queryHttpSettlement = 'UNKNOWN'; }
    try {
      if (instance) {
        await bounded(instance.close(), o['join-ms'], 'proxy-public-close-deadline');
        await waitFor(() => listeners.proxy.closeObserved && proxySockets.size === 0 && listeners.proxy.accepted === listeners.proxy.closed, 3000, 'proxy-listener-sockets-close-deadline', new AbortController().signal);
      }
      report.cleanup.proxyClose = instance ? 'JOINED' : 'NOT_STARTED';
    }
    catch (error) { failure(error); report.cleanup.proxyClose = 'UNKNOWN'; }
    try {
      await bounded(new Promise(r => { const check = () => { if (queries.every(q => q.iteratorSettledAt && q.closeAt) && clients.every(c => c.iteratorSettledAt && c.closeAt)) { bus.off('changed', check); r(); } }; bus.on('changed', check); check(); }), o['join-ms'], 'sdk-query-iterator-close-join-deadline');
      report.cleanup.sdkIterators = 'JOINED';
    } catch (error) { failure(error); report.cleanup.sdkIterators = 'UNKNOWN'; }
    report.cleanup.relayRequests = wires.every(r => r.settledAt) ? 'JOINED' : 'UNKNOWN';
    try {
      if (relay) {
        const closed = new Promise((r, j) => relay.close(error => { listeners.relay.closeCallback = true; if (error) j(error); else r(); }));
        relay.closeIdleConnections();
        await bounded(closed, o['join-ms'], 'relay-listener-close-deadline');
        await waitFor(() => listeners.relay.closeObserved && listeners.relay.closeCallback && !sockets.size && listeners.relay.accepted === listeners.relay.closed, 3000, 'relay-socket-close-deadline', new AbortController().signal);
      }
      report.cleanup.relayClose = relay ? 'JOINED' : 'NOT_STARTED';
    } catch (error) { failure(error); report.cleanup.relayClose = 'UNKNOWN'; }
    try { await bounded(new Promise(r => { const check = () => { if (handles.every(joined)) { bus.off('changed', check); r(); } }; bus.on('changed', check); check(); }), o['join-ms'], 'owned-process-stream-callback-join-deadline'); report.cleanup.directProcesses = 'JOINED'; }
    catch (error) { failure(error); report.cleanup.directProcesses = 'UNKNOWN'; }
    try {
      await waitFor(() => gates.length > 0 && queries.length > 0 && gates.every(gateJoined) && queries.every(q => q.gate && q.initAt && q.nativeVersion === '2.1.292' && q.nativeModel === o.model && q.handle === q.gate.handle && q.iteratorSettledAt && q.closeAt), o['join-ms'], 'real-source-gate-publication-executor-query-join-deadline', new AbortController().signal);
      report.cleanup.sourceSdkGates = 'JOINED';
    } catch (error) { failure(error); report.cleanup.sourceSdkGates = 'UNKNOWN'; }
    for (const restore of spyRestores.reverse()) { try { restore(); } catch (error) { failure(error, 'observer-restore-exception'); } }
    delete globalThis[Symbol.for('meridian.caption-native-gate.observe')];
    if (productConsole) Object.assign(console, productConsole);
    try {
      if (token !== undefined) {
        const current = fs.statSync(o['token-file']);
        report.grant.preserved = current.dev === tokenStat.dev && current.ino === tokenStat.ino && current.mode === tokenStat.mode && current.size === tokenStat.size && current.mtimeMs === tokenStat.mtimeMs && fs.readFileSync(o['token-file'], 'utf8').trim() === token;
        need(report.grant.preserved, 'token-input-changed');
      }
    } catch (error) { failure(error, 'token-preservation-check-exception'); }
    token = undefined;
    report.wire = wires.map(wirePublic); report.queries = queries.map(publicQuery); report.sourceGates = gates.map(publicGate);
    report.clients = clients.map(c => ({ group: c.group, clientSessionDigest: idDigest(c.sessionId), nativePathConfirmed: c.nativePathConfirmed === true, summaryEnabled: c.summaryEnabled, nativeVersion: c.nativeVersion ?? null, nativeModel: c.nativeModel ?? null, barrierAt: c.barrierAt ?? null, workerDigest: idDigest(c.worker?.agent), agentCallDigest: idDigest(c.agentCall?.id), workerStopAt: c.workerStop?.at ?? null, terminal: c.terminal ?? null, iteratorSettledAt: c.iteratorSettledAt ?? null, closeAt: c.closeAt ?? null, events: c.events, receipts: c.receipts.map(r => ({ index: r.index, idDigest: idDigest(r.id), agentDigest: idDigest(r.agent), at: r.at, resultDigest: r.resultDigest })) }));
    report.processes = handles.map(h => ({ n: h.n, kind: h.kind, gate: h.gate ?? null, createdAt: h.createdAt, exit: h.exit, exitAt: h.exitAt ?? null, code: h.code ?? null, signal: h.signal ?? null, close: h.close, closeAt: h.closeAt ?? null, callbackExpected: h.callbackExpected, callback: h.callback, stdinClose: h.stdinClose, stdinAbsent: h.stdinAbsent === true, stdoutEnd: h.stdoutEnd, stdoutClose: h.stdoutClose, stdoutAbsent: h.stdoutAbsent === true, stderrEnd: h.stderrEnd, stderrClose: h.stderrClose, stderrAbsent: h.stderrAbsent === true, nativeResultAt: h.nativeResultAt, afterExitSignalPrevented: h.afterExitSignalPrevented ?? 0, join: joined(h) ? 'JOINED' : 'UNKNOWN', raw: h.writers.map(closeWriter) }));
    report.cleanup.localHttpResources = { proxy: { ...listeners.proxy, liveSockets: proxySockets.size }, relay: { ...listeners.relay, liveSockets: sockets.size }, scope: 'two observed local listeners and their accepted sockets; not every OS/network connection' };
    report.cleanup.descendants = { status: 'UNKNOWN', scope: 'native secondary/synchronous processes and global absence not observed; source gate POSIX exec handle, publication and owned direct processes are separately observed', rootGate: 'no global census or PID/group sweep; no config/session/history cleanup permission inferred' };
    report.cleanup.recoveryCacheObserver = 'MISSING';
    report.cleanup.ownedSessionTreeObserver = tree?.processSessionTree ? { available: true, finalStats: tree.processSessionTree.stats() } : { available: false };
    report.actualParentArm ??= { status: 'MISSING', declaredParentObserved: wires.some(r => r.parent), reason: 'actual declared-ancestor cancellation not executed; separate root-owned HTTP/unit gate' };
    report.privateRaw = closeWriter(raw);
    const scopedJoin = report.cleanup.queryHttpSettlement === 'JOINED' && report.cleanup.proxyClose === 'JOINED' && report.cleanup.sdkIterators === 'JOINED' && report.cleanup.relayRequests === 'JOINED' && report.cleanup.relayClose === 'JOINED' && report.cleanup.directProcesses === 'JOINED' && report.cleanup.sourceSdkGates === 'JOINED' && pending.size === 0 && report.processes.every(h => h.join === 'JOINED' && h.raw.every(w => w.flushed === true)) && report.privateRaw.flushed === true && clients.length > 0 && clients.every(c => c.nativePathConfirmed && c.handle && joined(c.handle) && c.iteratorSettledAt && c.closeAt && c.nativeVersion === '2.1.292' && c.nativeModel === o.model);
    report.cleanup.scopedOwnedJoin = scopedJoin ? 'JOINED' : 'UNKNOWN';
    report.cleanup.grantCleanupAllowed = scopedJoin && report.grant.inputRead && report.grant.preserved === true;
    report.cleanup.grantCleanupScope = 'root review only: preserved access-only task input after actual source SDK gate publication/executor, direct native/sidecheck handles, queries, local HTTP resources and private writers joined; no deletion is performed and global descendants/config/session/history remain outside this claim';
    if (!scopedJoin && !report.firstFailure) failure(new GateError('scoped-source-case-cleanup-not-joined', 'MISSING'));
    if (report.firstFailure) report.status = report.findings.some(f => f.status === 'FAIL') ? 'FAIL' : 'MISSING';
    report.coverage = 'selected source case only; full matrix, package bundled-gate observation, private working cache/child retention and actual-parent arm remain separate OPEN gates; no global native-descendant absence claim';
    json(join(o.output, 'report.json'), report);
    if (process.send) {
      try { await bounded(new Promise((r, j) => process.send({ kind: 'settled', scopedOwnedJoin: report.cleanup.scopedOwnedJoin, grantCleanupAllowed: report.cleanup.grantCleanupAllowed, globalDescendantAbsence: 'UNKNOWN' }, error => error ? j(error) : r())), 1000, 'parent-settlement-ipc-deadline'); }
      catch (error) { process.exitCode = 1; }
    }
    process.exitCode = report.status === 'PASS' && scopedJoin && process.exitCode !== 1 ? 0 : 1;
    // Handles/timers that remain after a bounded UNKNOWN are left for root;
    // this exact worker exits without deleting the grant or signalling PIDs.
    process.exit(process.exitCode);
  }
}

try {
  const o = options(process.argv.slice(2));
  if (o.worker) await worker(o); else await parent(o);
} catch (error) {
  process.stderr.write(JSON.stringify({ status: error instanceof GateError ? error.status : 'FAIL', code: error instanceof GateError ? error.code : 'gate-startup-exception' }) + '\n');
  process.exitCode = 1;
}
