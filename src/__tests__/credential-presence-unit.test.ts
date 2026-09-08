/**
 * Unit tests for readStoredCredentialPresence — the cross-check that stops
 * /profiles/list calling a logged-out account authenticated.
 *
 * The case that motivated it, measured on a ten-account fleet: three accounts
 * whose stored accessToken was the empty string were reported `loggedIn: true`
 * by `claude auth status`, so the profiles page showed them as fine while every
 * request routed to them returned 401 authentication_error.
 *
 * The store is dependency-injected rather than the platform one, so the file
 * touches no real credential and is safe to run beside every other suite.
 */

import { describe, expect, test } from "bun:test"
import { readStoredCredentialPresence, type CredentialStore } from "../proxy/tokenRefresh"

function storeReading(value: unknown): CredentialStore {
  return {
    async read() { return value as any },
    async write() { return true },
  }
}

const throwingStore: CredentialStore = {
  async read() { throw new Error("keychain refused") },
  async write() { return true },
}

describe("readStoredCredentialPresence", () => {
  test("a credential carrying an access token is present", async () => {
    const store = storeReading({ claudeAiOauth: { accessToken: "sk-ant-oat-xyz", refreshToken: "rt", expiresAt: 1 } })
    expect(await readStoredCredentialPresence(store)).toBe("present")
  })

  test("an EMPTY access token is absent, whatever the auth probe says", async () => {
    // The measured shape: the file parses, every field is there, and the two
    // token values are "". This is the whole reason the cross-check exists.
    const store = storeReading({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } })
    expect(await readStoredCredentialPresence(store)).toBe("absent")
  })

  test("a credential with no oauth block at all is absent", async () => {
    expect(await readStoredCredentialPresence(storeReading({}))).toBe("absent")
  })

  test("a non-string access token is absent rather than trusted", async () => {
    const store = storeReading({ claudeAiOauth: { accessToken: 12345, refreshToken: "rt", expiresAt: 1 } })
    expect(await readStoredCredentialPresence(store)).toBe("absent")
  })

  // The read() contract cannot tell a missing credential from an unreadable
  // one, so neither may demote a working account.
  test("a store answering null is unknown, never absent", async () => {
    expect(await readStoredCredentialPresence(storeReading(null))).toBe("unknown")
  })

  test("a store that throws is unknown", async () => {
    expect(await readStoredCredentialPresence(throwingStore)).toBe("unknown")
  })
})
