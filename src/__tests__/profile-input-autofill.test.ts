/**
 * No text field on /profiles may be taken for a login form's username box: a
 * ChatGPT seat card puts a "Sign in again" button beside its rename field,
 * and LastPass filled that field with an email (it ignores autocomplete="off").
 */
import { describe, expect, it } from "bun:test"
import { PROFILE_INPUT_ATTRS, profilePageHtml } from "../telemetry/profilePage"

describe("profile page text fields", () => {
  it("opt out of LastPass, 1Password and Bitwarden by their own attributes", () => {
    for (const attr of ['data-lpignore="true"', 'data-1p-ignore="true"', 'data-bwignore="true"', 'data-form-type="other"', 'autocomplete="off"']) {
      expect(PROFILE_INPUT_ATTRS).toContain(attr)
    }
  })

  it("carry them on every input: search, rename, profile name and both paste boxes", () => {
    const inputs = profilePageHtml.split("<input").slice(1).map(rest => rest.slice(0, 260))
    expect(inputs.length).toBe(5)
    for (const input of inputs) expect(input.includes("PROFILE_INPUT_ATTRS") || input.includes('data-lpignore="true"')).toBe(true)
    expect(profilePageHtml).toContain(`var PROFILE_INPUT_ATTRS = '${PROFILE_INPUT_ATTRS}';`)
    expect(profilePageHtml).toContain('id=\\"rename-input\\" type=\\"text\\"')
  })
})
