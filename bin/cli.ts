#!/usr/bin/env node

import { startProxyServer } from "../src/proxy/server"
import { runCopilotLogin, runCopilotStatus } from "../src/proxy/copilot/login"
import { exec as execCallback } from "child_process"
import { promisify } from "util"

const exec = promisify(execCallback)

// Prevent SDK subprocess crashes from killing the proxy
process.on("uncaughtException", (err) => {
  console.error(`[PROXY] Uncaught exception (recovered): ${err.message}`)
})
process.on("unhandledRejection", (reason) => {
  console.error(`[PROXY] Unhandled rejection (recovered): ${reason instanceof Error ? reason.message : reason}`)
})

const port = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10)
const host = process.env.CLAUDE_PROXY_HOST || "127.0.0.1"
const idleTimeoutSeconds = parseInt(process.env.CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS || "120", 10)

export async function runCli(
  start = startProxyServer,
  runExec: typeof exec = exec
) {
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

  const proxy = await start({ port, host, idleTimeoutSeconds })

  // Handle EADDRINUSE — preserve CLI behavior of exiting on port conflict
  proxy.server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.exit(1)
    }
  })
}

if (import.meta.main) {
  const subcommand = process.argv[2]

  if (subcommand === "copilot-login") {
    await runCopilotLogin()
  } else if (subcommand === "copilot-status") {
    await runCopilotStatus()
  } else {
    await runCli()
  }
}
