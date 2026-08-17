/**
 * Persistent server settings.
 *
 * Stored in ~/.config/meridian/settings.json. Survives proxy restarts.
 * Shared between CLI, UI, and API — browser localStorage is only used
 * for client-only preferences (theme, collapsed sections, etc.).
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { PriorityFailbackPolicy } from "./routing"

/**
 * Resolve the settings file path.
 *
 * Resolved per call rather than frozen at import time so tests can redirect
 * it via MERIDIAN_CONFIG_DIR (see `src/__tests__/preload.ts`). Without the
 * override the path is exactly what it has always been, so existing installs
 * are unaffected.
 *
 * NOTE: deliberately does NOT honour XDG_CONFIG_HOME — anyone who has that
 * set would silently relocate to a different settings file and appear to
 * lose their configuration.
 */
function settingsFile(): string {
  const override = process.env.MERIDIAN_CONFIG_DIR
  return override
    ? join(override, "settings.json")
    : join(homedir(), ".config", "meridian", "settings.json")
}

export interface MeridianSettings {
  /** Last active profile ID — restored on proxy startup */
  activeProfile?: string
  /** Profile routing mode (#383, priority spec): "active" (default),
   *  "sticky", or "priority". MERIDIAN_ROUTING env var takes precedence. */
  routing?: string
  /** Priority-mode pool order (highest priority first). Falls back to
   *  profiles.json order. MERIDIAN_PROFILE_ORDER env var takes precedence. */
  profileOrder?: string[]
  priorityFailback?: PriorityFailbackPolicy
}

/** Read settings from disk. Returns empty object if file doesn't exist or is invalid. */
export function loadSettings(): MeridianSettings {
  const file = settingsFile()
  try {
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, "utf-8"))
  } catch {
    return {}
  }
}

/** Write settings to disk. Merges with existing settings (doesn't clobber unknown keys). */
export function saveSettings(updates: Partial<MeridianSettings>): void {
  const file = settingsFile()
  const current = loadSettings()
  const merged = { ...current, ...updates }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
  } catch (err) {
    console.warn(`[meridian] Failed to write ${file}: ${err instanceof Error ? err.message : err}`)
  }
}

/** Get a single setting value */
export function getSetting<K extends keyof MeridianSettings>(key: K): MeridianSettings[K] {
  return loadSettings()[key]
}

/** Set a single setting value and persist */
export function setSetting<K extends keyof MeridianSettings>(key: K, value: MeridianSettings[K]): void {
  saveSettings({ [key]: value })
}
