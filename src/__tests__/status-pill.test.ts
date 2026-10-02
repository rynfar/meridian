/**
 * The header's health pill, as rendered from raw `/health` JSON.
 */

import { describe, expect, it } from "bun:test"
import { statusPillView } from "../telemetry/statusPill"

const UNREACHABLE = {
  state: "unreachable",
  since: "2026-10-01T21:02:00.000Z",
  failingSince: "2026-10-01T21:00:00.000Z",
  consecutiveFailures: 7,
  lastReachedAt: "2026-10-01T20:59:58.000Z",
  lastFailureAt: "2026-10-01T21:03:00.000Z",
  lastErrorKind: "dns",
  holdUntil: "2026-10-01T21:08:00.000Z",
  override: null,
}

const local = (iso: string) => new Date(iso).toLocaleString()

describe("statusPillView", () => {
  it("keeps the plain status when the upstream is reachable or not reported", () => {
    expect(statusPillView({ status: "healthy" })).toEqual({ tone: "healthy", text: "Operational", title: "", alert: null })
    expect(statusPillView({ status: "healthy", upstream: { claude: { ...UNREACHABLE, state: "ok" } } }).text).toBe("Operational")
    expect(statusPillView({ status: "degraded" })).toMatchObject({ tone: "degraded", text: "Degraded" })
    expect(statusPillView({ status: "unhealthy" })).toMatchObject({ tone: "unhealthy", text: "Offline" })
    expect(statusPillView(null)).toMatchObject({ tone: "unhealthy", text: "Offline", alert: null })
  })

  it("shows an outage, with since and the last error on hover", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: UNREACHABLE } })
    expect(view).toMatchObject({ tone: "unhealthy", text: "Can't reach Anthropic", alert: "outage" })
    expect(view.title).toContain("Failing since: " + local(UNREACHABLE.failingSince))
    expect(view.title).toContain("Last error: dns (7 connection failures)")
    expect(view.title).toContain("Last answered: " + local(UNREACHABLE.lastReachedAt))
    expect(view.title).toContain("let back in at " + local(UNREACHABLE.holdUntil))
  })

  // The auth check behind `status` fails along with the resolver, and
  // "Offline" would send someone to `claude login` for a network problem.
  it("outranks a degraded or offline auth reading", () => {
    expect(statusPillView({ status: "degraded", upstream: { claude: UNREACHABLE } }).text).toBe("Can't reach Anthropic")
    expect(statusPillView({ status: "unhealthy", upstream: { claude: UNREACHABLE } }).text).toBe("Can't reach Anthropic")
  })

  it("says when the outage is a forced test state", () => {
    const view = statusPillView({
      status: "healthy",
      upstream: { claude: { ...UNREACHABLE, holdUntil: null, override: { state: "unreachable", until: "2026-10-01T21:10:00.000Z" } } },
    })
    expect(view.text).toBe("Can't reach Anthropic")
    expect(view.title).toBe("Forced unreachable by a test override until " + local("2026-10-01T21:10:00.000Z") + ".")
  })

  it("shows the way back as a yellow recheck", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: { ...UNREACHABLE, state: "probing", holdUntil: null } } })
    expect(view).toMatchObject({ tone: "degraded", text: "Rechecking Anthropic", alert: "recovering" })
    expect(view.title).toContain("(last error: dns)")
    expect(view.title).toContain("Last failure: " + local(UNREACHABLE.lastFailureAt))
  })

  it("survives malformed fields", () => {
    const view = statusPillView({ status: "healthy", upstream: { claude: { state: "unreachable", since: "not a date", lastErrorKind: 5 } } })
    expect(view.text).toBe("Can't reach Anthropic")
    expect(view.title).toContain("Failing since: unknown")
    expect(view.title).toContain("Last error: connection")
    expect(view.title).toContain("Last answered: never since start")
  })

  // Serialized into the header script: anything it closes over is undefined
  // in the browser.
  it("is self-contained", () => {
    const rebuilt = new Function(`return (${statusPillView.toString()})`)() as typeof statusPillView
    expect(rebuilt({ status: "healthy", upstream: { claude: UNREACHABLE } }).text).toBe("Can't reach Anthropic")
  })
})
