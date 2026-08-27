/**
 * Profile renaming.
 *
 * A rename has to move everything that names a profile: its entry in
 * profiles.json and, when its credentials live under
 * ~/.config/meridian/profiles/<id>, the credential directory itself. Renaming
 * the entry alone would leave the profile pointing at a directory that is no
 * longer its own — an account logged out by a cosmetic change — so both are
 * planned together and applied as one step that either happens or does not.
 *
 * The old name survives as an ALIAS on the renamed profile. It is a redirect,
 * not a second name: after `x` is renamed to `y`, `x-meridian-profile: x` is
 * served by `y`, and the moment `x` is claimed again — by `profile add x`, or
 * by renaming something else to `x` — the redirect is dropped.
 *
 * Chains are collapsed on write. Renaming x→y and later y→z leaves z holding
 * both "x" and "y", so resolution is a single lookup and no alias can dangle
 * at an intermediate name that no longer exists.
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { getSetting, setSetting } from "./settings"
import type { ProfileConfig } from "./profiles"

/** Profile names are restricted to exactly what `meridian profile add` accepts. */
const INVALID_PROFILE_ID = /[^a-zA-Z0-9_-]/

export function isValidProfileId(id: string): boolean {
  return id.length > 0 && !INVALID_PROFILE_ID.test(id)
}

export function defaultProfilesDir(): string {
  return join(homedir(), ".config", "meridian", "profiles")
}

export function defaultProfilesConfigFile(): string {
  return join(homedir(), ".config", "meridian", "profiles.json")
}

export function loadProfileConfigFrom(file: string): ProfileConfig[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.warn(`[meridian] Failed to read ${file}: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

export function saveProfileConfigTo(file: string, profiles: ProfileConfig[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Drop `name` from every profile's alias list — a real profile is claiming the
 * name, so the redirect has to stop. Profiles with nothing to drop are
 * returned as-is.
 */
export function reclaimAlias(profiles: ProfileConfig[], name: string): ProfileConfig[] {
  return profiles.map(p => {
    if (!p.aliases?.includes(name)) return p
    const remaining = p.aliases.filter(a => a !== name)
    const next: ProfileConfig = { ...p }
    if (remaining.length > 0) next.aliases = remaining
    else delete next.aliases
    return next
  })
}

export interface ProfileRenamePlan {
  /** The complete profile list as it should be written to disk. */
  profiles: ProfileConfig[]
  /** Credential directory to move, when this profile keeps one under profilesDir. */
  dirMove?: { from: string; to: string }
  /** Aliases the renamed profile ends up carrying, chains already collapsed. */
  aliases: string[]
}

export type ProfileRenameResult =
  | { ok: true; plan: ProfileRenamePlan }
  | { ok: false; error: string; hint?: string }

/**
 * Pure: decide what a rename would change. Refuses rather than corrupting —
 * an unknown source, an occupied target, or a name the charset rejects each
 * come back as an error with nothing planned.
 */
export function planProfileRename(
  profiles: ProfileConfig[],
  from: string,
  to: string,
  profilesDir: string,
): ProfileRenameResult {
  if (!isValidProfileId(to)) {
    return {
      ok: false,
      error: `Invalid profile name "${to}".`,
      hint: "Use only letters, numbers, hyphens, underscores.",
    }
  }
  const target = profiles.find(p => p.id === from)
  if (!target) {
    return { ok: false, error: `Profile "${from}" not found.`, hint: "Run: meridian profile list" }
  }
  if (from === to) {
    return { ok: false, error: `Profile "${from}" is already called that.` }
  }
  if (profiles.some(p => p.id === to)) {
    return { ok: false, error: `Profile "${to}" already exists.`, hint: "Run: meridian profile list" }
  }

  const oldDir = join(profilesDir, from)
  const newDir = join(profilesDir, to)
  // Only a directory Meridian named after the profile moves. A profile that
  // imported ~/.claude points at credentials that were never ours to rename.
  const ownsDir = target.claudeConfigDir === oldDir
  // oauth-token profiles have no claudeConfigDir on the entry, but the SDK is
  // pinned to profilesDir/<id> for isolation (see profiles.ts) — that
  // directory is named after the profile too, so it moves with it.
  const isOauthToken = Boolean(target.oauthToken) || target.type === "oauth-token"

  // Collapse chains: the renamed profile keeps every alias it already had and
  // gains the name it is leaving behind. Filtering `to` covers renaming a
  // profile back to one of its own former names.
  const aliases = [...new Set([...(target.aliases ?? []), from])].filter(a => a !== to)

  const renamed: ProfileConfig = { ...target, id: to, aliases }
  if (ownsDir) renamed.claudeConfigDir = newDir

  // Renaming TO a name another profile still redirects from claims it back.
  const next = reclaimAlias(profiles, to).map(p => (p.id === from ? renamed : p))

  const plan: ProfileRenamePlan = { profiles: next, aliases }
  if (ownsDir || isOauthToken) plan.dirMove = { from: oldDir, to: newDir }
  return { ok: true, plan }
}

export interface ApplyProfileRenameOptions {
  /** Directory holding per-profile credential dirs. Defaults to the real one. */
  profilesDir?: string
  /** profiles.json path. Defaults to the real one. */
  configFile?: string
}

export type ApplyProfileRenameResult =
  | { ok: true; from: string; to: string; aliases: string[]; profiles: ProfileConfig[] }
  | { ok: false; error: string; hint?: string }

/**
 * Apply a rename to disk: credentials first, then the profile list, then the
 * active pointer. If the profile list cannot be written the credential move is
 * undone, so the profile is never left naming a directory that moved out from
 * under it.
 */
export function applyProfileRename(
  from: string,
  to: string,
  options: ApplyProfileRenameOptions = {},
): ApplyProfileRenameResult {
  const profilesDir = options.profilesDir ?? defaultProfilesDir()
  const configFile = options.configFile ?? defaultProfilesConfigFile()

  const profiles = loadProfileConfigFrom(configFile)
  const planned = planProfileRename(profiles, from, to, profilesDir)
  if (!planned.ok) return planned
  const { plan } = planned

  // Credentials move first: a directory rename within one filesystem is
  // atomic, and until profiles.json is written nothing else has changed — so
  // a failure here leaves the profile exactly as it was.
  let movedDir: { from: string; to: string } | undefined
  if (plan.dirMove && existsSync(plan.dirMove.from)) {
    if (existsSync(plan.dirMove.to)) {
      return {
        ok: false,
        error: `Cannot rename to "${to}": ${plan.dirMove.to} already exists.`,
        hint: "Remove or move that directory, then retry.",
      }
    }
    try {
      renameSync(plan.dirMove.from, plan.dirMove.to)
      movedDir = plan.dirMove
    } catch (err) {
      return {
        ok: false,
        error: `Could not move credentials for "${from}": ${err instanceof Error ? err.message : err}`,
      }
    }
  }

  try {
    saveProfileConfigTo(configFile, plan.profiles)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (movedDir) {
      try {
        renameSync(movedDir.to, movedDir.from)
      } catch (undoErr) {
        const undoReason = undoErr instanceof Error ? undoErr.message : String(undoErr)
        return {
          ok: false,
          error: `Could not write ${configFile} (${reason}), and could not move credentials back (${undoReason}).`,
          hint: `Profile "${from}" still expects its credentials at ${movedDir.from} — move ${movedDir.to} back by hand.`,
        }
      }
    }
    return { ok: false, error: `Could not write ${configFile}: ${reason}` }
  }

  // The active profile is stored as a name, so it has to follow the rename or
  // the instance is left pointing at a profile that no longer exists.
  if (getSetting("activeProfile") === from) setSetting("activeProfile", to)

  return { ok: true, from, to, aliases: plan.aliases, profiles: plan.profiles }
}
