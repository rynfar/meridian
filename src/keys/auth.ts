/**
 * Admin authentication — master key hashing + JWT session tokens.
 *
 * Master key is hashed with SHA-256 and stored on disk.
 * On login, input is hashed and compared. On success, a JWT is issued.
 * The JWT is used for all subsequent admin API calls.
 */

import { createHash, createHmac } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { env } from "../env"

interface AdminConfig {
  masterKeyHash: string
}

const JWT_EXPIRY_HOURS = 24

function defaultAdminPath(): string {
  return resolve(homedir(), ".claude-proxy", "admin.json")
}

let config: AdminConfig | null = null
const filePath = env("ADMIN_FILE") ?? defaultAdminPath()

function load(): AdminConfig | null {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"))
    }
  } catch {}
  return null
}

function save(cfg: AdminConfig): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(cfg, null, 2))
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Initialize admin config. If env var is set and no config exists, auto-setup. */
export function initAdmin(): void {
  config = load()
  const envKey = env("MASTER_KEY")

  if (envKey && !config) {
    config = { masterKeyHash: hashKey(envKey) }
    save(config)
  } else if (envKey && config) {
    const newHash = hashKey(envKey)
    if (newHash !== config.masterKeyHash) {
      config.masterKeyHash = newHash
      save(config)
    }
  }
}

/** Check if admin is configured (master key hash exists). */
export function isAdminConfigured(): boolean {
  if (!config) config = load()
  return config !== null && !!config.masterKeyHash
}

/** Verify a master key against the stored hash. */
export function verifyMasterKey(key: string): boolean {
  if (!config) config = load()
  if (!config) return false
  return hashKey(key) === config.masterKeyHash
}

/** Generate a JWT token for an authenticated admin session. */
export function generateJwt(): string {
  if (!config) throw new Error("Admin not configured")

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_HOURS * 3600,
    iat: Math.floor(Date.now() / 1000),
    sub: "admin",
  })).toString("base64url")

  const signature = createHmac("sha256", config.masterKeyHash)
    .update(`${header}.${payload}`)
    .digest("base64url")

  return `${header}.${payload}.${signature}`
}

/** Verify a JWT token. Returns true if valid and not expired. */
export function verifyJwt(token: string): boolean {
  if (!config) config = load()
  if (!config) return false

  const parts = token.split(".")
  if (parts.length !== 3) return false

  const [header, payload, signature] = parts

  // Verify signature
  const expected = createHmac("sha256", config.masterKeyHash)
    .update(`${header}.${payload}`)
    .digest("base64url")

  if (signature !== expected) return false

  // Check expiration
  try {
    const data = JSON.parse(Buffer.from(payload!, "base64url").toString())
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return false
  } catch {
    return false
  }

  return true
}
