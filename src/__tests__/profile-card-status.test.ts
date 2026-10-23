/**
 * The duplicate badge and the post-sign-in "updating" state both live pages
 * draw. Evaluated from the shipped browser source, so what is asserted here is
 * what / and /profiles run.
 */
import { describe, expect, test } from "bun:test"
import { profileCardStatusJs } from "../telemetry/profileCardStatus"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

type View = { state: "updating" } | { state: "failed"; error: string } | null
type Status = {
  duplicateBadgeHtml: (p: Record<string, unknown>, cls: string) => string
  beginUpdate: (id: string) => void
  updateOf: (p: Record<string, unknown>, requestedAt: number | null) => View
  updating: (id: string) => boolean
  updateHtml: (view: View) => string
}

const load = () => new Function(profileCardStatusJs + "\nreturn meridianCardStatus;")() as Status

describe("duplicate badge", () => {
  test("names the other profile and says what proved it", () => {
    const html = load().duplicateBadgeHtml({ id: "n-dh-c1", duplicateOf: ["dn-dh-c1"], duplicateBasis: "account-organization" }, "profile-badge")
    expect(html).toContain('class="profile-badge badge-duplicate"')
    expect(html).toContain("duplicate of dn-dh-c1")
    expect(html).toContain("the same Claude account in the same organization")
  })

  test("no duplicates, or an instance too old to say, draws nothing", () => {
    const status = load()
    expect(status.duplicateBadgeHtml({ id: "a", duplicateOf: [] }, "x")).toBe("")
    expect(status.duplicateBadgeHtml({ id: "a" }, "x")).toBe("")
  })

  test("a profile name is escaped", () => {
    expect(load().duplicateBadgeHtml({ id: "a", duplicateOf: ["<b>"] }, "x")).toContain("&lt;b&gt;")
  })
})

describe("updating after a sign-in", () => {
  test("the server's updating state shows a spinner", () => {
    const status = load()
    const view = status.updateOf({ id: "a", factsRefresh: { state: "updating", since: 1 } }, Date.now())
    expect(view).toEqual({ state: "updating" })
    expect(status.updateHtml(view)).toContain("card-spinner")
    expect(status.updateHtml(view)).toContain("Updating with the new sign-in\u2026")
  })

  test("an answer requested before the sign-in finished cannot clear it", () => {
    const status = load()
    const before = Date.now() - 1_000
    status.beginUpdate("a")
    expect(status.updateOf({ id: "a", factsRefresh: null }, before)).toEqual({ state: "updating" })
    expect(status.updating("a")).toBe(true)
    // The first answer asked for afterwards, saying nothing is running, ends it.
    expect(status.updateOf({ id: "a", factsRefresh: null }, Date.now() + 1)).toBeNull()
    expect(status.updating("a")).toBe(false)
  })

  test("a failed refresh shows its reason on the card", () => {
    const status = load()
    status.beginUpdate("a")
    const view = status.updateOf({ id: "a", factsRefresh: { state: "failed", error: "Anthropic did not answer" } }, Date.now() + 1)
    expect(view).toEqual({ state: "failed", error: "Anthropic did not answer" })
    expect(status.updateHtml(view)).toContain('role="alert"')
    expect(status.updateHtml(null)).toBe("")
  })
})

describe("the pages", () => {
  for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
    test(`${name} draws the duplicate badge and the updating state`, () => {
      expect(html).toContain("var meridianCardStatus=(function(){")
      expect(html).toContain("meridianCardStatus.duplicateBadgeHtml(")
      expect(html).toContain("meridianCardStatus.updateHtml(")
      expect(html).toContain(".badge-duplicate")
    })
  }

  test("/profiles starts the updating state when a sign-in finishes, Claude and ChatGPT alike", () => {
    const begins = profilePageHtml.match(/meridianCardStatus\.beginUpdate\(/g) ?? []
    // Claude re-login, Claude add, ChatGPT re-login, ChatGPT connect.
    expect(begins.length).toBe(4)
  })
})
