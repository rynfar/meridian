/**
 * SDK feature toggles — per-adapter configuration for Claude Code features.
 *
 * Persisted under MERIDIAN_CONFIG_DIR, defaulting to ~/.config/meridian.
 * Read at request time (no restart needed to pick up changes).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface AdapterFeatures {
  /** Use the Claude Code system prompt preset (tool instructions, safety rules) */
  codeSystemPrompt: boolean
  /** Include the client agent's system prompt (e.g. OpenCode/Crush instructions) */
  clientSystemPrompt: boolean
  /** Load CLAUDE.md instruction files (off, project, full) */
  claudeMd: "off" | "project" | "full"
  /** Enable auto-memory (read + write across sessions) */
  memory: boolean
  /** Enable background memory consolidation */
  dreaming: boolean
  /** Default thinking mode (adaptive, enabled, disabled) */
  thinking: "adaptive" | "enabled" | "disabled"
  /** Forward thinking blocks to the client */
  thinkingPassthrough: boolean
  /** Share memory directory with Claude Code (~/.claude instead of SDK default) */
  sharedMemory: boolean
  /**
   * Run the WebFetch domain safety check. Before each fetch the subprocess
   * sends the target hostname to api.anthropic.com to test it against a
   * blocklist. Turn off to keep hostnames local; WebFetch then fetches any
   * URL unchecked, so pair it with tool permissions if that matters.
   */
  webFetchPreflight: boolean
  /**
   * Load the MCP connectors attached to the account's claude.ai profile
   * (Drive, Gmail, Calendar, …). Off by default: the calling agent never
   * negotiated those tools, and they reach third parties through
   * mcp-proxy.anthropic.com. Ignored in passthrough mode, where the client
   * executes tools and cannot run one that exists only in the subprocess.
   */
  claudeAiConnectors: boolean
  /** Per-request cost cap in USD (0 = disabled) */
  maxBudgetUsd: number
  /** Fallback model when primary fails (empty = disabled) */
  fallbackModel: string
  /** Enable SDK debug logging to proxy stderr */
  sdkDebug: boolean
  /** Comma-separated extra directories Claude can access (beyond CWD) */
  additionalDirectories: string
}

export type FeatureConfig = Record<string, Partial<AdapterFeatures>>

const DEFAULT_FEATURES: AdapterFeatures = {
  // Default to ON for non-passthrough adapters. Historically the preset was
  // applied via a query.ts fallback when sdkFeatures was unset; now that
  // server.ts respects the value directly (issue #408), the default has to
  // be encoded here. ADAPTER_DEFAULTS overrides this for passthrough below.
  codeSystemPrompt: true,
  clientSystemPrompt: true,
  claudeMd: "off" as const,
  memory: false,
  dreaming: false,
  thinking: "disabled",
  thinkingPassthrough: false,
  sharedMemory: false,
  // Matches the subprocess default — opt out, don't opt in.
  webFetchPreflight: true,
  claudeAiConnectors: false,
  maxBudgetUsd: 0,
  fallbackModel: "",
  sdkDebug: false,
  additionalDirectories: "",
}

/**
 * Per-adapter default overrides. Most adapters use DEFAULT_FEATURES; only
 * adapters with adapter-specific defaults appear here.
 */
const ADAPTER_DEFAULTS: Record<string, Partial<AdapterFeatures>> = {
  // The `passthrough` adapter is the lightweight Anthropic-API-compatible
  // proxy mode. The Claude Code preset is ~28 KB of system prompt the
  // forwarded model doesn't need (and most pass-through clients don't want
  // to pay for). Default it OFF — preserves the #190 token-saving fix.
  // User can flip it on via the settings UI for explicit opt-in.
  passthrough: {
    codeSystemPrompt: false,
  },
  // The OpenAI-compatible endpoint (/v1/chat/completions) serves generic chat
  // clients (Open WebUI, LibreChat, curl) that bring their own system prompt.
  // Default the claude_code preset OFF so their prompt isn't overridden by the
  // ~28KB Claude Code persona (same rationale as passthrough). Users can flip
  // it on via the settings UI for explicit opt-in.
  openai: {
    codeSystemPrompt: false,
  },
  // Jcode supplies its own coding-agent instructions over the generic
  // OpenAI-compatible endpoint, so the Claude Code preset stays off.
  jcode: {
    codeSystemPrompt: false,
  },
  // Cherry Studio is a chat client that brings its own system prompt. Default
  // the ~28KB Claude Code preset OFF (same rationale as openai/passthrough) so
  // its prompt isn't overridden. WebSearch still works without the preset
  // (verified). Users can flip it on via the settings UI.
  cherry: {
    codeSystemPrompt: false,
  },
  // Prime Agent ships ~17-19KB of its own harness doctrine — RLM control
  // semantics, subagent delegation guidance, continual-harness state. Layering
  // Claude Code's ~28KB preset on top duplicates and contradicts it, so keep
  // the preset OFF (same rationale as codex/jcode/cherry). Users can flip it on
  // via the settings UI.
  //
  // Measured rather than assumed: 6 multi-round `ipython` loops per arm, driven
  // through Meridian with the real captured Prime Agent prompt and tool schema.
  // Both arms scored identically on what matters — every run called only
  // `ipython`, ran all three requested steps in order, and finished. The preset
  // bought nothing, so OFF keeps the behaviour and saves ~28KB per request.
  // (Both arms also re-ran the final cell in most samples; since it appears
  // equally with the preset on, it is a property of the task and model, not of
  // this setting.)
  prime: {
    codeSystemPrompt: false,
  },
  // Codex CLI endpoint (/v1/responses). Codex ships its own ~21KB harness
  // instructions; keep the Claude Code preset OFF so they aren't overridden
  // (same rationale as openai). Passthrough is forced in the adapter itself.
  codex: {
    codeSystemPrompt: false,
  },
}

function getConfigPath(): string {
  const dir = process.env.MERIDIAN_CONFIG_DIR || join(homedir(), ".config", "meridian")
  return join(dir, "sdk-features.json")
}

let cachedConfig: FeatureConfig | null = null
let lastReadTime = 0
let lastReadPath: string | undefined
const CACHE_TTL_MS = 5000

function readConfig(): FeatureConfig {
  const now = Date.now()
  const path = getConfigPath()
  if (cachedConfig && lastReadPath === path && now - lastReadTime < CACHE_TTL_MS) return cachedConfig
  try {
    if (existsSync(path)) {
      cachedConfig = JSON.parse(readFileSync(path, "utf-8")) as FeatureConfig
    } else {
      cachedConfig = {}
    }
  } catch {
    cachedConfig = {}
  }
  lastReadTime = now
  lastReadPath = path
  return cachedConfig
}

function writeConfig(config: FeatureConfig): void {
  const path = getConfigPath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(config, null, 2))
    renameSync(tmp, path)
    cachedConfig = config
    lastReadTime = Date.now()
    lastReadPath = path
  } catch (e) {
    console.error("[sdk-features] write failed:", (e as Error).message)
  }
}

/**
 * Get resolved features for an adapter.
 * Priority: user config > adapter defaults > global defaults
 */
export function getFeaturesForAdapter(adapterName: string): AdapterFeatures {
  const config = readConfig()
  const userOverrides = config[adapterName] ?? {}
  const adapterDefaults = ADAPTER_DEFAULTS[adapterName] ?? {}

  return {
    ...DEFAULT_FEATURES,
    ...adapterDefaults,
    ...userOverrides,
  }
}

/**
 * Returns the thinking value the user has *explicitly* configured for an
 * adapter, or undefined when none is set (i.e. it falls back to defaults).
 *
 * The merged result from getFeaturesForAdapter() can't tell an explicit
 * "disabled" choice apart from the default "disabled" (DEFAULT_FEATURES.thinking
 * is "disabled"). Those two cases must behave differently: an explicit
 * "disabled" is an authoritative "no thinking" instruction that overrides client
 * requests, whereas the default "disabled" is a no-op fallback so clients can
 * still request thinking per-request. See the thinking resolution in server.ts.
 */
export function getExplicitThinking(adapterName: string): AdapterFeatures["thinking"] | undefined {
  const explicit = readConfig()[adapterName]?.thinking
  return typeof explicit === "string" && VALID_THINKING_VALUES.has(explicit)
    ? (explicit as AdapterFeatures["thinking"])
    : undefined
}

/**
 * Get the full config for all adapters (for the settings UI).
 *
 * The adapter list comes from the adapter registry, not a copy kept here —
 * see listAdapterNames() for why. Required lazily: this module is imported by
 * request-path code that has no reason to pull in every adapter definition,
 * and the registry only matters when the settings UI asks for it.
 */
export function getAllFeatureConfigs(): Record<string, AdapterFeatures> {
  const { listAdapterNames } = require("./adapters/detect") as typeof import("./adapters/detect")
  const result: Record<string, AdapterFeatures> = {}
  for (const name of listAdapterNames()) {
    result[name] = getFeaturesForAdapter(name)
  }
  return result
}

const VALID_CLAUDE_MD_VALUES = new Set(["off", "project", "full"])
const VALID_THINKING_VALUES = new Set(["adaptive", "enabled", "disabled"])

/**
 * Validate and sanitise a partial feature update.
 * Returns only recognised keys with correct types; throws on invalid input.
 */
export function validateFeatureUpdate(raw: unknown): Partial<AdapterFeatures> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be a JSON object")
  }
  const input = raw as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_FEATURES)) continue
    const expected = typeof DEFAULT_FEATURES[key as keyof AdapterFeatures]
    if (key === "claudeMd") {
      if (typeof value !== "string" || !VALID_CLAUDE_MD_VALUES.has(value)) {
        throw new Error(`claudeMd must be one of: ${[...VALID_CLAUDE_MD_VALUES].join(", ")}`)
      }
      result[key] = value
    } else if (key === "thinking") {
      if (typeof value !== "string" || !VALID_THINKING_VALUES.has(value)) {
        throw new Error(`thinking must be one of: ${[...VALID_THINKING_VALUES].join(", ")}`)
      }
      result[key] = value
    } else if (expected === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
      result[key] = value
    } else if (expected === "number") {
      if (typeof value !== "number" || !isFinite(value)) throw new Error(`${key} must be a finite number`)
      result[key] = value
    } else if (expected === "string") {
      if (typeof value !== "string") throw new Error(`${key} must be a string`)
      result[key] = value
    }
  }
  return result as Partial<AdapterFeatures>
}

/**
 * Update features for a specific adapter.
 */
export function updateAdapterFeatures(adapterName: string, features: Partial<AdapterFeatures>): void {
  const config = readConfig()
  config[adapterName] = { ...(config[adapterName] ?? {}), ...features }
  writeConfig(config)
}

/**
 * Reset an adapter to its defaults (remove user overrides).
 */
export function resetAdapterFeatures(adapterName: string): void {
  const config = readConfig()
  delete config[adapterName]
  writeConfig(config)
}
