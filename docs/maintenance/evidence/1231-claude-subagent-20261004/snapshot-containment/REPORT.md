# E72 snapshot containment correction

The unchanged harness at `f7b81ac0f0a840b5ca833780b7eb02958ae7e22d`
called `readFileSync` before rejecting nonregular or symlink grant inputs.
Its private-grant ownership, mode and link checks also occurred after the
content read. A FIFO input could consequently block the synchronous read
before a JavaScript deadline could run. No blocking FIFO was opened here.

The correction ports E71's metadata-first snapshot implementation. It rejects
nonregular inputs before opening them, verifies a grant's runtime UID, mode
0400 and single link before reading, opens with
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, and checks descriptor/path identity both
before and after the descriptor read. The identity includes device, inode,
ownership, mode, links, size, mtime and ctime. Source and private runtime grants
retain the grant predicate during subsequent invariance checks.

The same five new controls run the actual harness under a read-observing
preload with synthetic package, SDK and grants. The preload rejects every
network request before dispatch; a fresh empty child HOME contains no real
credentials. Each owned controller observes child `close`, with a bounded
wait and process-group kill/join on timeout. Existing test bodies and
assertions are byte-preserved.

| Control | Unchanged content-read attempts | Corrected attempts | Corrected result |
| --- | ---: | ---: | --- |
| Symlink | 1 | 0 | Reject before content read |
| Directory | 1 | 0 | Reject before content read |
| Hardlink | 2 | 0 | Reject before content read |
| Writable mode 0600 | 2 | 0 | Reject before content read |
| Private regular mode 0400 | 2 pathname reads | 2 descriptor reads | Zero-query rehearsal |

All five controls report zero network requests, SDK calls and generation
queries, acceptance false, joined children and successful private cleanup.
The valid grant exercises both the initial snapshot and cleanup invariance
read. Its recorded descriptor flags are checked against the runtime's actual
constant values rather than a platform-specific integer.

The focused before arm fails all five new tests (63 assertions). The corrected
arm passes all five (69 assertions). The complete focused harness file passes
27 tests with 913 assertions; 48 existing synthetic scenario receipts and a
second set of five snapshot receipts are retained. Original failure logs and
frozen before/after harness and test sources are retained as byte-checked gzip
archives. [The receipt](receipt.json) records source hashes, raw/archive hashes,
tool identities and results; [the manifest](verified-artifacts.json) covers
the evidence files. Run `python3 verify.py` from this directory to verify the
archives and current source against that receipt.

The focused commands, from the applicable isolated source checkout, are:

```sh
E72_SNAPSHOT_ESCROW_DIR=/owned/fresh-private-control-directory \
  bun test src/__tests__/claude-subagent-harness.test.ts \
  --test-name-pattern 'before any content read|through no-follow'
bun test src/__tests__/claude-subagent-harness.test.ts
node --check scripts/e2e-claude-code-subagent-session.mjs
git diff --check
```

To reproduce the before arm, use an isolated copy with the archived
`before-harness.mjs.gz` at its original script path and `control-test.ts.gz`
at its original test path. Use `after-harness.mjs.gz` for the corrected arm.
These controls require no repository dependency install, native SDK or grant.
Use a new escrow directory for each attempt; existing receipts are never
overwritten.

This proves the synthetic containment correction only. Production code,
E72 requested/classifier model semantics, native authentication and SDK calls
were unchanged. Full-suite/type/build/final-head CI, parent rebase and actual
Linux/client/model E72 acceptance remain open. No commit, rebase or push was
performed by this correction worker.
