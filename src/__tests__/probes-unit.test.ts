/**
 * Unit tests for the liveness/readiness probes.
 *
 * The decision logic is pure so every branch is provable without an HTTP
 * server, a subprocess or a credential file - which is the same reason the
 * probes themselves touch none of those at request time.
 */

import { describe, expect, test } from "bun:test"
import { livenessReport, readinessReport, renderProbe } from "../proxy/probes"

const READY = { profileCount: 3, claudeExecutableResolved: true }

describe("livenessReport", () => {
  test("passes", () => {
    expect(livenessReport().ok).toBe(true)
  })

  // Pinned deliberately: the value of a liveness probe is everything it does
  // NOT depend on. A check added here is a way for a working process to be
  // killed over somebody else's outage, so growing this list is the
  // regression, not a feature.
  test("has no checks at all, which is the design", () => {
    expect(livenessReport().checks).toEqual([])
  })
})

describe("readinessReport", () => {
  test("is ready with profiles and a resolved executable", () => {
    const report = readinessReport(READY)
    expect(report.ok).toBe(true)
    expect(report.checks.every(c => c.ok)).toBe(true)
  })

  // MERIDIAN_CONFIG_DIR relocates the whole config directory, so an instance
  // pointed at an empty one has no accounts while its neighbour is fine. That
  // is exactly the per-instance failure readiness exists to route around.
  test("is not ready with no profiles, and says which check failed", () => {
    const report = readinessReport({ ...READY, profileCount: 0 })
    expect(report.ok).toBe(false)
    const failed = report.checks.find(c => c.name === "profiles")
    expect(failed?.ok).toBe(false)
    expect(failed?.detail).toContain("no profiles configured")
  })

  test("is not ready with no Claude executable, and names the fix", () => {
    const report = readinessReport({ ...READY, claudeExecutableResolved: false })
    expect(report.ok).toBe(false)
    expect(report.checks.find(c => c.name === "claude-executable")?.detail).toContain("MERIDIAN_CLAUDE_PATH")
  })

  test("reports both failures rather than stopping at the first", () => {
    const report = readinessReport({ profileCount: 0, claudeExecutableResolved: false })
    expect(report.checks.filter(c => !c.ok).map(c => c.name)).toEqual(["profiles", "claude-executable"])
  })

  // A passing check carries no detail: the string exists to explain a failure,
  // and "ok" repeated per check is noise in the surface a load balancer polls.
  test("a passing check has no detail", () => {
    expect(readinessReport(READY).checks.every(c => c.detail === undefined)).toBe(true)
  })
})

describe("renderProbe", () => {
  test("the terse pass is two bytes, because it is polled every few seconds", () => {
    expect(renderProbe("readyz", readinessReport(READY), false)).toBe("ok\n")
  })

  // Even without ?verbose, a failure names what failed - a 503 nobody can
  // explain is a 503 somebody switches off.
  test("the terse failure names the failing check and omits the passing one", () => {
    const out = renderProbe("readyz", readinessReport({ ...READY, profileCount: 0 }), false)
    expect(out).toContain("[-]profiles failed: no profiles configured")
    expect(out).not.toContain("claude-executable")
    expect(out.trimEnd().endsWith("readyz check failed")).toBe(true)
  })

  test("verbose lists every check and the verdict", () => {
    const out = renderProbe("readyz", readinessReport(READY), true)
    expect(out).toBe("[+]profiles ok\n[+]claude-executable ok\nreadyz check passed\n")
  })

  test("verbose names the kind it was asked about", () => {
    expect(renderProbe("livez", livenessReport(), true)).toBe("livez check passed\n")
  })

  test("every rendering ends with a newline, so curl output is not glued to a prompt", () => {
    for (const verbose of [true, false]) {
      for (const report of [livenessReport(), readinessReport(READY), readinessReport({ profileCount: 0, claudeExecutableResolved: false })]) {
        expect(renderProbe("readyz", report, verbose).endsWith("\n")).toBe(true)
      }
    }
  })
})
