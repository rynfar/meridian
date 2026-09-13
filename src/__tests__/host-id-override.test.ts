/**
 * Operator-pinned host identity (#905, follow-up to #903).
 *
 * The derived `hostId` mixes in the pid-namespace inode, which is wrong in both
 * directions inside a container:
 *
 *   - NOT STABLE. The inode changes on every `docker restart`, while the
 *     session store survives in the writable layer. A proxy SIGKILLed holding a
 *     store lock returns with a different `hostId`, so the old lock probes as
 *     `indeterminate` rather than `dead`, is never retired, and every request
 *     fails with `timed out waiting for lock` until the container is recreated.
 *   - NOT UNIQUE. Every container from an image tag shares a baked
 *     `/etc/machine-id`, so `hostId` reduces to that inode — allocated from a
 *     fixed base at boot, so two freshly-booted hosts can collide. Sharing a
 *     session directory then lets each read the other's LIVE lock as `dead`.
 *
 * Measured in containers before the fix: same machine-id, pid-ns
 * `4026533323 -> 4026533324` across one `docker restart`, and `hostId`
 * `46a864e0... -> ef60ea0b...`.
 *
 * These are the pure properties. The end-to-end behaviour is gated by E52.
 */

import { describe, it, expect } from "bun:test"
import { pinnedHostIdFor } from "../proxy/session/processIncarnation"

describe("pinnedHostIdFor", () => {
  it("is undefined when unpinned, so nothing changes outside containers", () => {
    expect(pinnedHostIdFor(undefined)).toBeUndefined()
    expect(pinnedHostIdFor("")).toBeUndefined()
    expect(pinnedHostIdFor("   ")).toBeUndefined()
  })

  // The property that makes a restart safe: the pin is the ONLY input, so a
  // changed pid-namespace inode cannot move the identity.
  it("is a pure function of the pin", () => {
    expect(pinnedHostIdFor("container-alpha")).toBe(pinnedHostIdFor("container-alpha"))
    expect(pinnedHostIdFor(" container-alpha ")).toBe(pinnedHostIdFor("container-alpha"))
  })

  // The property that prevents cross-host retirement of a live lock.
  it("separates distinct pins", () => {
    expect(pinnedHostIdFor("host-A")).not.toBe(pinnedHostIdFor("host-B"))
  })

  // hostId is compared for equality only and lands in a lock file that is read
  // cross-host, so a pinned hostname must not travel in the clear.
  it("hashes the pin rather than carrying it", () => {
    const pin = "prod-worker-07.internal.example.com"
    const id = pinnedHostIdFor(pin)!
    expect(id).not.toContain(pin)
    expect(id).not.toContain("prod-worker")
    expect(id).toMatch(/^[0-9a-f]{16,}$/)
  })

  it("does not collide with a derived identity for the same string", () => {
    // Namespaced as `pinned:` so a pin equal to a machine-id cannot forge one.
    expect(pinnedHostIdFor("deadbeefdeadbeefdeadbeefdeadbeef"))
      .not.toBe(pinnedHostIdFor("linux:deadbeefdeadbeefdeadbeefdeadbeef:pid:[1]"))
  })
})
