import { expect, it } from "bun:test"
import { fileURLToPath } from "node:url"

it("the SQLite lifecycle fixture joins store callbacks and closes both ports", async () => {
  const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)))
  const child = Bun.spawn([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { setupLifecycleBackend, teardownLifecycleBackend }
      from ${modulePath("./fixtures/bookkeeping-lifecycle-backend.ts")};
    import { prepareForkForPublication, publishPinnedTranscript, runGc }
      from ${modulePath("../proxy/sessionLifecycle.ts")};
    import { getSessionStoreDir, lookupSharedSession, storeSharedSession }
      from ${modulePath("../proxy/sessionStore.ts")};
    import { activeLifecycleBackend } from ${modulePath("../proxy/session/bookkeeping/lifecycleBackend.ts")};
    import { initializeSessionBookkeeping } from ${modulePath("../proxy/session/bookkeeping/database.ts")};
    const previous = getSessionStoreDir();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-fixture-")));
    try {
      for (const id of ["first", "second"]) {
        const directory = join(root, id);
        setupLifecycleBackend(directory);
        try {
          assert.equal(getSessionStoreDir(), directory);
          const options = { storeDir: directory, preparedGraceMs: 0, retiredGraceMs: 0 };
          const target = await prepareForkForPublication({ sessionId: id, configDir: root }, options);
          const published = await publishPinnedTranscript(target, () => storeSharedSession(
            id, id, 1, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, target), options);
          assert.ok(published);
          assert.equal(lookupSharedSession(id)?.claudeSessionId, id);
          let deleted = 0;
          await runGc([], { ...options, deleter: async () => { deleted++; } });
          assert.equal(deleted, 0);
          assert.equal(existsSync(join(directory, "sessions.json")), false);
          assert.equal(existsSync(join(directory, "session-gc.json")), false);
        } finally { teardownLifecycleBackend(); }
        assert.equal(activeLifecycleBackend(), undefined);
        assert.equal(getSessionStoreDir(), previous);
        const reopened = initializeSessionBookkeeping(directory);
        assert.equal(reopened.reader.get("SELECT count(*) AS n FROM mappings").n, 1);
        reopened.close();
      }
      console.log("fixture publication and teardown verified");
    } finally {
      teardownLifecycleBackend();
      rmSync(root, { recursive: true, force: true });
    }
  `], { env: { ...process.env, BOOKKEEPING_TEST_BACKEND: "sqlite" }, stdout: "pipe", stderr: "pipe" })
  const [output, errors, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect(status, errors).toBe(0)
  expect(output).toContain("fixture publication and teardown verified")
}, 15_000)
