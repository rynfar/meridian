import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("desktop follow mode parity", () => {
  const rendererPath = resolve(__dirname, "../../apps/desktop/src/renderer.ts")
  const trayPath = resolve(__dirname, "../../apps/desktop/src/trayRenderer.ts")
  const rendererSrc = readFileSync(rendererPath, "utf-8")
  const traySrc = readFileSync(trayPath, "utf-8")

  test("desktop renderer surfaces follow status in header notice, active badges, and disables local switching", () => {
    expect(rendererSrc).toContain("Following active profile from")
    expect(rendererSrc).toContain("follow ? `Following ${esc(text(follow.url))}` : 'Active'")
    expect(rendererSrc).toContain("Profile switching is controlled by")
  })

  test("desktop tray renderer reflects follow active badge and followed state", () => {
    expect(traySrc).toContain("const follow = object(state.profiles).follow")
    expect(traySrc).toContain("follow ? `Following ${esc(text(follow.url))}` : 'Active'")
    expect(traySrc).toContain("Switching controlled by ${esc(text(follow.url))}")
  })
})
