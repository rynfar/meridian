import { describe, expect, it } from "bun:test"
import { DEFAULT_SESSION_GC_MAX_DELETES, defaultSessionGcMaxPending, resolveSessionGcLimits } from "../proxy/sessionGcLimits"

describe("session GC limits", () => {
  it("deletes up to 64 transcripts a run", () => {
    expect(DEFAULT_SESSION_GC_MAX_DELETES).toBe(64)
  })

  it("sizes the deletion backlog to three graces of deletions at the full rate", () => {
    // The default grace is the 10-minute turn hold and a minute: 64 a minute
    // for 11 minutes, three times over.
    expect(defaultSessionGcMaxPending(660_000, 64, 60_000)).toBe(2_112)
    // Runs twice as often delete twice as fast.
    expect(defaultSessionGcMaxPending(660_000, 64, 30_000)).toBe(4_224)
  })

  it("follows the grace, so a longer turn hold cannot slow cleanup", () => {
    expect(defaultSessionGcMaxPending(360_000, 64, 60_000)).toBe(1_152)
    expect(defaultSessionGcMaxPending(1_860_000, 64, 60_000)).toBe(5_952)
  })

  it("never goes under the 256 it was, and reads a disabled sweep as once a minute", () => {
    expect(defaultSessionGcMaxPending(0, 64, 60_000)).toBe(256)
    expect(defaultSessionGcMaxPending(660_000, 64, 0)).toBe(2_112)
  })
})

describe("resolveSessionGcLimits", () => {
  const settings = (values: Record<string, number>) =>
    (name: string, fallback: number): number => values[name] ?? fallback

  it("resolves the defaults from the turn hold", () => {
    expect(resolveSessionGcLimits(settings({}), 600_000)).toEqual({
      maxDeletesPerRun: 64,
      shutdownMaxDeletesPerRun: 16,
      retiredGraceMs: 660_000,
      maxPending: 2_112,
      intervalMs: 60_000,
    })
    // A longer hold lengthens the grace, and the backlog follows it.
    expect(resolveSessionGcLimits(settings({}), 1_800_000)).toMatchObject({ retiredGraceMs: 1_860_000, maxPending: 5_952 })
  })

  it("derives the backlog from the configured interval", () => {
    expect(resolveSessionGcLimits(settings({ SESSION_GC_INTERVAL_MS: 30_000 }), 600_000)).toMatchObject({
      intervalMs: 30_000,
      maxPending: 4_224,
    })
    expect(resolveSessionGcLimits(settings({ SESSION_GC_INTERVAL_MS: 120_000 }), 600_000).maxPending).toBe(1_056)
    // No periodic sweep reads as one a minute; a negative interval as none.
    expect(resolveSessionGcLimits(settings({ SESSION_GC_INTERVAL_MS: -5 }), 600_000)).toMatchObject({
      intervalMs: 0,
      maxPending: 2_112,
    })
  })

  it("derives the backlog from the configured grace and deletion cap", () => {
    expect(resolveSessionGcLimits(settings({ SESSION_GC_GRACE_MS: 360_000 }), 600_000)).toMatchObject({
      retiredGraceMs: 360_000,
      maxPending: 1_152,
    })
    expect(resolveSessionGcLimits(settings({ SESSION_GC_MAX_DELETES: 32 }), 600_000)).toMatchObject({
      maxDeletesPerRun: 32,
      shutdownMaxDeletesPerRun: 16,
      maxPending: 1_056,
    })
    expect(resolveSessionGcLimits(settings({ SESSION_GC_GRACE_MS: -1 }), 600_000)).toMatchObject({
      retiredGraceMs: 0,
      maxPending: 256,
    })
  })

  it("keeps the shutdown sweep at 16 deletions, or fewer when the cap is lower", () => {
    expect(resolveSessionGcLimits(settings({ SESSION_GC_MAX_DELETES: 500 }), 600_000).shutdownMaxDeletesPerRun).toBe(16)
    expect(resolveSessionGcLimits(settings({ SESSION_GC_MAX_DELETES: 4 }), 600_000)).toMatchObject({
      maxDeletesPerRun: 4,
      shutdownMaxDeletesPerRun: 4,
    })
    expect(resolveSessionGcLimits(settings({ SESSION_GC_MAX_DELETES: 0 }), 600_000)).toMatchObject({
      maxDeletesPerRun: 1,
      shutdownMaxDeletesPerRun: 1,
    })
  })

  it("lets an explicit backlog win, never under 1", () => {
    expect(resolveSessionGcLimits(settings({ SESSION_GC_MAX_PENDING: 500 }), 600_000).maxPending).toBe(500)
    expect(resolveSessionGcLimits(settings({ SESSION_GC_MAX_PENDING: 0 }), 600_000).maxPending).toBe(1)
  })
})
