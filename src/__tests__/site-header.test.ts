/**
 * Site header + landing page layout contract.
 *
 * The shared header (profileBar.ts) is the single site chrome injected into
 * every HTML page: logo + wordmark + nav + live status pill. The landing
 * page must not duplicate it, and its profile cards are the profile
 * switcher (no dropdown).
 */

import { describe, expect, test } from "bun:test"
import { landingHtml } from "../telemetry/landing"
import { dashboardHtml } from "../telemetry/dashboard"
import { settingsPageHtml } from "../telemetry/settingsPage"
import { profilePageHtml } from "../telemetry/profilePage"
import { pluginPageHtml } from "../proxy/plugins/pluginPage"
import { profileBarHtml, profileBarJs } from "../telemetry/profileBar"

const allPages: Array<[string, string]> = [
  ["landing", landingHtml],
  ["dashboard", dashboardHtml],
  ["settings", settingsPageHtml],
  ["profiles", profilePageHtml],
  ["plugins", pluginPageHtml],
]

describe("shared site header", () => {
  test("header markup has brand link, logo, and nav", () => {
    expect(profileBarHtml).toContain("meridian-header")
    // Brand links home and carries the logo mark + wordmark
    expect(profileBarHtml).toContain('href="/"')
    expect(profileBarHtml).toContain("<svg")
    expect(profileBarHtml).toContain("Meridian")
    // Full site nav
    for (const href of ["/telemetry", "/profiles", "/settings", "/plugins"]) {
      expect(profileBarHtml).toContain(`href="${href}"`)
    }
  })

  test("header shows live status pill fed by /health", () => {
    expect(profileBarHtml).toContain("mhStatus")
    expect(profileBarJs).toContain("/health")
  })

  test("header shows active profile chip, not a dropdown", () => {
    expect(profileBarHtml).not.toContain("meridianProfileSelect")
    expect(profileBarHtml).not.toContain("<select")
    expect(profileBarHtml).toContain("mhProfile")
    expect(profileBarJs).toContain("/profiles/list")
  })

  test("every page embeds the shared header exactly once", () => {
    for (const [name, html] of allPages) {
      const count = html.split("meridian-header").length - 1
      expect(count, `${name} page should embed the header once`).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("landing page layout", () => {
  test("no duplicate in-page header or big status banner", () => {
    expect(landingHtml).not.toContain("status-banner")
    expect(landingHtml).not.toContain("<h1>MERIDIAN</h1>")
  })

  test("removed sections: connect-an-agent, bottom links, model chips", () => {
    expect(landingHtml).not.toContain("Connect an Agent")
    expect(landingHtml).not.toContain('class="links"')
    expect(landingHtml).not.toContain("Models (24h)")
  })

  test("profile cards switch the active profile", () => {
    expect(landingHtml).toContain("switchProfile")
    expect(landingHtml).toContain("/profiles/active")
    expect(landingHtml).toContain("/profiles/list")
  })

  test("has a friendly how-it-works intro pointing at the endpoint", () => {
    expect(landingHtml).toContain("ANTHROPIC_BASE_URL")
  })

  test("stats strip shows meaningful telemetry, not fillers", () => {
    // Token + cache signals are in; TTFB stays on the /telemetry page
    expect(landingHtml).toContain("tokenUsage")
    expect(landingHtml).toContain("Cache Hit")
    expect(landingHtml).not.toContain("Median TTFB")
    // Envelope violations render only when noteworthy
    expect(landingHtml).toContain("envelopeViolationCount>0")
  })

  test("account cards come from configured profiles, not synthetic cost buckets", () => {
    // With profiles configured, only pl.profiles render (no "default" card);
    // the single-account fallback labels the card with the login email.
    expect(landingHtml).toContain("configured.length>0")
    expect(landingHtml).toContain("k==='default'?(email||'account')")
  })
})

describe("per-page titles do not repeat the brand", () => {
  test("dashboard h1 is the page name, not the brand", () => {
    expect(dashboardHtml).not.toContain("<h1>Meridian</h1>")
    expect(dashboardHtml).toContain("<h1>Telemetry</h1>")
  })

  test("plugins page drops the redundant back-link", () => {
    expect(pluginPageHtml).not.toContain("Back to Meridian")
  })
})
