/**
 * Meridian setup — OpenCode plugin configuration.
 *
 * Manages the meridian plugin entry in ~/.config/opencode/opencode.json
 * (or the platform-equivalent path). Called by:
 *   - `meridian setup`  — writes the plugin entry
 *   - `meridian` startup — warns if plugin is missing
 *   - `GET /health`     — reports plugin status
 *   - every request      — warns when an OpenCode client sends no plugin
 *                          headers (see notePluginlessOpenCodeRequest)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir, platform } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { LRUMap } from "../utils/lruMap"

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
// Request-time plugin check
// ---------------------------------------------------------------------------

/**
 * Sessions already warned about. Bounded: a proxy that runs for weeks must not
 * accumulate one entry per conversation forever. Eviction only costs a repeated
 * warning, which is the harmless direction.
 */
const pluginlessWarned = new LRUMap<string, true>(256)

/** Reset the warned-session memory. Used by tests. */
export function clearPluginlessWarnings(): void {
  pluginlessWarned.clear()
}

/**
 * NOTE: OpenCode-specific. Warn when an OpenCode client reaches the proxy
 * without the plugin's agent headers, once per session.
 *
 * This exists because the exposure it reports cannot be fixed from inside
 * Meridian. OpenCode 1.18.11 sends `x-session-affinity` natively, so a
 * plugin-less client is fully keyed and never reaches the fingerprint fallback
 * — and its internal `title` / `summary` / `compaction` agents run under the
 * SAME session id as the user's chat. One real key, two unrelated
 * conversations. Live, both attempts of a plugin-less run returned HTTP 400
 * `session_turn_conflict` on the user's first turn after an ~8s wait.
 *
 * The fix for that collision scopes the session key by agent, which it reads
 * from the plugin's `x-opencode-agent-mode`. A client that sends none cannot be
 * scoped, and inferring the agent from request shape was tried and reverted:
 * "tool-less, one message" is equally the first turn of an ordinary tool-less
 * chat, and keying that apart broke resume for it.
 *
 * So the remaining job is to stop the exposure being silent. The startup
 * warning in `bin/cli.ts` does not cover it — that one is gated on an OpenCode
 * config FILE existing, deliberately, so Meridian stays quiet for the many
 * clients that are not OpenCode. Run the documented
 * `ANTHROPIC_BASE_URL=… opencode` with no config file and nothing warns.
 *
 * Keyed on the `opencode/` User-Agent rather than the resolved adapter:
 * `MERIDIAN_DEFAULT_AGENT` defaults to opencode, so unrelated clients land on
 * that adapter, and telling a Pi user to configure an OpenCode plugin is worse
 * than saying nothing. The User-Agent has no such ambiguity.
 *
 * Returns the message to log, or undefined when there is nothing to say.
 * Stateful but I/O-free — the caller owns the logging.
 */
export function notePluginlessOpenCodeRequest(input: {
  userAgent: string | undefined
  /** The plugin's `x-opencode-agent-mode` header, if it sent one. */
  agentModeHeader: string | undefined
  /** Client session id — used only to warn once per conversation. */
  sessionId: string | undefined
}): string | undefined {
  if (!input.userAgent?.toLowerCase().startsWith("opencode/")) return undefined
  // A plugin old enough to omit the agent headers is equally unable to prevent
  // the collision, so it gets the same warning.
  if (input.agentModeHeader) return undefined

  const key = input.sessionId || "(keyless)"
  if (pluginlessWarned.get(key)) return undefined
  pluginlessWarned.set(key, true)

  // Truncated: the line is meant to be pasteable into an issue.
  const shortId = input.sessionId ? `${input.sessionId.slice(0, 12)}…` : "(no session header)"
  return (
    `OpenCode request without the Meridian plugin's agent headers (session ${shortId}). ` +
    `OpenCode runs its internal title/summary agents under your session id, so Meridian ` +
    `cannot tell them apart from your conversation: the first turn of each session can fail ` +
    `with a 400 or replay against a cold cache. Fix: meridian setup (or update the plugin).`
  )
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
