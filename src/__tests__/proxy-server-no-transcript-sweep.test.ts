/**
 * #1261 landed without Meridian's own idle transcript sweep, so neither the
 * object createProxyServer returns nor the exported ProxyServer and
 * ProxyInstance types may grow a `transcriptSweep` member: both are in the
 * stable API contract, and the sweep was never approved for it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ProxyInstance, ProxyServer } from "../proxy/server"

const { createProxyServer } = await import("../proxy/server")

/** `true` only when `T` has no key `K`; assigning `true` fails to typecheck otherwise. */
type LacksKey<T, K extends PropertyKey> = K extends keyof T ? false : true

const proxyServerLacksSweep: LacksKey<ProxyServer, "transcriptSweep"> = true
const proxyInstanceLacksSweep: LacksKey<ProxyInstance, "transcriptSweep"> = true

describe("public proxy shape without an idle transcript sweep", () => {
  let dir: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-no-transcript-sweep-"))
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = dir
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    rmSync(dir, { recursive: true, force: true })
  })

  it("createProxyServer returns no transcriptSweep member", () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    expect("transcriptSweep" in proxy).toBe(false)
  })

  it("the exported types have no transcriptSweep key", () => {
    expect(proxyServerLacksSweep).toBe(true)
    expect(proxyInstanceLacksSweep).toBe(true)
  })
})
