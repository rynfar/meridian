/**
 * Claude profile removal: profileRemove.ts and POST /profiles/claude/remove.
 *
 * Everything on disk here lives in a throwaway config dir - no test may read,
 * move or write anything under the developer's real ~/.config/meridian.
 *
 * The assertions worth keeping are the two failure directions, not the happy
 * path: a removal that wrote the list and could not delete the directory is
 * recoverable and must SAY SO, and a removal that could not write the list
 * must not have deleted anything at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyProfileRemove, planProfileRemove, profileRemovalSettings } from "../proxy/profileRemove"
import {
  enableDiskProfileDiscovery,
  getActiveProfileId,
  resetActiveProfile,
  resetDiskProfileDiscovery,
  setActiveProfile,
  type ProfileConfig,
} from "../proxy/profiles"
import { createProxyServer } from "../proxy/server"
import { getSetting, saveSettings } from "../settings"

const PROFILES_DIR = "/cfg/meridian/profiles"

describe("planProfileRemove", () => {
  test("takes the named entry out and leaves the rest in order", () => {
    const result = planProfileRemove([{ id: "a" }, { id: "b" }, { id: "c" }], "b", PROFILES_DIR)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles.map(p => p.id)).toEqual(["a", "c"])
    expect(result.plan.removed.id).toBe("b")
  })

  test("refuses a name nothing answers to", () => {
    const result = planProfileRemove([{ id: "a" }], "ghost", PROFILES_DIR)
    expect(result).toMatchObject({ ok: false, code: "unknown_profile" })
    if (result.ok) return
    expect(result.hint).toBeUndefined()
  })

  test("refuses a former name, and says which profile holds it now", () => {
    const result = planProfileRemove([{ id: "employer", aliases: ["work"] }], "work", PROFILES_DIR)

    expect(result).toMatchObject({ ok: false, code: "unknown_profile" })
    if (result.ok) return
    expect(result.hint).toContain("employer")
  })

  test("removing an id never matches an alias on another profile", () => {
    // Both answer to "work" - one as its real id, one as a redirect.
    const result = planProfileRemove([{ id: "old", aliases: ["work"] }, { id: "work" }], "work", PROFILES_DIR)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles.map(p => p.id)).toEqual(["old"])
  })
})

describe("profileRemovalSettings", () => {
  test("moves the active pointer to the first remaining profile", () => {
    expect(profileRemovalSettings({ id: "work" }, [{ id: "personal" }], { activeProfile: "work" }))
      .toEqual({ activeProfile: "personal" })
  })

  test("clears the pointer when no profile remains", () => {
    const update = profileRemovalSettings({ id: "work" }, [], { activeProfile: "work" })
    expect("activeProfile" in update).toBe(true)
    expect(update.activeProfile).toBeUndefined()
  })

  test("drops the profile and its former names from the saved order", () => {
    expect(profileRemovalSettings(
      { id: "employer", aliases: ["work"] },
      [{ id: "personal" }],
      { activeProfile: "personal", profileOrder: ["work", "personal", "employer"] },
    )).toEqual({ profileOrder: ["personal"] })
  })

  test("returns nothing when no setting names the profile", () => {
    expect(profileRemovalSettings({ id: "work" }, [{ id: "personal" }], { activeProfile: "personal", profileOrder: ["personal"] })).toEqual({})
  })
})

function useTempConfigDir() {
  const ctx = { root: "", profilesDir: "", configFile: "" }
  let savedConfigDir: string | undefined
  beforeEach(() => {
    ctx.root = mkdtempSync(join(tmpdir(), "meridian-remove-"))
    ctx.profilesDir = join(ctx.root, "profiles")
    ctx.configFile = join(ctx.root, "profiles.json")
    mkdirSync(ctx.profilesDir, { recursive: true })
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = ctx.root
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
  })
  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    chmodSync(ctx.profilesDir, 0o700)
    rmSync(ctx.root, { recursive: true, force: true })
  })
  return {
    ctx,
    seed(profiles: ProfileConfig[]): void {
      writeFileSync(ctx.configFile, JSON.stringify(profiles, null, 2))
    },
    readConfig(): ProfileConfig[] {
      return JSON.parse(readFileSync(ctx.configFile, "utf-8")) as ProfileConfig[]
    },
    seedProfileDir(id: string): string {
      const dir = join(ctx.profilesDir, id)
      mkdirSync(dir)
      writeFileSync(join(dir, ".credentials.json"), "{}")
      return dir
    },
  }
}

describe("applyProfileRemove", () => {
  const { ctx, seed, readConfig, seedProfileDir } = useTempConfigDir()

  test("drops the entry and deletes the credentials it owned", () => {
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }, { id: "personal" }])

    const result = applyProfileRemove("work", { profilesDir: ctx.profilesDir, configFile: ctx.configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsRemoved).toEqual([workDir])
    expect(result.dirsOrphaned).toEqual([])
    expect(existsSync(workDir)).toBe(false)
    expect(readConfig().map(p => p.id)).toEqual(["personal"])
  })

  test("leaves a credential directory it does not own alone", () => {
    // A profile pointed outside profilesDir names credentials somebody else
    // owns, such as the host's own ~/.claude.
    const foreign = join(ctx.root, "not-ours")
    mkdirSync(foreign)
    seed([{ id: "wild", claudeConfigDir: foreign }])

    const result = applyProfileRemove("wild", { profilesDir: ctx.profilesDir, configFile: ctx.configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsRemoved).toEqual([])
    expect(existsSync(foreign)).toBe(true)
    expect(readConfig()).toEqual([])
  })

  test("deletes the isolation dir an oauth-token profile never recorded", () => {
    const isolation = seedProfileDir("ci")
    seed([{ id: "ci", type: "oauth-token" }])

    expect(applyProfileRemove("ci", { profilesDir: ctx.profilesDir, configFile: ctx.configFile }).ok).toBe(true)
    expect(existsSync(isolation)).toBe(false)
  })

  test("removes the profile even when the directory cannot be deleted, and reports the orphan", () => {
    if (process.getuid?.() === 0) return // root ignores the write bit
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }])
    chmodSync(ctx.profilesDir, 0o500)

    const result = applyProfileRemove("work", { profilesDir: ctx.profilesDir, configFile: ctx.configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readConfig()).toEqual([])
    expect(result.dirsRemoved).toEqual([])
    expect(result.dirsOrphaned.map(o => o.dir)).toEqual([workDir])
    expect(existsSync(workDir)).toBe(true)
  })

  test("deletes nothing and changes no setting when the profile list cannot be written", () => {
    if (process.getuid?.() === 0) return // root ignores the read-only bit
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }, { id: "personal" }])
    saveSettings({ activeProfile: "work", profileOrder: ["work", "personal"] })
    chmodSync(ctx.root, 0o500)

    try {
      const result = applyProfileRemove("work", { profilesDir: ctx.profilesDir, configFile: ctx.configFile })
      expect(result).toMatchObject({ ok: false, code: "store_write_failed" })
    } finally {
      chmodSync(ctx.root, 0o700)
    }
    expect(existsSync(join(workDir, ".credentials.json"))).toBe(true)
    expect(readConfig().map(p => p.id)).toEqual(["work", "personal"])
    expect(getSetting("activeProfile")).toBe("work")
    expect(getSetting("profileOrder")).toEqual(["work", "personal"])
  })

  test("moves the persisted pointer and prunes the saved order", () => {
    seed([{ id: "employer", aliases: ["work"] }, { id: "personal" }])
    saveSettings({ activeProfile: "employer", profileOrder: ["work", "employer", "personal"] })

    const result = applyProfileRemove("employer")

    expect(result).toMatchObject({ ok: true, activeProfile: "personal", aliases: ["work"] })
    expect(getSetting("activeProfile")).toBe("personal")
    expect(getSetting("profileOrder")).toEqual(["personal"])
  })

  test("named no paths, it works on the config directory this instance uses", () => {
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }, { id: "personal" }])

    const result = applyProfileRemove("work")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsRemoved).toEqual([workDir])
    expect(result.activeProfile).toBeUndefined()
    expect(readConfig().map(p => p.id)).toEqual(["personal"])
  })

  test("refuses an unknown profile without touching the file", () => {
    seed([{ id: "work" }])

    expect(applyProfileRemove("ghost", { profilesDir: ctx.profilesDir, configFile: ctx.configFile }))
      .toMatchObject({ ok: false, code: "unknown_profile" })
    expect(readConfig().map(p => p.id)).toEqual(["work"])
  })
})

describe("POST /profiles/claude/remove", () => {
  const { ctx, seed, readConfig, seedProfileDir } = useTempConfigDir()

  beforeEach(() => {
    enableDiskProfileDiscovery()
    resetActiveProfile()
  })
  afterEach(() => {
    resetDiskProfileDiscovery()
    resetActiveProfile()
  })

  function app(profiles: ProfileConfig[] = []) {
    return createProxyServer({ port: 0, host: "127.0.0.1", profiles, silent: true }).app
  }

  function remove(target: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) {
    return target.fetch(new Request("http://localhost/profiles/claude/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }))
  }

  test("removes the profile and its credentials, prunes the order and moves the active pointer", async () => {
    const workDir = seedProfileDir("work")
    const personalDir = seedProfileDir("personal")
    seed([{ id: "work", claudeConfigDir: workDir }, { id: "personal", claudeConfigDir: personalDir }])
    saveSettings({ profileOrder: ["work", "personal"] })
    const server = app()
    setActiveProfile("work")

    const res = await remove(server, { profile: "work" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      profile: "work",
      provider: "claude",
      activeProfile: "personal",
      remaining: ["personal"],
      dirsOrphaned: [],
    })
    expect(readConfig().map(p => p.id)).toEqual(["personal"])
    expect(existsSync(workDir)).toBe(false)
    expect(existsSync(personalDir)).toBe(true)
    expect(getActiveProfileId()).toBe("personal")
    expect(getSetting("activeProfile")).toBe("personal")
    expect(getSetting("profileOrder")).toEqual(["personal"])
  })

  test("leaves the pointer alone when it names another profile", async () => {
    seed([{ id: "work" }, { id: "personal" }])
    const server = app()
    setActiveProfile("personal")

    const res = await remove(server, { profile: "work" })

    expect(res.status).toBe(200)
    expect(await res.json()).not.toHaveProperty("activeProfile")
    expect(getActiveProfileId()).toBe("personal")
  })

  test("refuses a cross-origin browser write without touching anything", async () => {
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }])

    const res = await remove(app(), { profile: "work" }, { Origin: "https://evil.example" })

    expect(res.status).toBe(403)
    expect(readConfig().map(p => p.id)).toEqual(["work"])
    expect(existsSync(workDir)).toBe(true)
  })

  test("refuses when credentials are read-only", async () => {
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }])
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"

    const res = await remove(app(), { profile: "work" })

    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toContain("MERIDIAN_CREDENTIALS_READONLY")
    expect(readConfig().map(p => p.id)).toEqual(["work"])
    expect(existsSync(workDir)).toBe(true)
  })

  test("rejects a missing or malformed profile", async () => {
    seed([{ id: "work" }])
    const server = app()

    expect((await remove(server, {})).status).toBe(400)
    expect((await remove(server, { profile: 7 })).status).toBe(400)
    expect((await remove(server, "{ not json")).status).toBe(400)
    expect(readConfig().map(p => p.id)).toEqual(["work"])
  })

  test("answers 404 for an unknown name, naming the current one for a former name", async () => {
    seed([{ id: "employer", aliases: ["work"] }])
    const server = app()

    const unknown = await remove(server, { profile: "ghost" })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: "unknown_profile", provider: "claude" })

    const former = await remove(server, { profile: "work" })
    expect(former.status).toBe(404)
    expect((await former.json() as { error: string }).error).toContain("employer")
    expect(readConfig().map(p => p.id)).toEqual(["employer"])
  })

  test("refuses a profile defined in the startup configuration", async () => {
    seed([{ id: "personal" }])

    const res = await remove(app([{ id: "configured", claudeConfigDir: join(ctx.root, "configured") }]), { profile: "configured" })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "owned_elsewhere", provider: "claude" })
    expect(readConfig().map(p => p.id)).toEqual(["personal"])
  })
})
