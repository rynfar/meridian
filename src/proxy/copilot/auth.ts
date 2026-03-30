/**
 * GitHub Copilot authentication.
 *
 * Reads GitHub OAuth access tokens saved by CLIProxyAPIPlus or Meridian's
 * own copilot-login flow, then exchanges them for short-lived Copilot API
 * JWTs (valid ~25 min).
 *
 * Token search order:
 *   1. ~/.meridian/copilot-auth.json          (Meridian native)
 *   2. ~/.cli-proxy-api/github-copilot-*.json  (CLIProxyAPIPlus)
 */

import { readFileSync, existsSync, readdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"

/** Buffer before JWT expiry when we pre-fetch a new one */
const JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000

interface CachedJWT {
  token: string
  endpoint: string
  expiresAt: number
}

let jwtCache: CachedJWT | null = null

/**
 * Scan known locations for a saved GitHub access token.
 */
function loadGitHubToken(): string {
  // 1. Meridian-native path
  const meridianPath = join(homedir(), ".meridian", "copilot-auth.json")
  if (existsSync(meridianPath)) {
    try {
      const data = JSON.parse(readFileSync(meridianPath, "utf8"))
      if (data.access_token) return data.access_token
    } catch {}
  }

  // 2. CLIProxyAPIPlus path — scan for any github-copilot-*.json
  const cliProxyDir = join(homedir(), ".cli-proxy-api")
  if (existsSync(cliProxyDir)) {
    let files: string[]
    try {
      files = readdirSync(cliProxyDir)
    } catch {
      files = []
    }
    for (const file of files) {
      if (!file.startsWith("github-copilot-") || !file.endsWith(".json")) continue
      try {
        const data = JSON.parse(readFileSync(join(cliProxyDir, file), "utf8"))
        if (data.access_token && data.disabled !== true) return data.access_token
      } catch {}
    }
  }

  throw new Error(
    "No GitHub Copilot token found. " +
    "Run VibeProxy/CLIProxyAPIPlus to authenticate first, " +
    "or run: meridian copilot-login"
  )
}

/**
 * Exchange a GitHub access token for a short-lived Copilot API JWT.
 * Result is cached until near-expiry.
 */
export async function getCopilotJWT(): Promise<{ token: string; endpoint: string }> {
  const now = Date.now()

  if (jwtCache && now < jwtCache.expiresAt - JWT_REFRESH_BUFFER_MS) {
    return { token: jwtCache.token, endpoint: jwtCache.endpoint }
  }

  const accessToken = loadGitHubToken()

  const resp = await fetch(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Authorization: `token ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "GithubCopilot/1.0",
    },
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Copilot token exchange failed (${resp.status}): ${body}`)
  }

  const data = await resp.json() as {
    token: string
    expires_at: number
    endpoints?: { api?: string }
  }

  if (!data.token) {
    throw new Error("Copilot token exchange returned empty token")
  }

  const endpoint = data.endpoints?.api?.replace(/\/$/, "") ?? "https://api.githubcopilot.com"
  const expiresAt = data.expires_at > 0
    ? data.expires_at * 1000
    : now + 25 * 60 * 1000

  jwtCache = { token: data.token, endpoint, expiresAt }

  return { token: data.token, endpoint }
}

/** Force-clear the JWT cache (for testing / after auth errors). */
export function clearJWTCache(): void {
  jwtCache = null
}
