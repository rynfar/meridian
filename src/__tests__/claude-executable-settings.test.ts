/**
 * Choosing the Claude Code executable at runtime, through the real settings
 * route and the real resolver: the turn after a change runs the newly chosen
 * binary, streaming or not, with no restart.
 *
 * The executables are shell scripts that answer `--version` and `auth status`
 * like Claude Code, and the "system" one is put first on PATH, so nothing here
 * runs a real Claude Code. Isolated by package.json, like
 * header-settings-routes.test.ts: other files mock ../proxy/models
 * process-wide, and this one needs the real resolver.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, blockStop, messageDelta, messageStart, messageStop, textBlockStart, textDelta, withMockSdkSessionId } from "./helpers"

const ranWith: Array<string | undefined> = []
installSdkMock(() => ({
  query: (input: { options?: { pathToClaudeCodeExecutable?: string } }) => (async function* () {
    ranWith.push(input.options?.pathToClaudeCodeExecutable)
    for (const event of [messageStart(), textBlockStart(0), textDelta(0, "ok"), blockStop(0), messageDelta(), messageStop(), assistantMessage([{ type: "text", text: "ok" }])]) {
      yield withMockSdkSessionId(event, input.options)
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "claude-executable-settings.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetCachedClaudePath, resetCachedClaudeAuthStatus, resolveClaudeExecutableSync } = await import("../proxy/models")
const { getSetting, setSetting } = await import("../settings")

type TestApp = { fetch: (request: Request) => Response | Promise<Response> }
interface Candidate { path: string | null; source: string | null; version: string | null; detail?: string }
interface State {
  mode: string
  modes: string[]
  customPath: string | null
  active: Candidate | null
  envOverride: Candidate | null
  candidates: { system: Candidate; bundled: Candidate; custom: Candidate }
}

describe("Claude Code executable setting", () => {
  let dir: string
  let bin: string
  let app: TestApp
  let proxy: ReturnType<typeof createProxyServer>
  let systemClaude: string
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_CLAUDE_PATH", "PATH"]

  /** An executable that answers `--version` and `auth status` like Claude Code. */
  function fakeClaude(path: string, version: string): string {
    writeFileSync(path, [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"))
    chmodSync(path, 0o755)
    return path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-claude-executable-"))
    bin = join(dir, "bin")
    mkdirSync(bin)
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    delete process.env.MERIDIAN_CLAUDE_PATH
    process.env.MERIDIAN_CONFIG_DIR = join(dir, "config")
    systemClaude = fakeClaude(join(bin, "claude"), "9.9.0")
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`
    resetCachedClaudePath()
    resetCachedClaudeAuthStatus()
    clearSessionCache()
    ranWith.length = 0
    proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    app = proxy.app
  })

  afterEach(async () => {
    await proxy.closeBackend?.()
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    resetCachedClaudePath()
    resetCachedClaudeAuthStatus()
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async (): Promise<State> =>
    await (await app.fetch(new Request("http://localhost/settings/api/claude-executable"))).json() as State

  const put = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    app.fetch(new Request("http://localhost/settings/api/claude-executable", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    }))

  /** Run one turn and return the executable the SDK was asked to run. */
  async function turn(stream: boolean): Promise<string | undefined> {
    const before = ranWith.length
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": crypto.randomUUID() },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 50, stream, messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(response.status).toBe(200)
    await response.text()
    expect(ranWith.length).toBeGreaterThan(before)
    return ranWith.at(-1)
  }

  it("defaults to system, and names what each choice would run, with versions", async () => {
    const state = await get()

    expect(state.mode).toBe("system")
    expect(state.modes).toEqual(["system", "bundled", "custom"])
    expect(state.customPath).toBeNull()
    expect(state.envOverride).toBeNull()
    expect(state.candidates.system).toEqual({ path: systemClaude, source: "path-lookup", version: "9.9.0" })
    expect(state.active).toEqual({ path: systemClaude, source: "path-lookup", version: "9.9.0" })
    // The packaged copy is reported from its package, without running it.
    const bundled = state.candidates.bundled
    if (bundled.path) expect(bundled.version).toMatch(/^\d+\.\d+\.\d+/)
    else expect(bundled.detail).toContain("not installed")
  })

  it("applies a change to the next turn, streaming or not, without a restart", async () => {
    const chosen = fakeClaude(join(dir, "claude-next"), "9.9.2")
    expect(await turn(false)).toBe(systemClaude)

    const custom = await put({ mode: "custom", path: chosen })
    expect(custom.status).toBe(200)
    const customState = await custom.json() as State
    expect(customState.mode).toBe("custom")
    expect(customState.active).toEqual({ path: chosen, source: "custom", version: "9.9.2" })
    expect(getSetting("claudeExecutable")).toBe("custom")
    expect(getSetting("claudeExecutablePath")).toBe(chosen)
    expect(await turn(false)).toBe(chosen)
    expect(await turn(true)).toBe(chosen)

    // Whatever the reply says the next turn runs is what it runs.
    const bundledState = await (await put({ mode: "bundled" })).json() as State
    expect(bundledState.mode).toBe("bundled")
    expect(bundledState.active?.path).toBeTruthy()
    expect(bundledState.active?.path).not.toBe(chosen)
    expect(await turn(true)).toBe(bundledState.active!.path!)

    const systemState = await (await put({ mode: "system" })).json() as State
    expect(systemState.active?.path).toBe(systemClaude)
    expect(await turn(false)).toBe(systemClaude)
    // The chosen path is kept, so choosing custom again needs no retyping.
    expect(systemState.customPath).toBe(chosen)
  })

  it("the profile CLI resolves the executable the server runs", async () => {
    const chosen = fakeClaude(join(dir, "claude-next"), "9.9.2")
    expect((await put({ mode: "custom", path: chosen })).status).toBe(200)

    expect(resolveClaudeExecutableSync()).toEqual({ path: chosen, source: "custom" })
  })

  it("refuses a path that cannot run Claude Code, and keeps the previous choice", async () => {
    const notClaude = join(dir, "not-claude")
    writeFileSync(notClaude, "#!/bin/sh\necho hello\n")
    chmodSync(notClaude, 0o755)

    for (const [body, error] of [
      [{ mode: "custom", path: notClaude }, "which is not a Claude Code version"],
      [{ mode: "custom", path: join(dir, "missing") }, "does not exist"],
      [{ mode: "custom", path: "relative/claude" }, "not an absolute path"],
      [{ mode: "custom" }, "custom needs the absolute path"],
      [{ mode: "newest" }, "mode must be one of"],
      [{ path: 42 }, "path must be a string"],
    ] as const) {
      const response = await put(body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain(error)
    }
    expect(getSetting("claudeExecutable")).toBeUndefined()
    expect(getSetting("claudeExecutablePath")).toBeUndefined()
    expect(await turn(false)).toBe(systemClaude)
  })

  it("a page on another origin cannot choose what runs", async () => {
    const chosen = fakeClaude(join(dir, "claude-next"), "9.9.2")

    const foreign = await put({ mode: "custom", path: chosen }, { Origin: "https://attacker.example" })
    expect(foreign.status).toBe(403)
    expect(getSetting("claudeExecutable")).toBeUndefined()

    const own = await put({ mode: "custom", path: chosen }, { Origin: "http://localhost" })
    expect(own.status).toBe(200)
  })

  it("MERIDIAN_CLAUDE_PATH outranks the setting, and the state says so", async () => {
    const fromEnv = fakeClaude(join(dir, "claude-env"), "9.9.3")
    const chosen = fakeClaude(join(dir, "claude-next"), "9.9.2")
    process.env.MERIDIAN_CLAUDE_PATH = fromEnv

    const state = await (await put({ mode: "custom", path: chosen })).json() as State
    expect(state.mode).toBe("custom")
    expect(state.envOverride).toEqual({ path: fromEnv, source: "env", version: "9.9.3" })
    expect(state.active).toEqual({ path: fromEnv, source: "env", version: "9.9.3" })
    expect(await turn(false)).toBe(fromEnv)
  })

  it("a chosen executable that has gone falls back to the system order on the next turn", async () => {
    const chosen = fakeClaude(join(dir, "claude-next"), "9.9.2")
    expect((await put({ mode: "custom", path: chosen })).status).toBe(200)
    expect(await turn(false)).toBe(chosen)

    rmSync(chosen)

    expect(await turn(false)).toBe(systemClaude)
  })

  it("does not commit a mode-only custom write against a concurrently cleared path", async () => {
    const chosen = fakeClaude(join(dir, "claude-race"), "9.9.2")
    expect((await put({ mode: "custom", path: chosen })).status).toBe(200)
    const entered = join(dir, "probe-entered"), release = join(dir, "probe-release")
    writeFileSync(chosen, `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\necho '9.9.2 (Claude Code)'\n`)
    const first = put({ mode: "custom" })
    try {
      const deadline = Date.now() + 3000
      while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(10)
      expect(existsSync(entered)).toBe(true)
      const second = put({ mode: "system", path: null })
      // Let the second request reach its mutation while the first version
      // check is suspended. A serialized implementation may still be queued.
      await Bun.sleep(50)
      writeFileSync(release, "release")
      const responses = await Promise.all([first, second])
      expect(responses.every(response => [200, 409].includes(response.status))).toBe(true)
      expect(getSetting("claudeExecutable")).toBe("system")
      expect(getSetting("claudeExecutablePath")).toBeUndefined()
    } finally {
      writeFileSync(release, "release")
      await first
    }
  })

  function heldClaude() {
    const chosen = join(dir, "claude-held"), entered = join(dir, "held-entered"), release = join(dir, "held-release")
    writeFileSync(chosen, `#!/bin/sh\necho $$ >> '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\necho '9.9.2 (Claude Code)'\n`)
    chmodSync(chosen, 0o755)
    return { chosen, entered, release }
  }

  async function enteredProbe(path: string) {
    const deadline = Date.now() + 3000
    while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(path)).toBe(true)
  }

  async function boundedResponse(pending: Promise<Response>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("settings probe outlived shutdown/disconnect")), 3000)
      })])
    } finally { clearTimeout(timer) }
  }

  it("joins an active path check on instance shutdown and never saves its choice", async () => {
    const { chosen, entered, release } = heldClaude()
    const pending = Promise.resolve(put({ mode: "custom", path: chosen }))
    try {
      await enteredProbe(entered)
      await proxy.closeBackend?.()
      expect((await boundedResponse(pending)).status).toBe(503)
      expect(getSetting("claudeExecutable")).toBeUndefined()
      const pid = Number(readFileSync(entered, "utf8").trim())
      expect(() => process.kill(pid, 0)).toThrow()
      expect((await put({ mode: "bundled" })).status).toBe(503)
    } finally { writeFileSync(release, "release"); await pending }
  })

  it("cancels an abandoned path check without publishing the chosen binary", async () => {
    const { chosen, entered, release } = heldClaude(), controller = new AbortController()
    const pending = Promise.resolve(put({ mode: "custom", path: chosen }, {}, controller.signal))
    try {
      await enteredProbe(entered)
      controller.abort()
      expect((await boundedResponse(pending)).status).toBe(503)
      expect(getSetting("claudeExecutable")).toBeUndefined()
      const pid = Number(readFileSync(entered, "utf8").trim())
      expect(() => process.kill(pid, 0)).toThrow()
    } finally { writeFileSync(release, "release"); await pending }
  })

  it("shares simultaneous version checks and keeps the surviving caller's lease", async () => {
    const { chosen, entered, release } = heldClaude(), controller = new AbortController()
    const first = Promise.resolve(put({ mode: "custom", path: chosen }, {}, controller.signal))
    let second: Promise<Response> | undefined
    try {
      await enteredProbe(entered)
      second = Promise.resolve(put({ mode: "custom", path: chosen }))
      await Bun.sleep(50)
      controller.abort()
      expect(readFileSync(entered, "utf8").trim().split("\n")).toHaveLength(1)
      const pid = Number(readFileSync(entered, "utf8").trim())
      expect(() => process.kill(pid, 0)).not.toThrow()
      writeFileSync(release, "release")
      expect((await boundedResponse(first)).status).toBe(503)
      expect((await boundedResponse(second)).status).toBe(200)
      expect(readFileSync(entered, "utf8").trim().split("\n")).toHaveLength(1)
      expect(getSetting("claudeExecutablePath")).toBe(chosen)
    } finally { writeFileSync(release, "release"); await Promise.all([first, second]) }
  })

  it("reports one saved preference snapshot while another writer changes the mode", async () => {
    const { chosen, entered, release } = heldClaude()
    setSetting("claudeExecutable", "custom")
    setSetting("claudeExecutablePath", chosen)
    const pending = get()
    try {
      await enteredProbe(entered)
      setSetting("claudeExecutable", "bundled")
      writeFileSync(release, "release")
      const state = await pending
      expect(state.mode).toBe("custom")
      expect(state.customPath).toBe(chosen)
      expect(state.active).toMatchObject({ path: chosen, source: "custom" })
    } finally { writeFileSync(release, "release"); await pending }
  })
})
