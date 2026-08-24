import { join } from "node:path"
import { homedir } from "node:os"
import { envBool, env, envInt } from "../env"
import { MemoryTelemetryStore } from "./store"
import { MemoryDiagnosticLogStore } from "./logStore"
import type { ITelemetryStore, IDiagnosticLogStore } from "./types"

function getDefaultDbPath(): string {
  return join(homedir(), ".config", "meridian", "telemetry.db")
}

function createStores(): { telemetry: ITelemetryStore; diagnostics: IDiagnosticLogStore } {
  if (!envBool("TELEMETRY_PERSIST")) {
    return {
      telemetry: new MemoryTelemetryStore(),
      diagnostics: new MemoryDiagnosticLogStore(),
    }
  }

  try {
    const { createSqliteStores } = require("./sqlite") as typeof import("./sqlite")
    const dbPath = env("TELEMETRY_DB") ?? getDefaultDbPath()
    const retention = envInt("TELEMETRY_RETENTION_DAYS", 7)
    const stores = createSqliteStores(dbPath, retention)
    console.error(`[telemetry] SQLite persistence enabled: ${dbPath} (${retention}d retention)`)
    return { telemetry: stores.telemetry, diagnostics: stores.diagnostics }
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
      telemetry: new MemoryTelemetryStore(),
      diagnostics: new MemoryDiagnosticLogStore(),
    }
  }
}

const stores = createStores()

export const telemetryStore: ITelemetryStore = stores.telemetry
export const diagnosticLog: IDiagnosticLogStore = stores.diagnostics

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
  TelemetryRetention,
  TelemetrySummary,
  PhaseTiming,
  ITelemetryStore,
  IDiagnosticLogStore,
  DiagnosticLog,
} from "./types"
