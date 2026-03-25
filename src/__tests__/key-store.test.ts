import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { KeyStore } from "../keys/store"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("KeyStore", () => {
  let store: KeyStore
  let tmpDir: string
  let filePath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keystore-test-"))
    filePath = join(tmpDir, "keys.json")
    store = new KeyStore(filePath)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("CRUD", () => {
    it("creates a key and returns raw secret once", () => {
      const result = store.create("test-key")
      expect(result.name).toBe("test-key")
      expect(result.key).toMatch(/^sk-[a-f0-9]{48}$/)
      expect(result.id).toBeTruthy()
    })

    it("validates a created key", () => {
      const { key } = store.create("test-key")
      const validated = store.validate(key)
      expect(validated).not.toBeNull()
      expect(validated!.name).toBe("test-key")
    })

    it("rejects invalid keys", () => {
      expect(store.validate("sk-invalid")).toBeNull()
    })

    it("lists keys with masked secrets", () => {
      store.create("key-1")
      store.create("key-2")
      const list = store.list()
      expect(list).toHaveLength(2)
      expect(list[0]!.key).toMatch(/^sk-[a-f0-9]{4}\.\.\./)
      expect(list[0]!.key).not.toMatch(/^sk-[a-f0-9]{48}$/)
    })

    it("deletes a key", () => {
      const { id, key } = store.create("to-delete")
      expect(store.validate(key)).not.toBeNull()
      expect(store.delete(id)).toBe(true)
      expect(store.validate(key)).toBeNull()
    })

    it("toggles enabled/disabled", () => {
      const { id, key } = store.create("toggle-me")
      expect(store.validate(key)).not.toBeNull()
      store.setEnabled(id, false)
      expect(store.validate(key)).toBeNull()
      store.setEnabled(id, true)
      expect(store.validate(key)).not.toBeNull()
    })

    it("returns size", () => {
      expect(store.size).toBe(0)
      store.create("a")
      store.create("b")
      expect(store.size).toBe(2)
    })
  })

  describe("persistence", () => {
    it("persists keys to disk and reloads", () => {
      const created = store.create("persist-me")
      // create uses flushNow (sync), so file is written immediately
      const store2 = new KeyStore(filePath)
      expect(store2.validate(created.key)).not.toBeNull()
      expect(store2.size).toBe(1)
    })

    it("lists keys with masked secrets", () => {
      const created = store.create("masked")
      const list = store.list()
      expect(list[0]!.key).not.toBe(created.key)
      expect(list[0]!.key).toMatch(/^sk-.*\.\.\./)
    })

    it("reveals full key via reveal()", () => {
      const created = store.create("revealable")
      expect(store.reveal(created.id)).toBe(created.key)
    })
  })

  describe("rate limits", () => {
    it("sets and checks limits", () => {
      const { id, key } = store.create("limited")
      store.setLimits(id, { limit6h: 1000, limitWeekly: 5000 })

      // No usage yet — should pass
      expect(store.checkLimits(key)).toBeNull()

      // Record usage just under limit
      store.recordUsage(key, 400, 400)
      expect(store.checkLimits(key)).toBeNull()

      // Record usage to exceed 6h limit
      store.recordUsage(key, 100, 200)
      expect(store.checkLimits(key)).toMatch(/6-hour token limit exceeded/)
    })

    it("returns null when no limits set", () => {
      const { key } = store.create("unlimited")
      store.recordUsage(key, 999999, 999999)
      expect(store.checkLimits(key)).toBeNull()
    })

    it("enforces global limits", () => {
      const { key } = store.create("global-limited")
      store.recordUsage(key, 500, 500)
      // No global limit — should pass
      expect(store.checkLimits(key, { limit6h: 0, limitWeekly: 0 })).toBeNull()
      // Global limit exceeded
      expect(store.checkLimits(key, { limit6h: 500, limitWeekly: 0 })).toMatch(/Global 6-hour/)
      // Global limit not exceeded
      expect(store.checkLimits(key, { limit6h: 2000, limitWeekly: 0 })).toBeNull()
      // Weekly limit exceeded
      expect(store.checkLimits(key, { limit6h: 0, limitWeekly: 500 })).toMatch(/Global weekly/)
    })

    it("tracks per-model usage", () => {
      const { key } = store.create("model-tracked")
      store.recordUsage(key, 100, 50, "opus[1m]")
      store.recordUsage(key, 200, 100, "sonnet[1m]")
      const list = store.list()
      const entry = list[0]!
      expect(entry.modelUsage?.["opus[1m]"]?.inputTokens).toBe(100)
      expect(entry.modelUsage?.["sonnet[1m]"]?.inputTokens).toBe(200)
    })
  })

  describe("usage windows", () => {
    it("tracks rolling usage", () => {
      const { key } = store.create("windowed")
      store.recordUsage(key, 100, 100)
      const SIX_HOURS = 6 * 60 * 60 * 1000
      expect(store.getUsageInWindow(key, SIX_HOURS)).toBe(200)
    })
  })
})
