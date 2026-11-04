# Antigravity idle-test failure: read-only source review

Date: 2026-11-04

## Verdict

**No source-backed production correction or required architectural fixture correction was established.** Keep the final `npm test` result red. Do not describe an explicit-Node fixture change as the proven fix for this run.

The smallest justified immediate change is **test failure observability**: retain the first failed HTTP response body alongside the existing status assertion. That can identify a classified probe failure on a later, deliberately instrumented run. It is not a correction to idle retention, process spawning, retries, or timeouts.

Explicit Node dispatch for this synthetic fixture is a coherent *conditional hardening option*, consistent with `antigravity-probe.test.ts`, but the checked source and retained log do not establish that dispatch was wrong in the failed run. Do not apply it merely to obtain green.

## Scope and custody

- Worktree: `/Users/rynfar/Library/Caches/meridian-validation.noindex/1220-final-after-1505-20261104`.
- Read `.git` worktree metadata directly: detached `HEAD` is `ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a`.
- Log: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/full-npm-test.log`.
- Read the full idle test, full `agy-cli.cjs`, all six source test files referencing it, runtime/probe/backend source, existing Antigravity probe tests, bookkeeping fixture support, and relevant native mock/PATH scopes.
- No shell commands, tests, builds, helper execution, credentials, model requests, network calls, or project edits were performed. This findings file is the only output written.
- Parent reports independent same-head typecheck and certified build passed; those results do not supersede the red suite.

## What the retained failure establishes

`full-npm-test.log:1089–1111` reports:

- The first idle-retention case expected HTTP 200 and received 503.
- Stack line 25 is `const reply = await send(first)`: the first user request failed, before the 400 ms idle wait or second turn.
- The test duration was **20,010.23 ms**. This is not an outer Bun test timeout. The npm command uses `--timeout 30000`.
- The response body was not printed. Neither probe kind nor failure reason, child runtime, output, exit/close facts, or argv were retained for this failure.
- Later idle cases passed, including the second at 11,750.81 ms. Their success supplies no explanation of the first failure.

`antigravityProbe.ts:20–35` uses one attempt for version, two for configuration/models, and a default 20,000 ms probe deadline. `antigravityRuntime.ts:536–549` maps non-cancelled `ProbeFailure` to a 503 containing output-free reason/attempt/deadline/exit diagnostics. **The elapsed duration is compatible with a version-probe timeout, not proof of one.** The backend also maps generic errors to 503 (`antigravity.ts:20–22`). The missing body prevents discrimination.

## Fixture and invocation findings

### Valid direct executable, not a Bun fixture

`src/__tests__/fixtures/agy-cli.cjs:1` is `#!/usr/bin/env node`; its observed file mode is 0755. It is CommonJS and uses Node built-ins plus global `fetch`. It does not import production TypeScript, SQLite, Bun APIs, or credentials. The idle test resolves its absolute path with `fileURLToPath` and passes it unchanged to `AntigravityRuntime` (`antigravity-idle-conversation.test.ts:9,16`).

The fixture answers `--version`, `models`, and `-p /config` before entering generation work (`agy-cli.cjs:9–15`). Stream-json generation reads stdin line by line and overrides the prompt derived from `-p` (`agy-cli.cjs:8,11–12,128–133`). `SKIP_TOOLS` bypasses tool calls but still uses the real local MCP listener. The two-turn fixture protocol matches the runtime's stream-json arguments, newline-delimited input, and retained stdin (`antigravityRuntime.ts:122–135,279`). No idle-path input/argv mismatch was found.

The runtime calls `spawn(executable, args, options)` directly for metadata and generation. Options preserve the real pipes, environment, POSIX process group, and Windows flags (`antigravityProbe.ts:37`; `antigravityRuntime.ts:131`). The fixture's shebang resolves `node` using inherited PATH. The source alone does not prove which interpreter actually ran, nor that an interpreter lookup stalled. Changing to `process.execPath` would be incorrect under Bun because that is Bun, not necessarily stock Node.

### Shared callers and existing helper boundary

The same fixture is referenced by:

- `antigravity-idle-conversation.test.ts`
- `antigravity-backend.test.ts`
- `antigravity-gaps.test.ts`
- `antigravity-replay.test.ts`
- `antigravity-responses.test.ts`
- `inflight.test.ts`

There is no existing shared explicit-Node launcher for `agy-cli.cjs`. A fix restricted to idle retention would leave the other direct callers unchanged; broad migration is not justified by one unexplained failure.

`antigravity-probe.test.ts:12–30` already resolves `Bun.which('node')` and installs a path-scoped `node:child_process.spawn` spy for *its own generated probe scripts*. It retains real children and passes options unchanged. Its unusable-shebang negative control (`:78–86`) proves that those tests do not depend on a generated script's shebang. The scoped set does **not** include `agy-cli.cjs`. This is a useful model for a future fixture hardening change, not evidence that this failed run launched Bun.

`fixtures/bookkeeping-support.ts:77–86` provides `buildNodeFixture` to bundle TypeScript bookkeeping fixtures for Node while keeping `libsql` external and providing module resolution. `withIdleWalReader` launches a real Node child and joins its actor and pipes. Those helpers solve a native-module/process fixture problem. This CJS agy fixture does not need a build or SQLite qualification. Reusing/generalizing the bookkeeping helper would add an unrelated layer.

## Process-global/mock review

No direct main-process `spawn` mock or leaked global PATH change was found that explains the idle failure:

- `models-auth-status.test.ts` does mock `child_process`, but the npm script excludes it from the main all-files invocation and runs it later in isolation.
- Native-refusal mocks in `sdk-native-boundary.test.ts`/`fixtures/sdk-native-trap.ts`, `profile-expiry-fields.test.ts`, and `login-deadline-persistence.test.ts` are installed in explicitly spawned worker processes, not the parent suite actor. The latter two files also appear later in the log.
- The Antigravity probe test's scoped spawn spy is restored in `afterEach`; that file appears much later in this retained log.
- The direct global PATH assignments found are in `claude-executable-resolver.test.ts` (try/finally restoration) and isolated `claude-executable-settings.test.ts`. The former is later in this log; the latter is excluded from the main invocation.
- No source test sets `NODE_OPTIONS`. The runtime copies the suite environment rather than pinning a fixture interpreter. The historical actor's external PATH/Node identity is still missing evidence.
- Fixture-specific account environment switches are either set on a particular runtime's copied `childEnv`, or saved and restored in `finally`; they do not establish contamination of this runtime.

This is a bounded static check, not proof that no runtime/load-order issue exists. A nearby prior Bun hang supplies no causal evidence for this failure.

## Smallest next change and discriminating proof

### Justified now: diagnostics only

Preserve the HTTP 200 assertion and all retention/reuse assertions, all existing waits, and all deadlines. On non-200, record the response body before the unchanged assertion throws. A diagnostic message such as `expect(response.status, await response.clone().text()).toBe(200)` already has precedent in `antigravity-backend.test.ts`; alternatively log the controlled fixture error body only on failure and leave the assertion line itself unchanged. Record no secrets or external process environment values.

Do not bypass `verifyAccount`, inject fake available models, cache account authorization, add retries, expand deadlines, or replace the real fixture process with a mocked result. None addresses an established defect here.

### Parent-owned bounded discrimination, not a green retry

1. Preserve the original red log and exact baseline SHA. Commit/identify any diagnostic change separately. If a helper is added, freeze a SHA256-named read-only copy before execution.
2. For one planned diagnostic run, passively capture only matching agy-fixture spawns while delegating to the original `spawn` with **unchanged** executable, argv and options. Record command/argv, elapsed time, stdout/stderr byte counts, error, exit, close, and pipe-close facts. Add a fixture-entry witness with PID, `process.execPath`, Node/Bun version fields and argv, written outside protocol stdout. Do not print full environment or prompt data.
3. Keep production 20 s probe and 10 s idle-test turn limits and the original suite budget unchanged. The parent should own the command, an explicit outer bound, and cleanup that retains custody until the original actor/pipes join. No unbounded pipe reads or repeated attempts until green.
4. The failure body distinguishes a classified version/configuration/model probe from a generic 503. Spawn and entry witnesses distinguish pre-entry/interpreter failure from a fixture that entered but did not complete, and exit from delayed pipe closure. A passing diagnostic run leaves the historical cause unresolved; do not promote it into a fix claim.
5. Only if that evidence establishes fixture interpreter/dispatch dependence, make a separate test-only hardening change using the existing path-scoped explicit-Node pattern. Restrict interception to the synthetic fixture, resolve stock Node explicitly, prepend the script to argv, and pass options unchanged. Keep production `AntigravityRuntime`/`readAgProbe` untouched. Prove the dispatch using an unusable-interpreter fixture copy and verify unrelated executable paths still delegate unchanged. Add generation/second-turn and original child-close witnesses, not merely version output. Then run affected tests and the final full gates once on the intended final head.

There is currently **no basis to claim this conditional hardening would fix the retained red**. The suite remains an explicit merge hold while independent package/live evidence proceeds.

## Assumptions and constants

The supplied worktree/log are the intended final validation artifacts; the worktree HEAD was independently read as above. No runtime constants, deadlines, assertions, source files, or environment settings were changed.
