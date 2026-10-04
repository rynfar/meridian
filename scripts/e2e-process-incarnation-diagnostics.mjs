/**
 * Credentialless headless diagnostic gate for #1229. The denied command is
 * injected at spawnSync; this is not proof that nono can run Meridian.
 * E2E_SOURCE_ROOT selects an unchanged source checkout for the before control.
 */
import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mock } from "bun:test"

const script = fileURLToPath(import.meta.url)
const sourceRoot = resolve(process.env.E2E_SOURCE_ROOT || join(dirname(script), ".."))
const scenario = process.argv[2]
const scenarios = ["eperm", "exit", "invalid-code", "malformed-output", "boot-denied"]
if (!scenario) {
  const results = []
  for (const name of scenarios) {
    const child = Bun.spawn([process.execPath, script, name], {
      env: { ...process.env, E2E_SOURCE_ROOT: sourceRoot },
      stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      results.push({ scenario: name, exit, ...(stdout.trim() ? { result: JSON.parse(stdout) } : {}) })
      if (exit !== 0) {
        console.log(JSON.stringify({ result: "FAIL", controls: results }, null, 2))
        // Only our assertion failure is forwarded, not raw system command output.
        console.error(stderr)
        process.exitCode = 1
        break
      }
    } finally {
      clearTimeout(timer)
    }
  }
  if (!process.exitCode) console.log(JSON.stringify({ result: "PASS", controls: results }, null, 2))
} else {
  assert(scenarios.includes(scenario), "Unknown diagnostic scenario")
  const root = mkdtempSync(join(tmpdir(), "meridian-incarnation-diagnostic-"))
  for (const key of Object.keys(process.env)) {
    if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
  }
  Object.assign(process.env, {
    MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
    MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_TELEMETRY_PERSIST: "0",
    MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE: "1",
  })
  // libsql chooses its native binary on import. Load the selected checkout's
  // dependency on the real host before emulating Darwin for this narrow gate.
  const sourceRequire = createRequire(join(sourceRoot, "src/telemetry/sqlite.ts"))
  await import(pathToFileURL(sourceRequire.resolve("libsql")).href)
  Object.defineProperty(process, "platform", { value: "darwin" })
  let allowProbe = false
  let probeSpawnCalls = 0
  mock.module("node:child_process", () => ({
    ...childProcess,
    spawnSync(command) {
      probeSpawnCalls++
      if (command === "/usr/sbin/ioreg") {
        if (scenario === "boot-denied" && !allowProbe) {
          return { error: Object.assign(new Error("synthetic-private-argument"), { code: "EPERM" }), status: null,
            stdout: "", stderr: "synthetic-private-stderr" }
        }
        return { status: 0, stdout: '"IOPlatformUUID" = "11111111-1111-4111-8111-111111111111"', stderr: "" }
      }
      if (command === "/usr/sbin/sysctl") {
        return { status: 0, stdout: "22222222-2222-4222-8222-222222222222", stderr: "" }
      }
      assert.equal(command, "/bin/ps", "Unexpected native command")
      if (allowProbe) return { status: 0, stdout: "Sun Oct 04 12:00:00 2026", stderr: "" }
      if (scenario === "exit") return { status: 1, stdout: "", stderr: "synthetic-private-stderr" }
      if (scenario === "malformed-output") return { status: 0, stdout: "malformed", stderr: "synthetic-private-stderr" }
      return { error: Object.assign(new Error("synthetic-private-argument"), {
        code: scenario === "invalid-code" ? "private code\nEPERM" : "EPERM",
      }), status: null, stdout: "", stderr: "synthetic-private-stderr" }
    },
  }))
  const load = relative => import(pathToFileURL(join(sourceRoot, relative)).href)
  let sdkCalls = 0
  const { setSdkMock } = await load("src/__tests__/sdkMock.ts")
  setSdkMock(() => ({ query: () => { sdkCalls++; throw new Error("Diagnostic gate must never call a model") },
    createSdkMcpServer: () => ({}), tool: () => ({}) }), "e2e-process-incarnation-diagnostics")
  const { setLoggerMock } = await load("src/__tests__/loggerMock.ts")
  setLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context, fn) => fn() }))
  const { CrossProcessTurnCoordinator } = await load("src/proxy/session/crossProcessTurnCoordinator.ts")
  const incarnation = await load("src/proxy/session/processIncarnation.ts")
  const { createProxyServer } = await load("src/proxy/server.ts")
  const { processSessionTurns } = await load("src/proxy/session/turnCoordinator.ts")
  const errors = []
  const coordinatorRoot = join(root, "locks")
  const coordinator = new CrossProcessTurnCoordinator(coordinatorRoot)
  const originalError = console.error
  let acquisitionError = ""
  try {
    try {
      const lease = await coordinator.acquire("diagnostic-control")
      await lease.release()
      assert.fail("Denied identity probe admitted a lock owner")
    } catch (error) {
      acquisitionError = error instanceof Error ? error.message : String(error)
    }
    assert.equal(readdirSync(coordinatorRoot).length, 0, "Denied capture published a lock")
    console.error = (...values) => errors.push(values.map(value => value instanceof Error ? value.message : String(value)).join(" "))
    const { app } = createProxyServer({ silent: true })
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-opencode-session": "diagnostic-control" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, stream: false,
        messages: [{ role: "user", content: "Synthetic diagnostic gate; never send upstream" }] }),
    }))
    console.error = originalError
    const diagnostic = errors.join(" ")
    const summary = { scenario, acquisitionRefused: acquisitionError.startsWith("cannot capture turn-lock owner process incarnation"),
      httpStatus: response.status, httpLogDiagnostic: diagnostic, acquisitionDiagnostic: acquisitionError,
      publishedLocks: readdirSync(coordinatorRoot).length, sdkCalls, probeSpawnCalls }
    console.log(JSON.stringify(summary))
    assert(summary.acquisitionRefused, "Admission did not fail at the identity gate")
    assert.equal(response.status, 500, "Denied probe changed HTTP admission behavior")
    assert.equal(await response.text(), "Internal Server Error", "Public error format changed")
    assert.equal(sdkCalls, 0, "Denied probe reached the SDK")
    assert(!/synthetic-private|private code/.test(diagnostic + acquisitionError), "Private probe fields leaked")
    const expected = scenario === "boot-denied" ? "/usr/sbin/ioreg process-identity probe failed (EPERM)"
      : scenario === "eperm" ? "/bin/ps process-identity probe failed (EPERM)"
      : scenario === "exit" ? "/bin/ps process-identity probe failed (exit 1)"
      : scenario === "invalid-code" ? "/bin/ps process-identity probe failed (no usable result)" : undefined
    if (expected) {
      assert(acquisitionError.includes(expected), "Admission diagnostic hides the failed probe and underlying error")
      assert(diagnostic.includes(expected), "HTTP diagnostic hides the failed probe and underlying error")
    } else {
      assert.equal(acquisitionError, "cannot capture turn-lock owner process incarnation", "Malformed successful output invented a command failure")
    }
    // The failed HTTP request must release the local turn fence too.
    const lease = await processSessionTurns.acquire("session:diagnostic-control", AbortSignal.timeout(1000))
    lease.release()
    allowProbe = true
    const collected = []
    const current = incarnation.captureProcessIncarnation(process.pid, text => collected.push(text))
    assert(current, "Available probe did not capture the original identity")
    assert.deepEqual(collected, [], "A successful capture reused a stale failure")
    const controlLease = await coordinator.acquire("diagnostic-control")
    await controlLease.release()
    assert.equal(readdirSync(coordinatorRoot).length, 0, "Positive control left its lock behind")
    assert.equal(incarnation.probeProcessIncarnation(current), "indeterminate", "Darwin recovery became less conservative")
    assert.equal(incarnation.probeProcessIncarnation({ ...current, bootId: "33333333-3333-4333-8333-333333333333" }), "dead",
      "Earlier-boot recovery changed")
  } finally {
    console.error = originalError
    rmSync(root, { recursive: true, force: true })
  }
}
