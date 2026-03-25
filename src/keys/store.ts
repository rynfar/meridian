/**
 * JSON-file-backed API key store.
 *
 * Keys are held in memory for fast auth checks and flushed to disk on mutation.
 * File path: CLAUDE_PROXY_KEYS_FILE or ~/.claude-proxy/keys.json
 */

import { env } from "../env"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID, randomBytes } from "node:crypto"
import type { ApiKey } from "./types"

function defaultKeysPath(): string {
  return resolve(homedir(), ".claude-proxy", "keys.json")
}

export class KeyStore {
  private keys: Map<string, ApiKey> = new Map()
  /** Index: api key string → key id (for O(1) auth lookups) */
  private keyIndex: Map<string, string> = new Map()
  private readonly filePath: string
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? env("KEYS_FILE") ?? defaultKeysPath()
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as any[]
        this.keys.clear()
        this.keyIndex.clear()
        for (const k of data) {
          // Skip entries that were hashed (no plaintext key) — they can't be validated
          if (!k.key && (k as any).keyHash) continue
          if (!k.key) continue
          this.keys.set(k.id, k as ApiKey)
          this.keyIndex.set(k.key, k.id)
        }
      }
    } catch {
      // Start fresh if file is corrupted
    }
  }

  /** Synchronous flush. */
  private flushSync(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify([...this.keys.values()], null, 2))
  }

  /** Debounced flush — batches rapid writes (e.g., recordUsage on every request). */
  private flush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushSync()
    }, 100)
  }

  /** Immediate flush — used for CRUD operations that need persistence now. */
  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushSync()
  }

  /** Validate a key string. Returns the ApiKey if valid and enabled, null otherwise. */
  validate(keyString: string): ApiKey | null {
    const id = this.keyIndex.get(keyString)
    if (!id) return null
    const key = this.keys.get(id)
    if (!key || !key.enabled) return null
    return key
  }

  /** Create a new API key. Returns the created key (including the secret). */
  create(name: string): ApiKey {
    const key: ApiKey = {
      id: randomUUID(),
      name,
      key: `sk-${randomBytes(24).toString("hex")}`,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    }
    this.keys.set(key.id, key)
    this.keyIndex.set(key.key, key.id)
    this.flushNow()
    return key
  }

  /** List all keys (secrets masked, with window usage). */
  list(windowMs: number = 0): Array<Omit<ApiKey, "usageLog"> & { used6h: number; usedWeekly: number; windowTokens: number; windowRequests: number }> {
    const SIX_HOURS = 6 * 60 * 60 * 1000
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000
    return [...this.keys.values()].map((k) => {
      const { usageLog, ...rest } = k
      // Compute windowed usage per key
      let windowTokens = 0, windowRequests = 0
      if (windowMs > 0 && usageLog) {
        const cutoff = Date.now() - windowMs
        for (const e of usageLog) {
          if (e.timestamp > cutoff) {
            windowTokens += e.tokens
            windowRequests += 1
          }
        }
      }
      // Compute windowed per-model breakdown
      let windowModelUsage: Record<string, { inputTokens: number; outputTokens: number; requestCount: number }> = {}
      if (windowMs > 0 && usageLog) {
        const cutoff = Date.now() - windowMs
        for (const e of usageLog) {
          if (e.timestamp > cutoff) {
            const modelName = e.model || "unknown"
            const mu = windowModelUsage[modelName] ??= { inputTokens: 0, outputTokens: 0, requestCount: 0 }
            mu.inputTokens += e.inputTokens || e.tokens || 0
            mu.outputTokens += e.outputTokens || 0
            mu.requestCount += 1
          }
        }
      }

      return {
        ...rest,
        key: k.key.slice(0, 7) + "..." + k.key.slice(-4),
        modelUsage: windowMs > 0 ? windowModelUsage : (k.modelUsage || {}),
        limits: k.limits || { limit6h: 0, limitWeekly: 0 },
        used6h: this.getUsageInWindow(k.key, SIX_HOURS),
        usedWeekly: this.getUsageInWindow(k.key, ONE_WEEK),
        windowTokens: windowMs > 0 ? windowTokens : (k.inputTokens + k.outputTokens),
        windowRequests: windowMs > 0 ? windowRequests : k.requestCount,
      }
    })
  }

  /** Get a single key by ID (secret masked). */
  get(id: string): (Omit<ApiKey, "usageLog"> & { used6h: number; usedWeekly: number }) | null {
    const k = this.keys.get(id)
    if (!k) return null
    const SIX_HOURS = 6 * 60 * 60 * 1000
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000
    const { usageLog, ...rest } = k
    return {
      ...rest,
      key: k.key.slice(0, 7) + "..." + k.key.slice(-4),
      used6h: this.getUsageInWindow(k.key, SIX_HOURS),
      usedWeekly: this.getUsageInWindow(k.key, ONE_WEEK),
    }
  }

  /** Get the full unmasked key by ID. Only for admin reveal. */
  reveal(id: string): string | null {
    const k = this.keys.get(id)
    return k?.key ?? null
  }

  /** Delete a key by ID. */
  delete(id: string): boolean {
    const key = this.keys.get(id)
    if (!key) return false
    this.keyIndex.delete(key.key)
    this.keys.delete(id)
    this.flushNow()
    return true
  }

  /** Toggle enabled/disabled. */
  setEnabled(id: string, enabled: boolean): boolean {
    const key = this.keys.get(id)
    if (!key) return false
    key.enabled = enabled
    this.flushNow()
    return true
  }

  /** Record usage for a key (called after each request). */
  recordUsage(keyString: string, inputTokens: number, outputTokens: number, model?: string): void {
    const id = this.keyIndex.get(keyString)
    if (!id) return
    const key = this.keys.get(id)
    if (!key) return
    key.inputTokens += inputTokens
    key.outputTokens += outputTokens
    key.requestCount += 1
    key.lastUsedAt = new Date().toISOString()
    if (model) {
      if (!key.modelUsage) key.modelUsage = {}
      const mu = key.modelUsage[model] ??= { inputTokens: 0, outputTokens: 0, requestCount: 0 }
      mu.inputTokens += inputTokens
      mu.outputTokens += outputTokens
      mu.requestCount += 1
    }
    // Rolling usage log for rate limit enforcement
    const totalTokens = inputTokens + outputTokens
    if (totalTokens > 0) {
      if (!key.usageLog) key.usageLog = []
      key.usageLog.push({ timestamp: Date.now(), tokens: totalTokens, inputTokens, outputTokens, model })
      // Prune entries older than 31 days
      const monthAgo = Date.now() - 31 * 24 * 60 * 60 * 1000
      key.usageLog = key.usageLog.filter(e => e.timestamp > monthAgo)
    }
    this.flush() // debounced — doesn't block on every request
  }

  /** Get token usage within a time window for a key. */
  getUsageInWindow(keyString: string, windowMs: number): number {
    const id = this.keyIndex.get(keyString)
    if (!id) return 0
    const key = this.keys.get(id)
    if (!key?.usageLog) return 0
    const cutoff = Date.now() - windowMs
    return key.usageLog
      .filter(e => e.timestamp > cutoff)
      .reduce((sum, e) => sum + e.tokens, 0)
  }

  /** Check if a key has exceeded its per-key or global limits. Returns null if OK, or an error message. */
  checkLimits(keyString: string, globalLimits?: { limit6h: number; limitWeekly: number }): string | null {
    const id = this.keyIndex.get(keyString)
    if (!id) return null
    const key = this.keys.get(id)

    const SIX_HOURS = 6 * 60 * 60 * 1000
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000

    // Per-key limits
    if (key?.limits) {
      if (key.limits.limit6h > 0) {
        const used = this.getUsageInWindow(keyString, SIX_HOURS)
        if (used >= key.limits.limit6h) {
          return `6-hour token limit exceeded (${used}/${key.limits.limit6h})`
        }
      }
      if (key.limits.limitWeekly > 0) {
        const used = this.getUsageInWindow(keyString, ONE_WEEK)
        if (used >= key.limits.limitWeekly) {
          return `Weekly token limit exceeded (${used}/${key.limits.limitWeekly})`
        }
      }
    }

    // Global limits — sum across all keys
    if (globalLimits) {
      if (globalLimits.limit6h > 0) {
        const globalUsed = this.getAggregateStats(SIX_HOURS)
        const total = globalUsed.inputTokens + globalUsed.outputTokens
        if (total >= globalLimits.limit6h) {
          return `Global 6-hour token limit exceeded (${total}/${globalLimits.limit6h})`
        }
      }
      if (globalLimits.limitWeekly > 0) {
        const globalUsed = this.getAggregateStats(ONE_WEEK)
        const total = globalUsed.inputTokens + globalUsed.outputTokens
        if (total >= globalLimits.limitWeekly) {
          return `Global weekly token limit exceeded (${total}/${globalLimits.limitWeekly})`
        }
      }
    }

    return null
  }

  /** Update limits for a key. */
  setLimits(id: string, limits: { limit6h?: number; limitWeekly?: number }): boolean {
    const key = this.keys.get(id)
    if (!key) return false
    if (!key.limits) key.limits = { limit6h: 0, limitWeekly: 0 }
    if (limits.limit6h != null) key.limits.limit6h = Math.max(0, Math.floor(limits.limit6h))
    if (limits.limitWeekly != null) key.limits.limitWeekly = Math.max(0, Math.floor(limits.limitWeekly))
    this.flushNow()
    return true
  }

  /** Aggregate stats across all keys for a given time window (0 = all time). */
  getAggregateStats(windowMs: number): { requests: number; inputTokens: number; outputTokens: number } {
    if (windowMs === 0) {
      // All time — use cumulative totals
      let requests = 0, inputTokens = 0, outputTokens = 0
      for (const k of this.keys.values()) {
        requests += k.requestCount
        inputTokens += k.inputTokens
        outputTokens += k.outputTokens
      }
      return { requests, inputTokens, outputTokens }
    }
    // Windowed — sum from usageLogs
    const cutoff = Date.now() - windowMs
    let inputTokens = 0, outputTokens = 0, requests = 0
    for (const k of this.keys.values()) {
      if (!k.usageLog) continue
      for (const e of k.usageLog) {
        if (e.timestamp > cutoff) {
          if (e.inputTokens != null) {
            inputTokens += e.inputTokens
            outputTokens += e.outputTokens || 0
          } else {
            // Legacy entries without split — attribute all to input
            inputTokens += e.tokens
          }
          requests += 1
        }
      }
    }
    return { requests, inputTokens, outputTokens }
  }

  /** Total number of keys. */
  get size(): number {
    return this.keys.size
  }

  /** Reload keys from disk (useful if file was edited externally). */
  reload(): void {
    this.load()
  }
}

/** Singleton instance used by the proxy. */
export const keyStore = new KeyStore()
