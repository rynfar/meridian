/**
 * MERIDIAN_CONFIG_DIR relocates the whole config directory.
 *
 * Two properties are under test. The first is that with the variable unset
 * every path is byte-identical to what it has always been — a regression here
 * moves every existing install's configuration. The second is that with it set
 * to a fresh directory the instance is genuinely separate: its own profiles,
 * its own adapter instances, its own feature toggles, and no way to reach the
 * default directory's copies by accident.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { configDir, configPath, defaultConfigDir } from "../configDir"
import {
  loadProfilesFromDisk,
  profilesRelocationNotice,
  resolveProfile,
  resetActiveProfile,
} from "../proxy/profiles"
import { loadAdapterInstances } from "../proxy/adapterInstances"
import { getPricingOverrides, setPricingOverride } from "../telemetry/pricingStore"

const legacyDir = join(homedir(), ".config", "meridian")
const root = join(tmpdir(), `meridian-config-dir-${process.pid}`)

/**
 * A fresh pair of directories per test. loadProfilesFromDisk caches for 5s
 * keyed by the resolved path, so two tests sharing one path would have the
 * second served from the first's cache — green, or red, for the wrong reason.
 */
let dirA = ""
let dirB = ""
let testCase = 0

let savedConfigDir: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
  testCase++
  dirA = join(root, `a${testCase}`)
  dirB = join(root, `b${testCase}`)
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  resetActiveProfile()
})

afterEach(() => {
  if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
  else delete process.env.MERIDIAN_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

describe("configDir", () => {
  test("unset — resolves to the directory it always has", () => {
    delete process.env.MERIDIAN_CONFIG_DIR
    expect(configDir()).toBe(legacyDir)
    expect(configPath("profiles.json")).toBe(join(legacyDir, "profiles.json"))
    expect(configPath("settings.json")).toBe(join(legacyDir, "settings.json"))
    expect(configPath("profiles", "work")).toBe(join(legacyDir, "profiles", "work"))
    expect(configPath("adapter-instances.json")).toBe(join(legacyDir, "adapter-instances.json"))
    expect(configPath("sdk-features.json")).toBe(join(legacyDir, "sdk-features.json"))
    expect(configPath("model-pricing.json")).toBe(join(legacyDir, "model-pricing.json"))
    expect(configPath("telemetry.db")).toBe(join(legacyDir, "telemetry.db"))
  })

  test("empty string is treated as unset rather than as the filesystem root", () => {
    process.env.MERIDIAN_CONFIG_DIR = ""
    expect(configDir()).toBe(legacyDir)
  })

  test("set — every path moves under it", () => {
    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(configDir()).toBe(dirA)
    expect(configPath("profiles.json")).toBe(join(dirA, "profiles.json"))
    expect(configPath("profiles", "work")).toBe(join(dirA, "profiles", "work"))
  })

  test("resolved per call, so a change mid-process is seen", () => {
    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(configDir()).toBe(dirA)
    process.env.MERIDIAN_CONFIG_DIR = dirB
    expect(configDir()).toBe(dirB)
  })

  test("XDG_CONFIG_HOME is deliberately ignored", () => {
    delete process.env.MERIDIAN_CONFIG_DIR
    const savedXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dirA
    try {
      expect(configDir()).toBe(legacyDir)
      expect(defaultConfigDir()).toBe(legacyDir)
    } finally {
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
      else delete process.env.XDG_CONFIG_HOME
    }
  })
})

describe("profiles.json follows the config directory", () => {
  test("a fresh empty directory has no profiles", () => {
    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(loadProfilesFromDisk()).toEqual([])
  })

  test("profiles are read from the configured directory", () => {
    writeFileSync(join(dirA, "profiles.json"), JSON.stringify([{ id: "from-a" }]))
    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(loadProfilesFromDisk().map(p => p.id)).toEqual(["from-a"])
  })

  test("the 5s cache does not serve one directory's profiles to another", () => {
    // Without keying the cache by path, the second read lands inside the TTL
    // of the first and returns dirA's list — the isolation failure this
    // whole change exists to prevent, passing for the wrong reason.
    writeFileSync(join(dirA, "profiles.json"), JSON.stringify([{ id: "from-a" }]))
    writeFileSync(join(dirB, "profiles.json"), JSON.stringify([{ id: "from-b" }]))

    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(loadProfilesFromDisk().map(p => p.id)).toEqual(["from-a"])

    process.env.MERIDIAN_CONFIG_DIR = dirB
    expect(loadProfilesFromDisk().map(p => p.id)).toEqual(["from-b"])

    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(loadProfilesFromDisk().map(p => p.id)).toEqual(["from-a"])
  })

  test("an empty directory does not fall back to the previous one", () => {
    writeFileSync(join(dirA, "profiles.json"), JSON.stringify([{ id: "from-a" }]))
    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(loadProfilesFromDisk()).toHaveLength(1)

    process.env.MERIDIAN_CONFIG_DIR = dirB
    expect(loadProfilesFromDisk()).toEqual([])
  })
})

describe("oauth-token isolation dir follows the config directory", () => {
  const oauthProfile = [{ id: "ci", oauthToken: "sk-ant-oat01-test" }]

  test("unset — the path is unchanged", () => {
    delete process.env.MERIDIAN_CONFIG_DIR
    const resolved = resolveProfile(oauthProfile, undefined)
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(join(legacyDir, "profiles", "ci"))
  })

  test("set — the isolation dir moves with it", () => {
    process.env.MERIDIAN_CONFIG_DIR = dirA
    const resolved = resolveProfile(oauthProfile, undefined)
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(join(dirA, "profiles", "ci"))
  })
})

describe("adapter-instances.json follows the config directory", () => {
  const savedEnvInstances = process.env.MERIDIAN_ADAPTER_INSTANCES

  beforeEach(() => {
    delete process.env.MERIDIAN_ADAPTER_INSTANCES
  })

  afterEach(() => {
    if (savedEnvInstances !== undefined) process.env.MERIDIAN_ADAPTER_INSTANCES = savedEnvInstances
  })

  test("instances are read from the configured directory, per directory", () => {
    writeFileSync(join(dirA, "adapter-instances.json"), JSON.stringify({ "inst-a": { base: "opencode" } }))
    writeFileSync(join(dirB, "adapter-instances.json"), JSON.stringify({ "inst-b": { base: "opencode" } }))

    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(Object.keys(loadAdapterInstances())).toEqual(["inst-a"])

    process.env.MERIDIAN_CONFIG_DIR = dirB
    expect(Object.keys(loadAdapterInstances())).toEqual(["inst-b"])
  })

  test("a fresh empty directory has no instances", () => {
    process.env.MERIDIAN_CONFIG_DIR = dirA
    expect(loadAdapterInstances()).toEqual({})
  })
})

describe("model-pricing.json follows the config directory", () => {
  const rate = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 }
  let savedPricingConfig: string | undefined

  beforeEach(() => {
    savedPricingConfig = process.env.MERIDIAN_PRICING_CONFIG
    delete process.env.MERIDIAN_PRICING_CONFIG
  })

  afterEach(() => {
    if (savedPricingConfig !== undefined) process.env.MERIDIAN_PRICING_CONFIG = savedPricingConfig
  })

  test("writes land in the configured directory and are not visible from another", () => {
    process.env.MERIDIAN_CONFIG_DIR = dirA
    setPricingOverride("some-custom-model", rate)
    expect(existsSync(join(dirA, "model-pricing.json"))).toBe(true)
    expect(getPricingOverrides()["some-custom-model"]).toEqual(rate)

    process.env.MERIDIAN_CONFIG_DIR = dirB
    expect(existsSync(join(dirB, "model-pricing.json"))).toBe(false)
    expect(getPricingOverrides()).toEqual({})
  })
})

describe("profilesRelocationNotice", () => {
  const configured = join(root, "relocated", "profiles.json")
  const fallback = join(legacyDir, "profiles.json")

  test("silent when not relocated, whatever the default holds", () => {
    expect(profilesRelocationNotice(fallback, fallback, true)).toBeUndefined()
    expect(profilesRelocationNotice(fallback, fallback, false)).toBeUndefined()
  })

  test("silent when relocated and the default has nothing to leave behind", () => {
    expect(profilesRelocationNotice(configured, fallback, false)).toBeUndefined()
  })

  test("names both paths when relocated away from an existing profile list", () => {
    const notice = profilesRelocationNotice(configured, fallback, true)
    expect(notice).toContain(configured)
    expect(notice).toContain(fallback)
    expect(notice).toContain("MERIDIAN_CONFIG_DIR")
  })
})
