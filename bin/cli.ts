#!/usr/bin/env bun

import { createRequire } from "module"
import { startProxyServer } from "../src/proxy/server"
import { supervise } from "../src/supervisor"
import { exec as execCallback } from "child_process"
import { promisify } from "util"
import { envInt, envOr } from "../src/env"

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

Usage: meridian [options]

Options:
  -v, --version          Show version
  -h, --help             Show this help
  --no-supervisor        Run without auto-restart supervisor

Environment variables:
  MERIDIAN_PORT                     Port to listen on (default: 3456)
  MERIDIAN_HOST                     Host to bind to (default: 127.0.0.1)
  MERIDIAN_PASSTHROUGH              Enable passthrough mode (tools forwarded to client)
  MERIDIAN_IDLE_TIMEOUT_SECONDS     Idle timeout in seconds (default: 120)

See https://github.com/rynfar/meridian for full documentation.`)
  process.exit(0)
}

const exec = promisify(execCallback)

const port = envInt("PORT", 3456)
const host = envOr("HOST", "127.0.0.1")
const idleTimeoutSeconds = envInt("IDLE_TIMEOUT_SECONDS", 120)

export async function runCli(
  start = startProxyServer,
  runExec: typeof exec = exec
) {
  // Prevent SDK subprocess crashes from killing the proxy
  process.on("uncaughtException", (err) => {
    console.error(`[PROXY] Uncaught exception (recovered): ${err.message}`)
  })
  process.on("unhandledRejection", (reason) => {
    console.error(`[PROXY] Unhandled rejection (recovered): ${reason instanceof Error ? reason.message : reason}`)
  })

  // Pre-flight auth check
  try {
    const { stdout } = await runExec("claude auth status", { timeout: 5000 })
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

  try {
    await start({ port, host, idleTimeoutSeconds })
  } catch (error) {
    // Bun.serve() throws on port conflict
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes("address already in use") || msg.includes("EADDRINUSE")) {
      console.error(`\nError: Port ${port} is already in use.`)
      console.error(`\nIs another instance of the proxy already running?`)
      console.error(`  Check with: lsof -i :${port}`)
      console.error(`  Kill it with: kill $(lsof -ti :${port})`)
      console.error(`\nOr use a different port:`)
      console.error(`  MERIDIAN_PORT=4567 meridian`)
      process.exit(1)
    }
    throw error
  }
}

if (import.meta.main) {
  if (args.includes("--no-supervisor")) {
    await runCli()
  } else {
    await supervise(["bun", "run", import.meta.filename, "--no-supervisor"])
  }
}
