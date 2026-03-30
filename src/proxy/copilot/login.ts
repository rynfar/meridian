/**
 * GitHub Copilot device flow OAuth login.
 *
 * Implements the GitHub device authorization grant:
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 *
 * Saves the resulting token to ~/.meridian/copilot-auth.json
 * in the same format as CLIProxyAPIPlus so both tools can share it.
 */

import { writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { exec as execCb } from "child_process"
import { promisify } from "util"
import { getCopilotJWT, clearJWTCache } from "./auth"

const exec = promisify(execCb)

const CLIENT_ID = "Iv1.b507a08c87ecfe98"
const DEVICE_CODE_URL = "https://github.com/login/device/code"
const TOKEN_URL = "https://github.com/login/oauth/access_token"
const USER_INFO_URL = "https://api.github.com/user"

const MERIDIAN_AUTH_PATH = join(homedir(), ".meridian", "copilot-auth.json")

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface TokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user user:email" })
  const resp = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  })
  if (!resp.ok) throw new Error(`Device code request failed: ${resp.status}`)
  return resp.json() as Promise<DeviceCodeResponse>
}

async function pollForToken(
  deviceCode: string,
  intervalSec: number,
  expiresIn: number
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000
  let pollMs = Math.max(intervalSec, 5) * 1000

  while (Date.now() < deadline) {
    await sleep(pollMs)

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    })

    const data = await resp.json() as TokenResponse

    if (data.access_token) return data.access_token

    switch (data.error) {
      case "authorization_pending":
        break // keep polling
      case "slow_down":
        pollMs += 5000
        break
      case "expired_token":
        throw new Error("Device code expired. Run meridian copilot-login again.")
      case "access_denied":
        throw new Error("Authorization denied by user.")
      default:
        if (data.error) throw new Error(`OAuth error: ${data.error} — ${data.error_description ?? ""}`)
    }
  }

  throw new Error("Timed out waiting for authorization.")
}

async function fetchUsername(accessToken: string): Promise<{ login: string; email: string }> {
  const resp = await fetch(USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "meridian" },
  })
  if (!resp.ok) return { login: "unknown", email: "" }
  const data: any = await resp.json()
  return { login: data.login ?? "unknown", email: data.email ?? "" }
}

async function tryOpenBrowser(url: string): Promise<void> {
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    await exec(`${cmd} "${url}"`)
  } catch {
    // Non-fatal — user can open manually
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runCopilotLogin(): Promise<void> {
  console.log("Starting GitHub Copilot authentication...")

  let deviceCode: DeviceCodeResponse
  try {
    deviceCode = await requestDeviceCode()
  } catch (err) {
    console.error(`\x1b[31mFailed to start device flow: ${err instanceof Error ? err.message : err}\x1b[0m`)
    process.exit(1)
  }

  console.log(`\nVisit: \x1b[36m${deviceCode.verification_uri}\x1b[0m`)
  console.log(`Enter code: \x1b[1;33m${deviceCode.user_code}\x1b[0m\n`)

  await tryOpenBrowser(deviceCode.verification_uri)

  console.log(`Waiting for authorization (expires in ${deviceCode.expires_in}s)...`)

  let accessToken: string
  try {
    accessToken = await pollForToken(deviceCode.device_code, deviceCode.interval, deviceCode.expires_in)
  } catch (err) {
    console.error(`\x1b[31m${err instanceof Error ? err.message : err}\x1b[0m`)
    process.exit(1)
  }

  // Verify token works for Copilot
  console.log("Verifying Copilot access...")
  const { login, email } = await fetchUsername(accessToken)

  // Save token — clear JWT cache so next request uses the new token
  clearJWTCache()

  const storage = {
    access_token: accessToken,
    token_type: "bearer",
    scope: "read:user user:email",
    username: login,
    email,
    type: "github-copilot",
    disabled: false,
  }

  mkdirSync(join(homedir(), ".meridian"), { recursive: true })
  writeFileSync(MERIDIAN_AUTH_PATH, JSON.stringify(storage, null, 2), { mode: 0o600 })

  // Quick JWT exchange to confirm Copilot subscription is active
  try {
    await getCopilotJWT()
    console.log(`\x1b[32m✓ Authenticated as ${email || login}\x1b[0m`)
    console.log(`  Token saved to ${MERIDIAN_AUTH_PATH}`)
  } catch (err) {
    console.error(`\x1b[33m⚠ Token saved but Copilot API verification failed: ${err instanceof Error ? err.message : err}\x1b[0m`)
    console.error("  You may not have an active Copilot subscription.")
  }
}

export async function runCopilotStatus(): Promise<void> {
  try {
    const { token } = await getCopilotJWT()
    console.log(`\x1b[32m✓ Copilot authenticated\x1b[0m (JWT: ${token.slice(0, 16)}...)`)
  } catch (err) {
    console.error(`\x1b[31m✗ Copilot not authenticated: ${err instanceof Error ? err.message : err}\x1b[0m`)
    console.error("  Run: meridian copilot-login")
    process.exit(1)
  }
}
