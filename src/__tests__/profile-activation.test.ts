import { describe, expect, it } from "bun:test"
import { activateProfile, type ProfileActivationDeps } from "../proxy/profileActivation"

function rig(activeProfile: string | undefined) {
  let active = activeProfile
  let cacheClears = 0
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  const lines: string[] = []
  const deps: ProfileActivationDeps = {
    getActiveProfileId: () => active,
    setActiveProfile: profileId => { active = profileId },
    clearActiveProfile: () => { active = undefined },
    clearSessionCache: () => { cacheClears += 1 },
    logEvent: (event, fields) => { events.push({ event, fields }) },
    logLine: message => { lines.push(message) },
  }
  return { deps, active: () => active, cacheClears: () => cacheClears, events, lines }
}

describe("activateProfile", () => {
  it("sets the profile, clears cached sessions, and attributes the transition", () => {
    const r = rig("old")
    activateProfile("new", { source: "profiles-api", userAgent: "client" }, r.deps)

    expect(r.active()).toBe("new")
    expect(r.cacheClears()).toBe(1)
    expect(r.events).toEqual([{
      event: "profile.switched",
      fields: {
        from: "old",
        to: "new",
        source: "profiles-api",
        userAgent: "client",
        origin: null,
      },
    }])
    expect(r.lines[0]).toContain("old")
  })

  it("clears active state when exclusions leave no eligible profile", () => {
    const r = rig("only")
    activateProfile(undefined, { source: "routing-exclusions" }, r.deps)

    expect(r.active()).toBeUndefined()
    expect(r.cacheClears()).toBe(1)
    expect(r.events[0]?.fields.to).toBeNull()
  })
})
