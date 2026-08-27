/**
 * Unit tests for profileRename.ts and the alias half of profiles.ts.
 *
 * Everything on disk here lives in a throwaway config dir — no test may read,
 * move or write anything under the developer's real ~/.config/meridian.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyProfileRename,
  isValidProfileId,
  planProfileRename,
  reclaimAlias,
} from "../proxy/profileRename"
import {
  findProfileByIdOrAlias,
  listProfiles,
  resolveProfile,
  resetActiveProfile,
  type ProfileConfig,
} from "../proxy/profiles"
import { setSetting, getSetting } from "../proxy/settings"

const PROFILES_DIR = "/cfg/meridian/profiles"

beforeEach(() => {
  resetActiveProfile()
})

describe("isValidProfileId", () => {
  test("accepts letters, numbers, hyphens and underscores", () => {
    for (const id of ["work", "Work2", "my-profile", "my_profile", "a"]) {
      expect(isValidProfileId(id)).toBe(true)
    }
  })

  test("rejects empty and anything outside the charset", () => {
    for (const id of ["", "with space", "dot.name", "slash/name", "..", "emoji🙂", "quote\"name"]) {
      expect(isValidProfileId(id)).toBe(false)
    }
  })
})

describe("reclaimAlias", () => {
  test("drops the name from whichever profile redirects it", () => {
    const profiles: ProfileConfig[] = [
      { id: "z", aliases: ["x", "y"] },
      { id: "other" },
    ]
    const next = reclaimAlias(profiles, "x")
    expect(next[0]!.aliases).toEqual(["y"])
    expect(next[1]).toBe(profiles[1]!)
  })

  test("removes the key entirely when the last alias goes", () => {
    const next = reclaimAlias([{ id: "z", aliases: ["x"] }], "x")
    expect(next[0]!.aliases).toBeUndefined()
    expect("aliases" in next[0]!).toBe(false)
  })

  test("leaves the list untouched when nothing redirects that name", () => {
    const profiles: ProfileConfig[] = [{ id: "z", aliases: ["x"] }]
    expect(reclaimAlias(profiles, "nothing")[0]).toBe(profiles[0]!)
  })
})

describe("planProfileRename — refusals", () => {
  const profiles: ProfileConfig[] = [
    { id: "work", claudeConfigDir: join(PROFILES_DIR, "work") },
    { id: "personal", claudeConfigDir: join(PROFILES_DIR, "personal") },
  ]

  test("refuses a profile that does not exist", () => {
    const result = planProfileRename(profiles, "ghost", "new", PROFILES_DIR)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"ghost" not found')
  })

  test("refuses a target that already exists", () => {
    const result = planProfileRename(profiles, "work", "personal", PROFILES_DIR)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"personal" already exists')
  })

  test("refuses an invalid target name", () => {
    const result = planProfileRename(profiles, "work", "not a name", PROFILES_DIR)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Invalid profile name")
  })

  test("refuses renaming a profile to the name it already has", () => {
    const result = planProfileRename(profiles, "work", "work", PROFILES_DIR)
    expect(result.ok).toBe(false)
  })

  test("a refusal plans nothing at all", () => {
    const before = JSON.stringify(profiles)
    planProfileRename(profiles, "work", "personal", PROFILES_DIR)
    expect(JSON.stringify(profiles)).toBe(before)
  })
})

describe("planProfileRename — what moves", () => {
  test("renames the entry, rewrites its config dir, and moves the credentials", () => {
    const profiles: ProfileConfig[] = [{ id: "work", claudeConfigDir: join(PROFILES_DIR, "work") }]
    const result = planProfileRename(profiles, "work", "employer", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles[0]!.id).toBe("employer")
    expect(result.plan.profiles[0]!.claudeConfigDir).toBe(join(PROFILES_DIR, "employer"))
    expect(result.plan.dirMove).toEqual({
      from: join(PROFILES_DIR, "work"),
      to: join(PROFILES_DIR, "employer"),
    })
  })

  test("moves the isolation dir of an oauth-token profile", () => {
    const profiles: ProfileConfig[] = [{ id: "ci", type: "oauth-token", oauthToken: "placeholder" }]
    const result = planProfileRename(profiles, "ci", "builder", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.dirMove).toEqual({
      from: join(PROFILES_DIR, "ci"),
      to: join(PROFILES_DIR, "builder"),
    })
  })

  test("does not touch credentials it never owned (imported ~/.claude)", () => {
    const profiles: ProfileConfig[] = [{ id: "work", claudeConfigDir: "/home/someone/.claude" }]
    const result = planProfileRename(profiles, "work", "employer", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.dirMove).toBeUndefined()
    expect(result.plan.profiles[0]!.claudeConfigDir).toBe("/home/someone/.claude")
  })

  test("an api profile has no directory to move", () => {
    const profiles: ProfileConfig[] = [{ id: "direct", type: "api", apiKey: "placeholder" }]
    const result = planProfileRename(profiles, "direct", "vendor", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.dirMove).toBeUndefined()
  })
})

describe("planProfileRename — aliases", () => {
  test("the old name becomes an alias of the new one", () => {
    const result = planProfileRename([{ id: "x" }], "x", "y", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.aliases).toEqual(["x"])
    expect(result.plan.profiles[0]!.aliases).toEqual(["x"])
  })

  test("collapses chains: x→y then y→z leaves z answering to both", () => {
    const first = planProfileRename([{ id: "x" }], "x", "y", PROFILES_DIR)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = planProfileRename(first.plan.profiles, "y", "z", PROFILES_DIR)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.plan.profiles[0]!.id).toBe("z")
    expect(second.plan.profiles[0]!.aliases!.sort()).toEqual(["x", "y"])
  })

  test("renaming back to a former name does not alias a profile to itself", () => {
    const result = planProfileRename([{ id: "y", aliases: ["x"] }], "y", "x", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles[0]!.id).toBe("x")
    expect(result.plan.profiles[0]!.aliases).toEqual(["y"])
  })

  test("renaming TO a name another profile redirects reclaims it", () => {
    const profiles: ProfileConfig[] = [
      { id: "z", aliases: ["x", "y"] },
      { id: "w" },
    ]
    const result = planProfileRename(profiles, "w", "x", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles.find(p => p.id === "z")!.aliases).toEqual(["y"])
    expect(result.plan.profiles.find(p => p.id === "x")!.aliases).toEqual(["w"])
  })

  test("aliases never accumulate duplicates", () => {
    const result = planProfileRename([{ id: "y", aliases: ["x"] }], "y", "z", PROFILES_DIR)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const again = planProfileRename(result.plan.profiles, "z", "y", PROFILES_DIR)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.plan.profiles[0]!.aliases!.sort()).toEqual(["x", "z"])
  })
})

describe("alias resolution", () => {
  test("a request naming the old profile is served by the renamed one", () => {
    const profiles: ProfileConfig[] = [
      { id: "employer", claudeConfigDir: "/cfg/employer", aliases: ["work"] },
    ]
    const resolved = resolveProfile(profiles, undefined, "work")
    expect(resolved.id).toBe("employer")
    expect(resolved.env).toEqual({ CLAUDE_CONFIG_DIR: "/cfg/employer" })
  })

  test("a real profile always wins over an alias of the same name", () => {
    const profiles: ProfileConfig[] = [
      { id: "employer", claudeConfigDir: "/cfg/employer", aliases: ["work"] },
      { id: "work", claudeConfigDir: "/cfg/work" },
    ]
    const resolved = resolveProfile(profiles, undefined, "work")
    expect(resolved.id).toBe("work")
    expect(resolved.env).toEqual({ CLAUDE_CONFIG_DIR: "/cfg/work" })
  })

  test("order on disk cannot change which one wins", () => {
    const profiles: ProfileConfig[] = [
      { id: "work", claudeConfigDir: "/cfg/work" },
      { id: "employer", claudeConfigDir: "/cfg/employer", aliases: ["work"] },
    ]
    expect(resolveProfile(profiles, undefined, "work").id).toBe("work")
  })

  test("once the alias is reclaimed the redirect is gone", () => {
    const renamed: ProfileConfig[] = [{ id: "employer", aliases: ["work"] }]
    const afterAdd = [...reclaimAlias(renamed, "work"), { id: "work", claudeConfigDir: "/cfg/work" }]
    expect(resolveProfile(afterAdd, undefined, "work").id).toBe("work")
    expect(findProfileByIdOrAlias(afterAdd, "work")!.id).toBe("work")
  })

  test("an unknown name still falls back to the first profile", () => {
    const profiles: ProfileConfig[] = [{ id: "employer", aliases: ["work"] }, { id: "other" }]
    expect(resolveProfile(profiles, undefined, "nothing").id).toBe("employer")
  })

  test("listProfiles exposes aliases only when there are some", () => {
    const listed = listProfiles([{ id: "employer", aliases: ["work"] }, { id: "solo" }], undefined)
    expect(listed[0]!.aliases).toEqual(["work"])
    expect(listed[1]!.aliases).toBeUndefined()
  })
})

describe("applyProfileRename", () => {
  let root: string
  let profilesDir: string
  let configFile: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meridian-rename-"))
    profilesDir = join(root, "profiles")
    configFile = join(root, "profiles.json")
    mkdirSync(profilesDir, { recursive: true })
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = root
  })

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(root, { recursive: true, force: true })
  })

  function seed(profiles: ProfileConfig[]): void {
    writeFileSync(configFile, JSON.stringify(profiles, null, 2))
  }

  function readConfig(): ProfileConfig[] {
    return JSON.parse(readFileSync(configFile, "utf-8"))
  }

  test("moves the credential directory and the config entry together", () => {
    const workDir = join(profilesDir, "work")
    mkdirSync(workDir)
    writeFileSync(join(workDir, ".credentials.json"), "{}")
    seed([{ id: "work", claudeConfigDir: workDir }])

    const result = applyProfileRename("work", "employer", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    expect(existsSync(workDir)).toBe(false)
    expect(existsSync(join(profilesDir, "employer", ".credentials.json"))).toBe(true)
    const saved = readConfig()
    expect(saved[0]!.id).toBe("employer")
    expect(saved[0]!.claudeConfigDir).toBe(join(profilesDir, "employer"))
    expect(saved[0]!.aliases).toEqual(["work"])
  })

  test("refuses when the destination directory is already occupied", () => {
    mkdirSync(join(profilesDir, "work"))
    mkdirSync(join(profilesDir, "employer"))
    seed([{ id: "work", claudeConfigDir: join(profilesDir, "work") }])

    const result = applyProfileRename("work", "employer", { profilesDir, configFile })

    expect(result.ok).toBe(false)
    expect(existsSync(join(profilesDir, "work"))).toBe(true)
    expect(readConfig()[0]!.id).toBe("work")
  })

  test("refuses a duplicate without moving anything", () => {
    mkdirSync(join(profilesDir, "work"))
    seed([
      { id: "work", claudeConfigDir: join(profilesDir, "work") },
      { id: "personal" },
    ])

    const result = applyProfileRename("work", "personal", { profilesDir, configFile })

    expect(result.ok).toBe(false)
    expect(existsSync(join(profilesDir, "work"))).toBe(true)
    expect(readConfig()[0]!.id).toBe("work")
  })

  test("puts the credentials back when the profile list cannot be written", () => {
    if (process.getuid?.() === 0) return // root ignores the read-only bit
    const workDir = join(profilesDir, "work")
    mkdirSync(workDir)
    seed([{ id: "work", claudeConfigDir: workDir }])
    chmodSync(configFile, 0o444)

    const result = applyProfileRename("work", "employer", { profilesDir, configFile })

    expect(result.ok).toBe(false)
    expect(existsSync(workDir)).toBe(true)
    expect(existsSync(join(profilesDir, "employer"))).toBe(false)
    chmodSync(configFile, 0o644)
    expect(readConfig()[0]!.id).toBe("work")
  })

  test("the active pointer follows the rename", () => {
    seed([{ id: "work", claudeConfigDir: join(profilesDir, "work") }])
    setSetting("activeProfile", "work")

    const result = applyProfileRename("work", "employer", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    expect(getSetting("activeProfile")).toBe("employer")
  })

  test("renaming a different profile leaves the active pointer alone", () => {
    seed([{ id: "work" }, { id: "personal" }])
    setSetting("activeProfile", "personal")

    applyProfileRename("work", "employer", { profilesDir, configFile })

    expect(getSetting("activeProfile")).toBe("personal")
  })

  test("a renamed profile still resolves under its old name", () => {
    seed([{ id: "work", claudeConfigDir: join(profilesDir, "work") }])

    const result = applyProfileRename("work", "employer", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(resolveProfile(result.profiles, undefined, "work").id).toBe("employer")
  })
})
