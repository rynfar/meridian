import { describe, expect, it } from "bun:test"
import {
  captureProcessIncarnation,
  evaluateProcessIncarnation,
  parseLinuxProcStatStartId,
  parseProcessIncarnation,
  parseProcessIncarnationJson,
  probeProcessIncarnation,
  type LocalBootIdentity,
  type ProcessIncarnation,
} from "../proxy/session/processIncarnation"

const hostId = "a".repeat(64)
const otherHostId = "b".repeat(64)
const bootId = "11111111-1111-4111-8111-111111111111"
const otherBootId = "22222222-2222-4222-8222-222222222222"

const linuxOwner: ProcessIncarnation = {
  version: 1,
  pid: 123,
  hostId,
  bootId,
  startId: "987654",
  startIdKind: "linux-proc-start-ticks",
}

const localBoot: LocalBootIdentity = { hostId, bootId }

describe("process incarnation protocol", () => {
  it("strictly parses complete versioned identities", () => {
    expect(parseProcessIncarnation(linuxOwner)).toEqual(linuxOwner)
    expect(parseProcessIncarnationJson(JSON.stringify(linuxOwner))).toEqual(linuxOwner)
    expect(parseProcessIncarnationJson("not json")).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, version: 2 })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, pid: 0 })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, hostId: "local" })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, bootId: "boot" })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, startId: "0" })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, startIdKind: "unknown" })).toBeUndefined()
    expect(parseProcessIncarnation({
      ...linuxOwner,
      startId: "638602697690000000",
      startIdKind: "windows-start-ticks",
    })).toBeDefined()
  })

  it("fails closed when host identity or the probe is uncertain", () => {
    expect(evaluateProcessIncarnation(linuxOwner, undefined, { status: "missing" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, { hostId: otherHostId, bootId }, { status: "missing" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, undefined))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, { status: "indeterminate" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: "987654",
      startIdKind: "darwin-ps-lstart",
    })).toBe("indeterminate")
    expect(evaluateProcessIncarnation({ ...linuxOwner, hostId: "bad" }, localBoot, { status: "missing" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: "malformed",
      startIdKind: "linux-proc-start-ticks",
    })).toBe("indeterminate")
  })

  it("proves death across a reboot, ESRCH, or exact Linux start mismatch", () => {
    expect(evaluateProcessIncarnation(
      linuxOwner,
      { hostId, bootId: otherBootId },
      { status: "indeterminate" },
    )).toBe("dead")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, { status: "missing" }))
      .toBe("dead")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: "987655",
      startIdKind: "linux-proc-start-ticks",
    })).toBe("dead")
  })

  it("recognizes an exact Linux incarnation match", () => {
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: linuxOwner.startId,
      startIdKind: linuxOwner.startIdKind,
    })).toBe("alive")
  })

  it("keeps a same-second Darwin birth-time collision fail closed", () => {
    const darwinOwner: ProcessIncarnation = {
      ...linuxOwner,
      startId: "Wed Aug 26 11:49:29 2026",
      startIdKind: "darwin-ps-lstart",
    }
    expect(evaluateProcessIncarnation(darwinOwner, localBoot, {
      status: "found",
      startId: darwinOwner.startId,
      startIdKind: darwinOwner.startIdKind,
    })).toBe("indeterminate")
    expect(evaluateProcessIncarnation(darwinOwner, localBoot, {
      status: "found",
      startId: "Wed Aug 26 11:49:30 2026",
      startIdKind: darwinOwner.startIdKind,
    })).toBe("dead")
  })

  it("parses Linux proc stat field 22 after the final comm parenthesis", () => {
    const fieldsFromState = ["S", ...Array.from({ length: 18 }, () => "0"), "987654", "0"]
    const stat = `123 (worker ) with spaces) ${fieldsFromState.join(" ")}
`
    expect(parseLinuxProcStatStartId(stat, 123)).toBe("987654")
    expect(parseLinuxProcStatStartId(stat, 124)).toBeUndefined()
    expect(parseLinuxProcStatStartId("123 malformed", 123)).toBeUndefined()
  })

  it("captures and conservatively probes the current process on every supported platform", () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    const current = captureProcessIncarnation()
    expect(current).toBeDefined()
    expect(parseProcessIncarnation(current)).toEqual(current)
    expect(probeProcessIncarnation(current!))
      .toBe(process.platform === "linux" ? "alive" : "indeterminate")
  }, 25_000) // Windows can run two cold PowerShell probes at up to 10s each.
})
