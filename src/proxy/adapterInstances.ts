/**
 * Adapter instances (#476, proposed by @Serpentiel).
 *
 * An instance is a named configuration of a base adapter:
 *
 *   {
 *     "oc-thinky":  { "base": "opencode",    "features": { "thinking": "enabled" } },
 *     "lite-plain": { "base": "passthrough", "passthrough": true,
 *                     "match": { "userAgentPrefix": "litellm/" } }
 *   }
 *
 * Selected explicitly via `x-meridian-agent: <instance-name>`, or
 * automatically via match rules (exact header values and/or a User-Agent
 * prefix). Instances resolve BEHAVIOR (transforms, plugin scoping, session
 * handling) by their base adapter's name and FEATURES by their own
 * definition — see detect.ts and server.ts for the resolution invariant.
 *
 * Config sources (first wins):
 *   1. MERIDIAN_ADAPTER_INSTANCES env var (JSON string)
 *   2. ~/.config/meridian/adapter-instances.json (5s TTL cache)
 *
 * With no instances configured, adapter detection is byte-identical to the
 * built-in chain. Built-in adapter names cannot be shadowed.
 *
 * This is a leaf module — no imports from server.ts, adapters, or session/.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { AdapterFeatures } from "./sdkFeatures"

const CONFIG_FILE = join(homedir(), ".config", "meridian", "adapter-instances.json")

export interface AdapterInstanceMatch {
  /** Exact header values — ALL listed headers must match (case-insensitive names). */
  header?: Record<string, string>
  /** User-Agent prefix match. */
  userAgentPrefix?: string
}

export interface AdapterInstanceDef {
  /** Base adapter name (opencode, passthrough, crush, ...). Behavior comes from here. */
  base: string
  /** Per-instance feature overrides, layered over the base's resolved features. */
  features?: Partial<AdapterFeatures>
  /** Per-instance passthrough override — beats the adapter transform's default. */
  passthrough?: boolean
  /** Automatic selection rules. Omit to select only via x-meridian-agent. */
  match?: AdapterInstanceMatch
}

export type AdapterInstanceMap = Record<string, AdapterInstanceDef>

/**
 * Parse and validate an instance map from raw JSON. Malformed input and
 * invalid entries are dropped (with a warning) rather than crashing —
 * a config typo must never take down adapter detection.
 */
export function parseAdapterInstances(raw: string | undefined): AdapterInstanceMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn("[meridian] adapter-instances config is not valid JSON — ignoring")
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

  const out: AdapterInstanceMap = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = value as Partial<AdapterInstanceDef> | null | undefined
    if (!v || typeof v !== "object" || typeof v.base !== "string" || v.base.length === 0) {
      console.warn(`[meridian] adapter instance "${name}" has no valid "base" — ignoring`)
      continue
    }
    if (v.features !== undefined && (typeof v.features !== "object" || v.features === null || Array.isArray(v.features))) {
      console.warn(`[meridian] adapter instance "${name}" has invalid "features" — ignoring`)
      continue
    }
    if (v.match !== undefined && (typeof v.match !== "object" || v.match === null || Array.isArray(v.match))) {
      console.warn(`[meridian] adapter instance "${name}" has invalid "match" — ignoring`)
      continue
    }
    out[name] = {
      base: v.base,
      ...(v.features ? { features: v.features } : {}),
      ...(typeof v.passthrough === "boolean" ? { passthrough: v.passthrough } : {}),
      ...(v.match ? { match: v.match } : {}),
    }
  }
  return out
}

/** Disk cache with short TTL (mirrors profiles.ts) so config edits apply without restart. */
const DISK_CACHE_TTL_MS = 5_000
let diskCache: AdapterInstanceMap = {}
let diskCacheAt = 0

/**
 * Load the configured instance map. Env var wins over the disk file.
 * Returns {} when nothing is configured — the common case, and the
 * guarantee that unconfigured setups keep byte-identical detection.
 */
export function loadAdapterInstances(): AdapterInstanceMap {
  const fromEnv = process.env.MERIDIAN_ADAPTER_INSTANCES
  if (fromEnv) return parseAdapterInstances(fromEnv)

  if (diskCacheAt > 0 && Date.now() - diskCacheAt < DISK_CACHE_TTL_MS) return diskCache
  try {
    diskCache = existsSync(CONFIG_FILE) ? parseAdapterInstances(readFileSync(CONFIG_FILE, "utf-8")) : {}
  } catch (err) {
    console.warn(`[meridian] Failed to read ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`)
    diskCache = {}
  }
  diskCacheAt = Date.now()
  return diskCache
}

/**
 * Does a request match an instance's rules? No rules = never auto-matched
 * (explicit x-meridian-agent selection only). When both header and UA rules
 * are present, both must match.
 */
export function matchesInstance(
  def: AdapterInstanceDef,
  getHeader: (name: string) => string | undefined
): boolean {
  const match = def.match
  if (!match) return false
  const hasHeaderRules = match.header !== undefined && Object.keys(match.header).length > 0
  const hasUaRule = typeof match.userAgentPrefix === "string" && match.userAgentPrefix.length > 0
  if (!hasHeaderRules && !hasUaRule) return false

  if (hasHeaderRules) {
    for (const [name, want] of Object.entries(match.header!)) {
      if (getHeader(name.toLowerCase()) !== want) return false
    }
  }
  if (hasUaRule) {
    const ua = getHeader("user-agent") ?? ""
    if (!ua.startsWith(match.userAgentPrefix!)) return false
  }
  return true
}
