/**
 * Unit tests for the `meridian profile login <id>` decision layer — pure
 * function tests (no mocks, no disk access, no `claude auth login`).
 */
import { describe, test, expect } from "bun:test"
import { isValidProfileId, planProfileLogin } from "../proxy/profileCli"
import type { ProfileConfig } from "../proxy/profiles"

const profiles: ProfileConfig[] = [
  { id: "personal", type: "claude-max", claudeConfigDir: "/home/.config/meridian/profiles/personal" },
  { id: "ci", type: "oauth-token", oauthToken: "sk-ant-oat01-xxx" },
  { id: "ci-inferred", oauthToken: "sk-ant-oat01-yyy" },
]

describe("isValidProfileId", () => {
  test("accepts letters, digits, hyphens and underscores", () => {
    for (const id of ["work", "work-2", "work_2", "Work2", "a"]) {
      expect(isValidProfileId(id)).toBe(true)
    }
  })

  test("refuses path separators, traversal segments and empty input", () => {
    for (const id of ["", ".", "..", "../../etc", "a/b", "a\\b", "~", "with space", "dollar$"]) {
      expect(isValidProfileId(id)).toBe(false)
    }
  })
})

describe("planProfileLogin", () => {
  test("an unknown ID is a request to add that profile, not an error", () => {
    expect(planProfileLogin("brand-new", profiles)).toEqual({ action: "create" })
  })

  test("an unknown ID with nothing configured yet still adds", () => {
    expect(planProfileLogin("first", [])).toEqual({ action: "create" })
  })

  test("refuses to turn a traversal ID into a profile directory", () => {
    expect(planProfileLogin("../../etc", profiles)).toEqual({ action: "reject-invalid-id" })
    expect(planProfileLogin("a/b", profiles)).toEqual({ action: "reject-invalid-id" })
    expect(planProfileLogin("", profiles)).toEqual({ action: "reject-invalid-id" })
  })

  test("GOLDEN: a known browser-login profile logs in, unchanged", () => {
    expect(planProfileLogin("personal", profiles)).toEqual({ action: "login", profile: profiles[0]! })
  })

  test("GOLDEN: an oauth-token profile is still refused, by type and by inference", () => {
    expect(planProfileLogin("ci", profiles)).toEqual({ action: "reject-oauth-token" })
    expect(planProfileLogin("ci-inferred", profiles)).toEqual({ action: "reject-oauth-token" })
  })

  test("an existing profile is never re-validated — login keeps working on hand-written IDs", () => {
    const handWritten: ProfileConfig[] = [{ id: "legacy.name", claudeConfigDir: "/somewhere" }]
    expect(planProfileLogin("legacy.name", handWritten)).toEqual({ action: "login", profile: handWritten[0]! })
  })
})
