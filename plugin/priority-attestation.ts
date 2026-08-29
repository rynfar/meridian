/**
 * OpenCode-side signer for Meridian priority failback attestations.
 *
 * This file lives under plugin/ because the V1 plugin is shipped as TypeScript.
 * The V2 build bundles it into dist/meridian-v2.js.
 */

import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PRIORITY_ATTESTATION_HEADER = "x-meridian-opencode-turn"
export const PRIORITY_ATTESTATION_KEY_ENV = "MERIDIAN_OPENCODE_ATTESTATION_KEY"
export const PRIORITY_ATTESTATION_KEY_FILE = "opencode-turn.key"

const TOKEN_PREFIX = "v1"
const MAC_DOMAIN = "meridian.opencode.turn.v1\0"
const TURN_DOMAIN = "meridian.opencode.human.v1\0"
const MAX_HEADER_BYTES = 768
const MAX_PAYLOAD_BYTES = 384
const TURN_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
export type OpenCodeAttestationGeneration = "oc1" | "oc2b18314"

export interface PriorityAttestationSignInput {
  readonly generation: OpenCodeAttestationGeneration
  readonly sessionId: string
  readonly agentId: string
  readonly humanMessageId: string
  /** Immutable OpenCode user-message creation time, in whole Unix seconds. */
  readonly issuedAt: number
}

function configDirectory(): string {
  return process.env.MERIDIAN_CONFIG_DIR ?? join(homedir(), ".config", "meridian")
}

export function priorityAttestationKeyPath(): string {
  return join(configDirectory(), PRIORITY_ATTESTATION_KEY_FILE)
}

function isSafeAgentId(value: string): boolean {
  return value.length >= 1
    && value.length <= 64
    && value.trim() === value
    && /^[\x20-\x7E]+$/.test(value)
}

function decodeCanonicalBase64Url(raw: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined
  const decoded = Buffer.from(raw, "base64url")
  return decoded.toString("base64url") === raw ? decoded : undefined
}

export function decodePriorityAttestationKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined
  const normalized = raw.trim()
  const decoded = decodeCanonicalBase64Url(normalized)
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

export function computePriorityTurnDigest(input: {
  readonly generation: OpenCodeAttestationGeneration
  readonly sessionId: string
  readonly humanMessageId: string
}): string | undefined {
  if (!SAFE_ID_PATTERN.test(input.sessionId) || !SAFE_ID_PATTERN.test(input.humanMessageId)) {
    return undefined
  }
  return createHash("sha256")
    .update(TURN_DOMAIN)
    .update(input.generation)
    .update("\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.humanMessageId)
    .digest("base64url")
}



export function createPriorityAttestation(
  input: PriorityAttestationSignInput,
  key: Buffer = loadPriorityAttestationKey() ?? Buffer.alloc(0),
): string | undefined {
  if (key.length !== 32) return undefined
  if (!SAFE_ID_PATTERN.test(input.sessionId) || !isSafeAgentId(input.agentId)) return undefined
  const turnDigest = computePriorityTurnDigest(input)
  if (!turnDigest || !TURN_DIGEST_PATTERN.test(turnDigest)) return undefined
  const issuedAt = input.issuedAt
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return undefined

  // Fixed insertion order is part of the wire contract. The proxy reconstructs
  // this exact JSON and rejects non-canonical or extensible payloads.
  const payload = JSON.stringify({
    v: 1,
    g: input.generation,
    s: input.sessionId,
    a: input.agentId,
    t: turnDigest,
    iat: issuedAt,
  })
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return undefined
  const encodedPayload = Buffer.from(payload).toString("base64url")
  const mac = createHmac("sha256", key)
    .update(MAC_DOMAIN)
    .update(payload)
    .digest("base64url")
  const token = `${TOKEN_PREFIX}.${encodedPayload}.${mac}`
  return Buffer.byteLength(token) <= MAX_HEADER_BYTES ? token : undefined
}

export type MutableHeaders = Record<string, string> | Headers

export function deleteHeader(headers: MutableHeaders, name: string): void {
  if (headers instanceof Headers) {
    headers.delete(name)
    return
  }
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key]
  }
}

export function getHeader(headers: MutableHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

export function setHeader(headers: MutableHeaders, name: string, value: string): void {
  deleteHeader(headers, name)
  if (headers instanceof Headers) headers.set(name, value)
  else headers[name] = value
}
