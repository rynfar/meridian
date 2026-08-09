/**
 * Follow-the-active-profile mode — MERIDIAN_FOLLOW_ACTIVE.
 *
 * The decision logic is pure so every branch is provable without a second
 * Meridian instance running: followed value present, absent, unknown here,
 * stale, and the followed instance being down mid-flight.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"

import {
  parseFollowTarget,
  isSelfTarget,
  readActiveProfile,
  decideFollowedProfile,
  followedActiveProfile,
  followStatus,
  followTarget,
  isFollowEnabled,
  pollFollowedActiveProfile,
  resetFollowActive,
  setFollowStateForTesting,
  FOLLOW_STALE_AFTER_MS,
} from "../proxy/followActive"
import { resolveProfile, resolveActiveProfileId, setActiveProfile, resetActiveProfile } from "../proxy/profiles"

const FOLLOWED = "http://127.0.0.1:3456"
const realFetch = globalThis.fetch

function follow(url = FOLLOWED): void {
  process.env.MERIDIAN_FOLLOW_ACTIVE = url
}

// Bun's `fetch` type carries a `preconnect` member, so a bare function is not
// assignable — keep the real one rather than reaching for a cast.
function stubFetch(impl: () => Promise<Response>): void {
  globalThis.fetch = Object.assign(() => impl(), { preconnect: realFetch.preconnect })
}

beforeEach(() => {
  resetFollowActive()
  resetActiveProfile()
  delete process.env.MERIDIAN_FOLLOW_ACTIVE
})

afterEach(() => {
  resetFollowActive()
  resetActiveProfile()
  delete process.env.MERIDIAN_FOLLOW_ACTIVE
  globalThis.fetch = realFetch
})

describe("parseFollowTarget", () => {
  test("unset or blank is off", () => {
    expect(parseFollowTarget(undefined).kind).toBe("off")
    expect(parseFollowTarget("").kind).toBe("off")
    expect(parseFollowTarget("   ").kind).toBe("off")
  })

  test("normalizes a full URL and strips the trailing slash", () => {
    expect(parseFollowTarget("http://127.0.0.1:3456")).toEqual({ kind: "on", url: "http://127.0.0.1:3456" })
    expect(parseFollowTarget("http://127.0.0.1:3456/")).toEqual({ kind: "on", url: "http://127.0.0.1:3456" })
    expect(parseFollowTarget("http://127.0.0.1:3456/profiles/list")).toEqual({ kind: "on", url: "http://127.0.0.1:3456" })
  })

  test("assumes http for a bare host:port", () => {
    expect(parseFollowTarget("127.0.0.1:3456")).toEqual({ kind: "on", url: "http://127.0.0.1:3456" })
    expect(parseFollowTarget("meridian.internal:8080")).toEqual({ kind: "on", url: "http://meridian.internal:8080" })
  })

  test("accepts https", () => {
    expect(parseFollowTarget("https://meridian.example.com")).toEqual({ kind: "on", url: "https://meridian.example.com" })
  })

  test("rejects a non-http scheme without throwing", () => {
    const parsed = parseFollowTarget("ftp://host:21")
    expect(parsed.kind).toBe("invalid")
  })

  test("rejects a value with no host without throwing", () => {
    expect(parseFollowTarget("http://").kind).toBe("invalid")
  })
})

describe("isSelfTarget", () => {
  test("same port and same host is self", () => {
    expect(isSelfTarget("http://127.0.0.1:3456", "127.0.0.1", 3456)).toBe(true)
  })

  test("loopback spellings are the same machine", () => {
    expect(isSelfTarget("http://localhost:3456", "127.0.0.1", 3456)).toBe(true)
    expect(isSelfTarget("http://127.0.0.1:3456", "localhost", 3456)).toBe(true)
    expect(isSelfTarget("http://[::1]:3456", "127.0.0.1", 3456)).toBe(true)
  })

  test("a different port is a different instance", () => {
    expect(isSelfTarget("http://127.0.0.1:3456", "127.0.0.1", 3458)).toBe(false)
  })

  test("a non-loopback host is a different instance", () => {
    expect(isSelfTarget("http://10.0.0.5:3456", "127.0.0.1", 3456)).toBe(false)
  })

  test("implicit scheme ports are compared", () => {
    expect(isSelfTarget("https://localhost", "127.0.0.1", 443)).toBe(true)
    expect(isSelfTarget("http://localhost", "127.0.0.1", 80)).toBe(true)
  })
})

describe("readActiveProfile", () => {
  test("reads and trims a string value", () => {
    expect(readActiveProfile({ activeProfile: "work" })).toBe("work")
    expect(readActiveProfile({ activeProfile: "  work  " })).toBe("work")
  })

  test("rejects rubbish bodies", () => {
    expect(readActiveProfile(null)).toBeUndefined()
    expect(readActiveProfile("<html>502 Bad Gateway</html>")).toBeUndefined()
    expect(readActiveProfile({})).toBeUndefined()
    expect(readActiveProfile({ activeProfile: 42 })).toBeUndefined()
    expect(readActiveProfile({ activeProfile: null })).toBeUndefined()
    expect(readActiveProfile({ activeProfile: "" })).toBeUndefined()
    expect(readActiveProfile({ activeProfile: "x".repeat(500) })).toBeUndefined()
  })
})

describe("decideFollowedProfile", () => {
  const now = 1_000_000

  test("follows a known value", () => {
    const outcome = decideFollowedProfile({ lastGood: { profileId: "work", at: now } }, ["personal", "work"], now)
    expect(outcome).toEqual({ follow: true, profileId: "work", stale: false })
  })

  test("falls back to local when no value has ever been read", () => {
    expect(decideFollowedProfile({}, ["personal", "work"], now)).toEqual({ follow: false, reason: "no-value" })
  })

  test("refuses to follow a profile this instance does not have", () => {
    const outcome = decideFollowedProfile({ lastGood: { profileId: "randall-personal", at: now } }, ["personal", "work"], now)
    expect(outcome).toEqual({ follow: false, reason: "unknown-profile", followedValue: "randall-personal" })
  })

  test("an empty profile list can follow nothing", () => {
    const outcome = decideFollowedProfile({ lastGood: { profileId: "work", at: now } }, [], now)
    expect(outcome).toEqual({ follow: false, reason: "unknown-profile", followedValue: "work" })
  })

  test("an unconfirmed value is still followed, flagged stale", () => {
    const state = { lastGood: { profileId: "work", at: now - FOLLOW_STALE_AFTER_MS - 1 } }
    expect(decideFollowedProfile(state, ["work"], now)).toEqual({ follow: true, profileId: "work", stale: true })
  })

  test("the followed instance being down keeps the last known value", () => {
    const state = {
      lastGood: { profileId: "work", at: now - 30_000 },
      lastPollAt: now,
      lastError: { message: "fetch failed", at: now },
    }
    expect(decideFollowedProfile(state, ["personal", "work"], now)).toEqual({ follow: true, profileId: "work", stale: false })
  })

  test("unknown-profile beats stale — a fallback is not a resolution", () => {
    const state = { lastGood: { profileId: "gone", at: now - FOLLOW_STALE_AFTER_MS - 1 } }
    expect(decideFollowedProfile(state, ["work"], now)).toEqual({ follow: false, reason: "unknown-profile", followedValue: "gone" })
  })
})

describe("configuration", () => {
  test("off by default", () => {
    expect(isFollowEnabled()).toBe(false)
    expect(followTarget()).toBeUndefined()
    expect(followedActiveProfile(["work"])).toBeUndefined()
    expect(followStatus(["work"])).toBeUndefined()
  })

  test("an unusable value leaves follow mode off rather than failing", () => {
    follow("ftp://nope")
    expect(isFollowEnabled()).toBe(false)
    expect(followedActiveProfile(["work"])).toBeUndefined()
  })

  test("the CLAUDE_PROXY_ alias works", () => {
    process.env.CLAUDE_PROXY_FOLLOW_ACTIVE = FOLLOWED
    try {
      expect(followTarget()).toEqual({ url: FOLLOWED })
    } finally {
      delete process.env.CLAUDE_PROXY_FOLLOW_ACTIVE
    }
  })
})

describe("polling the followed instance", () => {
  function respond(body: unknown, status = 200): void {
    stubFetch(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  }

  function refuseConnection(): void {
    stubFetch(async () => { throw new Error("connect ECONNREFUSED") })
  }

  test("a good response becomes the followed value", async () => {
    follow()
    respond({ activeProfile: "work", profiles: [] })
    await pollFollowedActiveProfile()
    expect(followedActiveProfile(["personal", "work"])).toEqual({ follow: true, profileId: "work", stale: false })
  })

  test("does nothing when follow mode is off", async () => {
    let called = false
    stubFetch(async () => { called = true; return new Response("{}") })
    await pollFollowedActiveProfile()
    expect(called).toBe(false)
  })

  test("a network failure keeps the last known value", async () => {
    follow()
    respond({ activeProfile: "work" })
    await pollFollowedActiveProfile()

    refuseConnection()
    await pollFollowedActiveProfile()

    expect(followedActiveProfile(["work"])).toEqual({ follow: true, profileId: "work", stale: false })
    expect(followStatus(["work"])?.lastError).toContain("ECONNREFUSED")
  })

  test("a non-200 keeps the last known value", async () => {
    follow()
    respond({ activeProfile: "work" })
    await pollFollowedActiveProfile()

    respond({ error: "unauthorized" }, 401)
    await pollFollowedActiveProfile()

    expect(followedActiveProfile(["work"])).toEqual({ follow: true, profileId: "work", stale: false })
    expect(followStatus(["work"])?.lastError).toBe("HTTP 401")
  })

  test("a rubbish body keeps the last known value", async () => {
    follow()
    respond({ activeProfile: "work" })
    await pollFollowedActiveProfile()

    respond({ something: "else" })
    await pollFollowedActiveProfile()

    expect(followedActiveProfile(["work"])).toEqual({ follow: true, profileId: "work", stale: false })
  })

  test("an unreachable instance that has never answered yields no value", async () => {
    follow()
    refuseConnection()
    await pollFollowedActiveProfile()
    expect(followedActiveProfile(["work"])).toEqual({ follow: false, reason: "no-value" })
  })

  test("picks up a change on the followed instance", async () => {
    follow()
    respond({ activeProfile: "personal" })
    await pollFollowedActiveProfile()
    expect(followedActiveProfile(["personal", "work"])).toMatchObject({ profileId: "personal" })

    respond({ activeProfile: "work" })
    await pollFollowedActiveProfile()
    expect(followedActiveProfile(["personal", "work"])).toMatchObject({ profileId: "work" })
  })
})

describe("followStatus", () => {
  test("reports the value in effect", () => {
    follow()
    setFollowStateForTesting({ lastGood: { profileId: "work", at: Date.now() } })
    expect(followStatus(["personal", "work"])).toMatchObject({
      url: FOLLOWED,
      activeProfile: "work",
      followedValue: "work",
      reason: null,
      stale: false,
    })
  })

  test("reports the fallback and why, keeping the raw followed value visible", () => {
    follow()
    setFollowStateForTesting({ lastGood: { profileId: "randall-personal", at: Date.now() } })
    expect(followStatus(["personal", "work"])).toMatchObject({
      activeProfile: null,
      followedValue: "randall-personal",
      reason: "unknown-profile",
    })
  })
})

describe("resolveProfile under follow mode", () => {
  const profiles = [
    { id: "personal", claudeConfigDir: "/home/.claude" },
    { id: "work", claudeConfigDir: "/home/.claude-work" },
  ]

  test("the followed value replaces the local active profile", () => {
    setActiveProfile("personal")
    follow()
    setFollowStateForTesting({ lastGood: { profileId: "work", at: Date.now() } })
    expect(resolveProfile(profiles, undefined).id).toBe("work")
    expect(resolveActiveProfileId(["personal", "work"])).toBe("work")
  })

  test("an explicit header still wins over the followed value", () => {
    setActiveProfile("personal")
    follow()
    setFollowStateForTesting({ lastGood: { profileId: "work", at: Date.now() } })
    expect(resolveProfile(profiles, undefined, "personal").id).toBe("personal")
  })

  test("a followed profile this instance lacks falls back to the local one", () => {
    setActiveProfile("personal")
    follow()
    setFollowStateForTesting({ lastGood: { profileId: "randall-personal", at: Date.now() } })
    expect(resolveProfile(profiles, undefined).id).toBe("personal")
  })

  test("no followed value yet falls back to the local one", () => {
    setActiveProfile("personal")
    follow()
    expect(resolveProfile(profiles, undefined).id).toBe("personal")
  })

  test("follow mode off leaves resolution exactly as it was", () => {
    setActiveProfile("personal")
    setFollowStateForTesting({ lastGood: { profileId: "work", at: Date.now() } })
    expect(resolveProfile(profiles, undefined).id).toBe("personal")
  })

  test("a stale followed value is still served", () => {
    setActiveProfile("personal")
    follow()
    setFollowStateForTesting({ lastGood: { profileId: "work", at: Date.now() - FOLLOW_STALE_AFTER_MS - 1 } })
    expect(resolveProfile(profiles, undefined).id).toBe("work")
    expect(followStatus(["personal", "work"])?.stale).toBe(true)
  })
})
