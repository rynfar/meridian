/**
 * Unit tests for setup.ts — OpenCode plugin configuration.
 *
 * Uses a temp directory so tests never touch the real OpenCode config.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { checkPluginConfigured, findOpencodeConfigPath, runSetup } from "../proxy/setup"

const PLUGIN_PATH = "/usr/local/lib/node_modules/@rynfar/meridian/plugin/meridian.ts"

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "meridian-setup-test-"))
}

describe("findOpencodeConfigPath", () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    for (const k of ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "APPDATA"]) {
      if (origEnv[k] === undefined) delete process.env[k]
      else process.env[k] = origEnv[k]
    }
  })

  it("respects OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = "/custom/opencode"
    expect(findOpencodeConfigPath()).toBe("/custom/opencode/opencode.json")
  })

  it("respects XDG_CONFIG_HOME", () => {
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = "/xdg/config"
    expect(findOpencodeConfigPath()).toContain("opencode/opencode.json")
    expect(findOpencodeConfigPath()).toContain("/xdg/config")
  })

  it("falls back to ~/.config/opencode/opencode.json", () => {
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.XDG_CONFIG_HOME
    const path = findOpencodeConfigPath()
    expect(path).toContain("opencode")
    expect(path).toEndWith("opencode.json")
  })
})

describe("checkPluginConfigured", () => {
  let tmp: string

  beforeEach(() => { tmp = makeTmpDir() })
  afterEach(() => rmSync(tmp, { recursive: true }))

  it("returns false when config file does not exist", () => {
    expect(checkPluginConfigured(join(tmp, "opencode.json"))).toBe(false)
  })

  it("returns false when plugin array is empty", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ plugin: [] }))
    expect(checkPluginConfigured(path)).toBe(false)
  })

  it("returns false when plugin array has no meridian entry", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ plugin: ["opencode-antigravity-auth"] }))
    expect(checkPluginConfigured(path)).toBe(false)
  })

  it("returns true when meridian.ts path is present", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ plugin: [PLUGIN_PATH] }))
    expect(checkPluginConfigured(path)).toBe(true)
  })

  it("returns true when stale claude-max-headers path is present", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ plugin: ["/old/path/claude-max-headers.ts"] }))
    expect(checkPluginConfigured(path)).toBe(true)
  })

  it("returns false when config has no plugin field", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ providers: {} }))
    expect(checkPluginConfigured(path)).toBe(false)
  })

  it("returns false when config is invalid JSON", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, "not json")
    expect(checkPluginConfigured(path)).toBe(false)
  })
})

describe("runSetup", () => {
  let tmp: string

  beforeEach(() => { tmp = makeTmpDir() })
  afterEach(() => rmSync(tmp, { recursive: true }))

  it("creates config file when it does not exist", () => {
    const configPath = join(tmp, "sub", "opencode.json")
    const result = runSetup(PLUGIN_PATH, configPath)

    expect(result.created).toBe(true)
    expect(result.pluginPath).toBe(PLUGIN_PATH)
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(written.plugin).toContain(PLUGIN_PATH)
  })

  it("adds plugin to existing config without touching other fields", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, JSON.stringify({
      plugin: ["opencode-antigravity-auth"],
      providers: { anthropic: {} },
    }))

    runSetup(PLUGIN_PATH, configPath)

    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(written.plugin).toContain("opencode-antigravity-auth")
    expect(written.plugin).toContain(PLUGIN_PATH)
    expect(written.providers).toEqual({ anthropic: {} })
  })

  it("removes stale claude-max-headers entry", () => {
    const configPath = join(tmp, "opencode.json")
    const stalePath = "/old/repos/opencode-claude-max-proxy/src/plugin/claude-max-headers.ts"
    writeFileSync(configPath, JSON.stringify({ plugin: [stalePath] }))

    const result = runSetup(PLUGIN_PATH, configPath)

    expect(result.removedStale).toContain(stalePath)
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(written.plugin).not.toContain(stalePath)
    expect(written.plugin).toContain(PLUGIN_PATH)
  })

  it("removes stale meridian-agent-mode entry", () => {
    const configPath = join(tmp, "opencode.json")
    const stalePath = "/some/path/meridian-agent-mode.ts"
    writeFileSync(configPath, JSON.stringify({ plugin: ["opencode-antigravity-auth", stalePath] }))

    runSetup(PLUGIN_PATH, configPath)

    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(written.plugin).toContain("opencode-antigravity-auth")
    expect(written.plugin).not.toContain(stalePath)
    expect(written.plugin).toContain(PLUGIN_PATH)
  })

  it("reports alreadyConfigured when same path already present", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, JSON.stringify({ plugin: [PLUGIN_PATH] }))

    const result = runSetup(PLUGIN_PATH, configPath)

    expect(result.alreadyConfigured).toBe(true)
  })

  it("does not duplicate the plugin entry when run twice", () => {
    const configPath = join(tmp, "opencode.json")

    runSetup(PLUGIN_PATH, configPath)
    runSetup(PLUGIN_PATH, configPath)

    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    const count = written.plugin.filter((p: string) => p === PLUGIN_PATH).length
    expect(count).toBe(1)
  })

  it("handles invalid JSON in existing config gracefully", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, "not valid json")

    const result = runSetup(PLUGIN_PATH, configPath)

    expect(result.created).toBe(false)
    const written = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(written.plugin).toContain(PLUGIN_PATH)
  })
})
