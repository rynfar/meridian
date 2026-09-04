/**
 * Unit tests for the profile-reordering helpers — pure functions, no mocks.
 */
import { describe, expect, it } from "bun:test"
import {
  EDGE_ZONE_PX,
  MAX_SCROLL_PX_PER_FRAME,
  edgeScrollVelocity,
  moveInOrder,
  reorderClientJs,
  sortByOrder,
} from "../telemetry/profileOrder"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

describe("moveInOrder", () => {
  const base = ["a", "b", "c", "d"]

  it("moves an item down", () => {
    expect(moveInOrder(base, 0, 2)).toEqual(["b", "c", "a", "d"])
  })

  it("moves an item up", () => {
    expect(moveInOrder(base, 3, 1)).toEqual(["a", "d", "b", "c"])
  })

  it("moves to the ends", () => {
    expect(moveInOrder(base, 2, 0)).toEqual(["c", "a", "b", "d"])
    expect(moveInOrder(base, 0, 3)).toEqual(["b", "c", "d", "a"])
  })

  it("returns an unchanged copy for a no-op move", () => {
    const out = moveInOrder(base, 1, 1)
    expect(out).toEqual(base)
    expect(out).not.toBe(base)
  })

  it("ignores out-of-range indices instead of corrupting the order", () => {
    expect(moveInOrder(base, -1, 2)).toEqual(base)
    expect(moveInOrder(base, 0, 9)).toEqual(base)
    expect(moveInOrder(base, 9, 0)).toEqual(base)
    expect(moveInOrder(base, 0, -1)).toEqual(base)
  })

  it("never mutates the input", () => {
    const input = ["a", "b", "c"]
    moveInOrder(input, 0, 2)
    expect(input).toEqual(["a", "b", "c"])
  })

  it("handles empty and single-item lists", () => {
    expect(moveInOrder([], 0, 0)).toEqual([])
    expect(moveInOrder(["only"], 0, 0)).toEqual(["only"])
  })
})

describe("sortByOrder", () => {
  const profiles = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }]

  it("applies the saved order", () => {
    expect(sortByOrder(profiles, ["gamma", "alpha", "beta"]).map((p) => p.id))
      .toEqual(["gamma", "alpha", "beta"])
  })

  it("keeps config order when nothing is saved", () => {
    expect(sortByOrder(profiles, []).map((p) => p.id)).toEqual(["alpha", "beta", "gamma"])
  })

  it("appends profiles missing from the saved order, in their original order", () => {
    // "beta" was added after the order was last saved.
    expect(sortByOrder(profiles, ["gamma", "alpha"]).map((p) => p.id))
      .toEqual(["gamma", "alpha", "beta"])
  })

  it("ignores ids in the order that no longer exist", () => {
    expect(sortByOrder(profiles, ["deleted", "beta", "alpha", "gamma"]).map((p) => p.id))
      .toEqual(["beta", "alpha", "gamma"])
  })

  it("ignores a duplicated id rather than rendering the profile twice", () => {
    const out = sortByOrder(profiles, ["beta", "beta", "alpha"])
    expect(out.map((p) => p.id)).toEqual(["beta", "alpha", "gamma"])
    expect(out.length).toBe(3)
  })

  it("never mutates the input", () => {
    const input = [{ id: "alpha" }, { id: "beta" }]
    sortByOrder(input, ["beta", "alpha"])
    expect(input.map((p) => p.id)).toEqual(["alpha", "beta"])
  })
})

describe("edgeScrollVelocity", () => {
  const H = 800

  it("holds still through the middle of the viewport", () => {
    expect(edgeScrollVelocity(H / 2, H)).toBe(0)
    expect(edgeScrollVelocity(EDGE_ZONE_PX, H)).toBe(0)
    expect(edgeScrollVelocity(H - EDGE_ZONE_PX, H)).toBe(0)
  })

  it("scrolls up near the top edge and down near the bottom", () => {
    expect(edgeScrollVelocity(10, H)).toBeLessThan(0)
    expect(edgeScrollVelocity(H - 10, H)).toBeGreaterThan(0)
  })

  it("ramps with depth into the zone, so a nudge and a fast travel both work", () => {
    const shallow = Math.abs(edgeScrollVelocity(EDGE_ZONE_PX - 8, H))
    const deep = Math.abs(edgeScrollVelocity(8, H))
    expect(shallow).toBeGreaterThan(0)
    expect(deep).toBeGreaterThan(shallow)
    expect(deep).toBeLessThanOrEqual(MAX_SCROLL_PX_PER_FRAME)
  })

  it("clamps at full speed when the pointer leaves the viewport", () => {
    // Dragging past the edge reports a clientY outside the window; the speed
    // must cap rather than grow without bound.
    expect(edgeScrollVelocity(-400, H)).toBe(-MAX_SCROLL_PX_PER_FRAME)
    expect(edgeScrollVelocity(H + 400, H)).toBe(MAX_SCROLL_PX_PER_FRAME)
  })

  it("never lets the two zones overlap on a short viewport", () => {
    // With a 100px window the raw 96px zones would both claim the middle and
    // the direction would depend on which branch ran first.
    const short = 100
    expect(edgeScrollVelocity(short / 2, short)).toBe(0)
    expect(edgeScrollVelocity(2, short)).toBeLessThan(0)
    expect(edgeScrollVelocity(short - 2, short)).toBeGreaterThan(0)
  })

  it("returns 0 rather than NaN for a degenerate viewport", () => {
    expect(edgeScrollVelocity(10, 0)).toBe(0)
    expect(edgeScrollVelocity(Number.NaN, H)).toBe(0)
    expect(edgeScrollVelocity(10, Number.NaN)).toBe(0)
  })
})

describe("one gesture implementation, shared by both pages", () => {
  // The defect being fixed was two pages disagreeing about the order. A second
  // transcription of the gesture is how that comes back, so assert the pages
  // interpolate the module rather than carrying their own copies.
  const marker = "window.meridianReorder = (function () {"

  it("both pages embed the shared client module exactly once", () => {
    for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
      expect(html.split(marker).length - 1, `${name} should embed the gesture once`).toBe(1)
      expect(html, `${name} should call init`).toContain("meridianReorder.init(")
      expect(html, `${name} should sort by the persisted order`).toContain("meridianReorder.sortProfiles(")
    }
  })

  it("both pages render the drag handle and the live region", () => {
    for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
      expect(html, `${name} needs the handle`).toContain("drag-handle")
      expect(html, `${name} needs the announcement target`).toContain('id="orderStatus"')
    }
  })

  it("the shared module carries the auto-scroll, so both pages get it", () => {
    expect(reorderClientJs).toContain("edgeScrollVelocity")
    expect(reorderClientJs).toContain("requestAnimationFrame")
    expect(reorderClientJs).toContain(`var EDGE_ZONE_PX = ${EDGE_ZONE_PX};`)
    expect(reorderClientJs).toContain(`var MAX_SCROLL_PX_PER_FRAME = ${MAX_SCROLL_PX_PER_FRAME};`)
  })
})
