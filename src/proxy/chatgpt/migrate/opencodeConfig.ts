/**
 * Which opencode config files load oc-codex-multi-auth, and editing them.
 *
 * Mirrors opencode's `config/config.ts` load order (verified against opencode
 * dev, 2026-09):
 *
 *   1. Global directory: `config.json`, `opencode.json`, `opencode.jsonc`,
 *      merged with remeda `mergeDeep`, which REPLACES arrays. A later file that
 *      declares `plugin` therefore discards every earlier file's list - the
 *      earlier entries are inert, not active.
 *   2. `OPENCODE_CONFIG`, then project `opencode.json`/`opencode.jsonc` files
 *      from the outermost directory down to the session directory, stopping at
 *      the worktree (`/` outside git), then `opencode.json{,c}` inside every
 *      `.opencode` directory on the same walk, `~/.opencode`,
 *      `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, and the managed
 *      directory. From step 2 on, plugin lists ACCUMULATE across files.
 *   3. Any `plugin/*.{ts,js}` or `plugins/*.{ts,js}` file inside those
 *      directories is loaded without being listed anywhere.
 *
 * Edits go through jsonc-parser `modify`, which changes only the touched
 * range, so comments, trailing commas and the operator's layout survive.
 * Option objects of `[spec, options]` plugin tuples are never read into a
 * report: they are free-form and may carry credentials.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type ParseError } from "jsonc-parser"
import {
  GLOBAL_CONFIG_FILE_NAMES,
  TUI_CONFIG_FILE_NAMES,
  PLUGIN_PACKAGE_NAME,
  defaultManagedConfigDir,
  opencodeGlobalConfigDir,
  type MigrationEnvironment,
} from "./layout"
import { isRecord } from "./sources"

export type LayerScope = "global" | "custom" | "project" | "dotdir" | "content" | "managed"

export interface ConfigLayer {
  /** A file path; for `content` the literal `OPENCODE_CONFIG_CONTENT`. */
  path: string
  scope: LayerScope
}

export interface OpencodeContext {
  /** Where opencode was started. */
  directory: string
  /** The git worktree root, or `/` outside git - where the upward walk stops. */
  worktree: string
}

export type PluginMatchReason = "package-name" | "package-json" | "path-name"

export interface PluginEntry {
  layer: ConfigLayer
  /** Index in that file's `plugin` array. */
  index: number
  /** The specifier only - never the options of a tuple entry. */
  spec: string
  match: PluginMatchReason | null
  /** False when a later global file's `plugin` array replaced this file's. */
  effective: boolean
  shadowedBy?: string
}

export interface AutoloadedPluginFile {
  path: string
  reason: "file-name" | "imports-plugin"
}

export interface PluginResolution {
  layers: ConfigLayer[]
  entries: PluginEntry[]
  autoloaded: AutoloadedPluginFile[]
  /** Files that exist but could not be parsed: whether they load the plugin is unknown. */
  unparseable: string[]
}

// ---------------------------------------------------------------------------
// Git worktree (only as far as opencode uses it: the upward walk's stop)
// ---------------------------------------------------------------------------

export function findWorktree(directory: string): string {
  let current = resolve(directory)
  while (true) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return "/"
    current = parent
  }
}

export function contextFor(directory: string): OpencodeContext {
  return { directory: resolve(directory), worktree: findWorktree(directory) }
}

/** opencode's `FSUtil.up`: every target in every directory from start to stop, innermost first. */
function up(targets: readonly string[], start: string, stop: string): string[] {
  const found: string[] = []
  let current = start
  while (true) {
    for (const target of targets) {
      const candidate = join(current, target)
      if (existsSync(candidate)) found.push(candidate)
    }
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export function globalConfigLayers(env: MigrationEnvironment): ConfigLayer[] {
  const dir = opencodeGlobalConfigDir(env)
  return GLOBAL_CONFIG_FILE_NAMES.map(name => ({ path: join(dir, name), scope: "global" as const }))
}

function directoriesFor(env: MigrationEnvironment, context: OpencodeContext | null): string[] {
  const dirs = [opencodeGlobalConfigDir(env)]
  if (context && !env.disableProjectConfig) dirs.push(...up([".opencode"], context.directory, context.worktree))
  dirs.push(...up([".opencode"], env.home, env.home))
  if (env.opencodeConfigDir) dirs.push(env.opencodeConfigDir)
  return [...new Set(dirs)]
}

/** Every config source opencode reads for this context, in merge order. */
export function configLayers(env: MigrationEnvironment, context: OpencodeContext | null): ConfigLayer[] {
  const layers: ConfigLayer[] = globalConfigLayers(env)
  if (env.opencodeConfig) layers.push({ path: env.opencodeConfig, scope: "custom" })
  if (context && !env.disableProjectConfig) {
    for (const path of up(["opencode.jsonc", "opencode.json"], context.directory, context.worktree).reverse()) {
      layers.push({ path, scope: "project" })
    }
  }
  for (const dir of directoriesFor(env, context)) {
    if (!dir.endsWith(".opencode") && dir !== env.opencodeConfigDir) continue
    for (const name of ["opencode.json", "opencode.jsonc"]) layers.push({ path: join(dir, name), scope: "dotdir" })
  }
  if (env.opencodeConfigContent) layers.push({ path: "OPENCODE_CONFIG_CONTENT", scope: "content" })
  const managed = env.managedConfigDir ?? defaultManagedConfigDir()
  for (const name of ["opencode.json", "opencode.jsonc"]) layers.push({ path: join(managed, name), scope: "managed" })
  return layers
}

// ---------------------------------------------------------------------------
// Parsing and matching
// ---------------------------------------------------------------------------

export class UnparseableOpencodeConfigError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`Could not parse ${path} as JSONC. It was left untouched.`)
    this.name = "UnparseableOpencodeConfigError"
    this.path = path
  }
}

export function parseConfigText(text: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(parsed)) throw new UnparseableOpencodeConfigError(path)
  return parsed
}

function readLayerText(layer: ConfigLayer, env: MigrationEnvironment): string | null {
  if (layer.scope === "content") return env.opencodeConfigContent ?? null
  try {
    if (!statSync(layer.path).isFile()) return null
    return readFileSync(layer.path, "utf8")
  } catch {
    return null
  }
}

function specifierOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return null
}

function isPathSpec(spec: string): boolean {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
}

/** `oc-codex-multi-auth`, `oc-codex-multi-auth@1.2.3`, `npm:oc-codex-multi-auth@latest`. */
export function packageNameOf(spec: string): string {
  const bare = spec.startsWith("npm:") ? spec.slice(4) : spec
  const versionAt = bare.startsWith("@") ? bare.indexOf("@", 1) : bare.indexOf("@")
  return versionAt > 0 ? bare.slice(0, versionAt) : bare
}

/** The nearest package.json at or above `start`: its directory, and its name (null when unreadable). */
function nearestPackageJson(start: string): { dir: string; name: string | null } | undefined {
  let current = start
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(current, "package.json")
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"))
        return { dir: current, name: isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : null }
      } catch {
        return { dir: current, name: null }
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** The deepest of `target` and its ancestors whose own name contains the plugin's. */
function pluginNamedPath(target: string): string | undefined {
  for (let current = target; ; current = dirname(current)) {
    if (basename(current).includes(PLUGIN_PACKAGE_NAME)) return current
    if (dirname(current) === current) return undefined
  }
}

/**
 * A path entry is the plugin when the package.json above it says so - which
 * also catches a checkout renamed to anything, such as a worktree. Only when
 * the target is gone does the directory name decide: no package.json at or
 * below the plugin-named directory, so one further up belongs to an enclosing
 * project (a home directory, a monorepo) and says nothing about this path.
 */
export function matchPluginSpec(spec: string, declaredIn: string | null): PluginMatchReason | null {
  if (!isPathSpec(spec)) return packageNameOf(spec) === PLUGIN_PACKAGE_NAME ? "package-name" : null
  let target: string
  try {
    target = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  } catch {
    return null
  }
  if (!isAbsolute(target)) target = resolve(declaredIn ? dirname(declaredIn) : process.cwd(), target)
  let start = target
  try {
    if (!statSync(target).isDirectory()) start = dirname(target)
  } catch {
    start = dirname(target)
  }
  const found = nearestPackageJson(start)
  if (found?.name === PLUGIN_PACKAGE_NAME) return "package-json"
  const named = pluginNamedPath(target)
  if (named === undefined) return null
  const insideNamed = found !== undefined && (found.dir === named || found.dir.startsWith(named + sep))
  return insideNamed ? null : "path-name"
}

function autoloadedFiles(dir: string): AutoloadedPluginFile[] {
  const found: AutoloadedPluginFile[] = []
  for (const sub of ["plugin", "plugins"]) {
    const pluginDir = join(dir, sub)
    let names: string[]
    try {
      names = readdirSync(pluginDir).filter(name => /\.(ts|js)$/.test(name)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(pluginDir, name)
      if (name.includes(PLUGIN_PACKAGE_NAME)) {
        found.push({ path, reason: "file-name" })
        continue
      }
      try {
        if (readFileSync(path, "utf8").includes(PLUGIN_PACKAGE_NAME)) found.push({ path, reason: "imports-plugin" })
      } catch {
        // An unreadable file is not evidence either way; opencode would fail to load it too.
      }
    }
  }
  return found
}

export function resolvePlugins(env: MigrationEnvironment, context: OpencodeContext | null): PluginResolution {
  const layers = configLayers(env, context)
  const entries: PluginEntry[] = []
  const unparseable: string[] = []
  let globalWinner: string | null = null

  // Walk global files backwards: the last one that declares `plugin` is the only global list that counts.
  const parsedByLayer = new Map<ConfigLayer, Record<string, unknown>>()
  for (const layer of layers) {
    const text = readLayerText(layer, env)
    if (text === null) continue
    try {
      parsedByLayer.set(layer, parseConfigText(text, layer.path))
    } catch (error) {
      if (!(error instanceof UnparseableOpencodeConfigError)) throw error
      unparseable.push(layer.path)
    }
  }
  for (const layer of [...layers].reverse()) {
    if (layer.scope !== "global") continue
    if (Array.isArray(parsedByLayer.get(layer)?.plugin)) {
      globalWinner = layer.path
      break
    }
  }

  for (const layer of layers) {
    const list = parsedByLayer.get(layer)?.plugin
    if (!Array.isArray(list)) continue
    const effective = layer.scope !== "global" || layer.path === globalWinner
    list.forEach((raw, index) => {
      const spec = specifierOf(raw)
      if (spec === null) return
      entries.push({
        layer,
        index,
        spec,
        match: matchPluginSpec(spec, layer.scope === "content" ? null : layer.path),
        effective,
        ...(effective ? {} : { shadowedBy: globalWinner ?? undefined }),
      })
    })
  }

  const autoloaded = directoriesFor(env, context).flatMap(autoloadedFiles)
  return { layers, entries, autoloaded, unparseable }
}

/**
 * The TUI config files opencode reads for this context, in merge order
 * (`config/tui.ts`): global, `OPENCODE_TUI_CONFIG`, project files root-first
 * (the walk does not stop at the worktree), then each `.opencode` directory
 * and `OPENCODE_CONFIG_DIR`. Unlike the main config, TUI plugin lists
 * accumulate across every file, global ones included.
 */
export function tuiConfigLayers(env: MigrationEnvironment, context: OpencodeContext | null): ConfigLayer[] {
  const layers: ConfigLayer[] = TUI_CONFIG_FILE_NAMES.map(name => ({ path: join(opencodeGlobalConfigDir(env), name), scope: "global" as const }))
  if (env.opencodeTuiConfig) layers.push({ path: env.opencodeTuiConfig, scope: "custom" })
  if (context && !env.disableProjectConfig) {
    for (const path of up(["tui.jsonc", "tui.json"], context.directory, "/").reverse()) layers.push({ path, scope: "project" })
  }
  for (const dir of directoriesFor(env, context)) {
    if (!dir.endsWith(".opencode") && dir !== env.opencodeConfigDir) continue
    for (const name of TUI_CONFIG_FILE_NAMES) layers.push({ path: join(dir, name), scope: "dotdir" })
  }
  const seen = new Set<string>()
  return layers.filter(layer => !seen.has(layer.path) && seen.add(layer.path))
}

/** Every oc-codex-multi-auth entry in the TUI config files; all of them load. */
export function resolveTuiPlugins(env: MigrationEnvironment, context: OpencodeContext | null): { entries: PluginEntry[]; unparseable: string[] } {
  const entries: PluginEntry[] = []
  const unparseable: string[] = []
  for (const layer of tuiConfigLayers(env, context)) {
    const text = readLayerText(layer, env)
    if (text === null) continue
    try {
      for (const { index, spec } of pluginEntriesIn(text, layer.path)) {
        entries.push({ layer, index, spec, match: matchPluginSpec(spec, layer.path), effective: true })
      }
    } catch (error) {
      if (!(error instanceof UnparseableOpencodeConfigError)) throw error
      unparseable.push(layer.path)
    }
  }
  return { entries, unparseable }
}

export function loadsPlugin(resolution: PluginResolution): boolean {
  return resolution.entries.some(entry => entry.match && entry.effective) || resolution.autoloaded.length > 0
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function detectIndent(text: string): { insertSpaces: boolean; tabSize: number } {
  const line = text.split("\n").find(candidate => /^[ \t]+\S/.test(candidate))
  if (!line) return { insertSpaces: true, tabSize: 2 }
  if (line.startsWith("\t")) return { insertSpaces: false, tabSize: 1 }
  return { insertSpaces: true, tabSize: line.length - line.trimStart().length }
}

/**
 * jsonc-parser 3.3.1 `modify` corrupts the text when it deletes the last of
 * several elements and the closing bracket follows it on the same line:
 * `["a", "b"]` becomes `["a""]`. That element is cut out here instead, from
 * the end of the one before it, which also takes the comma.
 */
function removeArrayElement(text: string, path: (string | number)[], index: number, formattingOptions: ReturnType<typeof detectIndent>): string {
  const array = findNodeAtLocation(parseTree(text, [], { allowTrailingComma: true })!, path)
  const elements = array?.type === "array" ? array.children ?? [] : []
  const target = elements[index]
  const previous = elements[index - 1]
  if (target && previous && index === elements.length - 1) {
    return `${text.slice(0, previous.offset + previous.length)}${text.slice(target.offset + target.length)}`
  }
  return applyEdits(text, modify(text, [...path, index], undefined, { formattingOptions }))
}

export interface PluginRemoval {
  text: string
  removed: string[]
}

/** Remove every `plugin` entry that is oc-codex-multi-auth. Unchanged text when none are. */
export function removePluginEntries(text: string, path: string): PluginRemoval {
  const list = parseConfigText(text, path).plugin
  if (!Array.isArray(list)) return { text, removed: [] }
  const indices: number[] = []
  const removed: string[] = []
  list.forEach((raw, index) => {
    const spec = specifierOf(raw)
    if (spec !== null && matchPluginSpec(spec, path)) {
      indices.push(index)
      removed.push(spec)
    }
  })
  let next = text
  const formattingOptions = detectIndent(text)
  // Highest index first, so each removal leaves the earlier indices valid.
  for (const index of indices.reverse()) next = removeArrayElement(next, ["plugin"], index, formattingOptions)
  parseConfigText(next, path)
  return { text: next, removed }
}

export function pluginEntriesIn(text: string, path: string): Array<{ index: number; spec: string }> {
  const list = parseConfigText(text, path).plugin
  if (!Array.isArray(list)) return []
  return list.flatMap((raw, index) => {
    const spec = specifierOf(raw)
    return spec !== null && matchPluginSpec(spec, path) ? [{ index, spec }] : []
  })
}

export interface PluginAddition {
  text: string
  /** `added`: a new entry; `replaced`: an entry for the plugin now names `spec`; `present`: nothing to do. */
  outcome: "added" | "replaced" | "present"
  previousSpec?: string
}

/**
 * Put oc-codex-multi-auth back in a `plugin` array, at `index` when the
 * array is still that long, else at its end. An entry that already loads the
 * plugin is left alone, unless `replace` asks for it to name `spec` instead.
 */
export function addPluginEntry(text: string, path: string, spec: string, options: { index?: number; replace?: boolean } = {}): PluginAddition {
  const config = parseConfigText(text, path)
  const formattingOptions = detectIndent(text)
  const existing = pluginEntriesIn(text, path)[0]
  if (existing) {
    if (!options.replace || existing.spec === spec) return { text, outcome: "present" }
    const raw = (config.plugin as unknown[])[existing.index]
    const target = Array.isArray(raw) ? ["plugin", existing.index, 0] : ["plugin", existing.index]
    const next = applyEdits(text, modify(text, target, spec, { formattingOptions }))
    parseConfigText(next, path)
    return { text: next, outcome: "replaced", previousSpec: existing.spec }
  }
  const list = Array.isArray(config.plugin) ? config.plugin : null
  const next = list === null
    ? applyEdits(text, modify(text, ["plugin"], [spec], { formattingOptions }))
    : applyEdits(text, modify(text, ["plugin", Math.min(options.index ?? list.length, list.length)], spec, { formattingOptions, isArrayInsertion: true }))
  parseConfigText(next, path)
  return { text: next, outcome: "added" }
}

/** What `provider.<id>` looked like before the forward migration pointed it at Meridian. */
export interface ProviderBefore {
  baseURL: string | undefined
  hadApiKey: boolean
  hadOptions: boolean
  hadProvider: boolean
  hadProviderMap: boolean
}

export function providerBefore(text: string, path: string, providerId: string): ProviderBefore {
  const config = parseConfigText(text, path)
  const providers = isRecord(config.provider) ? config.provider : null
  const provider = providers && isRecord(providers[providerId]) ? providers[providerId] : null
  const options = provider && isRecord(provider.options) ? provider.options : null
  return {
    baseURL: typeof options?.baseURL === "string" ? options.baseURL : undefined,
    hadApiKey: options !== null && options.apiKey !== undefined,
    hadOptions: options !== null,
    hadProvider: provider !== null,
    hadProviderMap: providers !== null,
  }
}

export interface ProviderRestore {
  text: string
  /** `not-meridian`: the provider does not point at Meridian, so nothing was touched. */
  outcome: "restored" | "removed" | "not-meridian"
  restoredBaseURL: string | null
  apiKeyRemoved: boolean
}

/**
 * Undo `pointProviderAtMeridian`. The baseURL goes back to `before.baseURL`,
 * or away when there was none. The apiKey is removed only when it is the
 * placeholder the forward step writes and the provider had none before, so a
 * key the operator added is never dropped. Containers the forward step
 * created and that are now empty go too.
 */
export function restoreProvider(
  text: string,
  path: string,
  input: { providerId: string; meridianBaseURL: string; placeholderApiKey: string; before: ProviderBefore | null },
): ProviderRestore {
  const config = parseConfigText(text, path)
  const current = providerOptions(config, input.providerId)
  const unchanged: ProviderRestore = { text, outcome: "not-meridian", restoredBaseURL: null, apiKeyRemoved: false }
  if (!current || typeof current.baseURL !== "string" || current.baseURL.replace(/\/+$/, "") !== input.meridianBaseURL.replace(/\/+$/, "")) return unchanged

  const formattingOptions = detectIndent(text)
  const edit = (next: string, path: (string | number)[], value: unknown) => applyEdits(next, modify(next, path, value, { formattingOptions }))
  const key = ["provider", input.providerId, "options"]
  const previous = input.before?.baseURL
  let next = edit(text, [...key, "baseURL"], previous)
  const apiKeyRemoved = !(input.before?.hadApiKey ?? false) && current.apiKey === input.placeholderApiKey
  if (apiKeyRemoved) next = edit(next, [...key, "apiKey"], undefined)

  const after = parseConfigText(next, path)
  const providers = isRecord(after.provider) ? after.provider : null
  const provider = providers && isRecord(providers[input.providerId]) ? providers[input.providerId] as Record<string, unknown> : null
  if (provider && isRecord(provider.options) && Object.keys(provider.options).length === 0 && !input.before?.hadOptions) {
    next = edit(next, key, undefined)
  }
  const afterOptions = parseConfigText(next, path)
  const providerNow = isRecord(afterOptions.provider) ? afterOptions.provider[input.providerId] : undefined
  if (isRecord(providerNow) && Object.keys(providerNow).length === 0 && !input.before?.hadProvider) {
    next = edit(next, ["provider", input.providerId], undefined)
  }
  const final = parseConfigText(next, path)
  if (isRecord(final.provider) && Object.keys(final.provider).length === 0 && !input.before?.hadProviderMap) {
    next = edit(next, ["provider"], undefined)
  }
  parseConfigText(next, path)
  return { text: next, outcome: previous === undefined ? "removed" : "restored", restoredBaseURL: previous ?? null, apiKeyRemoved }
}

export interface ProviderPointing {
  providerId: string
  baseURL: string
  /** Written only when the provider has no `options.apiKey` yet. */
  apiKey: string
}

export interface ProviderEdit {
  text: string
  changed: boolean
  previousBaseURL: string | null
  apiKeyAdded: boolean
  /** The provider already had an API key, which opencode will now send to Meridian. */
  existingApiKeyKept: boolean
}

function providerOptions(config: Record<string, unknown>, providerId: string): Record<string, unknown> | null {
  const providers = config.provider
  if (!isRecord(providers)) return null
  const provider = providers[providerId]
  if (!isRecord(provider)) return null
  return isRecord(provider.options) ? provider.options : null
}

export function pointProviderAtMeridian(text: string, path: string, pointing: ProviderPointing): ProviderEdit {
  const options = providerOptions(parseConfigText(text, path), pointing.providerId)
  const previousBaseURL = typeof options?.baseURL === "string" ? options.baseURL : null
  const hasApiKey = options !== null && options.apiKey !== undefined
  const formattingOptions = detectIndent(text)
  let next = text
  if (previousBaseURL !== pointing.baseURL) {
    next = applyEdits(next, modify(next, ["provider", pointing.providerId, "options", "baseURL"], pointing.baseURL, { formattingOptions }))
  }
  if (!hasApiKey) {
    next = applyEdits(next, modify(next, ["provider", pointing.providerId, "options", "apiKey"], pointing.apiKey, { formattingOptions }))
  }
  parseConfigText(next, path)
  return {
    text: next,
    changed: next !== text,
    previousBaseURL,
    apiKeyAdded: !hasApiKey,
    existingApiKeyKept: hasApiKey,
  }
}

/** The file a provider setting must go in to beat every other global file. */
export function highestPrecedenceGlobalFile(env: MigrationEnvironment): string {
  const layers = globalConfigLayers(env)
  const existing = [...layers].reverse().find(layer => existsSync(layer.path))
  return (existing ?? layers[1]!).path
}

/** Layers after the global ones that set this provider's baseURL, and so override it. */
export function providerBaseUrlOverrides(
  env: MigrationEnvironment,
  context: OpencodeContext | null,
  providerId: string,
): string[] {
  const overrides: string[] = []
  for (const layer of configLayers(env, context)) {
    if (layer.scope === "global") continue
    const text = readLayerText(layer, env)
    if (text === null) continue
    try {
      const options = providerOptions(parseConfigText(text, layer.path), providerId)
      if (options && options.baseURL !== undefined) overrides.push(layer.path)
    } catch (error) {
      if (!(error instanceof UnparseableOpencodeConfigError)) throw error
    }
  }
  return overrides
}

export function describeLayer(layer: ConfigLayer): string {
  return layer.scope === "content" ? "OPENCODE_CONFIG_CONTENT" : `${layer.path} (${layer.scope})`
}
