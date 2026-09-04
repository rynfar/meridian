#!/usr/bin/env node

import { createRequire } from "module"
import { startProxyServer } from "../src/proxy/server"
import { exec as execCallback, execFile as execFileCallback } from "child_process"
import { promisify } from "util"
import { resolveClaudeExecutableAsync } from "../src/proxy/models"

const require = createRequire(import.meta.url)
const { version } = require("../package.json")

const args = process.argv.slice(2)

if (args.includes("--version") || args.includes("-v")) {
  console.log(version)
  process.exit(0)
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`meridian v${version}

Local Anthropic API powered by your Claude Max subscription.

Usage: meridian [command] [options]

Commands:
  (default)        Start the proxy server
  status           Show what a running instance is doing (the / page, in the terminal)
  setup            Configure the OpenCode plugin (run once after install)
  profile          Manage Claude account profiles (add, list, switch, remove)
  refresh-token    Refresh the Claude Code OAuth token

Setup options:
  --v1                         Install the OpenCode V1 plugin
  --v2                         Install the pinned OpenCode V2 beta plugin
  --opencode-bin <executable>  Probe this OpenCode executable

Options:
  -v, --version   Show version
  -h, --help      Show this help

Environment variables:
  MERIDIAN_PORT                     Port to listen on (default: 3456)
  MERIDIAN_HOST                     Host to bind to (default: 127.0.0.1)
  MERIDIAN_PASSTHROUGH              Enable passthrough mode (tools forwarded to client)
  MERIDIAN_IDLE_TIMEOUT_SECONDS     Idle timeout in seconds (default: 120)
  MERIDIAN_PLUGIN_DIR               Plugin auto-discovery directory (default: ~/.config/meridian/plugins)
  MERIDIAN_PLUGIN_CONFIG            Plugin manifest path (default: ~/.config/meridian/plugins.json)

See https://github.com/rynfar/meridian for full documentation.`)
  process.exit(0)
}

if (args[0] === "profile") {
  const { profileAdd, profileAddOauthToken, profileList, profileRemove, profileSwitch, profileLogin, profileHelp } = await import("../src/proxy/profileCli")
  const subcommand = args[1]
  const profileId = args[2]
  const headless = args.includes("--headless")

  if (subcommand === "add" && profileId) {
    const oauthFlagIdx = args.indexOf("--oauth-token", 3)
    if (oauthFlagIdx >= 0) {
      const tokenArg = args[oauthFlagIdx + 1]
      await profileAddOauthToken(profileId, tokenArg?.startsWith("--") ? undefined : tokenArg)
    } else {
      await profileAdd(profileId, { headless })
    }
  }
  else if (subcommand === "list" || subcommand === "ls") profileList()
  else if (subcommand === "remove" && profileId) profileRemove(profileId)
  else if (subcommand === "switch" && profileId) await profileSwitch(profileId)
  else if (subcommand === "login" && profileId) await profileLogin(profileId, { headless })
  else profileHelp()
  process.exit(0)
}

if (args[0] === "setup") {
  const {
    detectOpenCodeGeneration,
    DuplicateMeridianConfigError,
    MissingV2PluginError,
    pluginPathForGeneration,
    runSetup,
    SUPPORTED_OPENCODE_V2_VERSION,
    UnparseableConfigError,
  } = await import("../src/proxy/setup")

  const forceV1 = args.includes("--v1")
  const forceV2 = args.includes("--v2")
  if (forceV1 && forceV2) {
    console.error("Choose only one OpenCode generation: --v1 or --v2")
    process.exit(1)
  }

  const binaryIndex = args.indexOf("--opencode-bin")
  const binary = binaryIndex >= 0 ? args[binaryIndex + 1] : undefined
  if (binaryIndex >= 0 && (!binary || binary.startsWith("--"))) {
    console.error("--opencode-bin requires an executable path")
    process.exit(1)
  }

  const environmentBinary = process.env.OPENCODE_BIN
  const commands = binary
    ? [binary]
    : environmentBinary ? [environmentBinary]
    : forceV2 ? ["opencode2", "opencode"] : undefined
  const detected = forceV1
    ? { generation: "v1" as const }
    : detectOpenCodeGeneration(commands)

  if (!forceV1 && (binary || environmentBinary) && !detected.version) {
    console.error(`Could not read a supported OpenCode version from ${binary ?? environmentBinary}.`)
    process.exit(1)
  }
  if (forceV2 && detected.generation !== "v2") {
    console.error("Could not find an OpenCode V2 beta. Install the pinned beta or pass --opencode-bin <path>.")
    process.exit(1)
  }
  if (detected.generation === "v2" && detected.version !== SUPPORTED_OPENCODE_V2_VERSION) {
    console.error(`OpenCode V2 ${detected.version ?? "unknown"} is not supported by this Meridian build.`)
    console.error(`Install @opencode-ai/cli@${SUPPORTED_OPENCODE_V2_VERSION}, then re-run meridian setup --v2.`)
    process.exit(1)
  }

  let pluginPath: string
  try {
    pluginPath = pluginPathForGeneration(import.meta.url, detected.generation)
  } catch (err) {
    if (err instanceof MissingV2PluginError) {
      console.error(`OpenCode V2 plugin bundle is missing: ${err.expectedPath}`)
      console.error("Reinstall Meridian, then re-run meridian setup --v2.")
      process.exit(1)
    }
    throw err
  }

  let result
  try {
    result = runSetup(pluginPath, undefined, detected.generation)
  } catch (err) {
    if (err instanceof UnparseableConfigError) {
      console.error(`\x1b[31m✗ Could not parse ${err.configPath}\x1b[0m`)
      console.error("  Your config was left untouched. Fix the syntax error, then re-run")
      console.error(`  'meridian setup' — or add this plugin manually:`)
      console.error(`    "plugin": ["${pluginPath}"]`)
      process.exit(1)
    }
    if (err instanceof DuplicateMeridianConfigError) {
      console.error("\x1b[31m✗ Meridian is already present in the other OpenCode config file\x1b[0m")
      console.error(`  OpenCode loads both ${err.configPath} and ${err.siblingPath}.`)
      console.error(`  Remove the Meridian entry from ${err.siblingPath}, then re-run 'meridian setup'.`)
      console.error("  Both files were left untouched.")
      process.exit(1)
    }
    throw err
  }

  const generationLabel = detected.generation === "v2" ? "OpenCode V2" : "OpenCode V1"
  if (result.alreadyConfigured) {
    console.log(`\x1b[32m✓ Meridian plugin already configured for ${generationLabel}\x1b[0m`)
    console.log(`  ${result.configPath}`)
  } else {
    if (result.removedStale.length > 0) {
      console.log(`  Removed ${result.removedStale.length} stale plugin entr${result.removedStale.length === 1 ? "y" : "ies"}`)
    }
    console.log(`\x1b[32m✓ Meridian plugin configured for ${generationLabel}\x1b[0m`)
    console.log(`  Config: ${result.configPath}`)
    console.log(`  Plugin: ${result.pluginPath}`)
    if (!result.created) {
      console.log(`\nRestart OpenCode for the plugin to take effect.`)
    }
  }
  process.exit(0)
}

if (args[0] === "refresh-token") {
  const { refreshOAuthToken } = await import("../src/proxy/tokenRefresh")
  const success = await refreshOAuthToken()
  if (success) {
    console.log("Token refreshed successfully")
    process.exit(0)
  } else {
    console.error("Token refresh failed. If the problem persists, run: claude login")
    process.exit(1)
  }
}

const exec = promisify(execCallback)
const execFile = promisify(execFileCallback)

// Process error handlers (SDK subprocess crash recovery, socket EPIPE, etc.)
// are installed by startProxyServer when `installProcessErrorHandlers: true`
// is passed below. Library consumers can either pass the same flag or call
// `installProxyProcessErrorHandlers()` directly.

const port = parseInt(process.env.MERIDIAN_PORT ?? process.env.CLAUDE_PROXY_PORT ?? "3456", 10)
const host = process.env.MERIDIAN_HOST ?? process.env.CLAUDE_PROXY_HOST ?? "127.0.0.1"
const idleTimeoutSeconds = parseInt(process.env.MERIDIAN_IDLE_TIMEOUT_SECONDS ?? process.env.CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS ?? "120", 10)
const pluginDir = process.env.MERIDIAN_PLUGIN_DIR
const pluginConfigPath = process.env.MERIDIAN_PLUGIN_CONFIG

/**
 * Print the dashboard for the instance on `host:port`, if that is what is
 * there. Returns the probe result so each caller can decide what a
 * non-Meridian answer means — a bad `status` invocation, or a genuine
 * port conflict.
 */
async function printRunningInstance() {
  const { probeMeridian } = await import("../src/proxy/statusProbe")
  const result = await probeMeridian(host, port, { apiKey: process.env.MERIDIAN_API_KEY })
  if (result.kind === "meridian") {
    const { renderCliDashboard } = await import("../src/telemetry/cliDashboard")
    process.stdout.write(
      renderCliDashboard({ host, port, ...result.snapshot }, { color: process.stdout.isTTY === true }),
    )
  }
  return result
}

if (args[0] === "status") {
  const result = await printRunningInstance()
  if (result.kind === "meridian") process.exit(0)
  const { formatStatusMessage } = await import("../src/proxy/statusProbe")
  console.error(formatStatusMessage(result, host, port))
  process.exit(1)
}

// Load profile configuration:
//   1. MERIDIAN_PROFILES env var (JSON array) — takes precedence
//   2. ~/.config/meridian/profiles.json — written by `meridian profile add`
// fs/path/os imports removed — profile discovery now handled by the server

// Profile config: only set from MERIDIAN_PROFILES env var.
// When undefined, the server auto-discovers from ~/.config/meridian/profiles.json
// on each request (so `meridian profile add` works without restart).
import type { ProfileConfig } from "../src/proxy/profiles"
let profiles: ProfileConfig[] | undefined
let defaultProfile: string | undefined
try {
  const raw = process.env.MERIDIAN_PROFILES
  if (raw) {
    profiles = JSON.parse(raw)
    defaultProfile = process.env.MERIDIAN_DEFAULT_PROFILE || undefined
  }
  // No else — let the server auto-discover from disk
} catch (e) {
  console.error(`[meridian] Failed to parse MERIDIAN_PROFILES: ${e instanceof Error ? e.message : e}`)
}

/**
 * Run the CLI default action (start the proxy server).
 *
 * @param start  Server bootstrap (overridable for tests).
 * @param runAuthCheck  Pre-flight `claude auth status` runner. Default
 *   resolves the bundled/platform-package binary via
 *   `resolveClaudeExecutableAsync` and runs `<resolved> auth status` via
 *   `execFile` — does NOT depend on `claude` being on PATH (#478). Tests
 *   override this to simulate ENOENT / non-zero exit / malformed JSON.
 */
export async function runCli(
  start = startProxyServer,
  runAuthCheck: () => Promise<{ stdout: string }> = async () => {
    const claudePath = await resolveClaudeExecutableAsync()
    return execFile(claudePath, ["auth", "status"], { timeout: 5000 })
  }
) {
  // Plugin check — warn if OpenCode config exists but meridian plugin is missing
  try {
    const { findOpencodeConfigPath, checkPluginConfigured, findPluginPath } = await import("../src/proxy/setup")
    const configPath = findOpencodeConfigPath()
    const { existsSync } = await import("fs")
    if (existsSync(configPath) && !checkPluginConfigured(configPath)) {
      const pluginPath = findPluginPath(import.meta.url)
      console.error("\x1b[33m⚠ Meridian plugin not found in OpenCode config.\x1b[0m")
      console.error("  Session tracking and subagent model selection won\'t work.")
      console.error(`  Fix: meridian setup`)
      console.error("")
    }
  } catch { /* non-fatal */ }

  // Pre-flight auth check — runs the resolved Claude binary's auth-status
  // subcommand. Independent of whether `claude` is on PATH (#478).
  try {
    const { stdout } = await runAuthCheck()
    const auth = JSON.parse(stdout)
    if (!auth.loggedIn) {
      console.error("\x1b[31m✗ Not logged in to Claude.\x1b[0m Run: claude login")
      process.exit(1)
    }
    if (auth.subscriptionType !== "max") {
      console.error(`\x1b[33m⚠ Claude subscription: ${auth.subscriptionType || "unknown"} (Max recommended)\x1b[0m`)
    }
  } catch {
    console.error("\x1b[33m⚠ Could not verify Claude auth status. If requests fail, run: claude login\x1b[0m")
  }

  // Enable disk auto-discovery when no MERIDIAN_PROFILES env var is set.
  // This lets `meridian profile add` work without restarting the server.
  if (!profiles) {
    const { enableDiskProfileDiscovery } = await import("../src/proxy/profiles")
    enableDiskProfileDiscovery()
  }

  const proxy = await start({ port, host, idleTimeoutSeconds, pluginDir, pluginConfigPath, profiles, defaultProfile, version, installProcessErrorHandlers: true })

  // Handle EADDRINUSE — preserve CLI behavior of exiting on port conflict
  proxy.server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.exit(1)
    }
  })

  // Graceful shutdown: close() itself drains in-flight requests (bounded by
  // MERIDIAN_SHUTDOWN_GRACE_MS) before releasing the port — see close() in
  // startProxyServer. This handler just owns the process-exit decision, since
  // only the CLI (not a library consumer embedding startProxyServer) should
  // ever call process.exit() on a signal.
  let shuttingDown = false
  const handleShutdownSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // Second signal = force. The drain window is up to 30s and a wedged
      // stream can hold it open for all of it; swallowing every later signal
      // made the process unkillable by Ctrl-C or a supervisor's retry, short
      // of SIGKILL. First signal drains, second one gives up.
      console.log(`\n[meridian] Received ${signal} again, exiting immediately.`)
      process.exit(130)
    }
    shuttingDown = true
    console.log(`\n[meridian] Received ${signal}, shutting down gracefully...`)
    proxy.close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[meridian] Error during shutdown: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      })
  }
  process.on("SIGTERM", handleShutdownSignal)
  process.on("SIGINT", handleShutdownSignal)
}

if (import.meta.main) {
  // Ask before starting, because the answer changes what "port in use" means.
  // The port that Meridian wants is usually held by Meridian, and being told
  // so is not an error — it is the question `meridian status` answers, asked
  // by accident. Checking here rather than from the EADDRINUSE handler keeps
  // the dashboard as the whole output: by the time a bind fails, the
  // pre-flight auth check and the plugin loader have already printed.
  const { isPortAvailable } = await import("../src/proxy/statusProbe")
  if (!(await isPortAvailable(host, port))) {
    const result = await printRunningInstance()
    if (result.kind === "meridian") process.exit(0)
    const { formatConflictMessage } = await import("../src/proxy/statusProbe")
    console.error(formatConflictMessage(result, host, port))
    process.exit(1)
  }
  await runCli()
}
