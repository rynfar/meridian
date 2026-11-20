/**
 * The free-reset view both account pages draw from `bankedResets`, the
 * sentence /profiles shows after a redeem, and the pages' own render and
 * redeem functions run against fixtures. The view functions are also rebuilt
 * from their `.toString()` copy, the way the pages embed them.
 */
import { describe, expect, it } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { freeResetOutcomeText, freeResetView, type FreeResetGroup, type FreeResetView } from "../telemetry/freeResets"
import { profilePageHtml } from "../telemetry/profilePage"
import { landingHtml } from "../telemetry/landing"

const NOW = 1_794_900_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id, resetsLeft: 1, expiresAt: NOW + 112 * DAY, startsAt: NOW - 7 * DAY, paused: false, usableNow: true, ...over,
})
const fullGrant = (over: Record<string, unknown> = {}) => grant("full-reset-2611", {
  expiresAt: NOW + 24 * DAY, startsAt: NOW - 6 * DAY, kind: "full", providerType: "weekly",
  clears: ["seven_day", "seven_day_overage_included"], givesBackWeekly: false, description: "Whole-week grant",
  percentUsed: { seven_day: 100, seven_day_overage_included: 27.5 }, ...over,
})
const fableGrant = (id: string, pct: number | undefined, over: Record<string, unknown> = {}) => grant(id, {
  kind: "fable", providerType: "full", clears: ["seven_day_overage_included"], givesBackWeekly: true,
  description: "Fable launch grant", ...(pct === undefined ? {} : { percentUsed: { seven_day_overage_included: pct } }), ...over,
})
/** As Anthropic reported a Team seat's Fable grant on 2026-11-19: it also clears the 5-hour window, never `seven_day`. */
const teamFableGrant = (pct: number) => fableGrant("launch-2610-fable", pct, {
  clears: ["five_hour", "seven_day_overage_included"], percentUsed: { five_hour: 80, seven_day_overage_included: pct },
})

/** As Anthropic reported DH Sub #1 on 2026-11-19: a whole-week grant and three Fable launch grants with no Fable usage. */
const SUB1 = {
  eligible: true,
  ineligibleReason: null,
  nextGrantId: "full-reset-2611",
  grants: [
    fullGrant(),
    fableGrant("launch-2610-fable", 0, { expiresAt: NOW + 12 * DAY }),
    fableGrant("launch-2610-fable-12mo", 0, { expiresAt: NOW + 300 * DAY }),
    fableGrant("launch-2610-fable-6mo", 0, { expiresAt: NOW + 150 * DAY }),
  ],
}
const LIVE = { stale: false, windows: [] }

const pageView = new Function(`return (${freeResetView.toString()})`)() as typeof freeResetView
const pageOutcome = new Function(`return (${freeResetOutcomeText.toString()})`)() as typeof freeResetOutcomeText

function groupOf(view: FreeResetView | null, kind: string): FreeResetGroup {
  const found = view?.groups.find(g => g.kind === kind)
  if (!found) throw new Error(`no ${kind} group`)
  return found
}

describe("freeResetView groups resets by what they clear", () => {
  it("counts full and Fable resets apart, each with its own next expiry", () => {
    const view = freeResetView(SUB1, NOW, LIVE)
    expect(view?.groups.map(g => [g.kind, g.name, g.available])).toEqual([["full", "Full reset", 1], ["fable", "Fable reset", 3]])
    expect(view?.available).toBe(4)
    const full = groupOf(view, "full")
    expect(full.expiresAt).toBe(NOW + 24 * DAY)
    expect(full.grantId).toBe("full-reset-2611")
    expect(full.grantName).toBe("Whole-week grant (full-reset-2611)")
    expect(full.muted).toBe(false)
    expect(full.note).toBe("all usable now \u00b7 expires in 24d")
    expect(full.title).toContain("clears this account's weekly usage")
    expect(groupOf(view, "fable").expiresAt).toBe(NOW + 12 * DAY)
  })

  it("keeps a Fable reset with no Fable usage visible but muted, with the reason and no grant to redeem", () => {
    const fable = groupOf(freeResetView(SUB1, NOW, LIVE), "fable")
    expect(fable.available).toBe(3)
    expect(fable.usable).toBe(3)
    expect(fable.grantId).toBeNull()
    expect(fable.muted).toBe(true)
    expect(fable.reason).toBe("no Fable usage to give back right now")
    expect(fable.note).toBe("no Fable usage to give back right now \u00b7 next expires in 12d")
    expect(fable.title).toContain("gives back only Fable usage")
    expect(fable.title).not.toContain("weekly usage.")
  })

  it("offers a Fable reset only while its grant confirms Fable usage, picking within the kind", () => {
    const view = freeResetView({ ...SUB1, grants: [SUB1.grants[0], fableGrant("launch-2610-fable-6mo", 27.5, { expiresAt: NOW + 150 * DAY }),
      fableGrant("launch-2610-fable", 27.5, { expiresAt: NOW + 12 * DAY })] }, NOW, LIVE)
    const fable = groupOf(view, "fable")
    expect(fable.grantId).toBe("launch-2610-fable")
    expect(fable.grantName).toBe("Fable launch grant (launch-2610-fable)")
    expect(fable.fableUsed).toBe("28%")
    expect(fable.muted).toBe(false)
    expect(fable.note).toBe("all usable now \u00b7 Fable 28% used \u00b7 next expires in 12d")
    expect(groupOf(view, "full").grantId).toBe("full-reset-2611")
  })

  it("says the 5-hour window clears only when the offered grant's scope lists it, and offers no Fable reset without Fable usage", () => {
    const team = groupOf(freeResetView({ ...SUB1, grants: [teamFableGrant(27.5)] }, NOW, LIVE), "fable")
    expect([team.grantId, team.clearsFiveHour]).toEqual(["launch-2610-fable", true])
    expect(team.title).toContain("gives back only Fable usage to the weekly allowance")
    expect(team.title).toContain("It also clears the 5-hour window.")
    const personal = freeResetView({ ...SUB1, grants: [fullGrant(), fableGrant("launch-2610-fable", 27.5)] }, NOW, LIVE)
    for (const kind of ["full", "fable"]) {
      expect(groupOf(personal, kind).clearsFiveHour).toBe(false)
      expect(groupOf(personal, kind).title).not.toContain("5-hour")
    }
    const idle = groupOf(freeResetView({ ...SUB1, grants: [teamFableGrant(0)] }, NOW, LIVE), "fable")
    expect([idle.grantId, idle.muted, idle.reason]).toEqual([null, true, "no Fable usage to give back right now"])
  })

  it("takes the provider's next grant only within its own kind", () => {
    const view = freeResetView({ ...SUB1, nextGrantId: "launch-2610-fable-6mo",
      grants: [fullGrant(), fableGrant("launch-2610-fable", 5, { expiresAt: NOW + 12 * DAY }), fableGrant("launch-2610-fable-6mo", 5)] }, NOW, LIVE)
    expect(groupOf(view, "fable").grantId).toBe("launch-2610-fable-6mo")
    expect(groupOf(view, "full").grantId).toBe("full-reset-2611")
  })

  it("falls back to the current 7d Fable window when the grant states no usage, and tells zero from unknown", () => {
    const raw = { ...SUB1, nextGrantId: null, grants: [fableGrant("launch-2610-fable", undefined)] }
    const used = groupOf(freeResetView(raw, NOW, { stale: false, windows: [{ type: "seven_day_fable", utilization: 0.4 }] }), "fable")
    expect(used.fableUsed).toBe("40%")
    expect(used.grantId).toBe("launch-2610-fable")
    const zero = groupOf(freeResetView(raw, NOW, { stale: false, windows: [{ type: "seven_day_fable", utilization: 0 }] }), "fable")
    expect([zero.grantId, zero.reason]).toEqual([null, "no Fable usage to give back right now"])
    const unknown = groupOf(freeResetView(raw, NOW, LIVE), "fable")
    expect([unknown.grantId, unknown.reason, unknown.muted]).toEqual([null, "Fable usage unknown", true])
    expect(groupOf(freeResetView(raw, NOW), "fable").grantId).toBeNull()
  })

  it("does not confirm Fable usage from a stale reading", () => {
    const stale = groupOf(freeResetView({ ...SUB1, grants: [fableGrant("launch-2610-fable", 60)] }, NOW, { stale: true, windows: [] }), "fable")
    expect(stale.grantId).toBeNull()
    expect(stale.reason).toBe("Fable usage not confirmed: the last reading is stale")
    expect(stale.fableUsed).toBeNull()
  })

  it("labels the known grants of an older snapshot that carries no kind", () => {
    const legacy = { ...SUB1, grants: [grant("full-reset-2611", { expiresAt: NOW + 24 * DAY }), grant("launch-2610-fable"),
      grant("launch-2610-fable-12mo"), grant("launch-2610-fable-6mo"), grant("another-campaign")] }
    const view = freeResetView(legacy, NOW, LIVE)
    expect(view?.groups.map(g => [g.kind, g.available])).toEqual([["full", 1], ["fable", 3], ["unknown", 1]])
    expect(groupOf(view, "fable").reason).toBe("Fable usage unknown")
  })

  it("never treats the provider's raw type as the scope", () => {
    const view = freeResetView({ eligible: true, nextGrantId: "promo", grants: [
      grant("promo", { kind: "unknown", providerType: "full", description: "Future promotion" }),
      grant("typed", { providerType: "full" }),
    ] }, NOW, LIVE)
    expect(view?.groups.map(g => g.kind)).toEqual(["unknown", "unknown"])
    for (const g of view?.groups ?? []) {
      expect(g.grantId).toBeNull()
      expect(g.muted).toBe(true)
    }
    const promo = view?.groups[0]
    expect(promo?.name).toBe("Unrecognised reset")
    expect(promo?.providerLabel).toBe("\u201cFuture promotion\u201d (type full)")
    expect(promo?.note).toBe("\u201cFuture promotion\u201d (type full) \u00b7 not recognised, none offered \u00b7 expires in 112d")
    expect(promo?.title).toContain("does not know what one clears")
    expect(view?.groups[1]?.providerLabel).toBe("type full")
  })

  it("separates unrecognised resets by what the provider calls them", () => {
    const view = freeResetView({ eligible: true, nextGrantId: null, grants: [
      grant("a", { kind: "unknown", description: "Spring promo" }), grant("b", { kind: "unknown", description: "Spring promo" }),
      grant("c", { kind: "unknown", description: "Summer promo", expiresAt: NOW + 3 * DAY }),
    ] }, NOW, LIVE)
    expect(view?.groups.map(g => [g.providerLabel, g.available, g.expiresAt])).toEqual([
      ["\u201cSpring promo\u201d", 2, NOW + 112 * DAY], ["\u201cSummer promo\u201d", 1, NOW + 3 * DAY],
    ])
  })

  it("names an unrecognised grant without provider words by its raw id, keeping different ids apart", () => {
    const view = freeResetView({ eligible: true, nextGrantId: "spring", grants: [grant("spring"), grant("summer", { kind: "unknown" })] }, NOW, LIVE)
    expect(view?.groups.map(g => [g.kind, g.providerLabel, g.available, g.grantId])).toEqual([
      ["unknown", "id spring", 1, null], ["unknown", "id summer", 1, null],
    ])
    expect(view?.groups[0]?.note).toBe("id spring \u00b7 not recognised, none offered \u00b7 expires in 112d")
  })

  it("says a held Fable reset has no Fable usage to give back when that is known", () => {
    const fable = groupOf(freeResetView({ ...SUB1, grants: [fableGrant("launch-2610-fable", 0, { usableNow: false })] }, NOW, LIVE), "fable")
    expect([fable.usable, fable.grantId, fable.muted, fable.reason]).toEqual([0, null, true, "no Fable usage to give back right now"])
    expect(fable.note).toBe("no Fable usage to give back right now \u00b7 expires in 112d")
  })

  it("counts a repeated grant once, while the six- and twelve-month grants stay distinct", () => {
    const view = freeResetView({ ...SUB1, grants: [...SUB1.grants, fableGrant("launch-2610-fable", 0)] }, NOW, LIVE)
    expect(groupOf(view, "fable").available).toBe(3)
  })

  it("separates resets the provider holds back from those usable now, per kind", () => {
    const view = freeResetView({ ...SUB1, grants: [fullGrant({ usableNow: false }), fableGrant("launch-2610-fable", 50, { paused: true }),
      fableGrant("launch-2610-fable-6mo", 50, { startsAt: NOW + DAY })] }, NOW, LIVE)
    const full = groupOf(view, "full")
    expect([full.usable, full.grantId, full.muted, full.note]).toEqual([0, null, true, "none usable now \u00b7 expires in 24d"])
    const fable = groupOf(view, "fable")
    expect([fable.available, fable.usable, fable.grantId]).toEqual([2, 0, null])
    expect(fable.title).toContain("2 Fable resets banked; 0 can be redeemed now, 2 held back by Anthropic")
  })

  it("ignores expired and spent grants, and never offers a grant with no id", () => {
    const view = freeResetView({ eligible: true, nextGrantId: null,
      grants: [fullGrant({ expiresAt: NOW - HOUR }), fullGrant({ id: "spent", resetsLeft: 0 }), fullGrant({ id: null })] }, NOW, LIVE)
    const full = groupOf(view, "full")
    expect([full.available, full.usable, full.grantId, full.muted]).toEqual([1, 1, null, false])
  })

  it("shows nothing for an ineligible, empty, absent or malformed reading", () => {
    expect(freeResetView(null, NOW)).toBeNull()
    expect(freeResetView(undefined, NOW)).toBeNull()
    expect(freeResetView({ ...SUB1, eligible: false }, NOW)).toBeNull()
    expect(freeResetView({ ...SUB1, grants: [] }, NOW)).toBeNull()
    expect(freeResetView({ eligible: true, grants: "nope" }, NOW)).toBeNull()
    expect(freeResetView({ eligible: true, grants: [{ resetsLeft: "1" }, null] }, NOW)).toBeNull()
  })

  it("words short expiries in hours and minutes", () => {
    const note = (expiresAt: number | null) => freeResetView({ eligible: true, nextGrantId: null, grants: [fullGrant({ expiresAt })] }, NOW)?.groups[0]?.note
    expect(note(NOW + 5 * HOUR + 1)).toBe("all usable now \u00b7 expires in 5h")
    expect(note(NOW + 20 * 60_000)).toBe("all usable now \u00b7 expires in 20m")
    expect(note(null)).toBe("all usable now")
  })

  it("is self-contained, so the copy the pages embed gives the same answer", () => {
    for (const [input, quota] of [[SUB1, LIVE], [null, undefined], [{ ...SUB1, eligible: false }, LIVE],
      [{ ...SUB1, grants: [fableGrant("launch-2610-fable", undefined)] }, { stale: false, windows: [{ type: "seven_day_fable", utilization: 0.2 }] }]] as const) {
      expect(pageView(input, NOW, quota)).toEqual(freeResetView(input, NOW, quota))
    }
  })
})

describe("freeResetOutcomeText", () => {
  it("reports a redeemed reset with what it cleared and what is left", () => {
    expect(freeResetOutcomeText(200, { result: "reset", cleared: ["five_hour", "seven_day"], resetsLeft: 0 }))
      .toEqual({ ok: true, text: "Reset redeemed: cleared five_hour, seven_day. 0 left on that grant." })
    expect(freeResetOutcomeText(200, { result: "reset", cleared: [], resetsLeft: null }))
      .toEqual({ ok: true, text: "Reset redeemed." })
  })

  it("explains each refusal in words rather than the provider's code", () => {
    expect(freeResetOutcomeText(200, { result: "not_limited" }).text)
      .toBe("Not redeemed: Anthropic says this account is not rate limited, so there is nothing to reset yet.")
    expect(freeResetOutcomeText(200, { result: "already_used" }).text).toContain("already been used")
    expect(freeResetOutcomeText(200, { result: "cooldown" }).ok).toBe(false)
  })

  it("warns when the outcome is unknown, so nobody retries blindly", () => {
    const out = freeResetOutcomeText(502, { code: "upstream_error", error: "Upstream request failed", indeterminate: true })
    expect(out.ok).toBe(false)
    expect(out.text).toBe("Not redeemed: Upstream request failed. It may have gone through - check the figures before trying again.")
    expect(freeResetOutcomeText(409, { error: "Another reset for this profile is still in progress" }).text)
      .toBe("Not redeemed: Another reset for this profile is still in progress.")
    expect(freeResetOutcomeText(0, null).text).toBe("Not redeemed: Meridian did not answer.")
  })

  it("is self-contained, so the embedded copy gives the same answer", () => {
    for (const [status, body] of [[200, { result: "reset", cleared: ["five_hour"], resetsLeft: 2 }], [200, { result: "not_limited" }],
      [502, { error: "x", indeterminate: true }], [0, null]] as const) {
      expect(pageOutcome(status, body)).toEqual(freeResetOutcomeText(status, body))
    }
  })
})

// The pages' own functions, cut out of the served HTML and run here.
function pageFunctions(html: string, names: readonly string[]): string {
  return names.map(name => {
    const source = html.match(new RegExp(`^(?:async )?function ${name}\\((?:.*\\}$|[^]*?^\\})`, "m"))?.[0]
    if (!source) throw new Error(`Missing rendered page function ${name}`)
    return source
  }).join("\n")
}
const textEsc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const decode = (s: string) => s.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
/** Every opening tag holds only well-quoted attributes: nothing the provider sent broke out of one. */
const tagsIntact = (html: string) => [...html.matchAll(/<[a-z]+((?:[^>"]|"[^"]*")*)>/g)]
  .every(m => (m[1] ?? "").replace(/\s+[\w-]+="[^"]*"/g, "").trim() === "")
const buttonsIn = (html: string) => [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(m => ({
  text: m[2] ?? "",
  attrs: Object.fromEntries([...(m[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1] ?? "", decode(a[2] ?? "")])),
}))

const HOSTILE = "<img src=x onerror=alert(1)>\"'"

function profilesPage(answer: { status: number; body: unknown } = { status: 200, body: { result: "reset", cleared: ["seven_day_fable"], resetsLeft: 0 } }) {
  const asked: string[] = []
  const posted: Array<Record<string, unknown>> = []
  const sandbox: Record<string, unknown> = {
    freeResetView, freeResetOutcomeText, esc: textEsc, Date, JSON, Number, Math, String, Object,
    labelForWindow: (w: string) => (w === "seven_day_fable" ? "7d Fable" : w),
    redeemingReset: null, resetOutcomes: Object.create(null), refreshes: 0, accept: true,
    confirm: (text: string) => { asked.push(text); return sandbox.accept },
    fetch: async (url: string, init: { body: string }) => {
      posted.push({ url, ...JSON.parse(init.body) })
      return { status: answer.status, json: async () => answer.body }
    },
    crypto: { randomUUID: () => "req-1" },
  }
  sandbox.window = sandbox
  sandbox.refresh = async () => { sandbox.refreshes = (sandbox.refreshes as number) + 1 }
  const context = createContext(sandbox)
  runInContext(pageFunctions(profilePageHtml, ["attr", "renderFreeResets", "redeemFreeReset"]), context)
  const render = (raw: unknown, quota: unknown = LIVE): string =>
    runInContext("renderFreeResets(freeResetView(raw, Date.now(), quota), { id: 'sub1', label: 'DH Sub #1' })",
      Object.assign(context, { raw, quota })) as string
  const redeem = async (attrs: Record<string, string>) => {
    const button = { disabled: false, textContent: "", getAttribute: (name: string) => attrs[name] ?? null }
    await (runInContext("redeemFreeReset", context) as (b: unknown) => Promise<void>)(button)
  }
  return { render, redeem, asked, posted, sandbox }
}

describe("/profiles draws one block per kind", () => {
  it("offers one named action per usable kind, and none on a Fable reset with nothing to give back", () => {
    const page = profilesPage()
    const html = page.render(SUB1)
    expect(html).toContain(">Full reset<")
    expect(html).toContain(">Fable reset<")
    expect(html).toContain("no Fable usage to give back right now")
    expect(buttonsIn(html).map(b => [b.text, b.attrs["data-kind"], b.attrs["data-grant"]])).toEqual([["Redeem full reset", "full", "full-reset-2611"]])
    expect(html).toMatch(/class="usage-extra free-resets held"[^>]*>(?:(?!usage-extra free-resets).)*Fable reset/)
  })

  it("names the exact kind and grant in the confirmation, and posts that grant only", async () => {
    const raw = { ...SUB1, grants: [fullGrant(), fableGrant("launch-2610-fable", 27.5)] }
    const page = profilesPage()
    const buttons = buttonsIn(page.render(raw))
    expect(buttons.map(b => b.text)).toEqual(["Redeem full reset", "Redeem Fable reset"])
    const fable = buttons[1]?.attrs ?? {}
    await page.redeem(fable)
    expect(page.asked).toHaveLength(1)
    const [title, message] = (page.asked[0] ?? "").split("\n\n")
    expect(title).toBe("Redeem a Fable reset on DH Sub #1 now?")
    expect(message).toContain("\u201cFable launch grant (launch-2610-fable)\u201d")
    expect(message).toContain("gives back only this account\u2019s Fable usage (now 28% used)")
    expect(message).not.toContain("clears this account\u2019s weekly usage")
    expect(message).not.toContain("5-hour")
    expect(message).toContain("It cannot be undone.")
    expect(message).not.toContain("rate limited")
    expect(message).toEndWith("0 usable Fable resets would be left.")
    expect(page.posted).toEqual([{ url: "/v1/usage/quota/reset", profile: "sub1", grantId: "launch-2610-fable", requestId: "req-1" }])
    expect(page.sandbox.refreshes).toBe(1)
  })

  it("words the full reset's confirmation as the whole week", async () => {
    const page = profilesPage()
    await page.redeem(buttonsIn(page.render(SUB1))[0]?.attrs ?? {})
    const [title, message] = (page.asked[0] ?? "").split("\n\n")
    expect(title).toBe("Redeem a full reset on DH Sub #1 now?")
    expect(message).toContain("\u201cWhole-week grant (full-reset-2611)\u201d")
    expect(message).toContain("clears this account\u2019s weekly usage")
    expect(message).not.toContain("5-hour")
    expect(message).not.toContain("rate limited")
    expect(page.posted.map(p => p.grantId)).toEqual(["full-reset-2611"])
  })

  it("adds the 5-hour window to a confirmation only when the spent grant's scope lists it", async () => {
    const teamFull = fullGrant({ id: "team-full", clears: ["five_hour", "seven_day", "seven_day_overage_included"] })
    const page = profilesPage()
    const buttons = buttonsIn(page.render({ ...SUB1, nextGrantId: null, grants: [teamFull, teamFableGrant(27.5)] }))
    expect(buttons.map(b => [b.attrs["data-grant"], b.attrs["data-clears-five-hour"]])).toEqual([["team-full", "true"], ["launch-2610-fable", "true"]])
    for (const b of buttons) await page.redeem(b.attrs)
    const [full, fable] = page.asked
    expect(full).toContain("clears this account\u2019s weekly usage right away. It also clears the 5-hour window.")
    expect(fable).toContain("gives back only this account\u2019s Fable usage (now 28% used) to its weekly allowance")
    expect(fable).toContain("It also clears the 5-hour window.")
    expect(fable).not.toContain("clears this account\u2019s weekly usage")
    expect(page.posted.map(p => p.grantId)).toEqual(["team-full", "launch-2610-fable"])
  })

  it("sends nothing when the confirmation is declined", async () => {
    const page = profilesPage()
    page.sandbox.accept = false
    await page.redeem(buttonsIn(page.render(SUB1))[0]?.attrs ?? {})
    expect(page.posted).toEqual([])
  })

  it("keeps a refusal on its own kind and offers the same kind again, never another", async () => {
    const raw = { ...SUB1, grants: [fullGrant(), fableGrant("launch-2610-fable", 27.5)] }
    const page = profilesPage({ status: 200, body: { result: "not_limited" } })
    await page.redeem(buttonsIn(page.render(raw))[1]?.attrs ?? {})
    const after = page.render(raw)
    expect(after).toMatch(/Fable reset(?:(?!usage-extra free-resets).)*Fable reset: Not redeemed: Anthropic says/)
    expect(after.split("reset-outcome")).toHaveLength(2)
    expect(buttonsIn(after).map(b => b.attrs["data-grant"])).toEqual(["full-reset-2611", "launch-2610-fable"])
    expect(page.posted.map(p => p.grantId)).toEqual(["launch-2610-fable"])
  })

  it("shows an unrecognised reset as a readout only, with the provider's words escaped", () => {
    const page = profilesPage()
    const html = page.render({ eligible: true, nextGrantId: "x", grants: [grant("x", { kind: "unknown", providerType: HOSTILE, description: HOSTILE })] })
    expect(html).toContain(">Unrecognised reset<")
    expect(buttonsIn(html)).toEqual([])
    expect(html).not.toContain("<img")
    expect(tagsIntact(html)).toBe(true)
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    const byId = page.render({ eligible: true, nextGrantId: null, grants: [grant(HOSTILE)] })
    expect(buttonsIn(byId)).toEqual([])
    expect(byId).not.toContain("<img")
    expect(tagsIntact(byId)).toBe(true)
    expect(byId).toContain("id &lt;img src=x onerror=alert(1)&gt;")
  })
})

describe("/ shows one row per kind and never redeems", () => {
  const rows = (raw: unknown, quota: unknown = LIVE): string => {
    const context = createContext({ freeResetView, Date })
    runInContext(pageFunctions(landingHtml, ["esc", "freeResetRows"]), context)
    return runInContext("freeResetRows(freeResetView(raw, Date.now(), quota))", Object.assign(context, { raw, quota })) as string
  }

  it("labels each kind's count and muted Fable row", () => {
    const html = rows(SUB1)
    expect([...html.matchAll(/<span class="w-label">([^<]*)<\/span><span class="w-credits">([^<]*)</g)].map(m => [m[1], m[2]]))
      .toEqual([["full reset", "1"], ["Fable reset", "3"]])
    expect(html).toMatch(/resets-row held"[^>]*><span class="w-label">Fable reset/)
    expect(html).toContain("no Fable usage to give back right now")
    expect(html).not.toContain("<button")
    expect(rows(null)).toBe("")
  })

  it("escapes the provider's words in text and attributes", () => {
    const html = rows({ eligible: true, nextGrantId: null, grants: [grant("x", { kind: "unknown", description: HOSTILE })] })
    expect(html).toContain(">other reset<")
    expect(html).not.toContain("<img")
    expect(tagsIntact(html)).toBe(true)
  })
})
