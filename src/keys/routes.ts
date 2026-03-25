/**
 * Admin API routes for key management.
 *
 * All routes require CLAUDE_PROXY_MASTER_KEY in the Authorization header.
 *
 * GET    /admin           — Dashboard (HTML)
 * GET    /admin/keys      — List all keys (JSON)
 * POST   /admin/keys      — Create a key { name }
 * DELETE /admin/keys/:id  — Delete a key
 * PATCH  /admin/keys/:id  — Update a key { enabled }
 */

import { env } from "../env"
import { Hono } from "hono"
import { keyStore } from "./store"
import { adminDashboardHtml } from "./dashboard"
import { MODEL_CATALOG } from "../proxy/openai"
import { getProxySettings, updateProxySettings } from "./settings"
import { createTelemetryRoutes } from "../telemetry"
import { isAdminConfigured, verifyMasterKey, generateJwt, verifyJwt } from "./auth"

export function createAdminRoutes() {
  const routes = new Hono()

  // Admin auth middleware — JWT-based
  routes.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname

    // Allow dashboard HTML and login endpoint without auth
    const isDashboard = path === "/admin" || path === "/admin/"
    const isTelemetryDashboard = (path === "/admin/telemetry" || path === "/admin/telemetry/") && c.req.method === "GET"
    const isLogin = (path === "/admin/login" || path === "/admin/login/") && c.req.method === "POST"
    if ((isDashboard || isTelemetryDashboard) && c.req.method === "GET") return next()
    if (isLogin) return next()

    if (!isAdminConfigured()) {
      return c.json({ error: "Admin not configured. Set MERIDIAN_MASTER_KEY or CLAUDE_PROXY_MASTER_KEY." }, 503)
    }

    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
    if (!bearer || !verifyJwt(bearer)) {
      return c.json({ error: "Invalid or expired session. Please login again." }, 401)
    }
    return next()
  })

  // Dashboard
  routes.get("/", (c) => c.html(adminDashboardHtml))

  // Login — verify master key, return JWT
  routes.post("/login", async (c) => {
    const body = await c.req.json()
    const key = body?.key
    if (!key || typeof key !== "string") {
      return c.json({ error: "Master key required" }, 400)
    }
    if (!isAdminConfigured()) {
      return c.json({ error: "Admin not configured. Set MERIDIAN_MASTER_KEY." }, 503)
    }
    if (!verifyMasterKey(key)) {
      return c.json({ error: "Invalid master key" }, 401)
    }
    return c.json({ token: generateJwt() })
  })

  // Telemetry dashboard and API (nested under /admin/telemetry)
  routes.route("/telemetry", createTelemetryRoutes())

  // List available models
  routes.get("/models", (c) => c.json(MODEL_CATALOG))

  // Proxy settings
  routes.get("/settings", (c) => c.json(getProxySettings()))
  routes.patch("/settings", async (c) => {
    const body = await c.req.json()
    const updated = updateProxySettings(body)
    return c.json(updated)
  })

  // Aggregate stats for a time window
  routes.get("/stats", (c) => {
    const windowMs = parseInt(c.req.query("window") || "0", 10)
    return c.json(keyStore.getAggregateStats(windowMs))
  })

  // List keys (optional ?window= for windowed usage stats)
  routes.get("/keys", (c) => {
    const windowMs = parseInt(c.req.query("window") || "0", 10)
    return c.json(keyStore.list(windowMs))
  })

  // Create key
  routes.post("/keys", async (c) => {
    const body = await c.req.json()
    const name = body?.name
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400)
    }
    const key = keyStore.create(name.trim())
    // Return the full key (unmasked) only on creation
    return c.json(key, 201)
  })

  // Reveal full key (for copy)
  routes.get("/keys/:id/reveal", (c) => {
    const key = keyStore.reveal(c.req.param("id"))
    if (!key) return c.json({ error: "Key not found" }, 404)
    return c.json({ key })
  })

  // Delete key
  routes.delete("/keys/:id", (c) => {
    const deleted = keyStore.delete(c.req.param("id"))
    if (!deleted) return c.json({ error: "Key not found" }, 404)
    return c.json({ ok: true })
  })

  // Update key (toggle enabled or set limits)
  routes.patch("/keys/:id", async (c) => {
    const body = await c.req.json()
    const id = c.req.param("id")

    if (typeof body?.enabled === "boolean") {
      const updated = keyStore.setEnabled(id, body.enabled)
      if (!updated) return c.json({ error: "Key not found" }, 404)
    }
    if (body?.limits) {
      const updated = keyStore.setLimits(id, body.limits)
      if (!updated) return c.json({ error: "Key not found" }, 404)
    }

    return c.json(keyStore.get(id))
  })

  // Get usage windows for a key
  routes.get("/keys/:id/usage", (c) => {
    const id = c.req.param("id")
    const key = keyStore.get(id)
    if (!key) return c.json({ error: "Key not found" }, 404)
    return c.json({
      used6h: key.used6h || 0,
      usedWeekly: key.usedWeekly || 0,
      limit6h: key.limits?.limit6h || 0,
      limitWeekly: key.limits?.limitWeekly || 0,
    })
  })

  return routes
}
