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

import spawn from "cross-spawn"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir, platform } from "os"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { LRUMap } from "../utils/lruMap"
import { ensurePriorityAttestationKey } from "./priorityAttestation"

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

export class MissingV2PluginError extends Error {
  constructor(public readonly expectedPath: string) {
    super(`OpenCode V2 plugin bundle not found at ${expectedPath}`)
    this.name = "MissingV2PluginError"
  }
}

export class DuplicateMeridianConfigError extends Error {
  constructor(
    public readonly configPath: string,
    public readonly siblingPath: string,
  ) {
    super(`A Meridian entry in ${siblingPath} conflicts with setup target ${configPath}`)
    this.name = "DuplicateMeridianConfigError"
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
function opencodeConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode")
  if (platform() === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "opencode")
  return join(homedir(), ".config", "opencode")
}

export function findOpencodeConfigPath(): string {
  const dir = opencodeConfigDirectory()
  const jsonPath = join(dir, "opencode.json")
  const jsoncPath = join(dir, "opencode.jsonc")
  return !existsSync(jsonPath) && existsSync(jsoncPath) ? jsoncPath : jsonPath
}

function siblingOpencodeConfigPath(configPath: string): string | undefined {
  const name = basename(configPath)
  if (name === "opencode.json") return join(dirname(configPath), "opencode.jsonc")
  if (name === "opencode.jsonc") return join(dirname(configPath), "opencode.json")
  return undefined
}

/**
 * Resolve the absolute path to plugin/meridian.ts from any entry point.
 * Works whether called from bin/cli.ts (dev) or dist/cli.js (installed).
 */
export function findPluginPath(fromUrl: string): string {
  const dir = dirname(fileURLToPath(fromUrl))
  return join(dir, "..", "plugin", "meridian.ts")
}

export type OpenCodeGeneration = "v1" | "v2"

export interface OpenCodeDetection {
  generation: OpenCodeGeneration
  version?: string
  command?: string
}

export const SUPPORTED_OPENCODE_V2_VERSION = "0.0.0-beta-18314"

/** Resolve the V2 plugin without selecting stale or incomplete artifacts. */
export function findV2PluginPath(fromUrl: string): string {
  const entryPath = fileURLToPath(fromUrl)
  const dir = dirname(entryPath)

  // A source CLI must use the source plugin even when an old dist/ exists.
  if (entryPath.endsWith(".ts")) {
    const sourcePlugin = join(dir, "..", "plugin", "meridian-v2.ts")
    if (existsSync(sourcePlugin)) return sourcePlugin
    throw new MissingV2PluginError(sourcePlugin)
  }

  // Published and Docker CLIs use the bundle beside dist/cli.js. Do not fall
  // back to TypeScript: production installs omit the V2 SDK dev dependency.
  const bundledPlugin = join(dir, "meridian-v2.js")
  if (existsSync(bundledPlugin)) return bundledPlugin
  throw new MissingV2PluginError(bundledPlugin)
}

/** Parse the public V1 and beta V2 version formats without guessing. */
export function classifyOpenCodeVersion(output: string): OpenCodeDetection | undefined {
  const match = output.trim().match(/^(?:opencode2?\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i)
  const version = match?.[1]
  if (!version) return undefined
  const major = Number(version.split(".", 1)[0])
  return {
    // The supported V1 line is 1.x. Treat every other well-formed version as
    // V2 so the CLI's exact-version gate rejects unknown beta/stable hosts
    // instead of installing the incompatible V1 plugin.
    generation: major === 1 ? "v1" : "v2",
    version,
  }
}

type VersionProbe = (command: string) => string | undefined

/**
 * Detect the installed OpenCode generation with bounded probes. `opencode`
 * remains first so an existing V1 installation keeps its current behavior;
 * side-by-side beta users can select `opencode2` explicitly.
 */
export function detectOpenCodeGeneration(
  commands: readonly string[] = process.env.OPENCODE_BIN
    ? [process.env.OPENCODE_BIN]
    : ["opencode", "opencode2"],
  probe: VersionProbe = (command) => {
    // cross-spawn resolves and safely executes npm's .cmd shims on Windows.
    const result = spawn.sync(command, ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    })
    if (result.error || result.status !== 0) return undefined
    return String(result.stdout ?? "")
  },
): OpenCodeDetection {
  for (const command of commands) {
    const output = probe(command)
    if (!output) continue
    const detected = classifyOpenCodeVersion(output)
    if (detected) return { ...detected, command }
  }
  return { generation: "v1" }
}

export function pluginPathForGeneration(fromUrl: string, generation: OpenCodeGeneration): string {
  return generation === "v2" ? findV2PluginPath(fromUrl) : findPluginPath(fromUrl)
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

const STALE_PATTERNS = [
  "opencode-claude-max-proxy",
  "claude-max-headers",
  "meridian-agent-mode",
]

function pluginEntryPackage(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const packageName = Reflect.get(entry, "package")
  return typeof packageName === "string" ? packageName : undefined
}

function isMeridianEntry(entry: unknown): boolean {
  const packageName = pluginEntryPackage(entry)
  if (!packageName) return false
  return STALE_PATTERNS.some(pattern => packageName.includes(pattern)) ||
    packageName.includes("meridian.ts") ||
    packageName.includes("meridian-v2.") ||
    packageName.includes("@rynfar/meridian")
}

/**
 * Returns true if the meridian plugin is already configured in the
 * OpenCode global config. Returns false if config doesn't exist or
 * plugin is missing.
 */
export function checkPluginConfigured(configPath?: string, expectedPluginPath?: string): boolean {
  const selectedPath = configPath ?? findOpencodeConfigPath()
  const siblingPath = configPath ? undefined : siblingOpencodeConfigPath(selectedPath)
  const paths = siblingPath ? [selectedPath, siblingPath] : [selectedPath]

  return paths.some((path) => {
    if (!existsSync(path)) return false
    const config = parseOpencodeConfig(readFileSync(path, "utf-8"))
    if (config === null) return false
    const plugins: unknown[] = [
      ...(Array.isArray(config.plugin) ? config.plugin : []),
      ...(Array.isArray(config.plugins) ? config.plugins : []),
    ]
    if (expectedPluginPath) return plugins.some(entry => pluginEntryPackage(entry) === expectedPluginPath)
    return plugins.some(isMeridianEntry)
  })
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
 * Configure the Meridian plugin in ~/.config/opencode/opencode.json.
 *
 * - Uses `plugin` for V1 and canonical `plugins` for V2
 * - Removes Meridian entries from both fields to prevent duplicate plugin IDs
 * - Adds the current plugin path
 * - Leaves all unrelated plugins and settings untouched
 */
export function runSetup(
  pluginPath: string,
  configPath?: string,
  generation: OpenCodeGeneration = "v1",
): SetupResult {
  const path = configPath ?? findOpencodeConfigPath()
  const dir = dirname(path)
  const targetField = generation === "v2" ? "plugins" : "plugin"
  const otherField = generation === "v2" ? "plugin" : "plugins"

  // Exact beta-18314 loads opencode.json and opencode.jsonc together. Refuse
  // to create a second Meridian definition in the sibling document: updating
  // two user-owned files cannot be made atomic, so ambiguity fails closed.
  const siblingPath = siblingOpencodeConfigPath(path)
  if (siblingPath && existsSync(siblingPath)) {
    const siblingConfig = parseOpencodeConfig(readFileSync(siblingPath, "utf-8"))
    if (siblingConfig === null) throw new UnparseableConfigError(siblingPath)
    const siblingPlugins = [
      ...(Array.isArray(siblingConfig.plugin) ? siblingConfig.plugin : []),
      ...(Array.isArray(siblingConfig.plugins) ? siblingConfig.plugins : []),
    ]
    if (siblingPlugins.some(isMeridianEntry)) {
      throw new DuplicateMeridianConfigError(path, siblingPath)
    }
  }

  // New file — write a minimal config using the generation's canonical field.
  if (!existsSync(path)) {
    // Provision before touching the OpenCode config. A malformed existing key
    // fails closed and leaves the user's config untouched.
    ensurePriorityAttestationKey()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({ [targetField]: [pluginPath] }, null, 2)}\n`, "utf-8")
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

  const entries = (field: "plugin" | "plugins"): unknown[] =>
    Array.isArray(config[field]) ? config[field] : []
  const targetEntries = entries(targetField)
  const otherEntries = entries(otherField)
  const targetMeridian = targetEntries.filter(isMeridianEntry)
  const otherMeridian = otherEntries.filter(isMeridianEntry)
  const targetExact = targetMeridian.filter(entry => pluginEntryPackage(entry) === pluginPath)
  const removedStale = [...targetMeridian, ...otherMeridian]
    .flatMap(entry => {
      const packageName = pluginEntryPackage(entry)
      return packageName ? [packageName] : []
    })
  const alreadyConfigured = targetMeridian.length === 1 &&
    targetExact.length === 1 &&
    otherMeridian.length === 0

  const targetPlugin = targetExact.length === 1 && targetMeridian.length === 1
    ? targetExact[0]
    : pluginPath
  const targetPlugins = [
    ...targetEntries.filter(entry => !isMeridianEntry(entry)),
    targetPlugin,
  ]
  const otherPlugins = otherEntries.filter(entry => !isMeridianEntry(entry))

  // V2 normalizes both `plugin` and canonical `plugins`. Remove Meridian from
  // the non-target field as well so switching generations cannot load two
  // definitions with the same plugin ID. Preserve unrelated entries in place.
  let updated = text
  const formattingOptions = { insertSpaces: true, tabSize: 2 }
  updated = applyEdits(updated, modify(updated, [targetField], targetPlugins, { formattingOptions }))
  if (Array.isArray(config[otherField]) && otherMeridian.length > 0) {
    updated = applyEdits(updated, modify(updated, [otherField], otherPlugins, { formattingOptions }))
  }
  // Keep one durable key across idempotent setup and V1/V2 switches. Validate
  // it before changing the OpenCode config; never rotate a malformed key.
  ensurePriorityAttestationKey()
  writeFileSync(path, updated, "utf-8")

  return { configPath: path, pluginPath, alreadyConfigured, removedStale, created: false }
}
