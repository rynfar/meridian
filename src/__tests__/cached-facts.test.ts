/**
 * Provenance markers for remembered values — pure functions, no mocks, plus the
 * profile page's contract that it actually renders them.
 *
 * The behaviour under test is a reader's question: is this number one the
 * check just took, one it took earlier and could not confirm, or one it has
 * never taken at all? The first two look identical on screen without a marker,
 * and the third used to look like nothing at all.
 */

import { describe, it, expect, test } from "bun:test"
import {
  CACHED_TEXT,
  NEVER_READ_TEXT,
  cachedTag,
  factProvenance,
  renderFactValue,
} from "../telemetry/cachedFacts"
import { profilePageHtml } from "../telemetry/profilePage"

describe("factProvenance", () => {
  it("calls a value from the check that just ran live", () => {
    expect(factProvenance("max", false)).toBe("live")
  })

  it("calls a value the failed check inherited cached", () => {
    expect(factProvenance("max", true)).toBe("cached")
  })

  it("calls an absent value never, whether or not the check failed", () => {
    expect(factProvenance(null, true)).toBe("never")
    expect(factProvenance(undefined, false)).toBe("never")
  })

  it("treats an empty string as absent rather than as a live reading of nothing", () => {
    expect(factProvenance("", false)).toBe("never")
    expect(factProvenance("", true)).toBe("never")
  })
})

describe("cachedTag", () => {
  it("marks a cached value", () => {
    expect(cachedTag("cached")).toContain(CACHED_TEXT)
    expect(cachedTag("cached")).toContain("cached-tag")
  })

  it("leaves a live value unmarked", () => {
    expect(cachedTag("live")).toBe("")
  })

  it("does not mark a value that was never read — there is nothing to date", () => {
    expect(cachedTag("never")).toBe("")
  })
})

describe("renderFactValue", () => {
  it("renders a live value with no marker at all", () => {
    const html = renderFactValue("alice@example.com", false)
    expect(html).toBe('<span class="detail-value">alice@example.com</span>')
    expect(html).not.toContain(CACHED_TEXT)
  })

  it("renders a cached value with the marker to the right of it", () => {
    const html = renderFactValue("alice@example.com", true) ?? ""
    expect(html).toContain("alice@example.com")
    expect(html).toContain(CACHED_TEXT)
    // "to the right of each value" — the marker follows the value, never leads it.
    expect(html.indexOf("alice@example.com")).toBeLessThan(html.indexOf(CACHED_TEXT))
  })

  it("renders never-known differently from known-but-stale rather than collapsing both", () => {
    const stale = renderFactValue("20x", true)
    const never = renderFactValue(null, true)

    expect(stale).not.toBe(never)
    // The stale one still carries the figure; the never one must not invent it.
    expect(stale).toContain("20x")
    expect(never).not.toContain("20x")
    expect(never).toContain(NEVER_READ_TEXT)
    // And a never-read value is not dated — claiming "(cached)" would assert a
    // reading that was never taken.
    expect(never).not.toContain(CACHED_TEXT)
  })

  it("omits the row when a SUCCESSFUL check found no value — not applicable, not stale", () => {
    expect(renderFactValue(null, false)).toBeNull()
    expect(renderFactValue("", false)).toBeNull()
  })

  it("keeps the caller's status class alongside detail-value", () => {
    expect(renderFactValue("\u2713 Authenticated", false, "status-ok"))
      .toContain('class="detail-value status-ok"')
    expect(renderFactValue(null, true, "status-err"))
      .toContain("detail-unknown")
  })

  it("escapes the value — emails and plan names come from a credential file", () => {
    const html = renderFactValue('<img src=x onerror="alert(1)">', true) ?? ""
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
    expect(html).toContain(CACHED_TEXT)
  })
})

describe("the profile page renders the marker", () => {
  test("the page styles the marker and the never-read stand-in", () => {
    expect(profilePageHtml).toContain(".cached-tag")
    expect(profilePageHtml).toContain(".detail-unknown")
  })

  test("the page's inline script can emit both states", () => {
    expect(profilePageHtml).toContain(CACHED_TEXT)
    expect(profilePageHtml).toContain(NEVER_READ_TEXT)
  })

  test("the marker is muted rather than competing with the value it annotates", () => {
    expect(profilePageHtml).toMatch(/\.cached-tag\s*\{[^}]*var\(--muted\)/)
  })
})
