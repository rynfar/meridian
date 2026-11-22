import { configPath } from "../configDir"
import { env, envBool, envInt, envIntValue, envSource, type EnvSource } from "../env"
import { getSetting } from "../settings"
import { MemoryTelemetryStore, resolveTelemetryCapacity, telemetryCapacityFromEnv } from "./store"
import { diagnosticLogCapacityFromEnv, MemoryDiagnosticLogStore, resolveDiagnosticLogCapacity } from "./logStore"
import type { ITelemetryStore, IDiagnosticLogStore, ResolvedTelemetryConfig } from "./types"

/**
 * Where SQLite goes when MERIDIAN_TELEMETRY_DB does not say.
 *
 * Follows MERIDIAN_CONFIG_DIR, which every other file in the config directory
 * already does. It did not, and that is a collision rather than an
 * inconsistency: two instances given separate config dirs precisely so they do
 * not share state were both handed ~/.config/meridian/telemetry.db, so one
 * dashboard counted the other's requests.
 */
function getDefaultDbPath(): string {
  return configPath("telemetry.db")
}

/**
 * Env beats the saved setting, matching how `routing` resolves.
 *
 * Deliberately not `envBool`, which cannot tell "unset" from "=0": a setting
 * saved in the UI must not be able to override an operator's explicit
 * `MERIDIAN_TELEMETRY_PERSIST=0` in a unit file, and `envBool` reports both as
 * plain false.
 */
function persistEnabled(): boolean {
  const raw = env("TELEMETRY_PERSIST")
  if (raw !== undefined) return raw === "1" || raw === "true" || raw === "yes"
  return getSetting("telemetryPersist") === true
}

/**
 * What this process WOULD use if it started right now.
 *
 * Called at startup to build the stores, and again by the settings API to
 * detect a pending restart — the same function both times on purpose. A
 * second copy of this precedence chain living in the settings route is how a
 * page ends up confidently reporting a state the proxy is not in.
 */
export function resolveTelemetryConfig(): ResolvedTelemetryConfig {
  return {
    persist: persistEnabled(),
    // The DB path stays env-only, unlike the other three: it is the one value
    // here that names a filesystem location, and a browser form that writes it
    // would let the page choose where the proxy creates files.
    dbPath: env("TELEMETRY_DB") ?? getDefaultDbPath(),
    retentionDays: envInt("TELEMETRY_RETENTION_DAYS", getSetting("telemetryRetentionDays") ?? 7),
    telemetrySize: resolveTelemetryCapacity(),
    diagnosticLogSize: resolveDiagnosticLogCapacity(),
  }
}

/**
 * How a set env var took part in resolveTelemetryConfig:
 *   `value`   its value is what the setting resolves to
 *   `default` it is not a usable value, so the built-in default applies and
 *             the saved setting stays outranked
 *   `ignored` it is empty or not a number, so resolution went on as though it
 *             were unset (the saved setting, else the default)
 */
export type TelemetryEnvUse = "value" | "default" | "ignored"

export interface TelemetryEnvSource extends EnvSource {
  use: TelemetryEnvUse
}

function withUse(source: EnvSource | null, use: TelemetryEnvUse): TelemetryEnvSource | null {
  return source ? { ...source, use } : null
}

function capacityUse(fromEnv: number | null | undefined): TelemetryEnvUse {
  if (fromEnv === undefined) return "ignored"
  return fromEnv === null ? "default" : "value"
}

/**
 * The env var behind each telemetry setting resolveTelemetryConfig reads, for
 * the settings page to name, judged by the same parse each resolver uses.
 */
export function telemetryEnvSources(): Record<"telemetryPersist" | "telemetryRetentionDays" | "telemetrySize" | "diagnosticLogSize", TelemetryEnvSource | null> {
  return {
    telemetryPersist: withUse(envSource("TELEMETRY_PERSIST"), "value"),
    telemetryRetentionDays: withUse(envSource("TELEMETRY_RETENTION_DAYS"),
      envIntValue("TELEMETRY_RETENTION_DAYS") === undefined ? "ignored" : "value"),
    telemetrySize: withUse(envSource("TELEMETRY_SIZE"), capacityUse(telemetryCapacityFromEnv())),
    diagnosticLogSize: withUse(envSource("DIAGNOSTIC_LOG_SIZE"), capacityUse(diagnosticLogCapacityFromEnv())),
  }
}

function createStores(): {
  telemetry: ITelemetryStore
  diagnostics: IDiagnosticLogStore
  /** Null while persisting: SQLite diagnostics are bounded by retention, not
   *  by a ring, so there is no capacity to report. */
  diagnosticLogCapacity: number | null
} {
  const wanted = resolveTelemetryConfig()
  if (!wanted.persist) {
    return {
      telemetry: new MemoryTelemetryStore(wanted.telemetrySize),
      diagnostics: new MemoryDiagnosticLogStore(wanted.diagnosticLogSize),
      diagnosticLogCapacity: wanted.diagnosticLogSize,
    }
  }

  try {
    const { createSqliteStores } = require("./sqlite") as typeof import("./sqlite")
    const { dbPath, retentionDays: retention } = wanted
    const stores = createSqliteStores(dbPath, retention)
    if (!envBool("QUIET")) {
      console.error(`[telemetry] SQLite persistence enabled: ${dbPath} (${retention}d retention)`)
    }
    return { telemetry: stores.telemetry, diagnostics: stores.diagnostics, diagnosticLogCapacity: null }
  } catch (err) {
    // This catch covers the whole setup, not just the import: a bad
    // MERIDIAN_TELEMETRY_DB path, a directory that cannot be created, a file
    // owned by another user. Naming libsql as the cause was a guess, and a
    // wrong one for every failure but the first - libsql is a regular
    // dependency, so "run npm install libsql" sends a user with a permissions
    // problem to reinstall something they already have. Say what happened.
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[telemetry] MERIDIAN_TELEMETRY_PERSIST is set but SQLite could not be opened, falling back to in-memory telemetry: ${reason}`)
    return {
      telemetry: new MemoryTelemetryStore(wanted.telemetrySize),
      diagnostics: new MemoryDiagnosticLogStore(wanted.diagnosticLogSize),
      diagnosticLogCapacity: wanted.diagnosticLogSize,
    }
  }
}

const stores = createStores()

export const telemetryStore: ITelemetryStore = stores.telemetry
export const diagnosticLog: IDiagnosticLogStore = stores.diagnostics

/**
 * Entries the running diagnostic ring holds, null when persisting.
 *
 * The metric store reports its own shape through `describe()`; the log store
 * has no such method, and adding one to IDiagnosticLogStore for a single
 * number would widen an interface two classes implement.
 */
export const diagnosticLogCapacity: number | null = stores.diagnosticLogCapacity

export { MemoryTelemetryStore } from "./store"
export { MemoryDiagnosticLogStore } from "./logStore"
export { createTelemetryRoutes } from "./routes"
export { landingHtml } from "./landing"
export { computePercentiles, computeSummary } from "./percentiles"
export { collapseRouteChains, summarizeRoutes } from "./routeChain"
export { renderPrometheusMetrics } from "./prometheus"
export { createSqliteStores } from "./sqlite"
export type {
  RequestMetric,
  RouteHop,
  RouteKind,
  RouteProfileTally,
  RouteSummary,
  ResolvedTelemetryConfig,
  TelemetryRetention,
  TelemetrySummary,
  PhaseTiming,
  ITelemetryStore,
  IDiagnosticLogStore,
  DiagnosticLog,
} from "./types"
