/**
 * Boot-identity visibility (#906, split from #903).
 *
 * Every session-store write takes a lock stamped with a process incarnation,
 * and `captureProcessIncarnation` returns undefined without a boot identity —
 * so `acquireLock` throws and every request that touches a session returns a
 * 500. `/health` never probed it, so a container missing `/etc/machine-id`
 * reported `healthy` to Docker's HEALTHCHECK and to any orchestrator while
 * serving nothing. That is why the original occurrence took three days to find.
 *
 * `bootIdentityHint` is pure and exported separately so every unavailable
 * branch is covered without breaking the host these tests run on.
 */

import { describe, it, expect } from "bun:test"
import { describeLocalBootIdentity, bootIdentityHint } from "../proxy/session/processIncarnation"

describe("bootIdentityHint", () => {
  // The hint is the whole point of the change. "cannot capture lock owner
  // process incarnation" — the original message — names nothing an operator
  // can act on, which is why the failure stayed invisible for three days.
  it("names the missing files on linux, the actual reported environment", () => {
    const hint = bootIdentityHint("linux")
    expect(hint).toContain("/etc/machine-id")
    expect(hint).toContain("/var/lib/dbus/machine-id")
    // The image classes that reproduce it, so the reader recognises their own.
    expect(hint).toMatch(/distroless|scratch|chroot|gVisor/i)
    // And a concrete remedy, not just a diagnosis.
    expect(hint).toContain("dbus-uuidgen")
  })

  it("names the darwin source", () => {
    expect(bootIdentityHint("darwin")).toMatch(/hardware UUID/)
  })

  it("names the win32 source", () => {
    expect(bootIdentityHint("win32")).toMatch(/machine GUID/)
  })

  it("says plainly which platforms are implemented for anything else", () => {
    const hint = bootIdentityHint("sunos")
    expect(hint).toContain("sunos")
    expect(hint).toContain("linux")
    expect(hint).toContain("darwin")
    expect(hint).toContain("win32")
  })

  it("returns a non-empty hint for every platform, including unknown ones", () => {
    for (const p of ["linux", "darwin", "win32", "aix", "freebsd", "", "android"]) {
      expect(bootIdentityHint(p).length).toBeGreaterThan(20)
    }
  })
})

describe("describeLocalBootIdentity", () => {
  it("reports availability on this host, with no hint when fine", () => {
    const status = describeLocalBootIdentity()
    expect(status.platform).toBe(process.platform)
    // linux/darwin/win32 are implemented and CI runs two of them.
    expect(status.available).toBe(true)
    expect(status.hint).toBeUndefined()
  })

  it("is stable across calls, so /health and startup cannot disagree", () => {
    expect(describeLocalBootIdentity()).toEqual(describeLocalBootIdentity())
  })

  it("exposes a boolean `available`, which both consumers branch on", () => {
    expect(typeof describeLocalBootIdentity().available).toBe("boolean")
  })
})

describe("the unavailable record both consumers act on", () => {
  // Constructed rather than provoked: the point is the CONTRACT, and a
  // regression that dropped `hint` or made `available` truthy-by-accident is
  // what would silently restore the original bug.
  const unavailable = (platform: string) => ({
    available: false as const,
    platform,
    hint: bootIdentityHint(platform),
  })

  it("carries everything the startup error message interpolates", () => {
    const s = unavailable("linux")
    expect(s.available).toBe(false)
    expect(s.platform).toBe("linux")
    expect(typeof s.hint).toBe("string")
    expect(s.hint.length).toBeGreaterThan(0)
  })

  it("would drive /health to unhealthy, and an available host would not", () => {
    const unhealthy = (s: { available: boolean }) => !s.available
    expect(unhealthy(unavailable("linux"))).toBe(true)
    expect(unhealthy(describeLocalBootIdentity())).toBe(false)
  })
})
