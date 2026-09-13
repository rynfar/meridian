import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import {
  PRIORITY_ATTESTATION_HEADER,
  PRIORITY_ATTESTATION_KEY_ENV,
  createPriorityAttestation,
  computePriorityTurnDigest,
} from "../../plugin/priority-attestation"
import {
  InvalidPriorityAttestationKeyError,
  ensurePriorityAttestationKey,
  priorityAttestationKeyPath,
  verifyPriorityAttestation,
} from "../proxy/priorityAttestation"
import type { RoutingTurnIdentity } from "../proxy/adapter"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { runSetup } from "../proxy/setup"

const KEY = Buffer.alloc(32, 7)
const KEY_TEXT = KEY.toString("base64url")
const NOW = 1_900_000_000

async function identityFromHeaders(
  headers: Record<string, string | undefined>,
): Promise<RoutingTurnIdentity | undefined> {
  let identity: RoutingTurnIdentity | undefined
  const app = new Hono()
  app.get("/", (context) => {
    identity = openCodeAdapter.getRoutingTurnIdentity?.(context)
    return context.body(null)
  })
  const requestHeaders = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) requestHeaders.set(name, value)
  }
  await app.request("http://localhost/", { headers: requestHeaders })
  return identity
}

let configDir = ""
let savedKeyEnv: string | undefined
let savedConfigDir: string | undefined

beforeEach(() => {
  savedKeyEnv = process.env[PRIORITY_ATTESTATION_KEY_ENV]
  savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
  configDir = join(tmpdir(), `meridian-attestation-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(configDir, { recursive: true })
  process.env.MERIDIAN_CONFIG_DIR = configDir
  process.env[PRIORITY_ATTESTATION_KEY_ENV] = KEY_TEXT
})

afterEach(() => {
  if (savedKeyEnv === undefined) delete process.env[PRIORITY_ATTESTATION_KEY_ENV]
  else process.env[PRIORITY_ATTESTATION_KEY_ENV] = savedKeyEnv
  if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
  else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe("priority attestation wire contract", () => {
  test("plugin signer and proxy verifier share one canonical V1 vector", () => {
    const token = createPriorityAttestation({
      generation: "oc1",
      sessionId: "ses_root",
      agentId: "build",
      humanMessageId: "msg_human_1",
      issuedAt: NOW,
    }, KEY)
    expect(token).toBeDefined()
    expect(verifyPriorityAttestation(token, KEY, NOW)).toEqual({
      generation: "oc1",
      sessionId: "ses_root",
      agentId: "build",
      turnId: computePriorityTurnDigest({
        generation: "oc1",
        sessionId: "ses_root",
        humanMessageId: "msg_human_1",
      })!,
      issuedAt: NOW,
    })
  })

  test("generation and genuine host message ID are bound into the turn digest", () => {
    const base = { sessionId: "ses_root", humanMessageId: "msg_human_1" }
    const v1 = computePriorityTurnDigest({ generation: "oc1", ...base })
    const v2 = computePriorityTurnDigest({ generation: "oc2b18314", ...base })
    const next = computePriorityTurnDigest({ generation: "oc1", ...base, humanMessageId: "msg_human_2" })
    expect(v1).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(v2).not.toBe(v1)
    expect(next).not.toBe(v1)
  })


  test("binds issue time to immutable host creation time across A-B-A replay", () => {
    const sessionId = `ses_clock_${Math.random().toString(16).slice(2)}`
    const sign = (humanMessageId: string, issuedAt: number) => createPriorityAttestation({
      generation: "oc1",
      sessionId,
      agentId: "build",
      humanMessageId,
      issuedAt,
    }, KEY)
    const firstVerified = verifyPriorityAttestation(sign("msg_human_1", NOW), KEY, NOW)
    const nextVerified = verifyPriorityAttestation(sign("msg_human_2", NOW + 1), KEY, NOW + 1)
    const replayedFirst = verifyPriorityAttestation(sign("msg_human_1", NOW), KEY, NOW + 1)
    expect(firstVerified?.issuedAt).toBe(NOW)
    expect(nextVerified?.issuedAt).toBe(NOW + 1)
    expect(replayedFirst?.turnId).toBe(firstVerified?.turnId)
    expect(replayedFirst?.issuedAt).toBe(firstVerified?.issuedAt)
  })

  test("fails closed for tampering, wrong keys, stale/future tokens, and malformed framing", () => {
    const token = createPriorityAttestation({
      generation: "oc2b18314",
      sessionId: "ses_root",
      agentId: "plan",
      humanMessageId: "msg_human_1",
      issuedAt: NOW,
    }, KEY)!
    const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
    expect(verifyPriorityAttestation(changed, KEY, NOW)).toBeUndefined()
    expect(verifyPriorityAttestation(token, Buffer.alloc(32, 8), NOW)).toBeUndefined()
    expect(verifyPriorityAttestation(token, KEY, NOW + 121)).toBeUndefined()
    expect(verifyPriorityAttestation(token, KEY, NOW - 31)).toBeUndefined()
    expect(verifyPriorityAttestation(`${token},${token}`, KEY, NOW)).toBeUndefined()
    expect(verifyPriorityAttestation(` ${token}`, KEY, NOW)).toBeUndefined()
    expect(verifyPriorityAttestation("v2.bad.bad", KEY, NOW)).toBeUndefined()
    expect(verifyPriorityAttestation("x".repeat(769), KEY, NOW)).toBeUndefined()
  })
})

describe("OpenCode adapter trusted turn identity", () => {
  test("returns only a normalized identity for a valid primary root attestation", async () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const token = createPriorityAttestation({
      generation: "oc1",
      sessionId: "ses_root",
      agentId: "build",
      humanMessageId: "msg_human_1",
      issuedAt,
    }, KEY)!
    const identity = await identityFromHeaders({
      "x-opencode-session": "ses_root",
      "x-opencode-agent-name": "build",
      "x-opencode-agent-mode": "primary",
      [PRIORITY_ATTESTATION_HEADER]: token,
    })
    expect(identity).toEqual({
      kind: "human",
      turnId: computePriorityTurnDigest({
        generation: "oc1",
        sessionId: "ses_root",
        humanMessageId: "msg_human_1",
      })!,
      issuedAt,
      generation: "opencode-v1",
    })
  })

  test("rejects keyless, affinity-only, mismatched, subagent, malformed, and pinned requests", async () => {
    const token = createPriorityAttestation({
      generation: "oc1",
      sessionId: "ses_root",
      agentId: "build",
      humanMessageId: "msg_human_1",
      issuedAt: Math.floor(Date.now() / 1000),
    }, KEY)!
    const base = {
      "x-opencode-session": "ses_root",
      "x-opencode-agent-name": "build",
      "x-opencode-agent-mode": "primary",
      [PRIORITY_ATTESTATION_HEADER]: token,
    }
    const cases: Array<Record<string, string | undefined>> = [
      { ...base, "x-opencode-session": undefined },
      { ...base, "x-opencode-session": undefined, "x-session-affinity": "ses_root" },
      { ...base, "x-opencode-session": "ses_other" },
      { ...base, "x-opencode-agent-name": "plan" },
      { ...base, "x-opencode-agent-mode": "subagent" },
      { ...base, [PRIORITY_ATTESTATION_HEADER]: "malformed" },
      { ...base, "x-meridian-profile": "work" },
      { ...base, "x-meridian-profile": "" },
    ]
    for (const headers of cases) {
      expect(await identityFromHeaders(headers)).toBeUndefined()
    }
  })
})

describe("priority attestation setup key", () => {
  test("creates one 0600 32-byte key and preserves it across V1/V2 setup", () => {
    delete process.env[PRIORITY_ATTESTATION_KEY_ENV]
    const first = ensurePriorityAttestationKey()
    const path = priorityAttestationKeyPath()
    const bytes = readFileSync(path, "utf8")
    expect(first.key).toHaveLength(32)
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)

    const configPath = join(configDir, "opencode.json")
    runSetup("/pkg/plugin/meridian.ts", configPath, "v1")
    runSetup("/pkg/dist/meridian-v2.js", configPath, "v2")
    expect(readFileSync(path, "utf8")).toBe(bytes)
  })

  test("uses a valid environment override without creating a key file", () => {
    const result = ensurePriorityAttestationKey()
    expect(result).toEqual({ key: KEY })
    expect(() => readFileSync(priorityAttestationKeyPath())).toThrow()
  })

  test("never replaces a malformed existing key", () => {
    delete process.env[PRIORITY_ATTESTATION_KEY_ENV]
    const path = priorityAttestationKeyPath()
    writeFileSync(path, "not-a-key\n", { mode: 0o644 })
    const configPath = join(configDir, "opencode.json")
    expect(() => runSetup("/pkg/plugin/meridian.ts", configPath, "v1"))
      .toThrow(InvalidPriorityAttestationKeyError)
    expect(readFileSync(path, "utf8")).toBe("not-a-key\n")
    expect(() => readFileSync(configPath)).toThrow()
  })

  test("tightens permissions without rotating an existing valid key", () => {
    if (process.platform === "win32") return
    delete process.env[PRIORITY_ATTESTATION_KEY_ENV]
    const path = priorityAttestationKeyPath()
    writeFileSync(path, `${KEY_TEXT}
`, { mode: 0o644 })
    chmodSync(path, 0o644)
    ensurePriorityAttestationKey()
    expect(readFileSync(path, "utf8")).toBe(`${KEY_TEXT}
`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
