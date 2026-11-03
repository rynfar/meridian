#!/usr/bin/env bun
/** Instrument unchanged qualified E41. --self-test is offline; --run is explicit opt-in. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spyOn } from "bun:test"

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const LIMITS = Object.freeze({ queries: 16, events: 4096, historyRows: 1024,
  blocks: 256, promptItems: 256, nodes: 100000, depth: 64, reportBytes: 4 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024, defaultSeconds: 1000, maxSeconds: 1200, killGraceMs: 5000 })
const sha = value => createHash("sha256").update(value).digest("hex")
const plain = value => value !== null && typeof value === "object"
const modelLabel = value => ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5"].includes(value) ? value : undefined
const secretKey = /^(?:api[-_]?key|authorization|password|secret|credentials?|oauthToken|accessToken|refreshToken|token|claudeCodeOAuthToken|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/i

// Hash in memory. Never invoke getters/toJSON or serialize env values. Non-data
// SDK options (functions, opaque objects) are structural, not closure fingerprints.
function fingerprint(value) {
  const h = createHash("sha256"), seen = new WeakMap()
  let nodes = 0
  const put = value => h.update(JSON.stringify(value) + "\n")
  function visit(v, depth) {
    assert(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, "Fingerprint bound exceeded")
    if (v === null || ["string", "boolean", "number"].includes(typeof v)) { put([typeof v, v]); return }
    if (typeof v === "undefined") { put(["undefined"]); return }
    if (typeof v === "bigint" || typeof v === "symbol") { put([typeof v, String(v)]); return }
    if (typeof v === "function") { put(["function", sha(Function.prototype.toString.call(v))]); return }
    if (seen.has(v)) { put(["reference", seen.get(v)]); return }
    seen.set(v, nodes)
    put([Array.isArray(v) ? "array" : "object"])
    const descriptors = Object.getOwnPropertyDescriptors(v)
    for (const key of Object.keys(descriptors).sort()) {
      const d = descriptors[key]
      if (!d.enumerable) continue
      if (key === "env" || secretKey.test(key)) { put(["excluded-sensitive-field"]); continue }
      put(["key", key])
      if ("value" in d) visit(d.value, depth + 1)
      else put(["accessor-not-invoked"])
    }
    put(["end"])
  }
  visit(value, 0)
  return h.digest("hex")
}
function id(value) {
  if (typeof value !== "string") return undefined
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^msg_[a-zA-Z0-9_-]{1,160}$/.test(value)) return { value }
  return { sha256: fingerprint(value) }
}
function usage(value) {
  if (!plain(value)) return undefined
  const result = {}
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
    if (Number.isFinite(value[k])) result[k] = value[k]
  return result
}
function contentMetadata(blocks) {
  if (!Array.isArray(blocks)) return []
  assert(blocks.length <= LIMITS.blocks, "Content block bound exceeded")
  const types = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image", "document", "refusal"])
  return blocks.map((block, index) => ({ index,
    type: types.has(block?.type) ? block.type : "other", sha256: fingerprint(block) }))
}
function makeState() {
  return { schema: 1, result: "RUNNING", scope: "owned qualified E41 protocol fixture only; not OpenCode executable",
    historicalResidualReproduced: false, encryptedFaultInjected: false,
    hashCoverage: "canonical own enumerable data; env/sensitive-key fields excluded; functions source-hashed, closures/opaque state not captured",
    limits: LIMITS, platform: `${process.platform}/${process.arch}`, bun: Bun.version,
    startedAt: new Date().toISOString(), queries: [], events: [], histories: [], stopped: false,
    sdkMessages: 0, promptItems: 0 }
}
function event(state, row) {
  assert(state.events.length < LIMITS.events, "Observer event bound exceeded")
  state.events.push({ order: state.events.length + 1, at: new Date().toISOString(),
    monotonicMs: Number(performance.now().toFixed(3)), ...row })
}
function stop(state, reason) { state.stopped = true; state.stopReason ??= reason }

// Proxy the actual iterator rather than drain/replay it. Every result object and
// message is returned unchanged. All other Query methods stay bound to the real
// Query (close/interrupt/process-gate custody remains the fixture's).
function observeIterator(iterator, onValue, onDone = () => {}, onError = () => {}) {
  let proxy
  proxy = new Proxy(iterator, { get(target, key) {
    if (key === Symbol.asyncIterator) return () => proxy
    const value = Reflect.get(target, key, target)
    if (["next", "return", "throw"].includes(key) && typeof value === "function") return async (...args) => {
      try {
        const step = await Reflect.apply(value, target, args)
        if (!step.done) onValue(step.value)
        else onDone(key)
        return step
      } catch (error) { onError(); throw error }
    }
    return typeof value === "function" ? value.bind(target) : value
  } })
  return proxy
}
function observePrompt(prompt, state, query) {
  const row = state.queries[query - 1]
  if (typeof prompt === "string") {
    const digest = fingerprint(prompt)
    if (row) { row.promptSha256 = digest; row.promptHashKind = "canonical-string" }
    event(state, { kind: "prompt", query, item: 0, sha256: digest })
    return prompt
  }
  assert(prompt && typeof prompt[Symbol.asyncIterator] === "function", "Unsupported prompt shape")
  const hash = createHash("sha256")
  let finished = false
  const onValue = value => {
    assert(!finished, "Prompt yielded after completion")
    assert(++state.promptItems <= LIMITS.promptItems, "Prompt item bound exceeded")
    const digest = fingerprint(value)
    hash.update(digest + "\n")
    event(state, { kind: "prompt", query, item: state.promptItems, sha256: digest })
  }
  const onDone = method => {
    if (finished) return
    finished = true
    if (row) { row.promptSha256 = hash.digest("hex"); row.promptHashKind = "ordered-item-digests"; row.promptComplete = method === "next" }
    event(state, { kind: "prompt-end", query, method })
  }
  const onError = () => stop(state, "prompt-iterator-error")
  if (typeof prompt.next === "function") return observeIterator(prompt, onValue, onDone, onError)
  return new Proxy(prompt, { get(target, key) {
    if (key === Symbol.asyncIterator) return () => observeIterator(target[Symbol.asyncIterator](), onValue, onDone, onError)
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
}
function observeMessage(message, state, query, knownSessions) {
  const sdkOrder = ++state.sdkMessages
  if (typeof message?.session_id === "string") knownSessions.add(message.session_id)
  const base = { query, sdkOrder, session: id(message?.session_id), uuid: id(message?.uuid) }
  const queryRow = state.queries[query - 1]
  if (queryRow && message?.type === "assistant" && message.message?.content?.some(b => b?.type === "tool_use")) queryRow.sawToolUse = true
  // Current Meridian deliberately caps passthrough at one native turn. Its
  // error_max_turns result commits a forwarded tool boundary, not a provider
  // failure. Do not preempt the unchanged fixture's handoff assertions.
  const toolBoundaryCandidate = message?.type === "result" && message.subtype === "error_max_turns"
    && queryRow?.maxTurns === 1 && queryRow?.sawToolUse === true && !message.error
  const native = message?.type === "assistant" ? message.message
    : message?.type === "stream_event" && message.event?.type === "message_start" ? message.event.message : undefined
  if (native) {
    event(state, { kind: message.type === "assistant" ? "native-assistant" : "message_start", ...base,
      messageId: id(native.id), model: modelLabel(native.model), modelSha256: fingerprint(native.model), usage: usage(native.usage),
      blocks: contentMetadata(native.content), messageSha256: fingerprint(message) })
  } else if (message?.type === "system" && message.subtype === "api_retry") {
    const number = v => Number.isFinite(v) ? v : undefined
    event(state, { kind: "api_retry", ...base, attempt: number(message.attempt),
      delayMs: number(message.retry_delay_ms), status: number(message.error_status) })
  } else if (message?.type === "system" && message.subtype === "init") {
    event(state, { kind: "session-init", ...base })
  } else if (message?.type === "result") {
    event(state, { kind: "result", ...base, usage: usage(message.usage),
      isError: message.is_error === true, toolBoundaryCandidate,
      subtype: ["success", "error_max_turns"].includes(message.subtype) ? message.subtype : undefined,
      subtypeSha256: fingerprint(message.subtype) })
  }
  const refusal = native?.stop_reason === "refusal" || native?.content?.some(b => b?.type === "refusal")
  if (refusal || message?.error || message?.type === "error" || (message?.type === "result" && message.is_error && !toolBoundaryCandidate)) {
    stop(state, refusal ? "native-refusal" : "native-terminal-error")
    event(state, { kind: "stop-before-next-query", ...base, reason: state.stopReason })
  }
}
function rootProject() {
  assert(isAbsolute(process.env.E2E_MERIDIAN_ROOT ?? ""), "Set absolute E2E_MERIDIAN_ROOT")
  const root = realpathSync(process.env.E2E_MERIDIAN_ROOT)
  const fixture = join(root, "scripts/e2e-qualified-passthrough-turns.mjs")
  const fidelity = join(root, "scripts/lib/e41-assistant-response.ts")
  assert(existsSync(fixture) && existsSync(fidelity), "Current qualified fixture/fidelity helper required")
  return { root, fixture, fidelity, fixtureSha256: sha(readFileSync(fixture)), fidelitySha256: sha(readFileSync(fidelity)) }
}
function ownedDirectory(path, root, allowMissing = false) {
  assert(typeof path === "string" && isAbsolute(path), "Absolute owned directory required")
  let ancestor = resolve(path)
  const suffix = []
  if (allowMissing) while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    assert.notEqual(parent, ancestor, "Missing directory has no existing ancestor")
    suffix.unshift(relative(parent, ancestor)); ancestor = parent
  }
  const real = join(realpathSync(ancestor), ...suffix), rel = relative(root, real)
  assert(rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)), "Directory is outside owned fixture")
  return real
}
function writeReport(path, state) {
  const data = JSON.stringify(state, null, 2) + "\n"
  assert(Buffer.byteLength(data) <= LIMITS.reportBytes, "Report bound exceeded")
  writeFileSync(path, data, { mode: 0o600 })
}
function pluginWitness(value) {
  if (!plain(value)) return undefined
  const out = {}
  for (const k of ["packageName", "packageVersion", "runtimeVersion"])
    if (typeof value[k] === "string") out[`${k}Sha256`] = fingerprint(value[k])
  if (["@rynfar/meridian", "@rynfar/meridian-plugin-opencode-scrub"].includes(value.packageName)) out.packageName = value.packageName
  for (const k of ["packageVersion", "runtimeVersion"])
    if (/^[0-9][0-9A-Za-z.+-]{0,79}$/.test(value[k] ?? "")) out[k] = value[k]
  if (/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) out.sha256 = value.sha256
  if (typeof value.path === "string") out.pathSha256 = fingerprint(value.path)
  for (const k of ["invocations", "errors"]) if (Number.isFinite(value[k])) out[k] = value[k]
  if (typeof value.preflight === "boolean") out.preflight = value.preflight
  return out
}
function fixtureVerdict(value) {
  const out = { result: ["PASS", "FAIL", "RUNNING"].includes(value.result) ? value.result : "UNKNOWN" }
  for (const k of ["joined", "parallel", "sourceHistoryOk", "modelOk", "followUpOk", "forkShapeOk", "toolShapeOk"])
    if (typeof value[k] === "boolean") out[k] = value[k]
  if (Number.isFinite(value.delivered)) out.delivered = value.delivered
  if (Array.isArray(value.toolCallBatchSizes)) out.toolCallBatchSizes = value.toolCallBatchSizes.filter(Number.isFinite)
  if (typeof value.failure === "string") out.failureSha256 = fingerprint(value.failure)
  if (Array.isArray(value.cacheMisses)) out.cacheMisses = value.cacheMisses.map(fingerprint)
  for (const k of ["clientPlugin", "scrubPreflight", "scrubFinal"]) out[k] = pluginWitness(value[k])
  return out
}

async function worker() {
  assert.equal(process.env.E2E_ALLOW_LIVE_MODEL, "1", "Explicit live opt-in required")
  assert.equal(process.env.E2E_INSTRUMENTED_WORKER, "1", "Use --run supervisor, not --worker")
  const project = rootProject()
  const reportPath = process.env.E2E_INSTRUMENTED_REPORT
  assert(dirname(reportPath ?? "") === HERE, "Report must remain next to escrowed helper")
  const state = makeState(), spies = [], knownSessions = new Set()
  Object.assign(state, { source: { fixtureSha256: project.fixtureSha256, fidelitySha256: project.fidelitySha256,
    observerSource: "1cb9e53cb4ded92b8589177265cb736eb0978011:scripts/e2e-session-store-turns.mjs" },
    requestedModel: modelLabel(process.env.PROBE_MODEL), requestedModelSha256: fingerprint(process.env.PROBE_MODEL),
    stream: process.argv.includes("--stream"), parallel: process.env.PROBE_PARALLEL === "1" })
  const require = createRequire(join(project.root, "package.json"))
  const sdk = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href)
  const realQuery = sdk.query, realHistory = sdk.getSessionMessages
  let ownedRoot
  const scope = () => {
    const current = realpathSync(process.env.MERIDIAN_WORKDIR ?? "")
    assert(/^meridian-probe-proxy-/.test(current.split(sep).at(-1)), "Unrecognized fixture workdir")
    ownedRoot ??= current
    assert.equal(current, ownedRoot, "Owned fixture changed")
    state.fixtureRoot = ownedRoot
    return ownedRoot
  }
  const flush = () => writeReport(reportPath, state)
  spies.push(spyOn(sdk, "query").mockImplementation(input => {
    assert(!state.stopped, "Observer stopped this arm; no additional SDK request permitted")
    assert(state.queries.length < LIMITS.queries, "Query bound exceeded")
    const fixtureRoot = scope(), options = input.options ?? {}
    assert.equal(ownedDirectory(options.cwd, fixtureRoot), fixtureRoot, "Query workdir must be exact owned fixture")
    // Require config isolation before allowing an actual SDK query. Read only
    // this locator, never credential values; omit the env from all fingerprints.
    const configDir = ownedDirectory(options.env?.CLAUDE_CONFIG_DIR, fixtureRoot, true)
    for (const session of [options.sessionId, options.resume]) if (typeof session === "string") knownSessions.add(session)
    const query = state.queries.length + 1
    state.queries.push({ query, startedAt: new Date().toISOString(), optionsSha256: fingerprint(options),
      configRelative: relative(fixtureRoot, configDir), resume: id(options.resume),
      checkpoint: id(options.resumeSessionAt), forkSession: options.forkSession === true,
      maxTurns: Number.isFinite(options.maxTurns) ? options.maxTurns : undefined,
      targetSession: id(options.sessionId), thinkingSha256: fingerprint(options.thinking),
      effortSha256: fingerprint(options.effort), promptKind: typeof input.prompt === "string" ? "string" : "async-iterable" })
    event(state, { kind: "query-start", query })
    const prompt = observePrompt(input.prompt, state, query)
    flush()
    let original
    try { original = realQuery({ ...input, prompt }) }
    catch (error) { stop(state, "query-construction-error"); flush(); throw error }
    return observeIterator(original, message => {
      observeMessage(message, state, query, knownSessions)
      if (["assistant", "result"].includes(message?.type)) flush()
    }, method => { event(state, { kind: "query-iterator-end", query, method }); flush() },
    () => { stop(state, "query-iterator-error"); flush() })
  }))
  spies.push(spyOn(sdk, "getSessionMessages").mockImplementation(async (session, options) => {
    assert(knownSessions.has(session), "History requested for unobserved session")
    const fixtureRoot = scope()
    assert.equal(ownedDirectory(options?.dir, fixtureRoot), fixtureRoot, "History workdir is not owned fixture")
    const configDir = ownedDirectory(process.env.CLAUDE_CONFIG_DIR, fixtureRoot)
    const startedAt = new Date().toISOString()
    const rows = await realHistory(session, options)
    assert(Array.isArray(rows) && rows.length <= LIMITS.historyRows, "History row bound exceeded")
    assert(state.histories.length < LIMITS.events, "History call bound exceeded")
    state.histories.push({ order: state.histories.length + 1, session: id(session), startedAt,
      completedAt: new Date().toISOString(), configRelative: relative(fixtureRoot, configDir),
      rows: rows.map((row, index) => ({ index, uuid: id(row?.uuid), session: id(row?.session_id),
        type: ["user", "assistant", "system"].includes(row?.type) ? row.type : "other",
        rowSha256: fingerprint(row), messageId: id(row?.message?.id), usage: usage(row?.message?.usage),
        model: modelLabel(row?.message?.model), modelSha256: fingerprint(row?.message?.model),
        blocks: contentMetadata(row?.message?.content) })) })
    event(state, { kind: "supported-history", history: state.histories.length, session: id(session), rows: rows.length })
    flush()
    return rows
  }))
  try {
    flush()
    // No copied fixture, source rewriting, options changes, retry injection,
    // threshold relaxation, or replacement full-response parser.
    await import(pathToFileURL(project.fixture).href)
    const fixtureRoot = scope()
    const originalReport = join(fixtureRoot, "qualified-e41-report.json")
    assert(lstatSync(originalReport).isFile() && !lstatSync(originalReport).isSymbolicLink(), "Missing regular owned verdict")
    assert(lstatSync(originalReport).size <= LIMITS.reportBytes, "Fixture report bound exceeded")
    state.fixture = fixtureVerdict(JSON.parse(readFileSync(originalReport, "utf8")))
    assert(state.queries.length > 0, "No SDK query observed")
    assert.equal(state.fixture.result, "PASS", "Original qualified E41 fixture failed")
    assert.equal(state.fixture.joined, true, "Original fixture did not join children")
    assert(!state.stopped, "Native terminal error/refusal observed")
    assert.equal(sha(readFileSync(project.fixture)), project.fixtureSha256, "Fixture changed during run")
    assert.equal(sha(readFileSync(project.fidelity)), project.fidelitySha256, "Fidelity helper changed during run")
    state.result = "PASS"
  } catch (error) {
    state.result = "FAIL"
    state.errorSha256 = fingerprint({ name: error?.name, message: error?.message })
    process.exitCode = 1
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore()
    state.finishedAt = new Date().toISOString()
    flush()
  }
}

async function runOwnedChild(args, options) {
  const child = spawn(process.execPath, args, { cwd: options.cwd, detached: true,
    stdio: ["ignore", "pipe", "pipe"], env: options.env })
  const summary = { result: "RUNNING", deadlineMs: options.deadlineMs, stdoutBytes: 0, stderrBytes: 0,
    timedOut: false, exceededOutputBound: false, closed: false }
  const hashes = { stdout: createHash("sha256"), stderr: createHash("sha256") }
  let escalation, hardStop, terminateStarted = false, settle
  const closed = new Promise(resolve => { settle = resolve })
  const signalGroup = signal => {
    if (child.pid) { try { process.kill(-child.pid, signal) } catch (error) { if (error?.code !== "ESRCH") summary.groupSignalFailed = true } }
  }
  const terminate = reason => {
    if (terminateStarted) return
    terminateStarted = true
    summary[reason] = true
    signalGroup("SIGTERM")
    escalation = setTimeout(() => signalGroup("SIGKILL"), options.killGraceMs)
    // Even a stray inherited pipe cannot keep the evidence supervisor alive.
    hardStop = setTimeout(() => {
      signalGroup("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); child.unref()
      summary.hardJoinExpired = true; settle({ code: null, signal: null })
    }, options.killGraceMs + 1000)
  }
  for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) stream.on("data", chunk => {
    summary[`${name}Bytes`] += chunk.length
    hashes[name].update(chunk)
    if (summary.stdoutBytes + summary.stderrBytes > LIMITS.outputBytes) terminate("exceededOutputBound")
  })
  child.once("error", () => { summary.spawnError = true; settle({ code: null, signal: null }) })
  child.once("close", (code, signal) => { summary.closed = true; settle({ code, signal }) })
  const interrupt = () => terminate("interrupted")
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt)
  const deadline = setTimeout(() => terminate("timedOut"), options.deadlineMs)
  const exit = await closed
  // Only this newly created process group is signaled. Timeout/error cannot
  // claim original fixture or SDK process-gate closure.
  signalGroup("SIGKILL")
  clearTimeout(deadline); clearTimeout(escalation); clearTimeout(hardStop)
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt)
  Object.assign(summary, exit, { stdoutSha256: hashes.stdout.digest("hex"), stderrSha256: hashes.stderr.digest("hex") })
  summary.result = exit.code === 0 && summary.closed && !terminateStarted && !summary.groupSignalFailed ? "PASS" : "FAIL"
  return summary
}
async function supervisedRun() {
  assert.equal(process.env.E2E_ALLOW_LIVE_MODEL, "1", "Explicit live opt-in required")
  const project = rootProject()
  assert(process.env.E2E_LIVE_PROFILE_FILE, "Qualified fixture requires explicit access-only profile")
  assert(process.env.PROBE_MODEL, "Set explicit PROBE_MODEL; do not inherit qualified fixture's Sonnet default")
  assert(process.platform !== "win32", "POSIX process-group custody required by this evidence helper")
  const seconds = Number(process.env.E2E_INSTRUMENTED_TIMEOUT_SECONDS ?? LIMITS.defaultSeconds)
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= LIMITS.maxSeconds, "Timeout must be 30..1200 seconds")
  const reportPath = join(HERE, `instrumented-e41-${Date.now()}-${process.pid}.json`)
  const supervisorPath = reportPath.replace(/\.json$/, "-supervisor.json")
  const summary = await runOwnedChild([SELF, "--worker", ...(process.argv.includes("--stream") ? ["--stream"] : [])], {
    cwd: project.root, deadlineMs: seconds * 1000, killGraceMs: LIMITS.killGraceMs,
    env: { ...process.env, E2E_INSTRUMENTED_WORKER: "1", E2E_INSTRUMENTED_REPORT: reportPath } })
  summary.report = reportPath
  let report
  if (existsSync(reportPath)) {
    assert(lstatSync(reportPath).size <= LIMITS.reportBytes, "Worker report bound exceeded")
    report = JSON.parse(readFileSync(reportPath, "utf8"))
  }
  if (report?.result !== "PASS") summary.result = "FAIL"
  summary.normalFixtureCustody = summary.result === "PASS" && report?.fixture?.joined === true
  writeReport(supervisorPath, summary)
  process.stdout.write(JSON.stringify({ result: summary.result, report: reportPath, supervisor: supervisorPath }) + "\n")
  process.exitCode = summary.result === "PASS" ? 0 : 1
}

async function selfTest() {
  const project = rootProject(), state = makeState(), knownSessions = new Set()
  const secret = "OFFLINE-SENTINEL-DO-NOT-SERIALIZE-729ce923"
  const messages = [
    { type: "system", subtype: "init", session_id: "12345678-1234-1234-1234-123456789012" },
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_test", content: [], usage: { cache_read_input_tokens: 3132 } } } },
    { type: "system", subtype: "api_retry", attempt: 1, retry_delay_ms: 5, error_status: 529 },
    { type: "assistant", uuid: "12345678-1234-1234-1234-123456789013", message: { id: "msg_test", model: "offline-model",
      content: [{ type: "thinking", thinking: secret, signature: secret }, { type: "tool_use", id: "tool-owned", input: { value: secret } }],
      usage: { cache_read_input_tokens: 3132, cache_creation_input_tokens: 200 } } },
    { type: "result", is_error: false, usage: { cache_read_input_tokens: 3132 } },
  ]
  const calls = [], originalSteps = [], seen = []
  const original = {
    at: 0, closeCount: 0, interruptCount: 0,
    [Symbol.asyncIterator]() { return this },
    async next() { assert.equal(this, original); const step = this.at < messages.length ? { done: false, value: messages[this.at++] } : { done: true, value: undefined }; originalSteps.push(step); return step },
    async return(value) { assert.equal(this, original); calls.push("return"); return { done: true, value } },
    async throw(error) { assert.equal(this, original); calls.push("throw"); throw error },
    close() { assert.equal(this, original); this.closeCount++ },
    async interrupt() { assert.equal(this, original); this.interruptCount++ },
  }
  const wrapped = observeIterator(original, value => { seen.push(value); observeMessage(value, state, 1, knownSessions) })
  assert.equal(wrapped[Symbol.asyncIterator](), wrapped)
  for (let i = 0; i <= messages.length; i++) {
    const step = await wrapped.next()
    assert.equal(step, originalSteps[i], "Iterator result identity lost")
    if (!step.done) assert.equal(step.value, messages[i], "Message identity/order lost")
  }
  wrapped.close(); await wrapped.interrupt(); await wrapped.return("owned")
  const marker = new Error("offline-owned")
  await assert.rejects(wrapped.throw(marker), error => error === marker)
  assert.equal(original.closeCount, 1); assert.equal(original.interruptCount, 1)
  assert.deepEqual(calls, ["return", "throw"]); assert.deepEqual(seen, messages)
  assert.deepEqual(state.events.filter(e => ["message_start", "api_retry", "native-assistant", "result"].includes(e.kind)).map(e => e.kind),
    ["message_start", "api_retry", "native-assistant", "result"])
  assert.equal(state.events.find(e => e.kind === "native-assistant").usage.cache_creation_input_tokens, 200)
  const promptValues = [{ type: "user", message: { content: secret } }, { type: "user", message: { content: "owned" } }]
  async function* prompt() { yield* promptValues }
  const observedPrompt = []
  for await (const value of observePrompt(prompt(), state, 1)) observedPrompt.push(value)
  assert.equal(observedPrompt[0], promptValues[0]); assert.equal(observedPrompt[1], promptValues[1])
  state.optionsSha256 = fingerprint({ env: { TOKEN: secret }, apiKey: secret, model: "offline", nested: { secret }, callback() {} })
  assert.equal(fingerprint({ env: { TOKEN: "a" }, model: "offline" }), fingerprint({ env: { TOKEN: "b" }, model: "offline" }), "Env values must be excluded")
  let getterCalled = false
  fingerprint(Object.defineProperty({}, "accessor", { enumerable: true, get() { getterCalled = true; return secret } }))
  assert.equal(getterCalled, false)
  observeMessage({ type: "assistant", message: { stop_reason: "refusal", content: [{ type: "refusal", refusal: secret }] } }, state, 2, knownSessions)
  assert.equal(state.stopped, true)
  const capped = makeState(); capped.queries.push({ maxTurns: 1 })
  observeMessage(messages[3], capped, 1, knownSessions)
  observeMessage({ type: "result", subtype: "error_max_turns", is_error: true }, capped, 1, knownSessions)
  assert.equal(capped.stopped, false, "Expected one-turn tool handoff must remain fixture-adjudicated")
  assert.equal(capped.events.at(-1).toolBoundaryCandidate, true)
  const emptyCap = makeState(); emptyCap.queries.push({ maxTurns: 1 })
  observeMessage({ type: "result", subtype: "error_max_turns", is_error: true }, emptyCap, 1, knownSessions)
  assert.equal(emptyCap.stopped, true, "Unexplained cap without tool_use must stop")
  const bad = makeState(); bad.queries.push({ maxTurns: 1 })
  observeMessage(messages[3], bad, 1, knownSessions)
  observeMessage({ type: "result", subtype: "error_during_execution", is_error: true }, bad, 1, knownSessions)
  assert.equal(bad.stopped, true, "Real result errors must stop even after tool_use")
  assert(!JSON.stringify(state).includes(secret), "Secret serialized")
  const require = createRequire(join(project.root, "package.json"))
  const sdk = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href)
  let mockCalls = 0
  const spy = spyOn(sdk, "query").mockImplementation(() => { mockCalls++; return wrapped })
  try {
    const url = pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href
    const alias = await import(url)
    assert.equal(alias.query({ prompt: "offline" }), wrapped)
    assert.equal(mockCalls, 1)
  } finally { spy.mockRestore() }
  assert.equal(sha(readFileSync(project.fixture)), project.fixtureSha256)
  assert.equal(sha(readFileSync(project.fidelity)), project.fidelitySha256)
  assert.equal(ownedDirectory(join(project.root, "absent-owned-selftest", "config"), project.root, true), join(project.root, "absent-owned-selftest", "config"))
  assert.throws(() => ownedDirectory(dirname(project.root), project.root), /outside owned fixture/)
  const capture = await runOwnedChild(["-e", `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(secret)});`], {
    cwd: project.root, env: {}, deadlineMs: 5000, killGraceMs: 100 })
  assert.equal(capture.result, "PASS")
  assert.equal(capture.stdoutBytes, Buffer.byteLength(secret)); assert.equal(capture.stderrBytes, Buffer.byteLength(secret))
  assert.equal(capture.stdoutSha256, sha(secret)); assert(!JSON.stringify(capture).includes(secret))
  const timeout = await runOwnedChild(["-e", "setInterval(()=>{},1000)"], {
    cwd: project.root, env: {}, deadlineMs: 100, killGraceMs: 100 })
  assert.equal(timeout.result, "FAIL"); assert.equal(timeout.timedOut, true)
  const report = { result: "PASS", mode: "offline-controlled-iterator", modelCalls: 0, credentialReads: 0,
    supervisorCaptureSanitized: true, supervisorTimeoutFailedClosed: true, missingOwnedConfigAccepted: true,
    outOfScopeHistoryRejected: true, expectedOneTurnToolBoundaryRetained: true,
    capWithoutToolAndOtherResultErrorsStop: true,
    messagesIn: messages.length, messagesOut: seen.length, iteratorResultIdentity: true, messageIdentityAndOrder: true,
    queryCloseInterruptReturnThrowRetained: true, asyncPromptIdentityAndOrder: true, apiRetryOrdering: true,
    envValuesExcluded: true, gettersNotInvoked: true, sentinelNotSerialized: true,
    sdkSpyAliasInterceptedWithoutCallingOriginal: true, originalFixtureAndFidelityUnchanged: true,
    fixtureSha256: project.fixtureSha256, fidelitySha256: project.fidelitySha256, helperSha256: sha(readFileSync(SELF)),
    bun: Bun.version, platform: `${process.platform}/${process.arch}`, completedAt: new Date().toISOString() }
  writeReport(join(HERE, "instrumented-e41-self-test.json"), report)
  process.stdout.write(JSON.stringify(report) + "\n")
}

try {
  const args = process.argv.slice(2)
  assert(args.every(arg => ["--self-test", "--run", "--worker", "--stream"].includes(arg)), "Unknown argument")
  const modes = args.filter(arg => ["--self-test", "--run", "--worker"].includes(arg))
  assert.equal(modes.length, 1, "Choose exactly one: --self-test or --run")
  if (modes[0] === "--self-test") await selfTest()
  else if (modes[0] === "--worker") await worker()
  else await supervisedRun()
} catch (error) {
  // Suppress upstream/parser/error strings: paths, grants and model content are
  // not safe diagnostics. Preserve only a stable fingerprint and failed status.
  process.stdout.write(JSON.stringify({ result: "FAIL", diagnosticSha256: fingerprint({ name: error?.name, message: error?.message }) }) + "\n")
  process.exitCode = 1
}
