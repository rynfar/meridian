/**
 * Header build badge views (telemetry/buildBadge.ts).
 *
 * The header ships these functions to the browser via `.toString()`, so the
 * tests evaluate that serialized text rather than the TS import - what is
 * asserted here is what the page actually runs.
 */
import { describe, expect, test } from "bun:test"
import { buildDriftView, buildIdentityView, type BuildDriftView, type BuildIdentityView } from "../telemetry/buildBadge"
import { profileBarJs } from "../telemetry/profileBar"

const identity = new Function(`return (${buildIdentityView.toString()})`)() as (build: unknown) => BuildIdentityView
const drift = new Function(`return (${buildDriftView.toString()})`)() as (status: unknown) => BuildDriftView

const SHA = "8d4c88c0123456789abcdef0123456789abcdef0"
const artifact = {
  source: "local", kind: "artifact", version: "1.77.1", releaseVersion: "1.77.1", counter: 3,
  counterScope: "3f0e4a52-9a6c-4c1e-9d1b-6d8b1f6c2a10", attemptId: "0b5b6f7e-6d4a-4a8e-9f31-2c2f7d9f2e11",
  branch: "feat/local-build-provenance", sha: SHA, dirty: true, displayVersion: "1.77.1+local.3",
  branchUrl: "https://github.com/rynfar/meridian/tree/feat%2Flocal-build-provenance",
  commitUrl: `https://github.com/rynfar/meridian/commit/${SHA}`,
  builtAt: "2026-09-26T10:00:00.000Z", certification: "verified",
}

function parts(build: unknown) {
  const view = identity(build)
  if (view.mode !== "local") throw new Error(`expected a local view, got ${view.mode}`)
  return view.parts
}

describe("buildIdentityView", () => {
  test("the header embeds exactly the serialized functions under test", () => {
    expect(profileBarJs).toContain(buildIdentityView.toString())
    expect(profileBarJs).toContain(buildDriftView.toString())
  })

  test("a current npm install says nothing", () => {
    expect(identity({ source: "npm", version: "1.77.1", latest: "1.77.1", updateAvailable: false })).toEqual({ mode: "hidden" })
    expect(identity({ source: "npm", version: "1.77.1" })).toEqual({ mode: "hidden" })
  })

  test("an outdated npm install keeps the releases-page update chip", () => {
    expect(identity({ source: "npm", version: "1.77.0", latest: "1.77.1", updateAvailable: true })).toEqual({
      mode: "update",
      text: "1.77.1 available",
      href: "https://github.com/rynfar/meridian/releases",
      title: "Running 1.77.0 - update with:\nnpm install -g @rynfar/meridian@latest",
    })
  })

  test("a certified artifact shows release, counter, linked branch and commit, dirty", () => {
    expect(parts(artifact).map((part) => [part.kind, part.text, part.href])).toEqual([
      ["version", "v1.77.1", undefined],
      ["run", "local #3", undefined],
      ["branch", "feat/local-build-provenance", artifact.branchUrl],
      ["commit", "8d4c88c", artifact.commitUrl],
      ["dirty", "dirty", undefined],
    ])
  })

  test("the tooltip keeps the raw metadata the chip abbreviates", () => {
    const view = identity(artifact)
    if (view.mode !== "local") throw new Error("expected local")
    expect(view.title.split("\n")).toEqual([
      "Local build - not an npm release",
      "build: 1.77.1+local.3",
      "branch: feat/local-build-provenance",
      `commit: ${SHA}`,
      "uncommitted changes present",
      "built: 2026-09-26T10:00:00.000Z",
      "certification: verified",
    ])
    expect(view.label).toBe("Running build: v1.77.1, local #3, feat/local-build-provenance, 8d4c88c, dirty")
  })

  test("a source run is labelled as such and never given a counter", () => {
    const view = parts({ source: "local", kind: "source", version: "1.77.1", releaseVersion: "1.77.1", sha: SHA, dirty: false })
    expect(view.map((part) => part.text)).toEqual(["v1.77.1", "source run", "8d4c88c"])
  })

  test("each run kind carries the abbreviation the compact header shows", () => {
    const run = (build: object) => parts(build).find((part) => part.kind === "run")?.short
    expect(run(artifact)).toBe("#3")
    expect(run({ source: "local", kind: "source", version: "1.77.1" })).toBe("src")
    expect(run({ source: "local", kind: "artifact", version: "1.77.1" })).toBe("local")
    expect(run({ source: "dev", version: "1.77.1" })).toBe("dev")
    expect(run({ source: "local", version: "1.77.1" })).toBe("local")
  })

  test("an uncertified artifact is not assigned a build number", () => {
    const view = parts({ source: "local", kind: "artifact", version: "1.77.1", certification: "unknown" })
    expect(view.map((part) => part.text)).toEqual(["package 1.77.1", "unnumbered"])
    expect(view[0]?.title).toBe("Package version; release ancestry is unknown")
  })

  test("unknown values are omitted, not invented", () => {
    const view = parts({ source: "local", version: "unknown" })
    expect(view.map((part) => part.text)).toEqual(["local build"])
    const legacy = parts({ source: "dev", version: "1.77.1", branch: "feat/x", sha: "abc1234def" })
    expect(legacy.map((part) => part.text)).toEqual(["package 1.77.1", "dev build", "feat/x", "abc1234"])
    expect(legacy.some((part) => part.kind === "dirty")).toBe(false)
  })

  test("links survive only as credential-free https URLs", () => {
    for (const bad of ["javascript:alert(1)", "http://github.com/a/b", "https://user:pw@github.com/a/b", "not a url", 42]) {
      const view = parts({ ...artifact, branchUrl: bad, commitUrl: bad })
      expect(view.find((part) => part.kind === "branch")?.href).toBeUndefined()
      expect(view.find((part) => part.kind === "commit")?.href).toBeUndefined()
    }
  })

  test("a malformed sha is not shown as a commit", () => {
    expect(parts({ ...artifact, sha: "<img src=x>" }).some((part) => part.kind === "commit")).toBe(false)
  })

  test("a missing build block hides the badge", () => {
    expect(identity(undefined)).toEqual({ mode: "hidden" })
    expect(identity("local")).toEqual({ mode: "hidden" })
  })
})

describe("buildDriftView", () => {
  const status = (state: string, extra: Record<string, unknown> = {}) => ({ runtime: artifact, state, ...extra })

  test("an exact behind count is stated as a warning", () => {
    expect(drift(status("behind", { buildsBehind: 3, latest: { ...artifact, counter: 6 } }))).toEqual({
      tone: "warning", text: "3 builds behind", title: "A newer local build (#6) is on disk; restart to run it",
    })
    expect(drift(status("behind", { buildsBehind: 1 })).text).toBe("1 build behind")
  })

  test("a behind state without a usable count claims no number", () => {
    expect(drift(status("behind", { buildsBehind: "3" })).text).toBe("behind")
    expect(drift(status("behind", { buildsBehind: -2 })).text).toBe("behind")
  })

  test("current is calm, not a warning", () => {
    expect(drift(status("current"))).toEqual({ tone: "calm", text: "current", title: "Running the newest local build (#3)" })
    expect(drift({ runtime: { kind: "source" }, state: "current" }).title).toBe("Source tree unchanged since this process started")
  })

  test("each drift state is reported truthfully", () => {
    const cases: Array<[string, BuildDriftView["tone"], string]> = [
      ["rollback", "warning", "rolled back"],
      ["source-changed", "warning", "source changed"],
      ["building", "neutral", "building…"],
      ["missing", "neutral", "no build record"],
      ["invalid", "neutral", "record invalid"],
      ["incomparable", "neutral", "not comparable"],
      ["unknown", "neutral", "drift unknown"],
      ["something-new", "neutral", "drift unknown"],
    ]
    for (const [state, tone, text] of cases) expect([state, drift(status(state)).tone, drift(status(state)).text]).toEqual([state, tone, text])
  })

  test("a failed poll replaces any earlier claim with an explicit unknown", () => {
    expect(drift(null)).toEqual({ tone: "neutral", text: "drift unknown", title: "Could not refresh build status; no drift is claimed" })
  })
})
