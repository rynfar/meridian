/**
 * Meridian setup — OpenCode plugin configuration.
 *
 * Manages the meridian plugin entry in ~/.config/opencode/opencode.json
 * (or the platform-equivalent path). Called by:
 *   - `meridian setup`  — writes the plugin entry
 *   - `meridian` startup — warns if plugin is missing
 *   - `GET /health`     — reports plugin status
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir, platform } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"

/**
 * Thrown when an existing OpenCode config can't be parsed (even tolerantly).
 * Setup refuses to overwrite it — losing a user's config is worse than not
 * configuring the plugin (#519).
 */
export class UnparseableConfigError extends Error {
  constructor(public readonly configPath: string) {
    super(`Could not parse ${configPath} — it may contain a syntax error.`)
    this.name = "UnparseableConfigError"
  }
}

/**
 * Parse OpenCode config text tolerantly (JSONC: comments + trailing commas are
 * valid in OpenCode configs). Returns the object, or null if it can't be parsed
 * into a plain object — callers must treat null as "do not touch this file".
 */
function parseOpencodeConfig(text: string): Record<string, unknown> | null {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  return parsed as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenCode global config file path.
 * Respects OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME env vars.
 */
export function findOpencodeConfigPath(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return join(process.env.OPENCODE_CONFIG_DIR, "opencode.json")
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json")
  }
  if (platform() === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "opencode", "opencode.json")
  }
  return join(homedir(), ".config", "opencode", "opencode.json")
}

/**
 * Resolve the absolute path to plugin/meridian.ts from any entry point.
 * Works whether called from bin/cli.ts (dev) or dist/cli.js (installed).
 */
export function findPluginPath(fromUrl: string): string {
  const dir = dirname(fileURLToPath(fromUrl))
  return join(dir, "..", "plugin", "meridian.ts")
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

const STALE_PATTERNS = [
  "opencode-claude-max-proxy",
  "claude-max-headers",
  "meridian-agent-mode",
]

function isMeridianEntry(entry: string): boolean {
  return STALE_PATTERNS.some(p => entry.includes(p)) ||
    entry.includes("meridian.ts") ||
    entry.includes("@rynfar/meridian")
}

/**
 * Returns true if the meridian plugin is already configured in the
 * OpenCode global config. Returns false if config doesn't exist or
 * plugin is missing.
 */
export function checkPluginConfigured(configPath?: string): boolean {
  const path = configPath ?? findOpencodeConfigPath()
  if (!existsSync(path)) return false
  const config = parseOpencodeConfig(readFileSync(path, "utf-8"))
  if (config === null) return false
  const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : []
  return plugins.some(p => typeof p === "string" && isMeridianEntry(p))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface SetupResult {
  configPath: string
  pluginPath: string
  alreadyConfigured: boolean
  removedStale: string[]
  created: boolean
}

/**
 * Configure the meridian plugin in ~/.config/opencode/opencode.json.
 *
 * - Creates the config file if it doesn't exist
 * - Removes stale meridian plugin entries from previous installs
 * - Adds the current plugin path
 * - Leaves all other plugins untouched
 */
export function runSetup(pluginPath: string, configPath?: string): SetupResult {
  const path = configPath ?? findOpencodeConfigPath()
  const dir = dirname(path)

  // New file — write a minimal config.
  if (!existsSync(path)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({ plugin: [pluginPath] }, null, 2)}\n`, "utf-8")
    return { configPath: path, pluginPath, alreadyConfigured: false, removedStale: [], created: true }
  }

  // Existing file — parse tolerantly (JSONC). If we can't understand it, FAIL
  // SAFE: never overwrite a config we couldn't parse (#519). Losing the user's
  // settings is worse than not configuring the plugin.
  const text = readFileSync(path, "utf-8")
  const config = parseOpencodeConfig(text)
  if (config === null) {
    throw new UnparseableConfigError(path)
  }

  const existing: string[] = Array.isArray(config.plugin)
    ? (config.plugin as unknown[]).filter((p): p is string => typeof p === "string")
    : []

  // Split into stale meridian entries and everything else
  const removedStale = existing.filter(isMeridianEntry)
  const others = existing.filter(p => !isMeridianEntry(p))
  const alreadyConfigured = removedStale.some(p => p === pluginPath)
  const newPlugins = [...others, pluginPath]

  // Surgically rewrite ONLY the `plugin` key, preserving the rest of the file —
  // comments, formatting, key order, and every other setting stay intact.
  const edits = modify(text, ["plugin"], newPlugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  writeFileSync(path, applyEdits(text, edits), "utf-8")

  return { configPath: path, pluginPath, alreadyConfigured, removedStale, created: false }
}
