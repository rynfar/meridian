import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as store from "../proxy/sessionStore"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"

type Result = { outcome: "won" | "cas" | "busy"; result?: { mappingGeneration: string; assignmentGeneration: string } }

it("allows exactly one real-process winner for identical SQLite dual generations (20 barriers)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-store-race-")))
  const losers = { busy: 0, cas: 0 }
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const directory = join(root, String(iteration))
      const handle = initializeSessionBookkeeping(directory)
      store.setSessionStoreDir(directory)
      store.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
      const mapping = store.lookupSharedSessionResult("work:race")
      const route = store.lookupPriorityAssignmentResult("race")
      if (mapping.status === "error" || !mapping.generation || route.status === "error") {
        throw new Error("cannot read initial dual generations")
      }
      const workers = ["a", "b"].map((worker) => {
        const publication = {
          key: "work:race", claudeSessionId: `sdk-${worker}`, messageCount: 1,
          lineageHash: `lineage-${worker}`, messageHashes: [`message-${worker}`],
          messageBlockHashes: [[`block-${worker}`]], expectedMappingGeneration: mapping.generation,
          priority: { routeKey: "race", profileId: "work", lastHumanTurnDigest: "a".repeat(43),
            lastHumanTurnIssuedAt: 1_900_000_000, expectedAssignmentGeneration: route.generation },
        }
        const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/bookkeeping-store-racer.ts")], {
          env: { ...process.env, RACE_INPUT: JSON.stringify({ directory, publication }) },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        })
        let stderr = ""
        child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
        const messages: unknown[] = []
        child.on("message", (message) => { messages.push(message) })
        const exited = once(child, "exit")
        const ready = Promise.race([
          once(child, "message").then(([message]) => { expect(message).toBe("ready") }),
          exited.then(([code]) => { throw new Error(`worker exited before barrier: ${code}: ${stderr}`) }),
        ])
        return { child, ready, exited, messages, publication, stderr: () => stderr }
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const race = async () => {
          await Promise.all(workers.map((worker) => worker.ready))
          for (const worker of workers) worker.child.send("go")
          const exits = await Promise.all(workers.map((worker) => worker.exited))
          expect(exits).toEqual([[0, null], [0, null]])
          expect(workers.map((worker) => worker.stderr())).toEqual(["", ""])
          for (const worker of workers) expect(worker.messages).toHaveLength(2)
          const results = workers.map((worker) => worker.messages[1] as Result)
          expect(results.filter((result) => result.outcome === "won")).toHaveLength(1)
          const loser = results.find((result) => result.outcome !== "won")!
          expect(["busy", "cas"]).toContain(loser.outcome)
          losers[loser.outcome as "busy" | "cas"]++
          const winnerIndex = results.findIndex((result) => result.outcome === "won")
          const winner = results[winnerIndex]!.result!
          expect(handle.reader.all("SELECT key FROM mappings")).toEqual([{ key: "work:race" }])
          expect(handle.reader.all("SELECT route_key FROM priority_assignments")).toEqual([{ route_key: "race" }])
          expect(store.lookupSharedSessionResult("work:race")).toMatchObject({
            status: "found", generation: winner.mappingGeneration,
            session: { claudeSessionId: workers[winnerIndex]!.publication.claudeSessionId,
              messageHashes: workers[winnerIndex]!.publication.messageHashes,
              messageBlockHashes: workers[winnerIndex]!.publication.messageBlockHashes },
          })
          expect(store.lookupPriorityAssignmentResult("race")).toMatchObject({
            status: "found", generation: winner.assignmentGeneration,
            assignment: { mappingKey: "work:race", mappingGeneration: winner.mappingGeneration },
          })
        }
        await Promise.race([race(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("publication racers timed out")), 10_000)
        })])
      } finally {
        clearTimeout(timer)
        for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await Promise.all(workers.map((worker) => worker.exited))
        store.setSessionStoreBackendForTest(null)
        handle.close()
      }
    }
    expect(losers.busy + losers.cas).toBe(20)
    console.log(`SQLite dual-generation race: N=20, busy=${losers.busy}, false-CAS=${losers.cas}, winners=20`)
  } finally {
    store.setSessionStoreBackendForTest(null)
    store.setSessionStoreDir(null)
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
