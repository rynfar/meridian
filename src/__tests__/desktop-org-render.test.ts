import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("desktop organization parity", () => {
  const rendererPath = resolve(__dirname, "../../apps/desktop/src/renderer.ts")
  const trayPath = resolve(__dirname, "../../apps/desktop/src/trayRenderer.ts")
  const rendererSrc = readFileSync(rendererPath, "utf-8")
  const traySrc = readFileSync(trayPath, "utf-8")

  test("desktop renderer reads and renders organizationName", () => {
    expect(rendererSrc).toContain("text(account.organizationName)")
    expect(rendererSrc).toContain("subParts")
  })

  test("desktop tray renderer includes organization in tooltip and subtitle", () => {
    expect(traySrc).toContain("text(account.organizationName)")
    expect(traySrc).toContain("nameTitle")
  })
})
