/**
 * The header's host label, as rendered from `/health`'s raw `hostname` field.
 */

import { describe, expect, it } from "bun:test"
import { hostLabelView } from "../telemetry/hostLabel"

describe("hostLabelView", () => {
  it("shows the machine's first DNS label, with the full name on hover", () => {
    expect(hostLabelView("nwkr-desktop")).toEqual({ text: "nwkr-desktop", title: "Running on nwkr-desktop" })
    expect(hostLabelView("build-3.ci.example.net")).toEqual({ text: "build-3", title: "Running on build-3.ci.example.net" })
    expect(hostLabelView("Studio.local")).toEqual({ text: "Studio", title: "Running on Studio.local" })
  })

  it("shows an address whole, since its first label names nothing", () => {
    expect(hostLabelView("10.0.0.12")?.text).toBe("10.0.0.12")
    expect(hostLabelView("fe80::1")?.text).toBe("fe80::1")
  })

  it("shows nothing when the setting is off and the field is absent, or when it is unusable", () => {
    expect(hostLabelView(undefined)).toBeNull()
    expect(hostLabelView("   ")).toBeNull()
    expect(hostLabelView(42)).toBeNull()
  })

  // Serialized into the header script: anything it closes over is undefined
  // in the browser.
  it("is self-contained", () => {
    const rebuilt = new Function(`return (${hostLabelView.toString()})`)() as typeof hostLabelView
    expect(rebuilt("a.b")).toEqual({ text: "a", title: "Running on a.b" })
  })
})
