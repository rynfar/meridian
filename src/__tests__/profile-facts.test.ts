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

interface Fact { label: string; value: string; tone: string; title?: string; cached?: boolean }
interface AccessHelp { pill: string; reason: string; summary: string }

const evaluated = new Function(
  profileFactsJs + "\nreturn { profileFacts, timeAgo, formatResets, profileAccessHelp, chatGptUsageGap, refusalSubject, codexCreditsView };",
)() as {
  profileFacts: (p: Record<string, unknown>) => Fact[]
  timeAgo: (ts: number | null | undefined) => string
  formatResets: (resets: unknown, now: number) => string
  profileAccessHelp: (p: Record<string, unknown>) => AccessHelp
  chatGptUsageGap: (error: string | null | undefined) => string
  refusalSubject: (p: Record<string, unknown> | undefined) => { vendor: string; noun: string }
  codexCreditsView: (credits: unknown, quota?: unknown) => { value: string; note: string; status: string; serving?: boolean; policy?: string | null; pace?: { text: string; title: string; approximate: boolean } | null } | null
}

const { profileFacts, timeAgo, formatResets, profileAccessHelp, chatGptUsageGap, refusalSubject, codexCreditsView } = evaluated

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

describe("a ChatGPT seat's card", () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000
  // The shape /profiles/list gives a seat followed from oc-codex-multi-auth.
  const owner = {
    name: "oc-codex-multi-auth", mode: "follow-external", account: 3,
    login: "opencode auth login", loginMethod: "OpenAI → Codex OAuth (ChatGPT Plus/Pro)",
    refresh: "npx -y oc-codex-multi-auth doctor --fix", refreshTool: "codex-refresh",
    remove: "codex-remove index=3 confirm=true", importCommand: null,
  }
  const seat = (extra: Record<string, unknown> = {}) => ({
    id: "oferty-c487c4", type: "chatgpt", provider: "chatgpt", label: "oferty@nowaker.net · id:c487c4",
    email: "oferty@nowaker.net", accountType: "Personal", planName: "Pro", subscriptionType: "pro",
    allowance: "20x", loggedIn: true, tokenState: "ok", unavailable: null, authProvenance: "live",
    resets: { available: 0, expiresAt: [] }, owner, ...extra,
  })

  test("states banked resets as the brief spells them", () => {
    const now = 1_800_000_000_000
    expect(formatResets({ available: 1, expiresAt: [now + 13 * DAY + 5 * HOUR] }, now)).toBe("1 (expires 13d)")
    expect(formatResets({ available: 2, expiresAt: [now + 3 * DAY + HOUR, now + 11 * DAY + 2 * HOUR] }, now)).toBe("2 (expire 3d, 11d)")
    expect(formatResets({ available: 0, expiresAt: [] }, now)).toBe("0")
  })

  test("never hides a reset whose expiry it does not know, and says unknown with nothing to go on", () => {
    const now = 1_800_000_000_000
    expect(formatResets({ available: 2, expiresAt: [now + 3 * DAY, null] }, now)).toBe("2 (expire 3d, unknown)")
    expect(formatResets({ available: 2, expiresAt: null }, now)).toBe("2 (expiry unknown)")
    expect(formatResets({ available: 1, expiresAt: [now + 5 * HOUR + 1] }, now)).toBe("1 (expires 5h)")
    expect(formatResets({ available: 1, expiresAt: [now + 40 * 60_000 + 1] }, now)).toBe("1 (expires 40m)")
    // No valid access token, so the credits were never asked for.
    expect(formatResets(null, now)).toBe("unknown")
    expect(formatResets(undefined, now)).toBe("unknown")
  })

  test("prints Resets right after Plan, and only for a seat", () => {
    const facts = profileFacts(seat({ resets: { available: 1, expiresAt: [Date.now() + 13 * DAY + HOUR] } }))
    const rows = facts.map(f => f.label)
    expect(rows.slice(rows.indexOf("Plan"), rows.indexOf("Plan") + 2)).toEqual(["Plan", "Resets"])
    expect(facts.find(f => f.label === "Resets")?.value).toBe("1 (expires 13d)")
    expect(valueOf(seat({ resets: null }), "Resets")).toBe("unknown")
    expect(labels({ subscriptionType: "max", allowance: "20x" })).not.toContain("Resets")
  })

  test("words the allowance against ChatGPT Plus, and the owner of the login", () => {
    expect(valueOf(seat(), "Allowance")).toBe("20x of a ChatGPT Plus plan’s Codex usage")
    expect(valueOf({ allowance: "20x" }, "Allowance")).toBe("20x of a Pro plan’s Claude Code usage")
    expect(valueOf(seat({ allowance: "~0x", planTier: "free" }), "Allowance")).toBe("~0x: a free seat has almost no Codex usage")
    expect(valueOf(seat(), "Owner")).toBe("oc-codex-multi-auth · account 3")
    expect(valueOf(seat({ unavailable: "quota_exhausted" }), "Owner state")).toBe("quota exhausted")
    expect(labels({ subscriptionType: "max" })).not.toContain("Owner")
  })

  test("shows a Business seat's workspace where a Claude card shows its organization", () => {
    const rows = labels(seat({ organizationName: "Acme Workspace" }))
    expect(rows.slice(0, 4)).toEqual(["Status", "Email", "Organization", "Account"])
    expect(valueOf(seat({ organizationName: "Acme Workspace" }), "Organization")).toBe("Acme Workspace")
    expect(labels(seat({ organizationName: null }))).not.toContain("Organization")
  })

  test("says what is wrong with the token rather than 'not logged in'", () => {
    const status = (tokenState: string) => valueOf(seat({ loggedIn: false, tokenState }), "Status")
    expect(status("expired")).toBe("✗ Access token expired")
    expect(status("refused")).toBe("✗ Token refused by chatgpt.com")
    expect(status("no_token")).toBe("✗ No access token")
    expect(valueOf(seat(), "Status")).toBe("✓ Authenticated")
  })

  test("sends a seat that cannot serve to its owner's exact command, never to meridian's", () => {
    const expired = profileAccessHelp(seat({ loggedIn: false, tokenState: "expired" }))
    expect(expired.pill).toBe("token expired")
    expect(expired.summary).toContain("npx -y oc-codex-multi-auth doctor --fix")
    expect(expired.summary).toContain("oc-codex-multi-auth owns this login")
    const refused = profileAccessHelp(seat({ loggedIn: false, tokenState: "refused" }))
    expect(refused.pill).toBe("token refused")
    expect(refused.summary).toContain("opencode auth login → OpenAI → Codex OAuth (ChatGPT Plus/Pro) → oferty@nowaker.net · id:c487c4 → Refresh account")
    for (const help of [expired, refused]) expect(help.summary).not.toContain("meridian profile login")
    expect(profileAccessHelp({ id: "work" })).toMatchObject({ pill: "needs login", summary: "Cannot serve requests — run: meridian profile login work" })
  })

  test("says when Meridian renews a seat whose access token was refused, instead of asking for a sign-in", () => {
    const owned = { name: "meridian", webSignIn: true }
    const now = Date.now()
    const renewing = seat({ loggedIn: false, tokenState: "refused", owner: owned, renewalRetryAt: now + 5 * 60_000 + 30_000 })
    expect(valueOf(renewing, "Next renewal")).toBe("in 5m")
    expect(valueOf(seat({ loggedIn: false, tokenState: "refused", owner: owned, renewalRetryAt: now - 1000 }), "Next renewal")).toBe("now")
    expect(labels(seat({ loggedIn: false, tokenState: "refused", owner: owned }))).not.toContain("Next renewal")
    const help = profileAccessHelp(renewing)
    expect(help.pill).toBe("renewing")
    expect(help.reason).toContain("Meridian renews it on its own")
    expect(profileAccessHelp(seat({ loggedIn: false, tokenState: "refused", owner: owned })).pill).toBe("needs login")
  })

  test("states purchased Codex credits where a Claude card states extra usage, and nothing without them", () => {
    const credits = (extra: Record<string, unknown>) => ({ hasCredits: false, unlimited: false, overageLimitReached: false, balance: null, ...extra })
    expect(codexCreditsView(credits({ hasCredits: true, balance: 1234.5 })))
      .toMatchObject({ value: "1,234.5 credits", note: "used once the plan’s limits run out", status: "ok" })
    expect(codexCreditsView(credits({ unlimited: true }))?.value).toBe("unlimited")
    expect(codexCreditsView(credits({ hasCredits: true }))?.value).toBe("available")
    expect(codexCreditsView(credits({ hasCredits: true, balance: 3, overageLimitReached: true })))
      .toMatchObject({ note: "overage limit reached", status: "high" })
    expect(codexCreditsView(credits({ balance: 0 }))).toBeNull()
    expect(codexCreditsView(null)).toBeNull()
  })

  test("states the seat's credits policy, and flags a seat serving on its credits now", () => {
    const credits = { hasCredits: true, unlimited: false, overageLimitReached: false, balance: 62500 }
    expect(codexCreditsView(credits, { creditsPolicy: "never", creditsPolicySource: "default" }))
      .toMatchObject({ value: "62,500 credits", note: "never used \u2014 credits policy is never", status: "ok", serving: false, policy: "policy: never" })
    expect(codexCreditsView(credits, { creditsPolicy: "reserve", creditsPolicySource: "seat" }))
      .toMatchObject({ note: "used only when no seat has plan usage left", policy: "policy: reserve (this seat)" })
    expect(codexCreditsView({ ...credits, unlimited: true }, { creditsPolicy: "immediately", servingOnCredits: true }))
      .toMatchObject({ value: "unlimited", note: "plan usage spent \u2014 serving on credits now", status: "warn", serving: true, policy: "policy: immediately" })
  })

  test("estimates how long a balance lasts at the instance's pace, and frames it by whether the seat is paying now", () => {
    const credits = { hasCredits: true, unlimited: false, overageLimitReached: false, balance: 62500 }
    const burning = { status: "burning", creditsPerHour: 40000, windowMinutes: 60, turns: 12, mix: [{ model: "gpt-6-sol", share: 0.62 }, { model: "gpt-6-luna", share: 0.38 }], approximate: [] }
    const serving = codexCreditsView(credits, { creditsPolicy: "immediately", servingOnCredits: true, creditsBurn: burning })
    expect(serving?.pace?.text).toBe("est. out in 1h34m at current pace")
    expect(serving?.pace?.title).toContain("62% gpt-6-sol / 38% gpt-6-luna")
    const trace = { ...burning, mix: [{ model: "gpt-6.1-sol", share: 0.9999 }, { model: "gpt-6-luna", share: 0.0001 }] }
    expect(codexCreditsView(credits, { servingOnCredits: true, creditsBurn: trace })?.pace?.title).toContain("100% gpt-6.1-sol / <1% gpt-6-luna")
    expect(codexCreditsView(credits, { creditsPolicy: "reserve", creditsBurn: burning })?.pace?.text)
      .toBe("starts after every seat\u2019s plan limits; would last ~1h34m at current pace")
    expect(codexCreditsView(credits, { creditsPolicy: "never", creditsBurn: burning })?.pace?.text)
      .toBe("not spent (policy never); would last ~1h34m at current pace")
    expect(codexCreditsView(credits, { servingOnCredits: true, creditsBurn: { ...burning, approximate: ["promo"] } })?.pace?.text)
      .toBe("est. out in ~1h34m at current pace")
    expect(codexCreditsView(credits, { creditsBurn: { status: "idle", windowMinutes: 60 } })?.pace?.text).toBe("idle")
    expect(codexCreditsView(credits, { creditsBurn: { status: "unknown_rate", windowMinutes: 180, models: ["gpt-9"] } })?.pace)
      .toMatchObject({ text: "no estimate", title: expect.stringContaining("gpt-9") })
    expect(codexCreditsView({ ...credits, unlimited: true, balance: null }, { creditsBurn: burning })?.pace?.text).toBe("unlimited")
    expect(codexCreditsView(credits, {})?.pace).toBeNull()
  })

  test("explains a missing reading and names who is refusing", () => {
    expect(chatGptUsageGap("token_expired")).toContain("never renews")
    expect(chatGptUsageGap("unauthorized")).toContain("refused")
    expect(chatGptUsageGap(null)).toBe("")
    expect(refusalSubject(seat())).toEqual({ vendor: "ChatGPT", noun: "seat" })
    expect(refusalSubject({ id: "work" })).toEqual({ vendor: "Anthropic", noun: "account" })
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

describe("qualified current credential expiry facts", () => {
  const now = 1_790_000_000_000
  const hour = 3_600_000
  const day = 24 * hour
  const currentFacts = new Function("Date", profileFactsJs + "\nreturn profileFacts;")(
    class extends Date { static override now() { return now } },
  ) as (p: Record<string, unknown>) => Fact[]

  test("future deadlines are actionable and explicitly separate from authentication", () => {
    const facts = currentFacts({ loggedIn: true, refreshTokenExpiresAt: now + 2 * day + 4 * hour,
      accessTokenExpiresAt: now + 3 * hour, renewalRequiredSoon: true })
    expect(facts[0]!.value).toBe("✓ Authenticated")
    expect(facts[1]).toMatchObject({ label: "Refresh deadline", value: "in 2d 4h", tone: "warn" })
    expect(facts[1]!.title).toContain("Reported by the stored credential")
    expect(facts[1]!.title).toContain("Authentication is checked separately")
    expect(facts[2]).toMatchObject({ label: "Stored access token", value: "expires in 3h 0m" })
    expect(facts[2]!.title).toContain("may be estimated")
  })

  test("a passed refresh deadline retains future access expiry and never invents logout or login age", () => {
    const facts = currentFacts({ loggedIn: true, refreshTokenExpiresAt: now - hour,
      accessTokenExpiresAt: now + 3 * hour, firstUnauthedAt: now - hour,
      unauthedReason: "refresh_rejected", authObtainedAt: now - day })
    expect(facts[0]!.value).toBe("✓ Authenticated")
    expect(facts[1]!.value).toBe("passed — login may need renewal")
    expect(facts[1]!.tone).toBe("warn")
    expect(facts[2]!.value).toBe("expires in 3h 0m")
    expect(facts.map(f => f.label)).not.toContain("Logged out")
    expect(facts.map(f => f.label)).not.toContain("Logged in")
    expect(facts.some(f => /stops in|can no longer|cannot renew/.test(f.value))).toBe(false)
  })

  test("past access metadata stays advisory and cached auth remains qualified", () => {
    const facts = currentFacts({ loggedIn: true, authProvenance: "cached", accessTokenExpiresAt: now - hour })
    expect(facts[0]).toMatchObject({ value: "✓ Authenticated", cached: true })
    expect(facts[1]).toMatchObject({ label: "Stored access token", value: "expiry passed", tone: "warn" })
    expect(facts[1]!.title).toContain("Authentication is checked separately")
  })

  test("unknown metadata omits countdowns and never supplies authentication proof", () => {
    expect(currentFacts({ loggedIn: false, authProvenance: "never", refreshTokenExpiresAt: null,
      accessTokenExpiresAt: null, renewalRequiredSoon: false })).toEqual([
      { label: "Status", value: "never read", tone: "err", cached: false },
    ])
  })

  test("both actual row renderers preserve escaped qualifiers, focus names and warning tone", () => {
    const escape = (s: unknown) => String(s).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]!)
    const source = landingHtml.slice(landingHtml.indexOf("function infoIcon(entry,type)"),
      landingHtml.indexOf("function infoPopOpen"))
    const infoIcon = new Function("profileFacts", "esc", "profileHref", source + "\nreturn infoIcon;")(
      () => [{ label: "Refresh deadline", value: "in 2d", tone: "warn", title: 'Stored "expiry" <only>', cached: true }],
      escape, (id: string) => "/profiles#" + id,
    ) as (p: { id: string }) => string
    const home = infoIcon({ id: "owned-fixture" })
    expect(home).toContain('title="Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(home).toContain('tabindex="0" aria-label="Refresh deadline: in 2d. Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(home).toContain("status-warn")
    expect(home).toContain("(cached)")
    expect(home).toContain('<span class="fact-explanation" aria-hidden="true">Stored &quot;expiry&quot; &lt;only&gt;</span>')
    expect(landingHtml).toContain(".prof-pop-value:focus > .fact-explanation { display: block; }")

    const profileSource = profilePageHtml.slice(profilePageHtml.indexOf("function factRows(facts)"),
      profilePageHtml.indexOf("// Mirrors src/telemetry/cachedFacts.ts"))
    // The profile page's text escape does not escape quotes. Its title and
    // accessible-name attributes must handle those independently.
    const textEscape = (s: unknown) => String(s).replace(/[&<>]/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
    })[ch]!)
    const rows = new Function("esc", profileSource + "\nreturn factRows;")(textEscape) as (facts: Fact[]) => string
    const profile = rows([{ label: "Refresh deadline", value: "in 2d", tone: "warn", title: 'Stored "expiry" <only>' }])
    expect(profile).toContain('title="Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(profile).toContain('tabindex="0" aria-label="Refresh deadline: in 2d. Stored &quot;expiry&quot; &lt;only&gt;"')
    expect(profile).toContain("status-warn")
    expect(profile).toContain('<span class="fact-explanation" aria-hidden="true">Stored "expiry" &lt;only&gt;</span>')
    expect(profilePageHtml).toContain(".detail-value:focus > .fact-explanation { display: block; }")
  })
})

describe("expiry fact focus survives automatic refresh", () => {
  for (const page of ["profiles", "home"] as const) {
    function fixture(initialFocus = false, windowFocused = true) {
      let focused = initialFocus
      let hovered = false
      let requests = 0
      let renders = 0
      const content = { innerHTML: "original focused facts" }
      const response = { ok: true, json: async () => ({ profiles: [] }) }
      let resolve!: (value: typeof response) => void
      let reject!: (reason: Error) => void
      const pending = new Promise<typeof response>((yes, no) => { resolve = yes; reject = no })
      const fetch = () => {
        requests++
        return requests === 1 ? pending : Promise.resolve(response)
      }
      const factElement = {
        matches: (selector: string) => selector === ".detail-value[tabindex]",
        closest: (selector: string): object | null => selector === ".prof-info" ? factElement : null,
      }
      const bodyElement = { matches: () => false, closest: () => null }
      const document = {
        get activeElement() { return focused ? factElement : bodyElement },
        hasFocus: () => windowFocused,
        querySelector: (selector: string) => (
          (selector.includes(":hover") && hovered) || (selector.includes(":focus") && windowFocused && focused)
        ) ? factElement : null,
        getElementById: () => content,
      }
      const source = page === "profiles"
        // The provider chips' inline script defines its own esc() earlier in
        // the page, so the slice ends at the first one after refresh().
        ? "var editingProfile = null, removingProfile = null, lastQuota = null, lastProfiles = null;\n"
          + "function adoptChatGpt() {}\nfunction noticeNewChatGptSeats() {}\n"
          + profilePageHtml.slice(profilePageHtml.indexOf("function detailFactFocused()"),
            profilePageHtml.indexOf("function esc(s)", profilePageHtml.indexOf("function detailFactFocused()")))
        : landingHtml.slice(landingHtml.indexOf("function infoPopOpen(){"), landingHtml.indexOf("function profileSection(q,s,pl,h)"))
          + landingHtml.slice(landingHtml.indexOf("async function refresh(){"), landingHtml.indexOf("function tokens(v)"))
      const refresh = new Function("document", "fetch", "render", "meridianReorder",
        source + "\nreturn refresh;")(document, fetch, () => { renders++ }, { adopt: () => {} }) as () => Promise<void>
      return {
        refresh, resolve: () => resolve(response), reject: () => reject(new Error("fixture unavailable")),
        focus: () => { focused = true }, blur: () => { focused = false }, hover: () => { hovered = true }, content, document,
        requests: () => requests, renders: () => renders,
      }
    }

    test(`${page}: focused facts prevent a new poll`, async () => {
      const f = fixture(true)
      await f.refresh()
      expect(f.requests()).toBe(0)
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: focus acquired during a poll prevents a successful redraw`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.focus()
      f.resolve()
      await poll
      expect(f.requests()).toBeGreaterThan(0)
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: focus acquired during a failing poll prevents error replacement`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.focus()
      f.reject()
      await poll
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: an unfocused poll still updates the page`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.resolve()
      await poll
      expect(f.requests()).toBeGreaterThan(0)
      expect(f.renders()).toBe(1)
    })

    test(`${page}: polling resumes after focus leaves the retained facts`, async () => {
      const f = fixture()
      const poll = f.refresh()
      f.focus()
      f.resolve()
      await poll
      expect(f.renders()).toBe(0)
      f.blur()
      await f.refresh()
      expect(f.renders()).toBe(1)
    })

    test(`${page}: a retained active fact prevents polling even in an inactive document`, async () => {
      const f = fixture(true, false)
      expect(f.document.hasFocus()).toBe(false)
      expect(f.document.querySelector(":focus")).toBeNull()
      f.resolve()
      await f.refresh()
      expect(f.requests()).toBe(0)
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    test(`${page}: an inactive document retains a fact selected during a successful poll until blur`, async () => {
      const f = fixture(false, false)
      const poll = f.refresh()
      f.focus()
      f.resolve()
      await poll
      expect(f.document.querySelector(":focus")).toBeNull()
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
      f.blur()
      await f.refresh()
      expect(f.renders()).toBe(1)
    })

    test(`${page}: an inactive document retains a selected fact during a failing poll`, async () => {
      const f = fixture(false, false)
      const poll = f.refresh()
      f.focus()
      f.reject()
      await poll
      expect(f.renders()).toBe(0)
      expect(f.content.innerHTML).toBe("original focused facts")
    })

    if (page === "home") test("home: hover still prevents polling without an active fact", async () => {
      const f = fixture(false, false)
      f.hover()
      await f.refresh()
      expect(f.document.hasFocus()).toBe(false)
      expect(f.requests()).toBe(0)
      expect(f.renders()).toBe(0)
    })
  }
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
