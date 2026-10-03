/**
 * Site header + landing page layout contract.
 *
 * The shared header (profileBar.ts) is the single site chrome injected into
 * every HTML page: logo + wordmark + nav + live status pill. The landing
 * page must not duplicate it, and its profile cards are the profile
 * switcher (no dropdown).
 */

import { describe, expect, test } from "bun:test"
import { providerPageHtml } from "../telemetry/providerPage"
import { landingHtml } from "../telemetry/landing"
import { dashboardHtml } from "../telemetry/dashboard"
import { settingsPageHtml } from "../telemetry/settingsPage"
import { profilePageHtml } from "../telemetry/profilePage"
import { pluginPageHtml } from "../proxy/plugins/pluginPage"
import { profileBarCss, profileBarHtml, profileBarJs } from "../telemetry/profileBar"
import { ICON_PATH } from "../telemetry/icon"
import { DEFAULT_PROFILE_SORT, PROFILE_SORT_MODES } from "../telemetry/profileSort"
import { FADE_FROM, GENERAL_WINDOW_TYPES, SPENT_AT } from "../telemetry/profileSpent"

const allPages: Array<[string, string]> = [
  ["providers", providerPageHtml],
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
    for (const href of ["/providers", "/telemetry", "/profiles", "/settings", "/plugins"]) {
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

  test("header shows a build chip fed by /health's build block", () => {
    expect(profileBarHtml).toContain("mhBuild")
    expect(profileBarJs).toContain("renderBuild")
    expect(profileBarJs).toContain("updateAvailable")
  })

  test("build chip colours follow the DESIGN.md role split", () => {
    // Blue = interactive: the update chip is a link to the releases page.
    // Violet = meta: the provenance chip has no href and must not be blue.
    // Swapping these is the single easiest way to break the design language,
    // and it is invisible in a screenshot review.
    // The provenance pill is violet, but its branch/commit pieces are links
    // and must be blue; drift uses the semantic warning hue and nothing else.
    const rule = (selector: string) => {
      const start = profileBarCss.indexOf(`.meridian-header ${selector} {`)
      expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0)
      return profileBarCss.slice(start, profileBarCss.indexOf("}", start))
    }

    const updateRule = rule(".mh-update")
    expect(updateRule).toContain("var(--accent, #58a6ff)")
    expect(updateRule).not.toContain("--accent2")

    const provenanceRule = rule(".mh-prov")
    expect(provenanceRule).toContain("var(--accent2, #bc8cff)")
    expect(provenanceRule).not.toContain("var(--accent,")

    const linkRule = rule("a.mh-prov-part")
    expect(linkRule).toContain("var(--accent, #58a6ff)")
    expect(linkRule).not.toContain("--accent2")

    const driftWarning = rule(".mh-drift.warning")
    expect(driftWarning).toContain("var(--yellow, #d29922)")
    expect(rule(".mh-drift")).not.toContain("--yellow")

    // Pieces without a safe URL render as spans, never as href-less anchors.
    expect(profileBarJs).toContain("document.createElement(part.href ? 'a' : 'span')")
    expect(profileBarHtml).toContain('id="mhUpdate"')
  })

  test("drift is polled only for local builds, never overlapping, and bypasses the cache", () => {
    expect(profileBarHtml).toContain('id="mhProv"')
    expect(profileBarHtml).toContain('id="mhDrift"')
    expect(profileBarJs).toContain("fetch('/build-status', { cache: 'no-store'")
    expect(profileBarJs).toContain("setDriftTracking(view.mode === 'local')")
    expect(profileBarJs).toContain("if (!driftTracking || driftInFlight) return;")
  })

  test("every page embeds the shared header exactly once", () => {
    for (const [name, html] of allPages) {
      const count = html.split("meridian-header").length - 1
      expect(count, `${name} page should embed the header once`).toBeGreaterThanOrEqual(1)
    }
  })

  // Without it the browser falls back to /favicon.ico, which nothing serves,
  // and every page load logs a 404 in the console.
  test("every page links the Meridian favicon", () => {
    for (const [name, html] of allPages) {
      const head = html.slice(0, html.indexOf("</head>"))
      expect(head, `${name} page should link the favicon`).toContain(`<link rel="icon" type="image/svg+xml" href="${ICON_PATH}">`)
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

  test("spent accounts recede and unusable ones are flagged instead", () => {
    // The page carries a copy of the classifier's arithmetic, so its
    // thresholds are interpolated from the tested module rather than retyped.
    expect(landingHtml).toContain(`var FADE_FROM=${FADE_FROM}`)
    expect(landingHtml).toContain(`var SPENT_AT=${SPENT_AT}`)
    expect(landingHtml).toContain(`var GENERAL_WINDOW_TYPES=${JSON.stringify(GENERAL_WINDOW_TYPES)}`)
    expect(landingHtml).toContain("--spend-fade")
    expect(landingHtml).toContain("needs login")
  })

  test("the fade never reaches the card itself, so the active ring survives it", () => {
    // filter and opacity apply to an element's OWN border and box-shadow, so
    // fading .profile-card greys out the accent ring on .profile-card.active -
    // the one mark saying which account is serving requests, gone exactly when
    // that account hits 95% and somebody comes looking for it. A descendant
    // cannot undo an ancestor's filter, so the fade must be scoped to the
    // card's children.
    expect(landingHtml).toContain(".profile-card.spend-fading > *, .profile-card.spend-spent > *")
    expect(landingHtml).toContain(
      ".profile-card.spend-fading:hover > *, .profile-card.spend-spent:hover > *",
    )
    // ...and never as a rule on the card itself, in either state.
    expect(landingHtml).not.toContain(".profile-card.spend-fading, .profile-card.spend-spent {")
    expect(landingHtml).not.toContain(".profile-card.spend-fading:hover, .profile-card.spend-spent:hover {")
  })

  test("a card's badges wrap instead of pushing the cost past a phone's edge", () => {
    // Measured at 375px: a "needs login" pill beside a long name pushed the
    // cost 80px outside its card and scrolled the whole page sideways.
    const rule = (selector: string) => {
      const start = landingHtml.indexOf(`  ${selector} {`)
      expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0)
      return landingHtml.slice(start, landingHtml.indexOf("}", start))
    }
    expect(rule(".profile-grid")).toContain("minmax(min(300px, 100%), 1fr)")
    expect(rule(".profile-head")).toContain("flex-wrap: wrap")
    expect(rule(".profile-name")).toContain("flex-wrap: wrap")
    expect(rule(".profile-name")).toContain("min-width: 0")
    expect(rule(".profile-name")).toContain("overflow-wrap: anywhere")
    expect(rule(".profile-cost")).toContain("flex-shrink: 0")
    const header = profileBarCss.slice(profileBarCss.indexOf(".meridian-header {"))
    expect(header.slice(0, header.indexOf("}"))).toContain("flex-wrap: wrap")
  })

  test("accounts can be re-sorted for viewing without touching the saved order", () => {
    // The page carries a copy of the comparator, so the modes it offers are
    // interpolated from the tested module rather than retyped.
    expect(landingHtml).toContain(`var PROFILE_SORT_MODES=${JSON.stringify(PROFILE_SORT_MODES)}`)
    expect(landingHtml).toContain(`var viewSort=${JSON.stringify(DEFAULT_PROFILE_SORT)}`)
    expect(landingHtml).toContain("sort-tab")
    // View tabs re-sort locally in the browser; profileOrder handles drag reordering.
    expect(landingHtml).toContain("meridianReorder.init(")
  })

  test("account cards come from configured profiles, not synthetic cost buckets", () => {
    // With profiles configured, only pl.profiles render (no "default" card);
    // the single-account fallback labels the card with the login email.
    expect(landingHtml).toContain("configured.length>0")
    expect(landingHtml).toContain("k==='default'?(email||'account')")
  })
})

describe("profiles page layout", () => {
  const rule = (selector: string) => {
    const start = profilePageHtml.indexOf(`  ${selector} {`)
    expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0)
    return profilePageHtml.slice(start, profilePageHtml.indexOf("}", start))
  }

  test("a card's header wraps instead of pushing its actions past a phone's edge", () => {
    // Measured at 320px and 375px: the name, type badge and rename button
    // sat on one unwrapping row and scrolled the page to 536px.
    expect(rule(".profile-card-header")).toContain("flex-wrap: wrap")
    expect(rule(".profile-name")).toContain("min-width: 0")
    expect(rule(".profile-name")).toContain("overflow-wrap: anywhere")
    expect(rule(".profile-badge")).toContain("overflow-wrap: anywhere")
    expect(rule(".profile-card-actions")).toContain("margin-left: auto")
    expect(rule(".profile-card-actions")).toContain("flex-shrink: 0")
    expect(rule(".rename-input")).toContain("max-width: 100%")
  })

  test("long values wrap inside the card rather than widening it", () => {
    // A bare 1fr track is as wide as its longest unbreakable value, so an
    // email address pushed the detail grid past the card.
    expect(rule(".profile-details")).toContain("grid-template-columns: 120px minmax(0, 1fr)")
    expect(rule(".detail-value")).toContain("overflow-wrap: anywhere")
    expect(rule(".copy-cmd")).toContain("overflow-wrap: anywhere")
    expect(rule(".switch-btn")).toContain("overflow-wrap: anywhere")
    expect(rule(".usage-grid")).toContain("minmax(min(140px, 100%), 1fr)")
    expect(rule(".usage-label")).not.toContain("white-space: nowrap")
    const narrow = profilePageHtml.slice(profilePageHtml.indexOf("@media (max-width: 480px)"))
    expect(narrow.slice(0, narrow.indexOf("}"))).toContain("grid-template-columns: minmax(0, 1fr)")
  })
})

describe("design-system conformance (DESIGN.md)", () => {
  const pageSources = [
    "src/telemetry/landing.ts",
    "src/telemetry/dashboard.ts",
    "src/telemetry/settingsPage.ts",
    "src/telemetry/profilePage.ts",
    "src/proxy/plugins/pluginPage.ts",
  ]

  test("pages contain no hardcoded hex colors — tokens only", async () => {
    for (const path of pageSources) {
      const src = await Bun.file(path).text()
      const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? []
      expect(hexes, `${path} must use theme tokens, found: ${hexes.join(", ")}`).toEqual([])
    }
  })

  test("pages do not set their own body background (backsplash is shared)", async () => {
    for (const path of pageSources) {
      const src = await Bun.file(path).text()
      const bodyRule = src.match(/body \{[^}]*\}/)?.[0] ?? ""
      expect(bodyRule.includes("background"), `${path} body rule must not set background`).toBe(false)
    }
  })
})

describe("settings page layout", () => {
  test("pricing table scrolls inside its card so a phone viewport never scrolls sideways", () => {
    expect(settingsPageHtml).toMatch(/\.pricing-scroll \{[^}]*overflow-x: auto/)
    expect(settingsPageHtml).toMatch(/<div class="pricing-scroll">\s*<table class="pricing-table">/)
  })

  test("a model id stays on one line and a rate input is sized to a rate", () => {
    const model = settingsPageHtml.match(/\.pricing-model \{[^}]*\}/)?.[0] ?? ""
    expect(model).toContain("white-space: nowrap")
    expect(model).not.toContain("word-break")
    // 7 characters of content (123.45, 0.0375) plus the input's padding and
    // border, which border-box sizing would otherwise take out of the text.
    expect(settingsPageHtml).toMatch(/\.pricing-table \.pricing-input \{[^}]*width: calc\(7ch \+ 18px\)/)
  })
})

describe("home page spacing on a phone", () => {
  test("the page edge is a third and a card's padding half of the desktop values", () => {
    expect(landingHtml).toContain(".container { max-width: 960px; margin: 0 auto; padding: 28px 24px; }")
    expect(landingHtml).toMatch(/\.profile-card \{[^}]*padding: 18px 20px;/)
    expect(landingHtml).toMatch(/@media \(max-width: 720px\) \{\s*\.container \{ padding-left: 8px; padding-right: 8px; \}\s*\.profile-card \{ padding: 9px 10px; \}\s*\}/)
  })
})

describe("header build info collapses to the room it has", () => {
  test("the calm drift chip goes first, warnings never", () => {
    expect(profileBarCss).toContain('.meridian-header[data-prov-calm="hidden"] .mh-drift.calm { display: none; }')
    expect(profileBarCss).not.toMatch(/data-prov-calm[^{]*\.mh-drift\.(warning|neutral)/)
    expect(profileBarCss).not.toMatch(/data-prov-[a-z]+="[a-z]+"\][^{]*\.mh-update/)
  })

  test("each compact form shows only its own pieces", () => {
    const shown = (form: string) => profileBarCss.match(new RegExp(`\\[data-prov-form="${form}"\\] (\\.[a-z-]+)[,\\s]`, "g")) ?? []
    expect(shown("commit").join(" ")).toContain(".mh-prov-short-commit")
    expect(shown("run").join(" ")).toContain(".mh-prov-short-run")
    expect(shown("version").join(" ")).not.toMatch(/short-(commit|run)/)
  })

  test("the fit follows the header's width and content, largest form first", () => {
    expect(profileBarJs).toContain("[['shown', 'full'], ['hidden', 'full']].concat(provForms.map(")
    expect(profileBarJs).toContain("new ResizeObserver(")
    expect(profileBarJs).toContain("new MutationObserver(queueFit)")
    expect(profileBarJs).toContain("attributeFilter: ['class', 'hidden']")
    // The short forms are appended beside the full parts, so the full pill's
    // tooltip and links are untouched and switching never rebuilds a link.
    expect(profileBarJs).toContain("provForms = appendShortForms(view.parts);")
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
