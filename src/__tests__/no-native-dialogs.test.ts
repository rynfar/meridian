/**
 * Meridian's pages never open the browser's own alert, confirm or prompt
 * boxes: they block the page, cannot be styled, and printed `[object Object]`
 * when the value handed to them was an error object. Every page uses the
 * shared in-page dialog (telemetry/dialog.ts) instead.
 */
import { describe, expect, it } from "bun:test"
import { dashboardHtml } from "../telemetry/dashboard"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"
import { providerPageHtml } from "../telemetry/providerPage"
import { settingsPageHtml } from "../telemetry/settingsPage"
import { pluginPageHtml } from "../proxy/plugins/pluginPage"
import { dialogErrorText } from "../telemetry/dialog"

const PAGES: Record<string, string> = {
  "/": landingHtml,
  "/profiles": profilePageHtml,
  "/settings": settingsPageHtml,
  "/telemetry": dashboardHtml,
  "/providers": providerPageHtml,
  "/plugins": pluginPageHtml,
}

function scriptsOf(html: string): string {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n")
}

function htmlAttributeHandlers(html: string): string {
  return [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map(m => m[1]).join("\n")
}

describe("served pages use no native dialogs", () => {
  for (const [route, html] of Object.entries(PAGES)) {
    it(`${route} calls none of alert, confirm or prompt`, () => {
      const code = scriptsOf(html) + "\n" + htmlAttributeHandlers(html)
      expect(code.length).toBeGreaterThan(0)
      // A call has no space before its parenthesis; prose such as "system
      // prompt (tool usage...)" does.
      expect(code.match(/(?<![\w$.])(alert|confirm|prompt)\(|\bwindow\.(alert|confirm|prompt)\b/g) ?? []).toEqual([])
    })
  }

  it("each page that reports errors carries the shared dialog", () => {
    for (const route of ["/", "/profiles", "/settings"]) {
      expect(scriptsOf(PAGES[route]!)).toContain("var meridianDialog")
    }
  })
})

describe("dialogErrorText", () => {
  it("passes a plain message through", () => {
    expect(dialogErrorText({ error: "No profiles configured" }, "Failed")).toBe("No profiles configured")
  })

  it("reads an Anthropic-style error object instead of printing [object Object]", () => {
    const text = dialogErrorText({ type: "error", error: { type: "profile_excluded", message: 'Profile "x" is excluded from work routing' } }, "Failed")
    expect(text).toBe('Profile "x" is excluded from work routing (profile_excluded)')
    expect(text).not.toContain("[object Object]")
  })

  it("adds the code beside a string error", () => {
    expect(dialogErrorText({ error: "Profile needs a login", code: "needs_login" }, "Failed")).toBe("Profile needs a login (needs_login)")
  })

  it("falls back when the reply carries no readable error", () => {
    expect(dialogErrorText(null, "Could not reach Meridian.")).toBe("Could not reach Meridian.")
    expect(dialogErrorText({ error: {} }, "Failed to save")).toBe("Failed to save")
    expect(dialogErrorText("boom", "Failed")).toBe("boom")
  })
})
