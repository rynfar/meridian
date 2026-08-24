/**
 * Unit tests for settings.ts — persistent server settings.
 *
 * These exercise the real module. Previously the settings path was frozen at
 * import time from homedir(), so the suite could not redirect it and these
 * tests re-implemented JSON roundtripping instead — they passed regardless of
 * what settings.ts actually did. MERIDIAN_CONFIG_DIR makes the module testable.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadSettings, saveSettings, getSetting, setSetting } from "../settings"

describe("settings module", () => {
  const tempDir = join(tmpdir(), `meridian-settings-unit-${process.pid}`)
  const settingsFile = join(tempDir, "settings.json")
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(tempDir, { recursive: true })
    process.env.MERIDIAN_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("loadSettings returns empty object when no file exists", () => {
    expect(existsSync(settingsFile)).toBe(false)
    expect(loadSettings()).toEqual({})
  })

  test("saveSettings then loadSettings roundtrips", () => {
    saveSettings({ activeProfile: "work" })
    expect(loadSettings().activeProfile).toBe("work")
  })

  test("saveSettings merges rather than clobbering existing keys", () => {
    saveSettings({ activeProfile: "personal", routing: "sticky" })
    saveSettings({ activeProfile: "work" })
    const result = loadSettings()
    expect(result.activeProfile).toBe("work")
    expect(result.routing).toBe("sticky")
  })

  test("saveSettings preserves unknown keys written by other versions", () => {
    writeFileSync(settingsFile, JSON.stringify({ futureKey: "keep-me" }))
    saveSettings({ activeProfile: "work" })
    const raw = JSON.parse(readFileSync(settingsFile, "utf-8"))
    expect(raw.futureKey).toBe("keep-me")
    expect(raw.activeProfile).toBe("work")
  })

  test("corrupt JSON returns empty settings instead of throwing", () => {
    writeFileSync(settingsFile, "not json{{{")
    expect(() => loadSettings()).not.toThrow()
    expect(loadSettings()).toEqual({})
  })

  test("getSetting / setSetting operate on individual keys", () => {
    expect(getSetting("routing")).toBeUndefined()
    setSetting("routing", "priority")
    expect(getSetting("routing")).toBe("priority")
  })

  test("profileOrder array survives a roundtrip", () => {
    setSetting("profileOrder", ["work", "personal"])
    expect(getSetting("profileOrder")).toEqual(["work", "personal"])
  })

  test("settings file is written with owner-only permissions", () => {
    saveSettings({ activeProfile: "work" })
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600)
  })

  test("MERIDIAN_CONFIG_DIR redirects reads away from the real config", () => {
    // The isolation property the whole suite depends on: with the override
    // set, the module must not fall back to ~/.config/meridian/settings.json.
    const otherDir = join(tempDir, "elsewhere")
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, "settings.json"), JSON.stringify({ routing: "priority" }))

    saveSettings({ routing: "sticky" })
    expect(loadSettings().routing).toBe("sticky")

    process.env.MERIDIAN_CONFIG_DIR = otherDir
    expect(loadSettings().routing).toBe("priority")
  })
})
