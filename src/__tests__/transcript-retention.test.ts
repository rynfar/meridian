/**
 * Which transcript retention period an SDK child is handed.
 *
 * The contract worth pinning is whose choice wins. Meridian's own period comes
 * from the env var, then settings.json, then Claude Code's default of 30. A
 * config root that names its own `cleanupPeriodDays` keeps it: without
 * profiles that root is the user's ~/.claude, and overriding a longer period
 * they chose for interactive Claude Code would delete their transcripts. And
 * whenever the period cannot be known for sure, none is passed, because no
 * period means Claude Code deletes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setSetting } from "../settings"
import {
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  meridianTranscriptRetention,
  resolveTranscriptRetention,
} from "../proxy/transcriptRetention"

const ENV_KEYS = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_TRANSCRIPT_RETENTION_DAYS", "CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS"]

describe("transcript retention", () => {
  let dir: string
  let configRoot: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-transcript-retention-"))
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = join(dir, "meridian")
    mkdirSync(process.env.MERIDIAN_CONFIG_DIR, { recursive: true })
    configRoot = join(dir, "claude-config")
    mkdirSync(configRoot, { recursive: true })
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const writeRootSettings = (text: string) => writeFileSync(join(configRoot, "settings.json"), text)

  describe("Meridian's own period", () => {
    it("defaults to Claude Code's own default of 30 days", () => {
      expect(DEFAULT_TRANSCRIPT_RETENTION_DAYS).toBe(30)
      expect(meridianTranscriptRetention()).toEqual({ days: 30, source: "default" })
    })

    it("takes the saved setting", () => {
      setSetting("transcriptRetentionDays", 7)
      expect(meridianTranscriptRetention()).toEqual({ days: 7, source: "settings" })
    })

    it("lets the env var win over the saved setting, under either prefix", () => {
      setSetting("transcriptRetentionDays", 7)
      process.env.CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS = "21"
      expect(meridianTranscriptRetention()).toEqual({ days: 21, source: "env" })
      process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "14"
      expect(meridianTranscriptRetention()).toEqual({ days: 14, source: "env" })
    })

    it("treats 0 as off whichever way it is set", () => {
      setSetting("transcriptRetentionDays", 0)
      expect(meridianTranscriptRetention()).toEqual({ days: 0, source: "settings" })
      process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "0"
      expect(meridianTranscriptRetention()).toEqual({ days: 0, source: "env" })
    })

    it("ignores an env value it cannot use rather than guessing", () => {
      setSetting("transcriptRetentionDays", 7)
      for (const bad of ["forever", "-1", "2.5", "3651", "30days", " "]) {
        process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = bad
        expect(meridianTranscriptRetention()).toEqual({ days: 7, source: "settings" })
      }
    })

    it("ignores a hand-edited setting it cannot use", () => {
      writeFileSync(join(dir, "meridian", "settings.json"), JSON.stringify({ transcriptRetentionDays: "thirty" }))
      expect(meridianTranscriptRetention()).toEqual({ days: 30, source: "default" })
    })
  })

  describe("a config root's own settings.json", () => {
    it("uses Meridian's period when the root has no settings.json, or no such directory at all", () => {
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 30, source: "default" })
      expect(resolveTranscriptRetention(join(dir, "does-not-exist"))).toEqual({ days: 30, source: "default" })
    })

    it("uses Meridian's period when the root's settings.json names none", () => {
      setSetting("transcriptRetentionDays", 10)
      writeRootSettings(JSON.stringify({ autoMemoryEnabled: false }))
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 10, source: "settings" })
      writeRootSettings("   \n")
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 10, source: "settings" })
    })

    it("keeps the root's own cleanupPeriodDays over Meridian's, env included", () => {
      process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "14"
      writeRootSettings(JSON.stringify({ cleanupPeriodDays: 365 }))
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 365, source: "config-dir" })
    })

    it("reads a settings.json with comments and trailing commas", () => {
      writeRootSettings('{\n  // kept for a year\n  "cleanupPeriodDays": 45,\n}\n')
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 45, source: "config-dir" })
    })

    it("passes no period when the root names one Claude Code would reject", () => {
      for (const bad of [0, -5, 2.5, "30", null]) {
        writeRootSettings(JSON.stringify({ cleanupPeriodDays: bad }))
        expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 0, source: "config-dir-unusable" })
      }
    })

    it("passes no period when the root's settings.json cannot be parsed or read", () => {
      writeRootSettings('{ "cleanupPeriodDays": 9')
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 0, source: "config-dir-unusable" })
      writeRootSettings("[30]")
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 0, source: "config-dir-unusable" })
      rmSync(join(configRoot, "settings.json"))
      mkdirSync(join(configRoot, "settings.json"))
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 0, source: "config-dir-unusable" })
    })

    it("does not let a root's own period switch retention back on once Meridian's is off", () => {
      setSetting("transcriptRetentionDays", 0)
      writeRootSettings(JSON.stringify({ cleanupPeriodDays: 90 }))
      expect(resolveTranscriptRetention(configRoot)).toEqual({ days: 0, source: "settings" })
    })
  })
})
