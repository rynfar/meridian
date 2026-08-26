import { describe, expect, it } from "bun:test"
import {
  getRecoveryClaimPath,
  getRecoveryClaimTombstonePath,
  parseRecoveryClaimOwner,
  recoveryClaimOwnerIsDead,
  type RecoveryClaimOwner,
} from "../proxy/session/recoveryClaim"

const owner: RecoveryClaimOwner = {
  version: 2,
  generation: "canonical-generation",
  token: "claim-token",
  pid: 123,
  hostname: "local-host",
  createdAt: 1,
  incarnation: {
    version: 1,
    pid: 123,
    hostId: "a".repeat(64),
    bootId: "11111111-1111-4111-8111-111111111111",
    startId: "12345",
    startIdKind: "linux-proc-start-ticks",
  },
}

describe("recovery claim protocol", () => {
  it("requires complete versioned owner metadata", () => {
    expect(parseRecoveryClaimOwner(owner)).toEqual(owner)
    expect(parseRecoveryClaimOwner({ ...owner, version: 1 })).toBeUndefined()
    expect(parseRecoveryClaimOwner({ ...owner, generation: "" })).toBeUndefined()
    expect(parseRecoveryClaimOwner({ ...owner, token: "" })).toBeUndefined()
    expect(parseRecoveryClaimOwner({ ...owner, pid: 0 })).toBeUndefined()
    expect(parseRecoveryClaimOwner({ ...owner, hostname: "" })).toBeUndefined()
  })

  it("takes over only after an authoritative incarnation-death probe", () => {
    expect(recoveryClaimOwnerIsDead(owner, () => true)).toBe(true)
    expect(recoveryClaimOwnerIsDead(owner, () => false)).toBe(false)
    expect(parseRecoveryClaimOwner({ ...owner, incarnation: undefined })).toBeUndefined()
  })

  it("derives deterministic generation and token-scoped paths", () => {
    const claim = getRecoveryClaimPath("/locks/session.lock", owner.generation)
    expect(claim).toBe(getRecoveryClaimPath("/locks/session.lock", owner.generation))
    expect(claim).not.toBe(getRecoveryClaimPath("/locks/session.lock", "other-generation"))
    expect(getRecoveryClaimTombstonePath(claim, owner.token))
      .toBe(getRecoveryClaimTombstonePath(claim, owner.token))
    expect(getRecoveryClaimTombstonePath(claim, owner.token))
      .not.toBe(getRecoveryClaimTombstonePath(claim, "other-token"))
  })
})
