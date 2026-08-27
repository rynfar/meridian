/**
 * Unit tests for profileFacts.ts.
 *
 * The module ships browser source, so the tests evaluate that exact text
 * rather than a TypeScript copy of it — what is asserted here is what both
 * pages actually run.
 */
import { describe, test, expect } from "bun:test"
import { profileFactsJs } from "../telemetry/profileFacts"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

interface Fact { label: string; value: string; tone: string }

const evaluated = new Function(
  profileFactsJs + "\nreturn { profileFacts: profileFacts, timeAgo: timeAgo };",
)() as {
  profileFacts: (p: Record<string, unknown>) => Fact[]
  timeAgo: (ts: number | null | undefined) => string
}

const { profileFacts, timeAgo } = evaluated

function labels(p: Record<string, unknown>): string[] {
  return profileFacts(p).map(f => f.label)
}

function valueOf(p: Record<string, unknown>, label: string): string | undefined {
  return profileFacts(p).find(f => f.label === label)?.value
}

describe("profileFacts", () => {
  test("status is always stated, even for a profile with nothing else known", () => {
    expect(labels({})).toEqual(["Status"])
  })

  test("a logged-in account reads as authenticated, in the affirmative tone", () => {
    const status = profileFacts({ loggedIn: true })[0]!
    expect(status.value).toBe("✓ Authenticated")
    expect(status.tone).toBe("ok")
  })

  test("a logged-out account reads as not logged in, in the error tone", () => {
    const status = profileFacts({ loggedIn: false })[0]!
    expect(status.value).toBe("✗ Not logged in")
    expect(status.tone).toBe("err")
  })

  test("the organization is stated when known", () => {
    expect(valueOf({ organizationName: "Acme Inc" }, "Organization")).toBe("Acme Inc")
  })

  test("an unknown organization is omitted rather than rendered as a placeholder", () => {
    expect(labels({ organizationName: null })).not.toContain("Organization")
    expect(labels({ organizationName: "" })).not.toContain("Organization")
    expect(labels({})).not.toContain("Organization")
  })

  test("the organization sits between the email and the plan", () => {
    const rows = labels({ email: "a@b.c", organizationName: "Acme Inc", subscriptionType: "max" })
    expect(rows).toEqual(["Status", "Email", "Organization", "Plan"])
  })

  test("email and plan are stated when known and omitted when not", () => {
    expect(valueOf({ email: "a@b.c" }, "Email")).toBe("a@b.c")
    expect(valueOf({ subscriptionType: "max" }, "Plan")).toBe("max")
    expect(labels({ email: null, subscriptionType: null })).toEqual(["Status"])
  })

  test("last verified is stated in the affirmative tone", () => {
    const fact = profileFacts({ lastSuccessAt: Date.now() }).find(f => f.label === "Last Verified")!
    expect(fact.value).toBe("just now")
    expect(fact.tone).toBe("ok")
  })

  test("last checked is omitted when it merely repeats last verified", () => {
    const at = Date.now()
    expect(labels({ lastSuccessAt: at, lastCheckedAt: at })).not.toContain("Last Checked")
  })

  test("last checked is stated when it differs from last verified", () => {
    const at = Date.now()
    expect(labels({ lastSuccessAt: at - 60_000, lastCheckedAt: at })).toContain("Last Checked")
  })

  test("last checked is stated when nothing ever verified", () => {
    expect(labels({ loggedIn: false, lastCheckedAt: Date.now() })).toEqual(["Status", "Last Checked"])
  })

  test("the full set reads in card order", () => {
    const at = Date.now()
    expect(labels({
      loggedIn: true,
      email: "a@b.c",
      organizationName: "Acme Inc",
      subscriptionType: "max",
      lastSuccessAt: at - 60_000,
      lastCheckedAt: at,
    })).toEqual(["Status", "Email", "Organization", "Plan", "Last Verified", "Last Checked"])
  })
})

describe("timeAgo", () => {
  test("an absent timestamp reads as a dash", () => {
    expect(timeAgo(null)).toBe("—")
    expect(timeAgo(0)).toBe("—")
    expect(timeAgo(undefined)).toBe("—")
  })

  test("recent timestamps read in the coarsest unit that fits", () => {
    const now = Date.now()
    expect(timeAgo(now)).toBe("just now")
    expect(timeAgo(now - 30_000)).toBe("30s ago")
    expect(timeAgo(now - 5 * 60_000)).toBe("5m ago")
    expect(timeAgo(now - 3 * 3_600_000)).toBe("3h ago")
  })
})

describe("both pages render from this one builder", () => {
  test("the landing page carries the shared source", () => {
    expect(landingHtml).toContain("function profileFacts(p)")
  })

  test("the profiles page carries the shared source", () => {
    expect(profilePageHtml).toContain("function profileFacts(p)")
  })

  test("neither page defines a second row list of its own", () => {
    // The drift this module exists to prevent: a page that stops calling the
    // builder and starts hand-writing rows again.
    expect(landingHtml).toContain("profileFacts(entry)")
    expect(profilePageHtml).toContain("profileFacts(p)")
    expect(profilePageHtml).not.toContain("Last Verified<")
  })

  test("the shared source is emitted exactly once per page", () => {
    expect(landingHtml.split("function profileFacts(p)").length - 1).toBe(1)
    expect(profilePageHtml.split("function profileFacts(p)").length - 1).toBe(1)
  })
})
