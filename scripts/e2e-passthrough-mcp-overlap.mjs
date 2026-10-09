#!/usr/bin/env bun
/** Credential-free SDK/native-CLI transport probe. This is not OpenCode/model acceptance. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createReadStream } from "node:fs"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OwnedFixtureProcesses, within, withFixtureEnvironment, scanMcpFailureLogs, removeJoinedSandbox, closeFixtureQuery, consumeFixtureQuery, assertFixtureQueryOutcomes, freezeFixtureCatalog, assertCapturedFixtureCatalog } from "./lib-passthrough-mcp-fixture.mjs"

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const sourceRoot = resolve(argument("source-root") ?? fileURLToPath(new URL("../", import.meta.url)))
const evidenceDir = resolve(argument("evidence-dir") ?? join(sourceRoot, "docs/maintenance/evidence/1283-passthrough-mcp-overlap"))
const testCase = argument("case") ?? "overlap"
const sharedInstance = process.argv.includes("--shared-instance")
const stepMs = Number(argument("step-ms") ?? (testCase === "init-timeout" || testCase === "uncooperative" ? 1_000 : 90_000))
const validCases = ["overlap", "pre-request-failure", "init-timeout", "cancel", "uncooperative"]
assert.ok(validCases.includes(testCase), `unknown case: ${testCase}`)
assert.ok(Number.isFinite(stepMs) && stepMs > 0 && stepMs <= 90_000, "--step-ms must be 1..90000")
const requireSource = createRequire(join(sourceRoot, "package.json"))
const { query } = await import(pathToFileURL(requireSource.resolve("@anthropic-ai/claude-agent-sdk")).href)
const { buildQueryOptions } = await import(pathToFileURL(join(sourceRoot, "src/proxy/query.ts")).href)
const { createPassthroughMcpServer } = await import(pathToFileURL(join(sourceRoot, "src/proxy/passthroughTools.ts")).href)
const claudeExecutable = argument("claude-executable") ?? fileURLToPath(pathToFileURL(join(sourceRoot, "node_modules/@anthropic-ai/claude-code/bin/claude.exe")))
const processes = new OwnedFixtureProcesses()
const markers = { first: `first-${randomUUID()}`, second: `second-${randomUUID()}` }
const requests = []
const otherRequests = []
const states = []
const inheritedPath = process.env.PATH
const startedAt = new Date().toISOString()
const reportPath = join(evidenceDir, `${startedAt.replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`)
const report = {
  scope: ["pre-request-failure", "init-timeout", "uncooperative"].includes(testCase)
    ? "credential-free SDK cleanup control with a substitute fixture child; no model or OpenCode acceptance"
    : "credential-free real SDK/native CLI with loopback responder; no OpenCode, Meridian client plugin, or model acceptance",
  startedAt, case: testCase, sharedInstance, sourceRoot,
  sourceHead: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim(),
  platform: process.platform, architecture: process.arch, bun: Bun.version, nodeCompatibility: process.versions.node,
  sdk: JSON.parse(await readFile(join(dirname(requireSource.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")).version,
  cli: { executable: claudeExecutable, version: null, sha256: null },
  sourceFiles: {}, outcome: "failed", error: null, environmentRestored: false,
}
for (const relative of ["src/proxy/query.ts", "src/proxy/passthroughTools.ts"]) {
  report.sourceFiles[relative] = createHash("sha256").update(await readFile(join(sourceRoot, relative))).digest("hex")
}
for (const relative of ["./e2e-passthrough-mcp-overlap.mjs", "./lib-passthrough-mcp-fixture.mjs"]) {
  report.sourceFiles[`harness:${relative}`] = createHash("sha256").update(await readFile(new URL(relative, import.meta.url))).digest("hex")
}
const cliHash = createHash("sha256")
try { for await (const chunk of createReadStream(claudeExecutable)) cliHash.update(chunk); report.cli.sha256 = cliHash.digest("hex") }
catch (error) { report.cli.identityError = error.code ?? error.name }
const root = await mkdtemp(join(tmpdir(), "meridian-passthrough-mcp-overlap-"))
let server
let releaseFirst = () => {}
const firstReleased = new Promise(resolve => { releaseFirst = resolve })
let failure
let expectedCatalog

async function until(condition, what) {
  const deadline = Date.now() + stepMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

// The CLI has no credential/config/proxy inheritance; all upstream requests are loopback.
try {
  await withFixtureEnvironment({
    PATH: inheritedPath, HOME: root, XDG_CACHE_HOME: join(root, ".cache"), CLAUDE_CONFIG_DIR: join(root, "config-home"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
  }, async () => {
    try {
      await access(claudeExecutable)
      const versionChild = processes.spawnClaudeCodeProcess({ command: claudeExecutable, args: ["--version"], cwd: root, env: { ...process.env }, signal: new AbortController().signal })
      let versionOutput = ""
      versionChild.stdout.on("data", chunk => { if (versionOutput.length < 1_024) versionOutput += chunk.toString() })
      assert.equal((await within(processes.children.at(-1).done, 10_000)).completed, true, "native CLI version probe timed out")
      assert.equal(processes.children.at(-1).exitCode, 0, "native CLI version probe failed")
      report.cli.version = versionOutput.match(/\d+\.\d+\.\d+[^\n]*/)?.[0] ?? null
      assert.ok(report.cli.version, "native CLI version was unavailable")

      server = Bun.serve({
        hostname: "127.0.0.1", port: 0, idleTimeout: 255,
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (path !== "/v1/messages") { otherRequests.push({ method: request.method, path }); return Response.json({}) }
          const body = await request.json()
          const conversation = JSON.stringify(body.messages ?? [])
          const turn = Object.keys(markers).find(name => conversation.includes(markers[name])) ?? "untagged"
          requests.push({ turn, tools: body.tools ?? [] })
          if (turn === "first") await firstReleased
          const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
          if (!body.stream) return Response.json(message)
          const events = [
            { type: "message_start", message: { ...message, content: [], stop_reason: null } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ]
          return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
        },
      })

      // Cache definitions once; baseline's .server and candidate's factory are both supported.
      let passthroughMcp = createPassthroughMcpServer([{
        name: "bash", description: "Run a shell command",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      }])
      if (sharedInstance && passthroughMcp.createServer) {
        const shared = passthroughMcp.createServer()
        passthroughMcp = { ...passthroughMcp, createServer: () => shared }
      }
      function startQuery(turn) {
        const abortController = new AbortController()
        const state = { turn, init: null, result: null, error: null, closeError: null, intentionalCancellation: false, settled: false, sdkQuery: null, abortController, done: Promise.resolve() }
        states.push(state) // own cancellation before SDK query construction can throw
        const config = buildQueryOptions({
          prompt: `${markers[turn]}: answer with one word`, model: "claude-opus-5-5", workingDirectory: root, systemContext: "",
          claudeExecutable, passthrough: true, stream: true, sdkAgents: {}, passthroughMcp,
          hasDeferredTools: passthroughMcp.hasDeferredTools, isUndo: false,
          blockedTools: [], incompatibleTools: [], mcpServerName: "oc", allowedMcpTools: [],
          settingSources: [], codeSystemPrompt: false, memory: false, dreaming: false,
          cleanEnv: { PATH: process.env.PATH, HOME: root, XDG_CACHE_HOME: join(root, ".cache"), CLAUDE_CONFIG_DIR: join(root, "config-home"),
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: randomUUID(), ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
        }, abortController)
        config.options.spawnClaudeCodeProcess = options => {
          if (testCase === "pre-request-failure") return processes.spawnClaudeCodeProcess({ ...options, command: process.execPath, args: ["-e", "process.exit(42)"] })
          if (testCase === "init-timeout" || testCase === "uncooperative") {
            const program = `const fs=require('node:fs'); ${testCase === "uncooperative" ? "process.on('SIGTERM',()=>{});" : ""} process.stdin.resume(); setInterval(()=>fs.appendFileSync('cleanup-heartbeat','x'),20);`
            return processes.spawnClaudeCodeProcess({ ...options, command: process.execPath, args: ["-e", program] })
          }
          return processes.spawnClaudeCodeProcess(options)
        }
        state.sdkQuery = query(config)
        state.done = consumeFixtureQuery(state)
        return state
      }
      const first = startQuery("first")
      await until(() => first.settled || requests.some(request => request.turn === "first"), "the first query's model request")
      assert.equal(first.settled, false, "first query failed before a held model request")
      expectedCatalog = freezeFixtureCatalog(requests.find(request => request.turn === "first")?.tools, passthroughMcp.toolNames)
      if (testCase === "cancel") {
        assert.equal(first.init?.mcp_servers?.find(entry => entry.name === passthroughMcp.serverName)?.status, "connected", "cancel control MCP initialization failed")
        first.intentionalCancellation = true
        first.abortController.abort()
        await until(() => first.settled, "cancelled query iterator")
        report.cancellationObserved = true
      } else {
        const second = startQuery("second")
        await until(() => second.settled, "the second query")
        report.secondRanWhileFirstOpen = !first.settled
        releaseFirst()
        await until(() => first.settled, "the first query")
        assert.equal(report.secondRanWhileFirstOpen, true, "queries did not overlap")
        for (const state of states) {
          assert.equal(state.init?.mcp_servers?.find(entry => entry.name === passthroughMcp.serverName)?.status, "connected", `${state.turn} MCP initialization failed`)
        }
      }
      report.outcome = "passed"
    } catch (error) {
      failure = error
      // Keep only fixture assertion/control diagnostics, never native/provider exception text.
      report.error = error.name === "AssertionError" || error.message.startsWith("timed out waiting") ? error.message : error.name
    } finally {
      releaseFirst()
      processes.closing = true
      for (const state of states) {
        state.abortController.abort()
        closeFixtureQuery(state)
      }
      const childrenJoined = await processes.closeAndJoin()
      const iteratorsJoined = (await within(Promise.all(states.map(state => state.done)), 3_000)).completed
      let listenerClosed = !server
      if (server) {
        const port = server.port
        try {
          const stopped = await within(Promise.resolve(server.stop(true)), 3_000)
          if (stopped.completed) {
            try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }) }
            catch (error) { listenerClosed = ["ConnectionRefused", "ECONNREFUSED"].includes(error.code ?? error.cause?.code) }
          }
        } catch (error) { report.listenerCloseError = error.name }
      }
      report.captureSealed = childrenJoined && iteratorsJoined && listenerClosed
      report.finalCatalogValidation = "unavailable"
      // Revalidate only after all owned producers/listener have stopped.
      if (report.captureSealed && expectedCatalog) {
        try {
          assertCapturedFixtureCatalog(requests, expectedCatalog, testCase === "cancel" ? ["first"] : ["first", "second"])
          report.finalCatalogValidation = "passed"
        } catch (error) {
          report.finalCatalogValidation = "failed"
          report.outcome = "failed"
          report.error ??= error.name === "AssertionError" ? error.message : error.name
          failure ??= error
        }
      }
      // A successful result event can precede an iterator or close fault.
      if (report.captureSealed && report.outcome === "passed") {
        try { assertFixtureQueryOutcomes(states) }
        catch (error) {
          report.outcome = "failed"
          report.error = error.name === "AssertionError" ? error.message : error.name
          failure ??= error
        }
      }
      report.queryCloseError = states.find(state => state.closeError)?.closeError ?? null
      report.logs = await scanMcpFailureLogs(root)
      report.mcpLogFailureCheck = report.logs.status === "available" ? (report.logs.failures ? "failed" : "passed") : "unavailable"
      if (report.mcpLogFailureCheck === "unavailable") report.limitations = ["MCP log diagnostics unavailable or incomplete; zero CLI log failures is not established"]
      report.requests = requests.map(request => ({ turn: request.turn, toolNames: request.tools.map(tool => tool.name), toolDefinitionsSha256: createHash("sha256").update(JSON.stringify(request.tools)).digest("hex") }))
      report.untaggedModelRequests = requests.filter(request => request.turn === "untagged").length
      report.otherRequests = otherRequests
      report.queries = states.map(state => ({ turn: state.turn, mcpServers: state.init?.mcp_servers?.map(entry => ({ name: entry.name, status: entry.status })) ?? null, result: state.result, errorClass: state.error, closeErrorClass: state.closeError, intentionalCancellation: state.intentionalCancellation, settled: state.settled }))
      report.cleanup = { childrenJoined, iteratorsJoined, listenerClosed, children: processes.summary(), sandboxRemoved: false, retainedSandbox: null }
      try { report.cleanup.sandboxRemoved = await removeJoinedSandbox(root, report.cleanup) }
      catch (error) { report.sandboxRemoveError = error.name }
      if (!report.cleanup.sandboxRemoved) { report.cleanup.retainedSandbox = root; report.outcome = "failed"; report.error = "cleanup did not join all owned resources"; failure ??= new Error(report.error) }
      if (testCase === "overlap" && report.outcome === "passed" && report.logs.failures) {
        report.outcome = "failed"; report.error = "CLI logged an MCP connection failure"; failure ??= new Error(report.error)
      }
    }
  })
} catch (error) {
  failure ??= error
  report.outcome = "failed"
  report.error ??= error.name
} finally {
  report.environmentRestored = true
  report.completedAt = new Date().toISOString()
  report.elapsedMs = Date.now() - Date.parse(startedAt)
  report.exitCode = failure ? 1 : 0
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
  process.exitCode = report.exitCode
}
