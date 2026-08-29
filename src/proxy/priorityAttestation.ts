/**
 * Verify and provision OpenCode priority-failback attestations.
 *
 * The OpenCode plugin signs a bounded positive assertion at its final outbound
 * hook. Meridian verifies it before treating a request as a new human turn.
 * Missing or invalid attestations fail closed to normal profile affinity.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { homedir, platform } from "node:os"
import { dirname, join } from "node:path"

export const PRIORITY_ATTESTATION_HEADER = "x-meridian-opencode-turn"
export const PRIORITY_ATTESTATION_KEY_ENV = "MERIDIAN_OPENCODE_ATTESTATION_KEY"
export const PRIORITY_ATTESTATION_KEY_FILE = "opencode-turn.key"

const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/
const MAC_DOMAIN = "meridian.opencode.turn.v1\0"
const MAX_HEADER_BYTES = 768
const MAX_PAYLOAD_BYTES = 384
const MAX_PAST_AGE_SECONDS = 120
const MAX_FUTURE_SKEW_SECONDS = 30
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const TURN_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type OpenCodeAttestationGeneration = "oc1" | "oc2b18314"

export interface VerifiedPriorityAttestation {
  readonly generation: OpenCodeAttestationGeneration
  readonly sessionId: string
  readonly agentId: string
  readonly turnId: string
  readonly issuedAt: number
}

export class InvalidPriorityAttestationKeyError extends Error {
  constructor(public readonly keyPath: string) {
    super(`OpenCode routing attestation key is invalid at ${keyPath}`)
    this.name = "InvalidPriorityAttestationKeyError"
  }
}

function configDirectory(): string {
  return process.env.MERIDIAN_CONFIG_DIR ?? join(homedir(), ".config", "meridian")
}

export function priorityAttestationKeyPath(): string {
  return join(configDirectory(), PRIORITY_ATTESTATION_KEY_FILE)
}

function decodeCanonicalBase64Url(raw: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined
  const decoded = Buffer.from(raw, "base64url")
  return decoded.toString("base64url") === raw ? decoded : undefined
}

export function decodePriorityAttestationKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined
  const decoded = decodeCanonicalBase64Url(raw.trim())
  return decoded?.length === 32 ? decoded : undefined
}

export function loadPriorityAttestationKey(): Buffer | undefined {
  const fromEnv = process.env[PRIORITY_ATTESTATION_KEY_ENV]
  if (fromEnv !== undefined) return decodePriorityAttestationKey(fromEnv)
  try {
    return decodePriorityAttestationKey(readFileSync(priorityAttestationKeyPath(), "utf8"))
  } catch {
    return undefined
  }
}

function readRequiredFileKey(path: string): Buffer {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new InvalidPriorityAttestationKeyError(path)
  }
  const key = decodePriorityAttestationKey(raw)
  if (!key) throw new InvalidPriorityAttestationKeyError(path)
  return key
}

/**
 * Ensure setup has a durable 32-byte signing key without ever rotating an
 * existing valid key. An environment key wins and avoids touching disk.
 */
export function ensurePriorityAttestationKey(): { readonly key: Buffer; readonly path?: string } {
  const fromEnv = process.env[PRIORITY_ATTESTATION_KEY_ENV]
  if (fromEnv !== undefined) {
    const key = decodePriorityAttestationKey(fromEnv)
    if (!key) throw new InvalidPriorityAttestationKeyError(PRIORITY_ATTESTATION_KEY_ENV)
    return { key }
  }

  const path = priorityAttestationKeyPath()
  try {
    const key = readRequiredFileKey(path)
    if (platform() !== "win32") chmodSync(path, 0o600)
    return { key, path }
  } catch (error) {
    if (!(error instanceof InvalidPriorityAttestationKeyError)) throw error
    try {
      readFileSync(path)
      // The file exists but is malformed. Never replace or rotate it silently.
      throw error
    } catch (readError) {
      if (readError === error) throw error
    }
  }

  mkdirSync(dirname(path), { recursive: true })
  const encoded = randomBytes(32).toString("base64url")
  try {
    writeFileSync(path, `${encoded}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  } catch (error) {
    // Another setup process may have won the atomic create race.
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined
    if (code !== "EEXIST") throw error
  }
  const key = readRequiredFileKey(path)
  if (platform() !== "win32") chmodSync(path, 0o600)
  return { key, path }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeAgentId(value: string): boolean {
  return value.length >= 1
    && value.length <= 64
    && value.trim() === value
    && /^[\x20-\x7E]+$/.test(value)
}

function parseCanonicalPayload(raw: string): VerifiedPriorityAttestation | undefined {
  if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (Object.keys(value).join(",") !== "v,g,s,a,t,iat") return undefined
  if (value.v !== 1) return undefined
  if (value.g !== "oc1" && value.g !== "oc2b18314") return undefined
  if (typeof value.s !== "string" || !SAFE_ID_PATTERN.test(value.s)) return undefined
  if (typeof value.a !== "string" || !isSafeAgentId(value.a)) return undefined
  if (typeof value.t !== "string" || !TURN_DIGEST_PATTERN.test(value.t)) return undefined
  if (typeof value.iat !== "number" || !Number.isSafeInteger(value.iat) || value.iat < 0) return undefined

  const canonical = JSON.stringify({
    v: 1,
    g: value.g,
    s: value.s,
    a: value.a,
    t: value.t,
    iat: value.iat,
  })
  if (canonical !== raw) return undefined
  return {
    generation: value.g,
    sessionId: value.s,
    agentId: value.a,
    turnId: value.t,
    issuedAt: value.iat,
  }
}

export function verifyPriorityAttestation(
  token: string | undefined,
  key: Buffer = loadPriorityAttestationKey() ?? Buffer.alloc(0),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedPriorityAttestation | undefined {
  if (!token || key.length !== 32 || Buffer.byteLength(token) > MAX_HEADER_BYTES) return undefined
  const match = TOKEN_PATTERN.exec(token)
  if (!match?.[1] || !match[2]) return undefined
  const payloadBytes = decodeCanonicalBase64Url(match[1])
  const suppliedMac = decodeCanonicalBase64Url(match[2])
  if (!payloadBytes || !suppliedMac || suppliedMac.length !== 32) return undefined
  const payloadRaw = payloadBytes.toString("utf8")
  if (Buffer.from(payloadRaw, "utf8").compare(payloadBytes) !== 0) return undefined
  const payload = parseCanonicalPayload(payloadRaw)
  if (!payload) return undefined
  if (payload.issuedAt < nowSeconds - MAX_PAST_AGE_SECONDS) return undefined
  if (payload.issuedAt > nowSeconds + MAX_FUTURE_SKEW_SECONDS) return undefined

  const expectedMac = createHmac("sha256", key)
    .update(MAC_DOMAIN)
    .update(payloadRaw)
    .digest()
  if (!timingSafeEqual(expectedMac, suppliedMac)) return undefined
  return payload
}
