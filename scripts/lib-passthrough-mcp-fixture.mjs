import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

/** Retain only an exception's class, never provider/native error text. */
function errorClass(error) { return error instanceof Error ? error.name : "UnknownThrownValue" }

/** A close fault is an outcome failure even when all owned resources join. */
export function closeFixtureQuery(state) {
  try { state.sdkQuery?.close() }
  catch (error) { state.closeError ??= errorClass(error) }
}

/** Consume through iterator termination; a result event alone is not success. */
export async function consumeFixtureQuery(state) {
  try {
    for await (const event of state.sdkQuery) {
      if (event.type === "system" && event.subtype === "init") state.init = event
      if (event.type === "result") state.result = event.subtype
    }
  } catch (error) { state.error = errorClass(error) }
  finally { closeFixtureQuery(state); state.settled = true }
}

/** Called after cleanup joins, so late iterator/close faults cannot escape. */
export function assertFixtureQueryOutcomes(states) {
  for (const state of states) {
    assert.equal(state.settled, true, `${state.turn} iterator did not settle`)
    assert.equal(state.closeError, null, `${state.turn} query close failed`)
    if (state.intentionalCancellation) {
      // Only the deliberately interrupted held query permits an iterator error.
      // It must have been aborted before a result, never after a success event.
      assert.equal(state.abortController.signal.aborted, true, `${state.turn} cancellation was not requested`)
      assert.equal(state.result, null, `${state.turn} cancellation received a result`)
    } else {
      assert.equal(state.result, "success", `${state.turn} failed`)
      assert.equal(state.error, null, `${state.turn} query iterator failed`)
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

/** Freeze the complete first native catalog before another query can start. */
export function freezeFixtureCatalog(definitions, toolNames) {
  assert.ok(Array.isArray(definitions), "first query sent no tool catalog")
  assert.deepEqual(definitions.map(tool => tool.name), toolNames, "catalog-mismatch: first request lost client tools")
  return deepFreeze(structuredClone({ definitions, toolNames }))
}

/** Validate the final capture after children, iterators and listener are joined. */
export function assertCapturedFixtureCatalog(requests, expected, requiredTurns) {
  for (const turn of requiredTurns) assert.ok(requests.some(request => request.turn === turn), `${turn} sent no tagged model requests`)
  for (const [index, request] of requests.entries()) {
    if (request.turn === "untagged") continue // Reported separately; never a tagged-catalog success witness.
    assert.ok(requiredTurns.includes(request.turn), `unexpected tagged model request: ${request.turn}`)
    assert.deepEqual(request.tools.map(tool => tool.name), expected.toolNames, `catalog-mismatch: ${request.turn} request ${index} lost client tools`)
    assert.deepEqual(request.tools, expected.definitions, `catalog-mismatch: ${request.turn} request ${index} changed tool definitions`)
  }
}

/** A bounded wait whose timer is cancelled after either outcome. */
export async function within(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([
      promise.then(value => ({ completed: true, value })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false }), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Track actual close, not ChildProcess.killed or SDK iterator completion. */
export class OwnedFixtureProcesses {
  constructor() { this.children = []; this.closing = false }

  /** @param {import("@anthropic-ai/claude-agent-sdk").SpawnOptions} options */
  spawnClaudeCodeProcess = (options) => {
    if (this.closing || options.signal.aborted) throw new Error("fixture process admission is closed")
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    const state = { child, closed: false, exitCode: null, signal: null, spawnError: null, stderrBytes: 0, signals: [] }
    // Register ownership before exposing the child to the SDK or cancellation.
    this.children.push(state)
    state.done = new Promise(resolve => {
      child.on("error", error => { state.spawnError = error.code ?? error.name })
      child.once("close", (code, signal) => {
        state.closed = true; state.exitCode = code; state.signal = signal
        options.signal.removeEventListener("abort", abort)
        resolve()
      })
    })
    child.stderr.on("data", chunk => { state.stderrBytes += chunk.length })
    const abort = () => this.signal(state, "SIGTERM")
    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) abort()
    return child
  }

  signal(state, signal) {
    if (state.closed) return
    state.signals.push(signal)
    try { state.child.kill(signal) }
    catch (error) { state.spawnError = error.code ?? error.name }
  }

  async closeAndJoin(termMs = 1_000, killMs = 3_000) {
    // Prevent a delayed SDK initialization from creating a child after the join.
    this.closing = true
    for (const state of this.children) this.signal(state, "SIGTERM")
    const joined = () => Promise.all(this.children.map(state => state.done))
    if (!(await within(joined(), termMs)).completed) {
      for (const state of this.children) this.signal(state, "SIGKILL")
      await within(joined(), killMs)
    }
    return this.children.every(state => state.closed)
  }

  summary() {
    return this.children.map(state => ({
      pid: state.child.pid ?? null, closed: state.closed,
      exitCode: state.exitCode, signal: state.signal, spawnError: state.spawnError,
      stderrBytes: state.stderrBytes, signals: state.signals,
    }))
  }
}

/** An outer finally restores the host environment even when cleanup throws. */
export async function withFixtureEnvironment(environment, run) {
  const inherited = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, environment)
    return await run()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, inherited)
  }
}

/** Never turn unavailable diagnostics into a verified zero. No raw log lines escape. */
export async function scanMcpFailureLogs(root) {
  const result = { status: "available", discovered: 0, read: 0, failures: 0, unreadable: 0, malformed: 0 }
  // The native CLI uses the host's cache convention. Search only owned cache
  // directories, never config/session files or the owner's real home.
  for (const cache of [join(root, ".cache"), join(root, "Library/Caches")]) {
    let files
    try { files = await readdir(cache, { recursive: true }) }
    catch (error) { if (error.code !== "ENOENT") result.unreadable++; continue }
    for (const file of files.filter(name => /mcp-logs-[^/\\]+[/\\][^/\\]+\.jsonl$/.test(name))) {
    result.discovered++
    let contents
    try { contents = await readFile(join(cache, file), "utf8"); result.read++ }
    catch { result.unreadable++; continue }
    for (const line of contents.split("\n").filter(Boolean)) {
      try {
        JSON.parse(line)
        if (line.includes("Failed to connect SDK MCP server")) result.failures++
      } catch { result.malformed++ }
    }
    }
  }
  if (!result.discovered) result.status = "unavailable"
  else if (result.unreadable || result.malformed) result.status = "incomplete"
  return result
}

/** The directory survives any unjoined child/iterator/listener. */
export async function removeJoinedSandbox(root, { childrenJoined, iteratorsJoined, listenerClosed }) {
  if (!childrenJoined || !iteratorsJoined || !listenerClosed) return false
  await rm(root, { recursive: true, force: true })
  return true
}
