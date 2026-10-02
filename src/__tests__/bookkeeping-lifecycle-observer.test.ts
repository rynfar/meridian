import { expect, it } from "bun:test"
import { fileURLToPath } from "node:url"

for (const mode of ["legacy", "sqlite"]) {
  it(`observes resource, lease, fence and counts without altering the ${mode} ledger`, async () => {
    const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)))
    const child = Bun.spawn([process.execPath, "--eval", `
      import assert from "node:assert/strict";
      import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { setupLifecycleBackend, teardownLifecycleBackend }
        from ${modulePath("./fixtures/bookkeeping-lifecycle-install.ts")};
      import { observeLifecycleState } from ${modulePath("./fixtures/bookkeeping-lifecycle-observer.ts")};
      import { prepareForkForPublication, acquireActiveTranscriptLease, attachActiveTranscriptExecutor,
        releaseActiveTranscriptLease, getTranscriptResourceKey }
        from ${modulePath("../proxy/sessionLifecycle.ts")};
      import { captureProcessIncarnation } from ${modulePath("../proxy/session/processIncarnation.ts")};
      import { withBookkeepingRead } from ${modulePath("../proxy/session/bookkeeping/database.ts")};
      const directory = mkdtempSync(join(tmpdir(), "lifecycle-observer-"));
      setupLifecycleBackend(directory);
      try {
        const options = { storeDir: directory, now: () => 1000 };
        const target = await prepareForkForPublication({ sessionId: "observed", configDir: directory }, options);
        const lease = await acquireActiveTranscriptLease([target], options);
        const owner = captureProcessIncarnation();
        assert.ok(owner);
        await attachActiveTranscriptExecutor(lease, owner, options, false);
        const key = getTranscriptResourceKey(target);
        const jsonPath = join(directory, "session-gc.json");
        const before = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : undefined;
        const snapshot = observeLifecycleState(directory);
        assert.equal(snapshot.resources[key].state, "prepared");
        assert.equal(snapshot.resources[key].generation, target.lifecycleGeneration);
        assert.equal(snapshot.resources[key].attempts, 0);
        assert.equal(snapshot.resources[key].nextAttemptAt, undefined);
        assert.deepEqual(snapshot.resources[key].activeLeases[lease.token], {
          token: lease.token, owner, executor: owner, executorRecoverable: false, createdAt: 1000,
        });
        assert.equal(Object.values(snapshot.resources[key].activeLeases).filter(l => l.purpose === "publication").length, 1);
        assert.equal(snapshot.fenceSlots[key.slice(0, 4)], Number(target.lifecycleGeneration.split(":").at(-1)));
        assert.equal(snapshot.counts["resources:prepared"], 1);
        assert.equal(snapshot.counts["resources:live"], 0);
        if (before !== undefined) {
          const persisted = JSON.parse(before);
          assert.deepEqual(snapshot.resources, persisted.resources);
          assert.deepEqual(snapshot.fenceSlots, persisted.meta.fenceSlots);
          assert.equal(readFileSync(jsonPath, "utf8"), before);
        } else {
          assert.equal(process.env.BOOKKEEPING_TEST_BACKEND, "sqlite");
          assert.equal(withBookkeepingRead(directory, r => r.get("SELECT count(*) AS n FROM resource_leases").n), 2);
          assert.equal(existsSync(jsonPath), false);
        }
        await releaseActiveTranscriptLease(lease, options);
        assert.equal(observeLifecycleState(directory).resources[key].activeLeases[lease.token], undefined);
      } finally { teardownLifecycleBackend(); rmSync(directory, { recursive: true, force: true }); }
    `], { env: { ...process.env, BOOKKEEPING_TEST_BACKEND: mode }, stdout: "pipe", stderr: "pipe" })
    const [output, errors, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ status, output, errors }).toEqual({ status: 0, output: "", errors: "" })
  }, 15_000)
}
