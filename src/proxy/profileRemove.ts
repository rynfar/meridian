/**
 * Claude profile removal, shared by `meridian profile remove` and
 * `POST /profiles/claude/remove`.
 *
 * Removing a profile drops its entry from profiles.json and deletes the
 * credential directory it owns. Both halves are planned before either is
 * applied, and the ORDER is the opposite of a rename's: the profile list is
 * written FIRST, then the directories are deleted.
 *
 * That order is the one that fails safely. A list written with the directory
 * still on disk leaves an orphaned directory - reported, recoverable, and
 * belonging to no profile. Deleting first and then failing to write the list
 * leaves a live profile pointing at credentials that are gone, which serves
 * 401s until somebody notices and cannot be undone at all.
 *
 * Removal matches on the profile ID only, never on a rename alias: an alias is
 * a redirect left behind by a rename, and "remove x" deleting the profile now
 * called y is not what anybody means.
 *
 * This is a leaf module - no imports from server.ts, profileCli.ts or session/.
 */

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { getSetting, saveSettings, type MeridianSettings } from "../settings"
import { readProfileConfigForUpdate, withProfileConfigLockSync } from "./profileConfigStore"
import type { ProfileConfig } from "./profiles"
import { defaultProfilesConfigFile, defaultProfilesDir, saveProfileConfigTo } from "./profileRename"

/**
 * Which on-disk directories should be removed when this profile is deleted.
 *
 * Browser-login profiles drop their explicit `claudeConfigDir`, and only when
 * it lives under `profilesDir` - a profile pointed at ~/.claude names the
 * host's own credentials, which removing one account must never delete.
 * oauth-token profiles drop the pinned isolation dir at `profilesDir/<id>`
 * (created by the SDK during use, not stored on the profile itself).
 */
export function dirsToRemoveOnProfileRemove(profile: ProfileConfig, profilesDir: string): string[] {
  const dirs: string[] = []
  if (profile.claudeConfigDir?.startsWith(profilesDir)) {
    dirs.push(profile.claudeConfigDir)
  }
  if (profile.oauthToken || profile.type === "oauth-token") {
    const isolationDir = join(profilesDir, profile.id)
    if (!dirs.includes(isolationDir)) dirs.push(isolationDir)
  }
  return dirs
}

export interface ProfileRemovePlan {
  /** The complete profile list as it should be written to disk. */
  profiles: ProfileConfig[]
  /** The entry being taken out. */
  removed: ProfileConfig
  /** Credential directories this profile owns, deleted after the list is written. */
  dirsToRemove: string[]
}

export type ProfileRemoveFailure = {
  ok: false
  /** `unknown_profile`: profiles.json has no entry with this id. */
  code: "unknown_profile" | "store_write_failed"
  error: string
  hint?: string
}

export type PlanProfileRemoveResult = { ok: true; plan: ProfileRemovePlan } | ProfileRemoveFailure

export function planProfileRemove(
  profiles: ProfileConfig[],
  id: string,
  profilesDir: string,
): PlanProfileRemoveResult {
  const idx = profiles.findIndex(p => p.id === id)
  if (idx === -1) {
    const byAlias = profiles.find(p => p.aliases?.includes(id))
    return {
      ok: false,
      code: "unknown_profile",
      error: `Profile "${id}" not found.`,
      ...(byAlias ? { hint: `"${id}" is a former name of "${byAlias.id}" - remove that instead.` } : {}),
    }
  }

  const removed = profiles[idx]!
  return {
    ok: true,
    plan: {
      profiles: profiles.filter((_, i) => i !== idx),
      removed,
      dirsToRemove: dirsToRemoveOnProfileRemove(removed, profilesDir),
    },
  }
}

/**
 * The settings that name a removed profile, rewritten without it. Only keys
 * that change are returned. The active pointer moves to the first remaining
 * profile, or is cleared when none remain; the saved failover order drops the
 * profile and the former names that redirected to it.
 */
export function profileRemovalSettings(
  removed: Pick<ProfileConfig, "id" | "aliases">,
  remaining: readonly ProfileConfig[],
  settings: Pick<MeridianSettings, "activeProfile" | "profileOrder">,
): Pick<MeridianSettings, "activeProfile" | "profileOrder"> {
  const names = new Set([removed.id, ...(removed.aliases ?? [])])
  const update: Pick<MeridianSettings, "activeProfile" | "profileOrder"> = {}
  if (settings.activeProfile === removed.id) update.activeProfile = remaining[0]?.id
  if (settings.profileOrder?.some(id => names.has(id))) {
    update.profileOrder = settings.profileOrder.filter(id => !names.has(id))
  }
  return update
}

export interface ApplyProfileRemoveOptions {
  /** Directory holding per-profile credential dirs. Defaults to the real one. */
  profilesDir?: string
  /** profiles.json path. Defaults to the real one. */
  configFile?: string
}

export type ApplyProfileRemoveResult =
  | {
      ok: true
      id: string
      /** Former names that redirected to the removed profile. */
      aliases: string[]
      /** Directories actually deleted. */
      dirsRemoved: string[]
      /**
       * Directories the list no longer claims and that could not be deleted.
       * The removal itself succeeded; these are orphans somebody may want to
       * clear by hand, and staying silent about them is how a credential
       * directory outlives every profile that named it.
       */
      dirsOrphaned: { dir: string; reason: string }[]
      /** Where the persisted active pointer moved; absent when it named another profile. */
      activeProfile?: string | null
      profiles: ProfileConfig[]
    }
  | ProfileRemoveFailure

export function applyProfileRemove(
  id: string,
  options: ApplyProfileRemoveOptions = {},
): ApplyProfileRemoveResult {
  const configFile = options.configFile ?? defaultProfilesConfigFile()
  try { return withProfileConfigLockSync(configFile, () => applyProfileRemoveLocked(id, options)) }
  catch (error) { return { ok: false, code: "store_write_failed", error: error instanceof Error ? error.message : String(error) } }
}

function applyProfileRemoveLocked(id: string, options: ApplyProfileRemoveOptions): ApplyProfileRemoveResult {
  const profilesDir = options.profilesDir ?? defaultProfilesDir()
  const configFile = options.configFile ?? defaultProfilesConfigFile()

  const profiles = readProfileConfigForUpdate(configFile)
  const planned = planProfileRemove(profiles, id, profilesDir)
  if (!planned.ok) return planned
  const { plan } = planned

  try {
    saveProfileConfigTo(configFile, plan.profiles)
  } catch (err) {
    return {
      ok: false,
      code: "store_write_failed",
      error: `Could not write ${configFile}: ${err instanceof Error ? err.message : err}`,
    }
  }

  const settings = profileRemovalSettings(plan.removed, plan.profiles, {
    activeProfile: getSetting("activeProfile"),
    profileOrder: getSetting("profileOrder"),
  })
  if (Object.keys(settings).length > 0) saveSettings(settings)

  const dirsRemoved: string[] = []
  const dirsOrphaned: { dir: string; reason: string }[] = []
  for (const dir of plan.dirsToRemove) {
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      dirsRemoved.push(dir)
    } catch (err) {
      dirsOrphaned.push({ dir, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    ok: true,
    id: plan.removed.id,
    aliases: plan.removed.aliases ?? [],
    dirsRemoved,
    dirsOrphaned,
    ...("activeProfile" in settings ? { activeProfile: settings.activeProfile ?? null } : {}),
    profiles: plan.profiles,
  }
}
