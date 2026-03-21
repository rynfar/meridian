#!/usr/bin/env node

import { startProxyServer } from "../src/proxy/server"
import { execSync } from "child_process"

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

// Pre-flight auth check
try {
  const authJson = execSync("claude auth status", { encoding: "utf-8", timeout: 5000 })
  const auth = JSON.parse(authJson)
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

await startProxyServer({ port, host, idleTimeoutSeconds })
