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
  try {
    const raw = readFileSync(path, "utf-8")
    const config = JSON.parse(raw)
    const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : []
    return plugins.some(p => typeof p === "string" && isMeridianEntry(p))
  } catch {
    return false
  }
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

  let config: Record<string, unknown> = {}
  let created = false

  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf-8"))
    } catch {
      // Unparseable — start fresh, preserve the file (we'll overwrite)
    }
  } else {
    created = true
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  const existing: string[] = Array.isArray(config.plugin)
    ? (config.plugin as unknown[]).filter((p): p is string => typeof p === "string")
    : []

  // Split into stale meridian entries and everything else
  const removedStale = existing.filter(isMeridianEntry)
  const others = existing.filter(p => !isMeridianEntry(p))
  const alreadyConfigured = removedStale.some(p => p === pluginPath)

  config.plugin = [...others, pluginPath]

  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8")

  return { configPath: path, pluginPath, alreadyConfigured, removedStale, created }
}
