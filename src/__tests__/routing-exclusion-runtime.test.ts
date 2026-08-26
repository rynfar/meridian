import { describe, expect, it } from "bun:test"
import {
  evaluateRoutingProfileAccess,
  noEligibleProfilesResponse,
  profileExcludedResponse,
  replacementForExcludedActive,
} from "../proxy/routingExclusionRuntime"

const profiles = [
  { id: "primary", env: {} },
  { id: "reserved", env: {} },
]

describe("routing exclusion runtime", () => {
  it("returns only work-eligible profiles and an eligible default", () => {
    const result = evaluateRoutingProfileAccess({
      profiles,
      defaultProfile: "reserved",
      purpose: "work",
      excludedProfileIds: ["reserved"],
    })

    expect(result.access.kind).toBe("allowed")
    expect(result.profiles.map(profile => profile.id)).toEqual(["primary"])
    expect(result.defaultProfile).toBeUndefined()
  })

  it("keeps excluded profiles available to the warm purpose", () => {
    const result = evaluateRoutingProfileAccess({
      profiles,
      defaultProfile: "reserved",
      purpose: "warm",
      explicitProfileId: "reserved",
      excludedProfileIds: ["reserved"],
    })

    expect(result.profiles.map(profile => profile.id)).toEqual(["primary", "reserved"])
    expect(result.defaultProfile).toBe("reserved")
  })

  it("moves an excluded active profile to the first eligible profile", () => {
    expect(replacementForExcludedActive({
      profiles,
      activeProfile: "reserved",
      excludedProfileIds: ["reserved"],
    })).toEqual({ change: true, profileId: "primary" })
  })

  it("returns stable error envelopes", async () => {
    const excluded = profileExcludedResponse("reserved")
    const empty = noEligibleProfilesResponse()
    expect(excluded.status).toBe(409)
    expect(await excluded.json()).toEqual({
      type: "error",
      error: {
        type: "profile_excluded",
        message: "Profile \"reserved\" is excluded from work routing",
      },
    })
    expect(empty.status).toBe(503)
  })
})
