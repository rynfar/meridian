import { describe, expect, test } from "bun:test"
import { chatGptWorkspaceOf, findDuplicateProfiles, sameAccount, type IdentifiedProfile } from "../proxy/duplicateProfiles"

const ACCOUNT = "15801697-0000-4000-8000-000000000001"
const ORG_SUB1 = "cbadc09f-0000-4000-8000-000000000001"
const ORG_SUB2 = "d934bd2b-0000-4000-8000-000000000002"
const ORG_PERSONAL = "fb434805-0000-4000-8000-000000000003"

function claude(id: string, accountUuid: string | null, organizationUuid: string | null, email = "damian.nowak@dreamhost.com", organizationName: string | null = null): IdentifiedProfile {
  return { id, identity: { provider: "claude", accountUuid, organizationUuid, email, organizationName } }
}

function seat(id: string, seatId: string, email: string): IdentifiedProfile {
  return { id, identity: { provider: "chatgpt", seat: seatId, email } }
}

describe("sameAccount", () => {
  test("one Claude account in one organization is a duplicate", () => {
    expect(sameAccount(claude("a", ACCOUNT, ORG_SUB1).identity!, claude("b", ACCOUNT, ORG_SUB1).identity!)).toBe("account-organization")
  })

  test("the same person in another organization is a separate subscription", () => {
    expect(sameAccount(claude("a", ACCOUNT, ORG_SUB1).identity!, claude("b", ACCOUNT, ORG_SUB2).identity!)).toBeNull()
  })

  test("known UUIDs outrank matching names", () => {
    const a = claude("a", ACCOUNT, ORG_SUB1, "x@example.com", "DH Sub #1").identity!
    const b = claude("b", ACCOUNT, ORG_SUB2, "x@example.com", "DH Sub #1").identity!
    expect(sameAccount(a, b)).toBeNull()
  })

  test("without UUIDs, email and organization name together stand in", () => {
    const a = claude("a", null, null, "Damian.Nowak@dreamhost.com", "DH Sub #2").identity!
    const b = claude("b", ACCOUNT, ORG_SUB2, "damian.nowak@dreamhost.com", "DH Sub #2").identity!
    expect(sameAccount(a, b)).toBe("email-organization")
  })

  test("email alone is never identity", () => {
    expect(sameAccount(claude("a", null, null, "x@example.com", null).identity!, claude("b", null, null, "x@example.com", null).identity!)).toBeNull()
    expect(sameAccount(claude("a", null, null, "x@example.com", "Org A").identity!, claude("b", null, null, "x@example.com", "Org B").identity!)).toBeNull()
  })

  test("a ChatGPT seat is its seat id; one person in two workspaces is two seats", () => {
    const pro = seat("of-n-p20-gpt", "user-abc__ws-personal", "n@example.com").identity!
    const team = seat("of-n-vk1-gpt", "user-abc__ws-team", "n@example.com").identity!
    expect(sameAccount(pro, team)).toBeNull()
    expect(sameAccount(pro, seat("copy", "user-abc__ws-personal", "n@example.com").identity!)).toBe("seat")
  })

  test("a new user id with the same email in the same workspace is the same seat", () => {
    const a = seat("a", "user-old__ws-team", "n@example.com").identity!
    expect(sameAccount(a, seat("b", "user-new__ws-team", "N@example.com").identity!)).toBe("workspace-email")
    expect(sameAccount(a, seat("c", "user-new__ws-team", "other@example.com").identity!)).toBeNull()
  })

  test("providers never match each other", () => {
    expect(sameAccount(claude("a", ACCOUNT, ORG_SUB1).identity!, seat("b", "user-abc__ws", "damian.nowak@dreamhost.com").identity!)).toBeNull()
  })
})

describe("findDuplicateProfiles", () => {
  // The fleet measured on desktop 2026-10-23: one person, a personal plan and
  // two Team organizations, two of which were signed in twice by mistake.
  const fleet = [
    claude("dn-dh-p", ACCOUNT, ORG_PERSONAL),
    claude("dn-dh-c1", ACCOUNT, ORG_SUB1),
    claude("n-dh-p", ACCOUNT, ORG_SUB2),
    claude("n-dh-c1", ACCOUNT, ORG_SUB1),
    claude("dn-dh-c2", ACCOUNT, ORG_SUB2),
    claude("kwiat-dh-p", "other-account", ORG_PERSONAL, "kwiat@example.com"),
    { id: "unknown", identity: null },
    seat("of-n-p20-gpt", "user-abc__ws-personal", "n@example.com"),
    seat("of-n-vk1-gpt", "user-abc__ws-team", "n@example.com"),
  ]

  test("flags exactly the pairs that share an account, naming each other", () => {
    const found = findDuplicateProfiles(fleet)
    const flagged = Object.fromEntries([...found].filter(([, v]) => v.duplicateOf.length > 0).map(([id, v]) => [id, v.duplicateOf]))
    expect(flagged).toEqual({
      "dn-dh-c1": ["n-dh-c1"],
      "n-dh-c1": ["dn-dh-c1"],
      "n-dh-p": ["dn-dh-c2"],
      "dn-dh-c2": ["n-dh-p"],
    })
    expect(found.get("n-dh-p")!.duplicateBasis).toBe("account-organization")
  })

  test("every profile gets an entry, unknown identity included", () => {
    const found = findDuplicateProfiles(fleet)
    expect(found.size).toBe(fleet.length)
    expect(found.get("unknown")).toEqual({ duplicateOf: [], duplicateBasis: null })
  })

  test("a triple names both others, and reports the weakest evidence", () => {
    const found = findDuplicateProfiles([
      claude("a", ACCOUNT, ORG_SUB1, "x@example.com", "Sub"),
      claude("b", ACCOUNT, ORG_SUB1, "x@example.com", "Sub"),
      claude("c", null, null, "x@example.com", "Sub"),
    ])
    expect(found.get("a")).toEqual({ duplicateOf: ["b", "c"], duplicateBasis: "email-organization" })
    expect(found.get("b")!.duplicateOf).toEqual(["a", "c"])
    expect(found.get("c")!.duplicateOf).toEqual(["a", "b"])
  })

  test("a re-login into the right account clears the flag", () => {
    const before = findDuplicateProfiles([claude("n-dh-c1", ACCOUNT, ORG_SUB1), claude("dn-dh-c1", ACCOUNT, ORG_SUB1)])
    expect(before.get("n-dh-c1")!.duplicateOf).toEqual(["dn-dh-c1"])
    const after = findDuplicateProfiles([claude("n-dh-c1", "nowaker-account", ORG_SUB1, "nowaker@dreamhost.com"), claude("dn-dh-c1", ACCOUNT, ORG_SUB1)])
    expect(after.get("n-dh-c1")!.duplicateOf).toEqual([])
  })
})

test("chatGptWorkspaceOf reads the workspace half of a seat id", () => {
  expect(chatGptWorkspaceOf("user-abc__ws-team")).toBe("ws-team")
  expect(chatGptWorkspaceOf("user-abc")).toBeNull()
})
