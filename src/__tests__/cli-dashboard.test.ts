/**
 * Unit tests for cliDashboard.ts — a pure renderer, so no server and no mocks.
 *
 * The fixtures are the response shapes of the four routes the landing page
 * fetches (/health, /profiles/list, /v1/usage/quota/all, /telemetry/summary),
 * with invented account ids: an upstream fixture must not carry real
 * addresses, and the renderer cannot tell the difference.
 */

import { describe, it, expect } from "bun:test"
import {
  renderCliDashboard,
  type CliDashboardInput,
  type ProfileListPayload,
  type QuotaPayload,
  type SummaryPayload,
} from "../telemetry/cliDashboard"

const NOW = 1_754_600_000_000
const HOUR = 3_600_000
const DAY = 86_400_000

const health = {
  status: "healthy",
  auth: { loggedIn: true, email: "someone@example.com", subscriptionType: "max" },
  mode: "internal",
}

const profileList: ProfileListPayload = {
  profiles: [
    { id: "primary", type: "claude-max", isActive: true },
    { id: "weekend", type: "claude-max", isActive: false },
    { id: "borrowed", type: "claude-max", isActive: false },
  ],
  routing: "sticky",
}

const quota: QuotaPayload = {
  profiles: [
    {
      id: "primary",
      windows: [
        { type: "five_hour", utilization: 0.66, resetsAt: NOW + 2 * HOUR + 14 * 60_000 },
        { type: "seven_day", utilization: 0.74, resetsAt: NOW + 3 * DAY + 6 * HOUR },
      ],
    },
    // The state this machine is actually in: no credentials for the profile.
    // /v1/usage/quota/all reports it as an error and returns no windows; the
    // page does not read the error field, so it must read as "no usage data
    // yet" rather than as a zeroed-out account.
    { id: "weekend", windows: [], error: "no_token" },
    {
      id: "borrowed",
      windows: [
        { type: "seven_day", utilization: 0.3, resetsAt: NOW + DAY },
        { type: "seven_day_opus", utilization: 0.91, resetsAt: NOW + DAY },
      ],
    },
  ],
}

const summary: SummaryPayload = {
  totalRequests: 1714,
  errorCount: 3,
  envelopeViolationCount: 0,
  totalDuration: { p50: 4200, p95: 18_300 },
  tokenUsage: { totalInputTokens: 1_240_000, totalOutputTokens: 2_300_000, avgCacheHitRate: 0.87 },
  costEstimate: {
    totalUsd: 312.45,
    byProfile: {
      primary: { requests: 1700, estimatedUsd: 310.2 },
      borrowed: { requests: 14, estimatedUsd: 2.25 },
    },
  },
}

const healthyFleet: CliDashboardInput = {
  host: "127.0.0.1",
  port: 3456,
  health,
  profileList,
  quota,
  summary,
  now: NOW,
}

describe("renderCliDashboard — a healthy fleet", () => {
  const out = renderCliDashboard(healthyFleet)

  it("names every configured profile", () => {
    expect(out).toContain("primary")
    expect(out).toContain("weekend")
    expect(out).toContain("borrowed")
  })

  it("marks exactly the active profile", () => {
    expect(out.match(/ACTIVE/g)).toHaveLength(1)
    const activeLine = out.split("\n").find((l) => l.includes("ACTIVE"))
    expect(activeLine).toContain("primary")
  })

  it("renders the header pill from /health status", () => {
    expect(out).toContain("Operational")
    expect(out).toContain("primary claude-max")
  })

  it("renders the endpoint and the page's meta line", () => {
    expect(out).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:3456")
    expect(out).toContain("someone@example.com (max) · internal · port 3456")
  })

  it("labels windows the way the page does", () => {
    expect(out).toContain("5h")
    expect(out).toContain("7d")
    expect(out).toContain("7d Opus")
  })

  it("renders utilization percentages", () => {
    expect(out).toContain("66%")
    expect(out).toContain("74%")
    expect(out).toContain("91%")
  })

  it("promotes a pace whose projection reaches the cap to 'runs out before reset'", () => {
    // primary: 74% used with ~54% of the week elapsed projects to 138%.
    expect(out).toContain("138%")
    expect(out).toContain("runs out before reset")
  })

  it("renders an under-pace profile with a signed delta and a projection", () => {
    // borrowed: 30% used with ~86% elapsed — 56 points under an even pace.
    expect(out).toContain("-56%")
    expect(out).toContain("~35% by reset")
  })

  it("aligns the figure column across every account", () => {
    const rowLines = out.split("\n").filter((l) => /[░█]/.test(l))
    expect(rowLines.length).toBeGreaterThan(3)
    const columns = new Set(rowLines.map((l) => l.indexOf("%")))
    expect(columns.size).toBe(1)
  })

  it("renders the 24h strip, total uncoloured and errors on the detail line", () => {
    expect(out).toContain("1714")
    expect(out).toContain("3 errors")
    expect(out).toContain("2.3M")
    expect(out).toContain("1.2M in")
    expect(out).toContain("87%")
    // usd() rounds at and above $100, cents only below it — landing.ts's rule.
    expect(out).toContain("$312")
    expect(out).toContain("4.2s")
    expect(out).toContain("p95 18.3s")
  })

  it("omits the envelope item when the wire contract is clean", () => {
    expect(out).not.toContain("wire-contract violations")
  })

  it("shows per-profile cost and request counts", () => {
    expect(out).toContain("$310")
    expect(out).toContain("1700 requests · est. API value · 24h")
    expect(out).toContain("14 requests · est. API value · 24h")
  })
})

describe("renderCliDashboard — a profile with no token", () => {
  it("renders it the way the page does, not as a zeroed account", () => {
    const out = renderCliDashboard(healthyFleet)
    const lines = out.split("\n")
    const weekendIdx = lines.findIndex((l) => l.includes("weekend"))
    expect(weekendIdx).toBeGreaterThan(-1)
    expect(lines.slice(weekendIdx, weekendIdx + 3).join("\n")).toContain("no usage data yet")
  })

  it("shows no traffic rather than a zero request count", () => {
    const out = renderCliDashboard(healthyFleet)
    expect(out).toContain("no traffic · 24h")
  })
})

describe("renderCliDashboard — missing fields", () => {
  const sparse: CliDashboardInput = {
    host: "127.0.0.1",
    port: 3456,
    health: { status: "degraded" },
    profileList: { profiles: [{ id: "primary", isActive: true }] },
    quota: { profiles: [{ id: "primary", windows: [] }] },
    summary: { errorCount: 0, tokenUsage: { avgCacheHitRate: null } },
    now: NOW,
  }
  const out = renderCliDashboard(sparse)

  it("renders an absent count as an explicit unknown, never as 0", () => {
    const requests = out.split("\n").find((l) => l.includes("Requests"))
    expect(requests).toContain("—")
    expect(requests).not.toMatch(/\b0\b/)
  })

  it("renders absent timings and a null cache rate as unknown", () => {
    expect(out).toContain("Median Response  —")
    expect(out).toContain("p95 —")
    const cache = out.split("\n").find((l) => l.includes("Cache Hit"))
    expect(cache).toContain("—")
  })

  it("degrades the health pill rather than claiming health", () => {
    expect(out).toContain("Degraded")
  })

  it("still renders a configured profile that reports nothing", () => {
    expect(out).toContain("primary")
    expect(out).toContain("no usage data yet")
  })
})

describe("renderCliDashboard — unreadable sections", () => {
  it("says why a section is missing instead of showing it empty", () => {
    const out = renderCliDashboard({
      host: "127.0.0.1",
      port: 3456,
      health,
      profileList: null,
      quota: null,
      summary: null,
      unavailable: {
        accounts: "accounts unavailable — the running instance requires an API key",
        traffic: "traffic unavailable — the running instance requires an API key",
      },
      now: NOW,
    })
    expect(out).toContain("accounts unavailable")
    expect(out).toContain("traffic unavailable")
    expect(out).not.toContain("$0.00")
  })
})

describe("renderCliDashboard — priority routing", () => {
  it("renders pool position and exhaustion instead of an active pill", () => {
    const out = renderCliDashboard({
      ...healthyFleet,
      profileList: { ...profileList, routing: "priority", profileOrder: ["borrowed", "primary", "weekend"], exhausted: [{ id: "primary", until: NOW + 2 * HOUR }] },
    })
    expect(out).toContain("#1 in pool")
    expect(out).toContain("#2 in pool")
    expect(out).toContain("exhausted · resets in 2h")
    expect(out).not.toContain("ACTIVE")
  })
})

describe("renderCliDashboard — colour", () => {
  it("emits no escape bytes when colour is off", () => {
    const out = renderCliDashboard(healthyFleet, { color: false })
    expect(out).not.toContain("\x1b")
  })

  it("defaults to no colour, so a caller that forgets cannot corrupt a pipe", () => {
    expect(renderCliDashboard(healthyFleet)).not.toContain("\x1b")
  })

  it("emits colour when asked, and the same text underneath", () => {
    const colored = renderCliDashboard(healthyFleet, { color: true })
    expect(colored).toContain("\x1b[38;5;")
    // eslint-disable-next-line no-control-regex
    const stripped = colored.replace(/\x1b\[[0-9;]*m/g, "")
    expect(stripped).toBe(renderCliDashboard(healthyFleet, { color: false }))
  })

  it("colours a hot window red and a comfortable one green", () => {
    const colored = renderCliDashboard(healthyFleet, { color: true })
    const hot = colored.split("\n").find((l) => l.includes("91%"))
    const cool = colored.split("\n").find((l) => l.includes("-56%"))
    expect(hot).toContain("\x1b[38;5;203m")
    expect(cool).toContain("\x1b[38;5;71m")
  })
})
