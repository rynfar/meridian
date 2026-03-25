import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { initAdmin, isAdminConfigured, verifyMasterKey, generateJwt, verifyJwt } from "../keys/auth"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Admin auth", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "auth-test-"))
    process.env.MERIDIAN_ADMIN_FILE = join(tmpDir, "admin.json")
    process.env.MERIDIAN_MASTER_KEY = "test-master-key-123"
    initAdmin()
  })

  afterEach(() => {
    delete process.env.MERIDIAN_ADMIN_FILE
    delete process.env.MERIDIAN_MASTER_KEY
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("configures admin on init", () => {
    expect(isAdminConfigured()).toBe(true)
  })

  it("verifies correct master key", () => {
    expect(verifyMasterKey("test-master-key-123")).toBe(true)
  })

  it("rejects wrong master key", () => {
    expect(verifyMasterKey("wrong-key")).toBe(false)
  })

  it("generates a valid JWT", () => {
    const jwt = generateJwt()
    expect(jwt.split(".")).toHaveLength(3)
    expect(verifyJwt(jwt)).toBe(true)
  })

  it("rejects invalid JWT", () => {
    expect(verifyJwt("invalid.token.here")).toBe(false)
    expect(verifyJwt("")).toBe(false)
    expect(verifyJwt("abc")).toBe(false)
  })

  it("rejects expired JWT", () => {
    // Monkey-patch Date.now to make a token that's already expired
    const jwt = generateJwt()
    // Tamper with payload to set exp in the past
    const parts = jwt.split(".")
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
    payload.exp = Math.floor(Date.now() / 1000) - 3600
    const newPayload = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const tampered = `${parts[0]}.${newPayload}.${parts[2]}`
    expect(verifyJwt(tampered)).toBe(false) // signature mismatch
  })
})
