// Design-review candidate only. Parent must freeze and hash before execution.
// One source test only; never preload this into npm test or the hosted lock diagnostic.
import { afterAll, spyOn } from "bun:test"
import * as childProcess from "node:child_process"
import { openSync, writeSync, closeSync } from "node:fs"

const sourceRoot = "/Users/rynfar/Library/Caches/meridian-validation.noindex/1220-final-after-1505-20261104"
const fixture = `${sourceRoot}/src/__tests__/fixtures/agy-cli.cjs`
const output = "/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/run-1.events.jsonl"
const fd = openSync(output, "wx", 0o600)
const started = performance.now()
const children = []
const captures = []
let sequence = 0, captureErrors = 0, factoryMatches = 0, messageCalls = 0, responseCount = 0
let afterAllJoined = false, writeWarning = false
const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000
const errorMetadata = error => ({ name: typeof error?.name === "string" ? error.name : null, code: typeof error?.code === "string" ? error.code : null })
function log(event, fields = {}) {
  try { writeSync(fd, JSON.stringify({ sequence: ++sequence, elapsedMs: elapsed(), event, ...fields }) + "\n") }
  catch (error) {
    captureErrors++
    if (!writeWarning) { writeWarning = true; console.error("[agy-local-diagnostic] artifact write failed", errorMetadata(error)) }
  }
}
function observe(action) {
  try { action() }
  catch (error) { captureErrors++; log("observer-error", errorMetadata(error)) }
}
function argsMetadata(argv) {
  if (!Array.isArray(argv)) return { kind: "unknown", argc: null, flags: [] }
  if (argv.length === 1 && argv[0] === "--version") return { kind: "version", args: ["--version"] }
  if (argv.length === 1 && argv[0] === "models") return { kind: "models", args: ["models"] }
  if (argv.length === 4 && argv[0] === "-p" && argv[1] === "/config" && argv[2] === "--output-format" && argv[3] === "json") return { kind: "configuration", args: ["-p", "/config", "--output-format", "json"] }
  // Flag names only. Never retain model, prompt, workspace or arbitrary argv values.
  const allowed = new Set(["--new-project", "--conversation", "--add-dir", "--input-format", "--model", "--output-format", "--print-timeout", "--disable-slash-commands", "--sandbox", "--json-schema", "--effort", "--dangerously-skip-permissions"])
  return { kind: argv.includes("--input-format") ? "conversation" : "unknown", argc: argv.length, flags: argv.filter(value => allowed.has(value)) }
}
function snapshot(record) {
  for (const [name, stream] of Object.entries(record.streams)) record.pipes[name].closedProperty = stream.closed === true
  return { childId: record.id, pid: record.child?.pid ?? record.pid, metadata: record.metadata, spawnSeen: record.spawnSeen, exit: record.exit, close: record.close, error: record.error, joined: record.joined, pipes: record.pipes }
}
function maybeJoined(record) {
  const state = snapshot(record)
  const pipesClosed = Object.values(state.pipes).every(pipe => !pipe.present || pipe.closeSeen || pipe.closedProperty)
  if (!record.joined && record.close && (record.exit || record.error || !state.pid) && pipesClosed) {
    record.joined = true
    log("fixture-joined", snapshot(record))
    record.resolveJoin()
  }
}
function observeEmitter(object, record, pipeName) {
  // Intercept emitted events, not read()/data listeners. Do not start stream flow.
  const original = object.emit
  object.emit = new Proxy(original, {
    apply(target, receiver, args) {
      observe(() => {
        const [event, value, signal] = args
        if (pipeName) {
          const pipe = record.pipes[pipeName]
          if (event === "data" && pipeName !== "stdin") {
            const bytes = typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength
            pipe.dataEvents++
            if (typeof bytes === "number") pipe.observedBytes += bytes
            else pipe.uncountedDataEvents++
          }
          if (event === "close") pipe.closeSeen = true
          if (event === "end") pipe.endSeen = true
          if (event === "finish") pipe.finishSeen = true
          if (event === "error") pipe.error = errorMetadata(value)
        } else {
          if (event === "spawn") record.spawnSeen = true
          if (event === "error") record.error = errorMetadata(value)
          if (event === "exit") record.exit = { code: value, signal }
          if (event === "close") record.close = { code: value, signal }
        }
      })
      // Original receiver, argument objects and return value; original exceptions propagate.
      const returned = Reflect.apply(target, receiver, args)
      observe(() => {
        const event = args[0]
        if (["spawn", "error", "exit", "close", "end", "finish"].includes(event)) {
          log(pipeName ? "pipe-event" : "fixture-event", { observedEvent: event, pipe: pipeName ?? null, ...snapshot(record) })
          maybeJoined(record)
        }
      })
      return returned
    },
  })
}
const originalSpawn = childProcess.spawn
const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(new Proxy(originalSpawn, {
  apply(target, receiver, args) {
    if (args[0] !== fixture) return Reflect.apply(target, receiver, args)
    let resolveJoin
    const join = new Promise(resolve => { resolveJoin = resolve })
    const record = { id: children.length + 1, pid: null, child: null, metadata: argsMetadata(args[1]), spawnSeen: false, exit: null, close: null, error: null, joined: false, pipes: {}, streams: {}, join, resolveJoin }
    children.push(record)
    log("fixture-spawn-call", { childId: record.id, executable: fixture, metadata: record.metadata })
    let child
    try { child = Reflect.apply(target, receiver, args) }
    catch (error) {
      record.error = errorMetadata(error)
      record.joined = true // No child object was returned; no owned actor or pipes exist.
      record.resolveJoin()
      log("fixture-spawn-threw", snapshot(record))
      throw error
    }
    record.child = child
    record.pid = child.pid ?? null
    observe(() => {
      for (const name of ["stdin", "stdout", "stderr"]) {
        const stream = child[name]
        record.pipes[name] = { present: !!stream, closeSeen: false, closedProperty: stream?.closed === true, endSeen: false, finishSeen: false, observedBytes: name === "stdin" ? null : 0, dataEvents: 0, uncountedDataEvents: 0, error: null }
        if (stream) { record.streams[name] = stream; observeEmitter(stream, record, name) }
      }
      observeEmitter(child, record, null)
      log("fixture-spawn-return", snapshot(record))
    })
    return child
  },
}))
// This early import changes module initialization order. It does not replace the backend.
const backend = await import(`${sourceRoot}/src/proxy/backends/antigravity.ts`)
const originalFactory = backend.createAntigravityServer
const factorySpy = spyOn(backend, "createAntigravityServer").mockImplementation(new Proxy(originalFactory, {
  apply(target, receiver, args) {
    const server = Reflect.apply(target, receiver, args)
    if (args[1]?.executable !== fixture) return server
    const serverId = ++factoryMatches
    observe(() => {
      const originalFetch = server.app.fetch
      server.app.fetch = new Proxy(originalFetch, {
        apply(fetchTarget, fetchReceiver, fetchArgs) {
          const request = fetchArgs[0]
          const selected = request instanceof Request && request.method === "POST" && request.url === "http://local/v1/messages"
          const requestId = selected ? ++messageCalls : null
          const requestStarted = performance.now()
          const returned = Reflect.apply(fetchTarget, fetchReceiver, fetchArgs)
          if (selected) observe(() => {
            log("messages-call", { serverId, requestId })
            const captured = returned.then(response => {
              responseCount++
              log("messages-response", { serverId, requestId, status: response.status, durationMs: performance.now() - requestStarted, retryAfter: response.headers.get("retry-after") })
              if (response.status === 200) return
              // Clone only a failed fixture response. Never consume the original body.
              return response.clone().text().then(body => log("messages-failed-body", { serverId, requestId, status: response.status, body }))
            }, error => { log("messages-rejected", { serverId, requestId, ...errorMetadata(error) }) })
            captures.push(captured.catch(error => { captureErrors++; log("response-capture-error", { serverId, requestId, ...errorMetadata(error) }) }))
          })
          return returned // Same original Promise; its resolved Response is unchanged.
        },
      })
      log("factory-observed", { serverId })
    })
    return server // Same object, including untouched closeBackend.
  },
}))
log("preload-installed", { sourceHead: "ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a", actorPid: process.pid, actorExecutable: process.execPath, actorVersions: { bun: process.versions.bun ?? null, node: process.versions.node }, fixture, childEntryWitness: false })
afterAll(async () => {
  // No new test/probe/turn deadline. Parent's bounded outer command owns a stuck join.
  await Promise.all(children.map(record => record.join))
  await Promise.all(captures)
  afterAllJoined = children.every(record => record.joined)
  log("after-all-joined", { afterAllJoined, factoryMatches, messageCalls, responseCount, captureErrors, children: children.map(snapshot) })
  // Leave event observers installed until actor exit so late facts are not lost.
})
process.on("exit", code => {
  log("actor-exit", { code, afterAllJoined, factoryMatches, messageCalls, responseCount, captureErrors, children: children.map(snapshot) })
  closeSync(fd)
})
// Retain spy handles for the whole isolated actor; never restore while children may live.
void spawnSpy
void factorySpy
