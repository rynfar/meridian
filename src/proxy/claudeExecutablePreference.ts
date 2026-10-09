/**
 * Which Claude Code executable the operator wants every turn to run.
 *
 * Both candidates have a case. The copy bundled with Meridian is the version
 * its Agent SDK was released and tested with. The operator's own installation
 * is often newer, and a newly released model can require a newer Claude Code
 * than the bundle (#1246). So the choice is a setting rather than a fixed
 * resolver order:
 *
 *   system   the `claude` found on PATH, falling back to the bundled copy
 *            (the default, and the order #1250 introduced)
 *   bundled  the copy Meridian ships with, falling back to PATH
 *            (the order before #1250)
 *   custom   the executable at `claudeExecutablePath`
 *
 * MERIDIAN_CLAUDE_PATH outranks all three. The choice lives in settings.json
 * (`claudeExecutable`, `claudeExecutablePath`) and is read whenever the
 * executable is resolved, so a change applies to the next turn without a
 * restart, whichever process saved it.
 */

import { loadSettings } from "../settings"

export const CLAUDE_EXECUTABLE_MODES = ["system", "bundled", "custom"] as const
export type ClaudeExecutableMode = (typeof CLAUDE_EXECUTABLE_MODES)[number]

export interface ClaudeExecutablePreference {
  readonly mode: ClaudeExecutableMode
  /** Set in custom mode only. */
  readonly customPath?: string
}

export const DEFAULT_CLAUDE_EXECUTABLE_PREFERENCE: ClaudeExecutablePreference = { mode: "system" }

export function isClaudeExecutableMode(value: unknown): value is ClaudeExecutableMode {
  return typeof value === "string" && (CLAUDE_EXECUTABLE_MODES as readonly string[]).includes(value)
}

/**
 * The preference stored values mean. Anything unknown, including unset, is
 * system; so is custom without a path, which the settings API never stores
 * but a hand-edited file can hold.
 */
export function resolveClaudeExecutablePreference(mode: unknown, customPath: unknown): ClaudeExecutablePreference {
  if (mode === "bundled") return { mode }
  if (mode === "custom" && typeof customPath === "string" && customPath.trim() !== "") {
    return { mode, customPath: customPath.trim() }
  }
  return DEFAULT_CLAUDE_EXECUTABLE_PREFERENCE
}

/** The preference saved right now. */
export function savedClaudeExecutablePreference(): ClaudeExecutablePreference {
  // A malformed or null settings document means the default, never a throw on the request path.
  const settings = loadSettings()
  return resolveClaudeExecutablePreference(settings?.claudeExecutable, settings?.claudeExecutablePath)
}
