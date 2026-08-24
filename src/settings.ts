/**
 * Persistent server settings.
 *
 * Stored in ~/.config/meridian/settings.json. Survives proxy restarts.
 * Shared between CLI, UI, and API — browser localStorage is only used
 * for client-only preferences (theme, collapsed sections, etc.).
 *
 * Lives at the src root, beside env.ts, rather than under proxy/, because
 * telemetry reads it too and telemetry may not import from proxy —
 * dependencies flow proxy → telemetry only. env.ts is the existing precedent
 * for "configuration both layers need"; a copy of the path logic in each
 * would be two things to keep agreeing about MERIDIAN_CONFIG_DIR.
 *
 * Leaf module: node builtins only, no imports from anywhere in the tree.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

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

  /**
   * Keep telemetry in SQLite instead of memory, so it survives a restart.
   * MERIDIAN_TELEMETRY_PERSIST takes precedence.
   *
   * The four telemetry keys below differ from every other setting here in one
   * way that the UI must not hide: the stores are built once at startup, so a
   * change to any of them does nothing until the proxy is restarted. Routing
   * is re-read per request; these are not, and cannot be without swapping a
   * store out from under in-flight writes.
   */
  telemetryPersist?: boolean
  /** Days before persisted telemetry is deleted. MERIDIAN_TELEMETRY_RETENTION_DAYS wins. */
  telemetryRetentionDays?: number
  /** Rows the in-memory ring holds. Ignored when persisting. MERIDIAN_TELEMETRY_SIZE wins. */
  telemetrySize?: number
  /** Entries the in-memory diagnostic log ring holds. MERIDIAN_DIAGNOSTIC_LOG_SIZE wins. */
  diagnosticLogSize?: number
}

/**
 * Accepted range for each numeric telemetry setting, and the reason for it.
 *
 * Lives here rather than in the route so the form and the validator read the
 * same numbers: a page that offers a value the API rejects is a worse bug than
 * either bound being slightly wrong.
 *
 * The upper bounds guard a value that only takes effect on the next start, so
 * a typo is not discovered until a restart that then fails or thrashes. Both
 * ring sizes are whole request/log records held in memory; a million rows is
 * hundreds of megabytes of resident heap, which is not a setting anyone means
 * to type. Retention is capped at ten years because SQLite cleanup deletes by
 * a cutoff, and a cutoff further out than the data's usefulness simply never
 * deletes anything.
 */
export const TELEMETRY_SETTING_LIMITS = {
  telemetryRetentionDays: { min: 1, max: 3650 },
  telemetrySize: { min: 10, max: 1_000_000 },
  diagnosticLogSize: { min: 10, max: 1_000_000 },
} as const satisfies Record<string, { min: number; max: number }>

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
