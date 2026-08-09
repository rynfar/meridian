/**
 * Multi-profile support.
 *
 * Allows a single Meridian instance to route requests to different Claude
 * accounts. Each profile is a named auth context — a CLAUDE_CONFIG_DIR for
 * Max subscriptions, an Anthropic API key for direct API access, or a
 * long-lived OAuth token minted by `claude setup-token`.
 *
 * Profile selection priority:
 *   1. x-meridian-profile request header (per-request override)
 *   2. Active profile (set via POST /profiles/active or UI, or taken from
 *      another instance under MERIDIAN_FOLLOW_ACTIVE — see followActive.ts)
 *   3. First configured profile (or implicit "default" if none configured)
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configPath, defaultConfigDir } from "../configDir"
import { setSetting, getSetting } from "../settings"
import { pickStickyProfile, type RoutingMode } from "./routing"
import { followedActiveProfile } from "./followActive"

/** Disk profile cache with short TTL so new profiles are picked up quickly */
const DISK_CACHE_TTL_MS = 5_000
let diskProfilesCache: ProfileConfig[] = []
let diskProfilesCacheAt = 0
/** Which file the cache holds, so a changed MERIDIAN_CONFIG_DIR is a miss
 *  rather than the previous directory's profile list served for 5s. */
let diskProfilesCachePath = ""

/**
 * Pure: what to say when the configured profiles.json is absent — a message,
 * or undefined when there is nothing worth saying.
 *
 * MERIDIAN_CONFIG_DIR used to move settings.json alone, so anyone who already
 * set it kept getting their profile list from the default directory. Now that
 * it moves the whole directory that list is gone from their instance, which
 * reads as profiles lost rather than profiles left where they always were.
 * Only relocation can produce that, hence the first condition: with the
 * variable unset both paths are the same file and this stays silent.
 */
export function profilesRelocationNotice(
  configuredFile: string,
  defaultFile: string,
  defaultFileExists: boolean,
): string | undefined {
  if (configuredFile === defaultFile || !defaultFileExists) return undefined
  return `[meridian] No profiles at ${configuredFile}, but ${defaultFile} exists. ` +
    `MERIDIAN_CONFIG_DIR moves the whole config directory, not settings.json alone — ` +
    `copy profiles.json (and profiles/) across, or unset the variable to use the default.`
}

/** The notice must not repeat on every 5s cache miss. */
let warnedProfilesLeftBehind = false

function warnIfProfilesLeftBehind(configuredFile: string): void {
  // Only a disk-discovering instance can be surprised by an empty list —
  // with MERIDIAN_PROFILES set the profiles come from there instead.
  if (warnedProfilesLeftBehind || !diskDiscoveryEnabled) return
  const defaultFile = join(defaultConfigDir(), "profiles.json")
  const notice = profilesRelocationNotice(configuredFile, defaultFile, existsSync(defaultFile))
  if (!notice) return
  warnedProfilesLeftBehind = true
  console.warn(notice)
}

/**
 * Load profiles from profiles.json in the config directory.
 * Cached with a 5s TTL so new profiles are picked up without restart,
 * while avoiding synchronous disk I/O on every request.
 */
export function loadProfilesFromDisk(): ProfileConfig[] {
  const file = configPath("profiles.json")
  if (
    diskProfilesCachePath === file &&
    diskProfilesCacheAt > 0 &&
    Date.now() - diskProfilesCacheAt < DISK_CACHE_TTL_MS
  ) {
    return diskProfilesCache
  }
  diskProfilesCachePath = file
  try {
    if (!existsSync(file)) {
      warnIfProfilesLeftBehind(file)
      diskProfilesCache = []
    } else {
      diskProfilesCache = JSON.parse(readFileSync(file, "utf-8"))
    }
    diskProfilesCacheAt = Date.now()
    return diskProfilesCache
  } catch (err) {
    console.warn(`[meridian] Failed to read ${file}: ${err instanceof Error ? err.message : err}`)
    diskProfilesCacheAt = Date.now()
    diskProfilesCache = []
    return []
  }
}

/**
 * Drop the cached disk profiles so the next read hits the file. Called after
 * a mutation this process performed (e.g. a rename via the UI), where waiting
 * out the TTL would show the caller their own stale profile list.
 */
export function invalidateDiskProfileCache(): void {
  diskProfilesCacheAt = 0
}

export type ProfileType = "claude-max" | "api" | "oauth-token"

export interface ProfileConfig {
  /** Unique profile identifier (e.g. "personal", "work") */
  id: string
  /**
   * Auth type. Inferred from the populated credential field when omitted:
   *   - `oauthToken`        → "oauth-token" (CLAUDE_CODE_OAUTH_TOKEN)
   *   - `apiKey`/`baseUrl`  → must be combined with explicit `type: "api"`
   *   - `claudeConfigDir`   → "claude-max" (CLAUDE_CONFIG_DIR)
   */
  type?: ProfileType
  /** Path to .claude config directory (claude-max profiles) */
  claudeConfigDir?: string
  /** Anthropic API key (api profiles) */
  apiKey?: string
  /** Anthropic base URL override (api profiles) */
  baseUrl?: string
  /** Long-lived OAuth token from `claude setup-token` (oauth-token profiles) */
  oauthToken?: string
  /**
   * Former names left behind by `meridian profile rename`. Each is a redirect,
   * not a second name: requests naming one are served by this profile until
   * the name is claimed again. Chains are collapsed on write (see
   * profileRename.ts), so every alias points straight at its current profile.
   */
  aliases?: string[]
}

export interface ResolvedProfile {
  id: string
  type: ProfileType
  /** Env vars to overlay on the SDK subprocess environment */
  env: Record<string, string>
}

const DEFAULT_PROFILE_ID = "default"

/** Mutable active profile — changed via POST /profiles/active or UI */
let activeProfileId: string | undefined

/**
 * Set the active profile. All requests without an explicit x-meridian-profile
 * header will use this profile. Persisted to settings.json in the config directory.
 */
export function setActiveProfile(profileId: string): void {
  activeProfileId = profileId
  setSetting("activeProfile", profileId)
}

/**
 * Get the LOCAL active profile ID — this instance's own choice, ignoring
 * follow mode. Callers that want the profile actually in effect want
 * `resolveActiveProfileId` instead.
 */
export function getActiveProfileId(): string | undefined {
  return activeProfileId
}

/** Last followed value warned about, so the warning is once per value. */
let warnedUnknownFollowed: string | undefined

/**
 * The active profile actually in effect: the followed instance's choice under
 * MERIDIAN_FOLLOW_ACTIVE, otherwise this instance's own.
 *
 * This is the ONE input follow mode replaces. Everything around it — the
 * header override, sticky assignment, the config default, the first-profile
 * fallback — is unchanged.
 *
 * @param availableIds profile IDs this instance actually has, so a followed
 *   value it cannot serve is rejected here rather than resolving to an
 *   unrelated account further down `resolveProfile`.
 */
export function resolveActiveProfileId(availableIds: readonly string[]): string | undefined {
  const outcome = followedActiveProfile(availableIds)
  if (!outcome) return activeProfileId
  if (outcome.follow) {
    warnedUnknownFollowed = undefined
    return outcome.profileId
  }
  if (outcome.reason === "unknown-profile" && outcome.followedValue !== warnedUnknownFollowed) {
    warnedUnknownFollowed = outcome.followedValue
    console.warn(
      `[meridian] Followed instance is on profile "${outcome.followedValue}", which is not configured here. ` +
      `Using this instance's own active profile instead.`
    )
  }
  return activeProfileId
}

/** The active profile in effect, resolved against the effective profile list. */
export function getEffectiveActiveProfileId(configProfiles: ProfileConfig[] | undefined): string | undefined {
  return resolveActiveProfileId(getEffectiveProfiles(configProfiles).map(p => p.id))
}

/** Reset active profile — for testing only. */
export function resetActiveProfile(): void {
  activeProfileId = undefined
  warnedUnknownFollowed = undefined
}

/**
 * Load persisted active profile from settings. Called once at startup
 * to restore the user's last selection. Only restores when disk
 * discovery is enabled (i.e. real CLI startup, not tests).
 * Validates the saved profile actually exists before restoring.
 */
export function restoreActiveProfile(configProfiles?: ProfileConfig[]): void {
  if (activeProfileId) return // already set (e.g. by env var)
  if (!diskDiscoveryEnabled) return // tests / programmatic usage — don't read disk
  const saved = getSetting("activeProfile")
  if (!saved) return
  // Validate the saved profile exists in the effective profile list
  const effective = getEffectiveProfiles(configProfiles)
  if (effective.length === 0 || effective.some(p => p.id === saved)) {
    activeProfileId = saved
  } else {
    console.warn(`[meridian] Saved active profile "${saved}" not found. Using default.`)
  }
}

/**
 * Get the effective profile list: config-provided profiles merged with
 * disk-loaded profiles. Disk profiles are re-read on each call so new
 * profiles added via `meridian profile add` are picked up without restart.
 */
/** Whether disk auto-discovery is enabled (set by CLI at startup) */
let diskDiscoveryEnabled = false

/** Enable disk auto-discovery of profiles. Called by the CLI when
 *  no MERIDIAN_PROFILES env var is set, so the server picks up
 *  profiles from profiles.json in the config directory dynamically. */
export function enableDiskProfileDiscovery(): void {
  diskDiscoveryEnabled = true
}

export function getEffectiveProfiles(configProfiles: ProfileConfig[] | undefined): ProfileConfig[] {
  const fromConfig = configProfiles ?? []
  if (!diskDiscoveryEnabled) return fromConfig
  const fromDisk = loadProfilesFromDisk()
  // Config (env var) takes precedence; disk fills in anything not already defined
  const configIds = new Set(fromConfig.map(p => p.id))
  return [...fromConfig, ...fromDisk.filter(p => !configIds.has(p.id))]
}

/** Check if any profiles are available from any source */
export function hasProfiles(configProfiles: ProfileConfig[] | undefined): boolean {
  return getEffectiveProfiles(configProfiles).length > 0
}

/** Options for the sticky-routing resolution step (#383). */
export interface ResolveProfileOptions {
  /** Session identity for sticky assignment (adapter.getSessionId). */
  stickySessionKey?: string
  /** Routing mode — "active" (default, pre-#383 chain) or "sticky". */
  routingMode?: RoutingMode
}

/**
 * Resolve a profile from the configuration.
 *
 * Priority: header > sticky assignment (routing="sticky" only) > active >
 * config default > first profile. Whatever that yields is matched against
 * profile ids first and rename aliases second, so a name a rename left behind
 * keeps routing without ever shadowing a live profile.
 *
 * The sticky step exists so multi-account
 * setups can distribute sessions across profiles WITHOUT losing per-account
 * prompt caching — see routing.ts. With routingMode unset/"active" the
 * chain is exactly the pre-#383 behavior.
 *
 * @param profiles - Configured profiles (from ProxyConfig)
 * @param defaultProfile - Default profile ID (from ProxyConfig)
 * @param requestedId - Explicit profile ID from request header
 * @param options - Sticky-routing inputs (session key + mode)
 */
export function resolveProfile(
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string,
  options?: ResolveProfileOptions
): ResolvedProfile {
  const effective = getEffectiveProfiles(profiles)

  // No profiles configured — return empty env (standard single-account mode)
  if (effective.length === 0) {
    return { id: DEFAULT_PROFILE_ID, type: "claude-max", env: {} }
  }

  // Sticky assignment: only in sticky mode, only with a session identity,
  // and always subordinate to an explicit header override.
  const stickyId =
    options?.routingMode === "sticky" && options.stickySessionKey
      ? pickStickyProfile(options.stickySessionKey, effective.map(p => p.id))
      : undefined

  // Priority: header > sticky > active > config default > first profile
  const activeId = resolveActiveProfileId(effective.map(p => p.id))
  const resolvedId = requestedId || stickyId || activeId || defaultProfile || effective[0]!.id
  const profile = findProfileByIdOrAlias(effective, resolvedId)

  if (!profile) {
    console.warn(`[meridian] Unknown profile "${resolvedId}". Using first configured profile.`)
    return buildResolvedProfile(effective[0]!)
  }

  return buildResolvedProfile(profile)
}

/**
 * Look a profile up by id, then by alias. Real profiles ALWAYS win: an alias
 * is only a redirect left behind by a rename, and a stale one must never
 * shadow a live account that has since taken the name.
 */
export function findProfileByIdOrAlias(
  profiles: ProfileConfig[],
  id: string
): ProfileConfig | undefined {
  return profiles.find(p => p.id === id) ?? profiles.find(p => p.aliases?.includes(id))
}

/**
 * Build env overrides for a profile config.
 */
function buildResolvedProfile(profile: ProfileConfig): ResolvedProfile {
  if (profile.oauthToken || profile.type === "oauth-token") {
    const env: Record<string, string> = {}
    if (profile.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = profile.oauthToken
      // Isolate from host ~/.claude. Without this, the SDK's 401-recovery
      // silently reads host creds from disk and swaps a refreshed token in
      // for our env value, masking token failures. Path must not collapse
      // to ~/.claude — see query.ts re: upstream claude-code#20553.
      env.CLAUDE_CONFIG_DIR = configPath("profiles", profile.id)
    }
    return { id: profile.id, type: "oauth-token", env }
  }

  const type = profile.type ?? "claude-max"

  if (type === "api") {
    const env: Record<string, string> = {}
    if (profile.apiKey) env.ANTHROPIC_API_KEY = profile.apiKey
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl
    return { id: profile.id, type, env }
  }

  // claude-max: override config directory
  const env: Record<string, string> = {}
  if (profile.claudeConfigDir) env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir
  return { id: profile.id, type, env }
}

/**
 * Get all configured profile IDs with their types.
 */
export function listProfiles(
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined
): Array<{ id: string; type: ProfileType; isActive: boolean; aliases?: string[] }> {
  const effective = getEffectiveProfiles(profiles)
  if (effective.length === 0) return []

  const currentActive = resolveActiveProfileId(effective.map(p => p.id)) || defaultProfile || effective[0]!.id
  return effective.map(p => ({
    id: p.id,
    type: p.type ?? "claude-max",
    isActive: p.id === currentActive,
    ...(p.aliases && p.aliases.length > 0 ? { aliases: p.aliases } : {}),
  }))
}
