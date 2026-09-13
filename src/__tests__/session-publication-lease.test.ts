import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  abandonFork,
  acquireActiveTranscriptLease,
  commitFork,
  prepareForkForPublication,
  publishPinnedTranscript,
  reconcile,
  releaseActiveTranscriptLease,
  runGc,
  type SessionLifecycleOptions,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"

describe("transcript publication lifetime", () => {
  let directory: string
  let options: SessionLifecycleOptions
  let deleted: TranscriptLocator[]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meridian-publication-lease-"))
    deleted = []
    options = {
      storeDir: join(directory, "store"),
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      deleter: async locator => { deleted.push(locator) },
    }
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  for (const stage of ["before SDK", "after SDK", "after commit"] as const) {
    it(`protects an unpublished target from another collector ${stage}`, async () => {
      const target = await prepareForkForPublication({
        sessionId: "pending-result",
        configDir: join(directory, "claude"),
      }, options)
      if (stage !== "before SDK") {
        const writer = await acquireActiveTranscriptLease([target], options)
        // The owning proxy's sweep sees its private request pin and promotes
        // the prepared resource. Another proxy cannot see that private pin.
        await reconcile([target], options)
        await releaseActiveTranscriptLease(writer, options)
      }
      if (stage === "after commit") await commitFork(target, options)

      await runGc([], options)
      expect(deleted).toEqual([])
      await commitFork(target, options)
      const durablePins: TranscriptLocator[] = []
      expect(await publishPinnedTranscript(target, () => {
        durablePins.push(target)
        return true
      }, options)).toBe(true)
      await runGc([], { ...options, pinProvider: () => durablePins })
      expect(deleted).toEqual([])
      // Once the durable mapping is evicted, the publication lease must no
      // longer retain a transcript for the rest of this process's lifetime.
      durablePins.length = 0
      await runGc([], options)
      expect(deleted).toHaveLength(1)
    })
  }

  for (const outcome of ["CAS loss", "exception"] as const) {
    it(`retains ownership after publication ${outcome} until abandonment`, async () => {
      const target = await prepareForkForPublication({
        sessionId: "rejected-result",
        configDir: join(directory, "claude"),
      }, options)
      await commitFork(target, options)
      if (outcome === "CAS loss") {
        expect(await publishPinnedTranscript(target, () => false, options)).toBe(false)
      } else {
        await expect(publishPinnedTranscript(target, () => {
          throw new Error("publication failed")
        }, options)).rejects.toThrow("publication failed")
      }
      await runGc([], options)
      expect(deleted).toEqual([])
      await abandonFork(target, options)
      await runGc([], options)
      expect(deleted).toHaveLength(1)
    })
  }

  it("keeps SDK writers exclusive while publication ownership is held", async () => {
    const target = await prepareForkForPublication({
      sessionId: "exclusive-writer",
      configDir: join(directory, "claude"),
    }, options)
    const writer = await acquireActiveTranscriptLease([target], options)
    await expect(acquireActiveTranscriptLease([target], options)).rejects.toThrow("active SDK writer")
    await releaseActiveTranscriptLease(writer, options)
    await abandonFork(target, options)
  })

  it("reclaims an unpublished target after its owning process exits", async () => {
    const modulePath = fileURLToPath(new URL("../proxy/sessionLifecycle.ts", import.meta.url))
    const child = Bun.spawn([process.execPath, "--eval", `
      import { prepareForkForPublication } from ${JSON.stringify(modulePath)};
      const target = await prepareForkForPublication(
        ${JSON.stringify({ sessionId: "crashed-request", configDir: join(directory, "claude") })},
        ${JSON.stringify({ storeDir: options.storeDir })});
      console.log(JSON.stringify(target));
    `], { stdout: "pipe", stderr: "pipe" })
    const [output, errors, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(status, errors).toBe(0)
    const target = JSON.parse(output) as TranscriptLocator
    await runGc([], options)
    expect(deleted).toEqual([{ sessionId: target.sessionId, configDir: target.configDir }])
  })

  it("keeps an abandoned target protected until its SDK writer is joined", async () => {
    const target = await prepareForkForPublication({
      sessionId: "abandoned-with-writer",
      configDir: join(directory, "claude"),
    }, options)
    const writer = await acquireActiveTranscriptLease([target], options)
    await abandonFork(target, options)
    await runGc([], options)
    expect(deleted).toEqual([])
    await releaseActiveTranscriptLease(writer, options)
    await runGc([], options)
    expect(deleted).toHaveLength(1)
  })
})
