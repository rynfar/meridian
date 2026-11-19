import { describe, expect, it } from "bun:test"
import { accountChanged, claudeLoginPart, seatLoginPart, tooSoonPart } from "../proxy/profileRefresh"

describe("claudeLoginPart", () => {
  it("names who the profile is signed in as", () => {
    const part = claudeLoginPart({ state: "authenticated", checkFailed: false, everAnswered: true, presence: "present", email: "a@example.com", accountChanged: false })
    expect(part.state).toBe("fresh")
    expect(part.note).toContain("a@example.com")
  })

  it("says a new login holds another account and that its facts were read afresh", () => {
    const part = claudeLoginPart({ state: "authenticated", checkFailed: false, everAnswered: true, presence: "present", email: "b@example.com", accountChanged: true })
    expect(part.state).toBe("fresh")
    expect(part.note).toContain("another account")
  })

  it("asks for a sign-in when the login is gone", () => {
    const part = claudeLoginPart({ state: "needs_login", checkFailed: false, everAnswered: true, presence: "absent", email: null, accountChanged: false })
    expect(part.state).toBe("failed")
    expect(part.note).toContain("Sign this profile in again")
  })

  it("does not claim an earlier answer stays when there never was one", () => {
    const failed = claudeLoginPart({ state: "unverified", checkFailed: true, everAnswered: false, presence: "unknown", email: null, accountChanged: false })
    expect(failed.state).toBe("failed")
    expect(failed.note).not.toContain("stays")
    expect(claudeLoginPart({ state: "unverified", checkFailed: true, everAnswered: true, presence: "unknown", email: null, accountChanged: false }).note).toContain("stays")
  })
})

describe("seatLoginPart", () => {
  it("reads a seat's login from the usage read that just ran", () => {
    expect(seatLoginPart({ loggedIn: true, tokenState: "ok", email: "s@example.com" })).toMatchObject({ state: "fresh" })
    expect(seatLoginPart({ loggedIn: false, tokenState: "refused", email: null }).state).toBe("failed")
  })
})

describe("tooSoonPart", () => {
  it("answers the time left on the part's own budget", () => {
    expect(tooSoonPart("Usage", 4_200)).toEqual({ state: "rate_limited", note: "Usage was re-read moments ago; the next re-read opens in 5s.", retryAfterMs: 4_200 })
  })
})

describe("accountChanged", () => {
  it("is true only when both readings name an account and they differ", () => {
    expect(accountChanged({ accountUuid: "a" }, { accountUuid: "b" })).toBe(true)
    expect(accountChanged({ accountUuid: "a" }, { accountUuid: "a" })).toBe(false)
    expect(accountChanged(undefined, { accountUuid: "b" })).toBe(false)
    expect(accountChanged({ accountUuid: "a" }, null)).toBe(false)
    expect(accountChanged({ accountUuid: null }, { accountUuid: "b" })).toBe(false)
  })
})
