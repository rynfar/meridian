import { afterAll, beforeAll, expect, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as models from "../../proxy/models"
import * as tokens from "../../proxy/tokenRefresh"
import * as organizations from "../../proxy/organizationName"
import * as setup from "../../proxy/setup"
import * as updates from "../../proxy/updateCheck"
import type { ProxyConfig } from "../../proxy/types"

/** Fence non-subject auth, native-store and CLI boundaries for mocked proxy fixtures. */
export function installProxyBoundaryFences(joinOwners: () => Promise<void>): {
  config(): Pick<ProxyConfig, "pluginDir" | "pluginConfigPath">
} {
  let root = ""
  const restores: Array<() => void> = []
  const previousEnv = new Map<string, string | undefined>()
  let storeWrites = 0
  let authChecks = 0
  let executableResolutions = 0
  let storeFactories = 0
  let proactiveRefreshes = 0
  let reactiveRefreshes = 0
  let backgroundRefreshStarts = 0
  let pluginProbes = 0

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "meridian-proxy-boundaries-"))
    const claudeDir = join(root, "claude-config")
    const configDir = join(root, "meridian-config")
    const executable = join(root, "claude-fixture")
    for (const dir of [claudeDir, configDir, join(root, "plugins")]) mkdirSync(dir)
    writeFileSync(join(configDir, "profiles.json"), "[]\n")
    writeFileSync(join(root, "plugins.json"), "[]\n")
    // If a path accidentally bypasses the resolver/auth spies, this owned stub
    // fails without invoking a real CLI or touching a credential store.
    writeFileSync(executable, "#!/bin/sh\nexit 91\n", { mode: 0o700 })
    const ownedEnv: Record<string, string> = {
      CLAUDE_CONFIG_DIR: claudeDir,
      MERIDIAN_CLAUDE_PATH: executable,
      MERIDIAN_CONFIG_DIR: configDir,
      MERIDIAN_DESIGN_TOKEN_PATH: join(root, "design-token.json"),
      MERIDIAN_UPDATE_CHECK_PATH: join(root, "update-check.json"),
      MERIDIAN_NO_UPDATE_CHECK: "1",
    }
    for (const [key, value] of Object.entries(ownedEnv)) {
      previousEnv.set(key, process.env[key])
      process.env[key] = value
    }
    const keep = (spy: { mockRestore(): void }): void => { restores.push(() => spy.mockRestore()) }
    keep(spyOn(models, "getClaudeAuthStatusAsync").mockImplementation(async () => {
      authChecks++
      return { loggedIn: true, email: "proxy-fixture@example.invalid", subscriptionType: "max" }
    }))
    keep(spyOn(models, "resolveClaudeExecutableAsync").mockImplementation(async () => {
      executableResolutions++
      return executable
    }))
    keep(spyOn(models, "getResolvedClaudeExecutableInfo").mockImplementation(() => ({ path: executable, source: "env" })))
    keep(spyOn(tokens, "createPlatformCredentialStore").mockImplementation(() => {
      storeFactories++
      return {
        refreshKey: `owned-fixture:${root}`,
        read: async () => null,
        write: async () => { storeWrites++; throw new Error("Proxy fixture must not write credentials") },
      }
    }))
    // Override operations with default module-level stores as well as the
    // store factory: a factory spy alone cannot intercept those singletons.
    keep(spyOn(tokens, "ensureFreshToken").mockImplementation(async () => { proactiveRefreshes++; return false }))
    keep(spyOn(tokens, "refreshOAuthToken").mockImplementation(async () => { reactiveRefreshes++; return false }))
    keep(spyOn(tokens, "startBackgroundRefresh").mockImplementation(() => { backgroundRefreshStarts++ }))
    keep(spyOn(tokens, "stopBackgroundRefresh").mockImplementation(() => {}))
    keep(spyOn(tokens, "getStoredPlanFields").mockImplementation(async () => ({})))
    keep(spyOn(tokens, "getAuthRenewalStatus").mockImplementation(async () => ({ renewalRequiredSoon: false })))
    keep(spyOn(tokens, "readStoredCredentialPresence").mockImplementation(async () => "unknown"))
    keep(spyOn(organizations, "refreshOrganizationNameSoon").mockImplementation(() => {}))
    keep(spyOn(setup, "checkPluginConfigured").mockImplementation(() => { pluginProbes++; return false }))
    keep(spyOn(updates, "startUpdateCheck").mockImplementation(async () => {}))
  })

  afterAll(async () => {
    // Do not restore production boundaries while an owned request/timer remains.
    await joinOwners()
    expect(storeWrites).toBe(0)
    console.log(`[proxy-boundary-fences] ${JSON.stringify({ authChecks, executableResolutions, storeFactories,
      proactiveRefreshes, reactiveRefreshes, backgroundRefreshStarts, pluginProbes, storeWrites })}`)
    for (const restore of restores.reverse()) restore()
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  return { config() {
    if (!root) throw new Error("Proxy boundary fences must be installed before creating a server")
    return { pluginDir: join(root, "plugins"), pluginConfigPath: join(root, "plugins.json") }
  } }
}
