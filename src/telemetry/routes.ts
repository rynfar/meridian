/**
 * Telemetry API routes.
 *
 * GET /telemetry            — HTML dashboard
 * GET /telemetry/requests   — Recent request metrics (JSON)
 * GET /telemetry/summary    — Aggregate statistics (JSON)
 * GET /telemetry/logs       — Diagnostic logs (JSON)
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { telemetryStore, diagnosticLog } from "./index"
import { dashboardHtml } from "./dashboard"
import { collapseRouteChains, summarizeRoutes } from "./routeChain"

/** Upper bound on the rows one /routes tally reads, matching the memory
 *  store's ring capacity so a window inside it is covered exactly. */
const ROUTE_SUMMARY_MAX_ROWS = 1000

// Read once at module load — src/telemetry/ is two levels below the package root
const _iconPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "icon.svg")
const _iconSvg = existsSync(_iconPath) ? readFileSync(_iconPath, "utf-8") : null

export function createTelemetryRoutes() {
  const routes = new Hono()

  // Dashboard
  routes.get("/", (c) => {
    return c.html(dashboardHtml)
  })

  // Favicon
  routes.get("/icon.svg", (c) => {
    if (!_iconSvg) return c.notFound()
    return c.body(_iconSvg, 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600",
    })
  })

  // Recent requests
  routes.get("/requests", (c) => {
    const limit = Number.parseInt(c.req.query("limit") || "50", 10)
    const since = c.req.query("since") ? Number.parseInt(c.req.query("since")!, 10) : undefined
    const model = c.req.query("model") || undefined

    const requests = telemetryStore.getRecent({
      limit: Math.min(limit, 500),
      since,
      model,
    })

    // Priority failover writes one row per account attempted; fold them back
    // into one row per client request, carrying the chain. `?hops=1` opts out
    // and returns the raw attempts.
    if (c.req.query("hops") === "1") return c.json(requests)
    return c.json(collapseRouteChains(requests))
  })

  // Where the window's requests went, and which accounts refused them.
  // Same store read and the same fold the requests view uses — a failover is
  // one request here, not one per account it tried.
  routes.get("/routes", (c) => {
    const raw = Number.parseInt(c.req.query("window") || "3600000", 10)
    const windowMs = Number.isFinite(raw) && raw > 0 ? raw : 3600000
    const metrics = telemetryStore.getRecent({ limit: ROUTE_SUMMARY_MAX_ROWS, since: Date.now() - windowMs })
    return c.json({ windowMs, ...summarizeRoutes(collapseRouteChains(metrics)) })
  })

  // What the store holds and for how long, so the page can say which of its
  // offered windows it can actually cover.
  routes.get("/retention", (c) => {
    return c.json({ ...telemetryStore.describe(), asOf: Date.now() })
  })

  // Aggregate summary
  routes.get("/summary", (c) => {
    const windowMs = Number.parseInt(c.req.query("window") || "3600000", 10) // default 1 hour

    const summary = telemetryStore.summarize(windowMs)
    return c.json(summary)
  })

  // Diagnostic logs
  routes.get("/logs", (c) => {
    const limit = Number.parseInt(c.req.query("limit") || "100", 10)
    const since = c.req.query("since") ? Number.parseInt(c.req.query("since")!, 10) : undefined
    const category = c.req.query("category") || undefined

    const logs = diagnosticLog.getRecent({
      limit: Math.min(limit, 500),
      since,
      category,
    })

    return c.json(logs)
  })

  return routes
}
