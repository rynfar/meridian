# Node hook fixture correction — read-only review

Reviewed 2026-11-04T08:15:25.642399+00:00 against current working bytes over committed head `5708dfd19062e4aff35d284e7971661fd11d8bf6`.

**Verdict: no material finding in this test-only correction.** This is a static verdict; parent-owned red/green and final gates remain required, with no new test barrier added here.

- Inspected complete fixture delta in `src/__tests__/antigravity-expansion.test.ts`; the pre-edit text matches the committed head's Git blob. The sole change is selecting `agHookCommand('node', file)` rather than the Bun test runner's `process.execPath`, plus structured output assertions.
- The fixture still goes through the real platform shell (`/bin/sh -c` or `cmd.exe /d /s /c`), retains the script/workspace path containing spaces, the unchanged 5,000 ms bound, cleanup, and Windows percent-expansion negative control. The `.cjs` probe now requires `HOOK_OK`, a Node version string, and `bun: null`; Bun also exposes a Node-compatible version, so the explicit Bun-null assertion is useful and prevents a Bun run from silently qualifying this Node fixture.
- Inspected `agHookCommand` in `antigravityProcess.ts` and its actual policy-hook use in `antigravityRuntime.ts:113`. Production still quotes `process.execPath` and the hook path. For the packaged Node runtime, selecting Node in this Bun-driven test matches the intended interpreter without changing production behavior. Both helper files are byte-identical to the existing owner checkout and outside the supplied final four-file product diff; no production fix is implied.
- Coverage is honestly bounded: literal `node` depends on Node being on the test environment's PATH; the runtime witness makes an incorrect interpreter visible. The executed path-with-spaces control remains the script path, not a newly space-containing Node executable path. Windows execution is not established by this read-only review.
- The reported prior local timeout (8,270 pass / 65 skip / 1 fail) is retained as the parent-supplied failed gate. This review does not establish that Bun caused it, reinterpret it as a pass, or attribute it to the explicit-model product change. Parent will preserve red/green evidence and rerun full final-head gates.
- Rechecked all four explicit-model product/test/spec SHA256 values: unchanged. The earlier narrow product-fit verdict remains unchanged. Requalification of the final installed actual OpenCode artifact and required final-head CI remain parent-owned.

Frozen inspected SHA256:

| Path | SHA256 |
|---|---|
| `src/__tests__/antigravity-expansion.test.ts` | `6965cf04631d64044c1608ff8f19331723e300f514bf5c01a0632d37958694ce` |
| `src/proxy/backends/antigravityProcess.ts` | `0c5eb50d5d27a350fcce00a9339ec2defa5fb2a57ca89f143003f7914d7e941e` |
| `src/proxy/backends/antigravityRuntime.ts` | `9459b719d6b7219619311905a3ac38eb0aab630e162de55b812ee1fd99199db5` |

No programs, tests, models, network calls, credential reads or source edits were performed by this reviewer. Only this report was written. Assumption: Node is the intended packaged interpreter and is available on the test PATH. The only changed test constant is executable selection from `process.execPath` to `node`; timeout and production constants are unchanged.

## Final fixture addendum (2026-11-04T08:16:00.133592+00:00)

**No material finding in the final frozen fixture.** The earlier literal-`node` snapshot above is superseded by `Bun.which('node')`, an explicit missing-Node error, and `agHookCommand(node, file)`. This resolves Node once to its executable path before shell invocation, retaining the real executable-path quoting boundary rather than relying on shell command lookup. The script path still contains spaces; no new executable-with-spaces or Windows execution claim is made. No resolver helper or production change is added. The five-second bounds, platform shell branches, structured interpreter witness, cleanup and percent negative are unchanged.

Final inspected test SHA256: `921f8d765b5ac60e8f2532e8835d72a35413bedbc9276d3b83ad870cf997900c`. The reviewer read the final bytes and verified this hash; no execution was performed.

Parent-reported focused discrimination: with the same structured witness but the original Bun executable, **5 pass / 1 fail**, with `bun: "1.3.14"`; with Node selection, **6 pass / 0 fail / 38 assertions**. This proves the interpreter distinction exercised by the assertion, not the cause of the earlier five-second/no-output failure; that earlier hang was not reproduced by this control. Final absolute-resolver head `19bf2128916c6aefc9e7128011bc9c201de27a07` has parent-reported focused **6 pass / 0 fail** and typecheck pass. Full suite and final-head CI are running under parent ownership. Full final-head verification and installed actual-client requalification remain the previously identified gates; no extra barrier is introduced.

The exact-pin product review remains unchanged. The updated test constant is interpreter selection from Bun's `process.execPath` to the resolved Node executable; timeout and production constants remain unchanged.
