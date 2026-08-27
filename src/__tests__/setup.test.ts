/**
 * Unit tests for setup.ts — OpenCode plugin configuration.
 *
 * Uses a temp directory so tests never touch the real OpenCode config.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { pathToFileURL } from "url"
import { parse as parseJsonc } from "jsonc-parser"
import {
  checkPluginConfigured,
  classifyOpenCodeVersion,
  detectOpenCodeGeneration,
  DuplicateMeridianConfigError,
  findOpencodeConfigPath,
  findV2PluginPath,
  MissingV2PluginError,
  runSetup,
  SUPPORTED_OPENCODE_V2_VERSION,
  UnparseableConfigError,
} from "../proxy/setup"
import { SUPPORTED_OPENCODE_V2_VERSION as PLUGIN_V2_VERSION } from "../../plugin/meridian-v2"

const PLUGIN_PATH = "/usr/local/lib/node_modules/@rynfar/meridian/plugin/meridian.ts"
const V2_PLUGIN_PATH = "/usr/local/lib/node_modules/@rynfar/meridian/dist/meridian-v2.js"

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

  it("prefers an existing opencode.jsonc when opencode.json is absent", () => {
    const dir = makeTmpDir()
    process.env.OPENCODE_CONFIG_DIR = dir
    const jsoncPath = join(dir, "opencode.jsonc")
    writeFileSync(jsoncPath, "{}\n")

    expect(findOpencodeConfigPath()).toBe(jsoncPath)
    rmSync(dir, { recursive: true, force: true })
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

describe("OpenCode generation detection", () => {
  it("keeps setup and the bundled plugin pinned to the same V2 host", () => {
    expect(SUPPORTED_OPENCODE_V2_VERSION).toBe(PLUGIN_V2_VERSION)
  })

  it("classifies the stable V1 version format", () => {
    expect(classifyOpenCodeVersion("1.18.11\n")).toEqual({ generation: "v1", version: "1.18.11" })
  })

  it("classifies the pinned V2 beta format", () => {
    expect(classifyOpenCodeVersion("opencode2 v0.0.0-beta-18314\n")).toEqual({
      generation: "v2",
      version: "0.0.0-beta-18314",
    })
  })

  it("routes future stable major versions through the fail-closed V2 gate", () => {
    expect(classifyOpenCodeVersion("opencode v2.0.0\n")).toEqual({
      generation: "v2",
      version: "2.0.0",
    })
  })

  it("rejects output that is not only a version", () => {
    expect(classifyOpenCodeVersion("OpenCode 2 beta")).toBeUndefined()
  })

  it("uses the first executable that returns a valid version", () => {
    const detected = detectOpenCodeGeneration(["missing", "opencode2"], command =>
      command === "opencode2" ? "v0.0.0-beta-18314" : undefined)
    expect(detected).toEqual({
      generation: "v2",
      version: "0.0.0-beta-18314",
      command: "opencode2",
    })
  })

  it("falls back to V1 when no OpenCode executable is available", () => {
    expect(detectOpenCodeGeneration(["missing"], () => undefined)).toEqual({ generation: "v1" })
  })
})

describe("findV2PluginPath", () => {
  let tmp: string

  beforeEach(() => { tmp = makeTmpDir() })
  afterEach(() => rmSync(tmp, { recursive: true }))

  it("selects the bundle beside an installed CLI", () => {
    const dist = join(tmp, "dist")
    mkdirSync(dist)
    const cli = join(dist, "cli.js")
    const plugin = join(dist, "meridian-v2.js")
    writeFileSync(cli, "")
    writeFileSync(plugin, "")

    expect(findV2PluginPath(pathToFileURL(cli).href)).toBe(plugin)
  })

  it("selects TypeScript source in a development tree even when dist is stale", () => {
    const bin = join(tmp, "bin")
    const pluginDir = join(tmp, "plugin")
    const dist = join(tmp, "dist")
    mkdirSync(bin)
    mkdirSync(pluginDir)
    mkdirSync(dist)
    const cli = join(bin, "cli.ts")
    const sourcePlugin = join(pluginDir, "meridian-v2.ts")
    writeFileSync(cli, "")
    writeFileSync(sourcePlugin, "current source")
    writeFileSync(join(dist, "meridian-v2.js"), "stale build")

    expect(findV2PluginPath(pathToFileURL(cli).href)).toBe(sourcePlugin)
  })

  it("fails closed when an installed CLI is missing its V2 bundle", () => {
    const dist = join(tmp, "dist")
    mkdirSync(dist)
    const cli = join(dist, "cli.js")
    writeFileSync(cli, "")

    expect(() => findV2PluginPath(pathToFileURL(cli).href)).toThrow(MissingV2PluginError)
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

  it("can require the plugin for the selected OpenCode generation", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ plugin: [PLUGIN_PATH] }))

    expect(checkPluginConfigured(path, PLUGIN_PATH)).toBe(true)
    expect(checkPluginConfigured(path, V2_PLUGIN_PATH)).toBe(false)
  })

  it("recognizes the bundled V2 plugin in the canonical plural field", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({ plugins: [V2_PLUGIN_PATH] }))
    expect(checkPluginConfigured(path)).toBe(true)
    expect(checkPluginConfigured(path, V2_PLUGIN_PATH)).toBe(true)
  })

  it("recognizes object-form V2 plugin entries", () => {
    const path = join(tmp, "opencode.json")
    writeFileSync(path, JSON.stringify({
      plugins: [{ package: V2_PLUGIN_PATH, options: { enabled: true } }],
    }))
    expect(checkPluginConfigured(path)).toBe(true)
    expect(checkPluginConfigured(path, V2_PLUGIN_PATH)).toBe(true)
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

  it("replaces the V1 plugin with the V2 bundle and keeps unrelated plugins", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, JSON.stringify({ plugin: ["keep-me", PLUGIN_PATH] }))

    const result = runSetup(V2_PLUGIN_PATH, configPath, "v2")
    const written = JSON.parse(readFileSync(configPath, "utf-8"))

    expect(result.removedStale).toContain(PLUGIN_PATH)
    expect(written.plugin).toEqual(["keep-me"])
    expect(written.plugins).toEqual([V2_PLUGIN_PATH])
  })

  it("configures canonical V2 plugins in an existing JSONC document", () => {
    const configPath = join(tmp, "opencode.jsonc")
    writeFileSync(configPath, '{\n  // keep this comment\n  "theme": "dark",\n}\n')

    const result = runSetup(V2_PLUGIN_PATH, configPath, "v2")
    const text = readFileSync(configPath, "utf-8")
    const written = parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, unknown>

    expect(result.configPath).toBe(configPath)
    expect(written.plugins).toEqual([V2_PLUGIN_PATH])
    expect(text).toContain("// keep this comment")
  })

  it("fails closed when the sibling OpenCode document already defines Meridian", () => {
    const configPath = join(tmp, "opencode.json")
    const siblingPath = join(tmp, "opencode.jsonc")
    const original = '{"plugins":["keep-me"]}\n'
    const sibling = `{\n  // OpenCode loads this too\n  "plugins": ["${V2_PLUGIN_PATH}"]\n}\n`
    writeFileSync(configPath, original)
    writeFileSync(siblingPath, sibling)

    expect(() => runSetup(V2_PLUGIN_PATH, configPath, "v2")).toThrow(DuplicateMeridianConfigError)
    expect(readFileSync(configPath, "utf-8")).toBe(original)
    expect(readFileSync(siblingPath, "utf-8")).toBe(sibling)
  })

  it("deduplicates Meridian across singular and plural fields", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, JSON.stringify({
      plugin: [PLUGIN_PATH, "keep-singular"],
      plugins: [V2_PLUGIN_PATH, "keep-plural"],
    }))

    const result = runSetup(V2_PLUGIN_PATH, configPath, "v2")
    const written = JSON.parse(readFileSync(configPath, "utf-8"))

    expect(result.alreadyConfigured).toBe(false)
    expect(written.plugin).toEqual(["keep-singular"])
    expect(written.plugins).toEqual(["keep-plural", V2_PLUGIN_PATH])
  })

  it("removes object-form stale Meridian entries and preserves unrelated objects", () => {
    const configPath = join(tmp, "opencode.json")
    const unrelated = { package: "keep-object", options: { setting: true } }
    writeFileSync(configPath, JSON.stringify({
      plugins: [
        { package: PLUGIN_PATH, options: { stale: true } },
        unrelated,
      ],
    }))

    const result = runSetup(V2_PLUGIN_PATH, configPath, "v2")
    const written = JSON.parse(readFileSync(configPath, "utf-8"))

    expect(result.removedStale).toEqual([PLUGIN_PATH])
    expect(written.plugins).toEqual([unrelated, V2_PLUGIN_PATH])
  })

  it("preserves options on one exact canonical object entry", () => {
    const configPath = join(tmp, "opencode.json")
    const configured = { package: V2_PLUGIN_PATH, options: { future: "value" } }
    writeFileSync(configPath, JSON.stringify({ plugins: [configured] }))

    const result = runSetup(V2_PLUGIN_PATH, configPath, "v2")
    const written = JSON.parse(readFileSync(configPath, "utf-8"))

    expect(result.alreadyConfigured).toBe(true)
    expect(written.plugins).toEqual([configured])
  })

  it("switches back to V1 without leaving a duplicate V2 definition", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, JSON.stringify({
      plugin: ["keep-singular"],
      plugins: [V2_PLUGIN_PATH, "keep-plural"],
    }))

    runSetup(PLUGIN_PATH, configPath, "v1")
    const written = JSON.parse(readFileSync(configPath, "utf-8"))

    expect(written.plugin).toEqual(["keep-singular", PLUGIN_PATH])
    expect(written.plugins).toEqual(["keep-plural"])
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

  it("fails safe on an unparseable config — throws and never overwrites (#519)", () => {
    const configPath = join(tmp, "opencode.json")
    const original = '{ "plugin": [ "/keep/this.ts"   // truncated, missing close\n'
    writeFileSync(configPath, original)

    expect(() => runSetup(PLUGIN_PATH, configPath)).toThrow(UnparseableConfigError)
    // The user's file must be left exactly as it was — never clobbered.
    expect(readFileSync(configPath, "utf-8")).toBe(original)
  })

  it("merges into a JSONC config, preserving comments and other settings (#519)", () => {
    const configPath = join(tmp, "opencode.json")
    const original = [
      "{",
      '  // my personal opencode config',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "theme": "dark",',
      '  "plugin": [',
      '    "some-other-plugin", // keep me',
      "  ],",
      "}",
      "",
    ].join("\n")
    writeFileSync(configPath, original)

    const result = runSetup(PLUGIN_PATH, configPath)
    const text = readFileSync(configPath, "utf-8")

    expect(result.created).toBe(false)
    // Plugin merged, not replaced (parse tolerantly — output is still JSONC)
    const parsed = parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, any>
    expect(parsed.plugin).toContain(PLUGIN_PATH)
    expect(parsed.plugin).toContain("some-other-plugin")
    expect(parsed.theme).toBe("dark")
    expect(parsed.$schema).toBe("https://opencode.ai/config.json")
    // Comments preserved (non-destructive edit)
    expect(text).toContain("// my personal opencode config")
  })

  it("treats a comment-containing config as already-configured in checkPluginConfigured (#519)", () => {
    const configPath = join(tmp, "opencode.json")
    writeFileSync(configPath, `{\n  // jsonc\n  "plugin": ["${PLUGIN_PATH}"]\n}\n`)
    expect(checkPluginConfigured(configPath)).toBe(true)
  })
})
