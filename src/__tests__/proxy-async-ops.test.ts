import { installModelsMock, syntheticClaudeBoundary } from "./modelsMock"
installModelsMock(() => syntheticClaudeBoundary)
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_PROXY_CONFIG, type ProxyInstance } from "../proxy/types"

const { createProxyServer, startProxyServer } = await import("../proxy/server")
const { runCli } = await import("../../bin/cli")
const { invalidateDiskProfileCache, resetDiskProfileDiscovery } = await import("../proxy/profiles")

const stubStart = (onStart: () => void) => async (): Promise<ProxyInstance> => {
  onStart()
  return { server: createServer(), config: DEFAULT_PROXY_CONFIG, close: async () => {} }
}

describe("proxy async ops", () => {
  const originalConfigDir = process.env.MERIDIAN_CONFIG_DIR
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "meridian-async-ops-"))
    process.env.MERIDIAN_CONFIG_DIR = configDir
    invalidateDiskProfileCache()
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = originalConfigDir
    resetDiskProfileDiscovery()
    invalidateDiskProfileCache()
    rmSync(configDir, { recursive: true, force: true })
  })

  it("starts server with async executable resolution", async () => {
    const proxyA = await startProxyServer({ port: 0, host: "127.0.0.1" })
    const proxyB = await startProxyServer({ port: 0, host: "127.0.0.1" })

    const firstClose = proxyA.close()
    const repeatedClose = proxyA.close()
    expect(repeatedClose).toBe(firstClose)
    await Promise.all([firstClose, repeatedClose])
    await proxyA.close()
    await proxyB.close()

    expect(typeof proxyA.server.keepAliveTimeout).toBe("number")
    expect(typeof proxyB.server.keepAliveTimeout).toBe("number")
  })

  it("serves async health endpoint with correct response schema", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const response = await app.fetch(new Request("http://localhost/health"))
    const body = await response.json() as any

    expect(typeof body.status).toBe("string")
    expect(body.backend).toBe("claude")
    expect(typeof body.version).toBe("string")
    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status)

    if (body.status === "healthy") {
      expect(typeof body.mode).toBe("string")
      expect(typeof body.auth.loggedIn).toBe("boolean")
      expect(body.auth.loggedIn).toBe(true)
      // claudeExecutable is present when the resolver has run (lazy init —
      // populated on the first SDK call or eager by startProxyServer). When
      // present it carries the resolved path + which step produced it
      // (added in #478 follow-up so users can self-diagnose "wrong claude
      // got picked"). Accept either shape so this test is independent of
      // whether a sibling test already triggered resolution in the same
      // process.
      const expectedKeys = ["auth", "backend", "build", "mode", "plugin", "status", "upstream", "version"]
      if (body.claudeExecutable !== undefined) {
        expect(typeof body.claudeExecutable.path).toBe("string")
        expect([
          "env",
          "bundled",
          "platform-package",
          "path-lookup",
          "legacy-cli-js",
        ]).toContain(body.claudeExecutable.source)
        expectedKeys.push("claudeExecutable")
      }
      expect(Object.keys(body).sort()).toEqual(expectedKeys.sort())
    }

    if (body.status === "unhealthy") {
      expect(typeof body.error).toBe("string")
      expect(body.auth.loggedIn).toBe(false)
      expect(Object.keys(body).sort()).toEqual(["auth", "backend", "build", "error", "status", "upstream", "version"])
    }

    if (body.status === "degraded") {
      expect(typeof body.mode).toBe("string")
      expect(typeof body.error).toBe("string")
      expect(Object.keys(body).sort()).toEqual(["backend", "build", "error", "mode", "status", "upstream", "version"])
    }

    expect(response.status).toBe(body.status === "unhealthy" ? 503 : 200)
  })

  // "returns degraded health when auth status is null" moved to
  // proxy-health-degraded.test.ts — needs mock.module before server import

  it("keeps CLI missing-binary warning behavior", async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: any[]) => {
      errors.push(args.join(" "))
    }

    let startCalled = 0
    try {
      await runCli(
        async () => {
          startCalled += 1
          const { EventEmitter } = await import("events")
          return { server: new EventEmitter(), config: {}, close: async () => {} } as any
        },
        // Simulate the auth-status check throwing — same scenario as before
        // (binary missing / spawn error). The injection point moved from
        // `runExec` to `runAuthCheck` after #478, but the assertion is the
        // same: when the check fails, the warning fires and the proxy still
        // starts. Test name kept stable.
        (async () => {
          throw new Error("spawn ENOENT")
        }) as any
      )
    } finally {
      console.error = originalError
    }

    expect(startCalled).toBe(1)
    expect(errors.some((line) => line.includes("Could not verify Claude auth status"))).toBe(true)
  })

  it("skips the CLI pre-flight auth check when profiles are configured", async () => {
    writeFileSync(join(configDir, "profiles.json"), JSON.stringify([{ id: "p", claudeConfigDir: join(configDir, "p") }]))

    let startCalled = 0
    let authChecks = 0
    await runCli(
      stubStart(() => { startCalled += 1 }),
      async () => {
        authChecks += 1
        return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }
      },
    )

    expect(startCalled).toBe(1)
    expect(authChecks).toBe(0)
  })

  it("runs the CLI pre-flight auth check when a profile uses the default context", async () => {
    writeFileSync(join(configDir, "profiles.json"), JSON.stringify([{ id: "p", claudeConfigDir: join(configDir, "p") }, { id: "bare" }]))

    let startCalled = 0
    let authChecks = 0
    await runCli(
      stubStart(() => { startCalled += 1 }),
      async () => {
        authChecks += 1
        return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }
      },
    )

    expect(startCalled).toBe(1)
    expect(authChecks).toBe(1)
  })
})
