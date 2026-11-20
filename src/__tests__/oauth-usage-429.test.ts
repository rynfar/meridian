import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { clearOAuthUsageForProfile, fetchOAuthUsageResult, resetOAuthUsageCache } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

describe("OAuth usage 429 cooldown", () => {
  let now: number
  let calls: number
  let respond: () => Response
  let clock: ReturnType<typeof spyOn<typeof Date, "now">>
  let random: ReturnType<typeof spyOn<typeof Math, "random">>
  let diagnostics: ReturnType<typeof spyOn<typeof console, "error">>
  const store: CredentialStore = {
    async read() {
      return { claudeAiOauth: {
        accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: now + 3_600_000,
      } }
    },
    async write() { return false },
  }
  const opts = {
    force: true,
    profileId: "limited",
    store,
    refreshImpl: async () => false,
    fetchImpl: async () => { calls += 1; return respond() },
  }
  const usage = { seven_day: { utilization: 12, resets_at: null } }

  beforeEach(() => {
    resetOAuthUsageCache()
    now = 1_700_000_000_000
    calls = 0
    respond = () => new Response("rate limited", { status: 429 })
    clock = spyOn(Date, "now").mockImplementation(() => now)
    random = spyOn(Math, "random").mockReturnValue(0.5)
    diagnostics = spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    clock.mockRestore()
    random.mockRestore()
    diagnostics.mockRestore()
    resetOAuthUsageCache()
  })

  test("honours one-hour Retry-After instead of the 15-minute stale lifetime", async () => {
    // Given no last-good snapshot and a one-hour upstream wait.
    respond = () => calls === 1
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": "3600" } })
      : Response.json(usage)
    await fetchOAuthUsageResult(opts)
    // When the stale lifetime expires, even forced callers stay suppressed.
    now += 15 * 60_000
    expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
    expect(calls).toBe(1)
    now += 45 * 60_000 - 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(1)
    // Then the full hour, not the display lifetime, releases the retry.
    now += 1
    expect((await fetchOAuthUsageResult(opts)).snapshot?.windows[0]?.utilization).toBe(0.12)
    expect(calls).toBe(2)
    expect(random).not.toHaveBeenCalled()
  })

  test("caps an absurd Retry-After at one hour", async () => {
    // Given a valid but excessive one-year wait.
    respond = () => calls === 1
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": "31536000" } })
      : Response.json(usage)
    await fetchOAuthUsageResult(opts)
    // When still inside the safety cap, there is no upstream call.
    now += 3_600_000 - 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(1)
    // Then the cap permits re-probing rather than waiting for a year.
    now += 1
    expect((await fetchOAuthUsageResult(opts)).snapshot).not.toBeNull()
    expect(calls).toBe(2)
  })

  test("honours an HTTP-date Retry-After", async () => {
    // Given the alternate valid header form.
    const retryAt = now + 30 * 60_000
    respond = () => calls === 1
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": new Date(retryAt).toUTCString() } })
      : Response.json(usage)
    await fetchOAuthUsageResult(opts)
    // When one millisecond remains, the request is suppressed.
    now = retryAt - 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(1)
    // Then the date boundary permits one fresh reading.
    now += 1
    expect((await fetchOAuthUsageResult(opts)).snapshot).not.toBeNull()
    expect(calls).toBe(2)
  })

  test.each([undefined, "invalid", "0"])("escalates without a usable Retry-After (%s)", async (hint) => {
    // Given repeated 429s and midpoint jitter (the nominal delay).
    respond = () => new Response("rate limited", {
      status: 429, headers: hint === undefined ? {} : { "Retry-After": hint },
    })
    await fetchOAuthUsageResult(opts)
    // When each cooldown elapses, the next no-hint delay doubles to its cap.
    for (const [index, wait] of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000].entries()) {
      now += wait - 1
      await fetchOAuthUsageResult(opts)
      await fetchOAuthUsageResult({ ...opts, force: false })
      // Then suppressed polls add neither upstream calls nor escalation.
      expect(calls).toBe(index + 1)
      now += 1
      expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
      expect(calls).toBe(index + 2)
    }
  })

  test.each([
    { sample: 0, waits: [60_000, 96_000, 192_000, 384_000, 720_000] },
    { sample: 0.5, waits: [60_000, 120_000, 240_000, 480_000, 900_000] },
    { sample: 1, waits: [72_000, 144_000, 288_000, 576_000, 900_000] },
  ])("bounds jitter at random sample $sample", async ({ sample, waits }) => {
    // Given the lower, midpoint or upper random bound.
    random.mockReturnValue(sample)
    await fetchOAuthUsageResult(opts)
    // When retrying successive 429s, jitter does not compound or cross caps.
    for (const [index, wait] of waits.entries()) {
      now += wait - 1
      await fetchOAuthUsageResult(opts)
      // Then each observed boundary is inside [floor, cap] and +/-20% of nominal.
      expect(calls).toBe(index + 1)
      now += 1
      await fetchOAuthUsageResult(opts)
      expect(calls).toBe(index + 2)
    }
  })

  test("resets escalation after success", async () => {
    // Given two consecutive no-hint refusals.
    await fetchOAuthUsageResult(opts)
    now += 60_000
    await fetchOAuthUsageResult(opts)
    now += 120_000
    // When a reading succeeds before another refusal.
    respond = () => Response.json(usage)
    expect((await fetchOAuthUsageResult(opts)).failure).toBeNull()
    respond = () => new Response("rate limited", { status: 429 })
    expect((await fetchOAuthUsageResult(opts)).failure?.consecutiveFailures).toBe(1)
    // Then the next wait is the initial 60s, not the previous doubled wait.
    now += 60_000 - 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(4)
    now += 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(5)
  })

  test("keeps escalation independent per profile", async () => {
    // Given one profile already on its second refusal.
    await fetchOAuthUsageResult(opts)
    now += 60_000
    await fetchOAuthUsageResult(opts)
    const other = { ...opts, profileId: "other" }
    // When a second profile receives its first refusal.
    await fetchOAuthUsageResult(other)
    now += 60_000
    // Then only that profile can retry at its initial delay.
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(3)
    await fetchOAuthUsageResult(other)
    expect(calls).toBe(4)
    now += 60_000
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(5)
  })

  test("clearing a profile resets its escalation", async () => {
    await fetchOAuthUsageResult(opts)
    now += 60_000
    await fetchOAuthUsageResult(opts)
    clearOAuthUsageForProfile("limited")
    await fetchOAuthUsageResult(opts)
    now += 60_000 - 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(3)
    now += 1
    await fetchOAuthUsageResult(opts)
    expect(calls).toBe(4)
  })
})
