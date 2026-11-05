# One local Antigravity idle diagnostic — design review only

**Not READY to execute.** Parent must review, then make and verify a hash-named read-only helper copy. No helper, command, test, build, credential access, model call or network operation was executed during design.

## Exact scope

- Original source: `/Users/rynfar/Library/Caches/meridian-validation.noindex/1220-final-after-1505-20261104`; detached HEAD read directly: `ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a`.
- Run only `src/__tests__/antigravity-idle-conversation.test.ts`, unchanged. Do not use this preload with `npm test`, any other test, a hosted lock diagnostic, or a model/account diagnostic.
- Helper candidate: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/antigravity-local-preload.mjs`.
- SHA256: `e2efd77a20016f108b6dbdb9f80cfed6a51945303ad72fddcd4b76fa3b2c9306`.
- Manifest: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/design-manifest.json`. Original and proposed test hashes are identical: `0e856c9b393d2e712c7e09d23e78adb00f8a110763ac7655f304b740a2f01fe4`. There is no proposed new test file.
- No edits to project source, original test, fixture, other helpers, executable, argv, options, environment, spawn dispatch, account/model behavior, retries or production limits.
- Keep the original 20,000 ms probe default, 10,000 ms turn setting, 400 ms idle wait, all HTTP/retention assertions, and Bun `--timeout 30000`.

## Parent-owned preflight and execution

1. Review helper and this plan. Recheck source HEAD and every source hash in the manifest. Preserve the original red npm log.
2. Verify the exact test still pins the synthetic `agy-cli.cjs`. Audit this isolated test's existing local fixture path; do not change inherited environment, inject fixture switches, add credentials or configure models. This is not a real agy/account invocation. Existing fixture generation includes its original loopback MCP exchange; the helper adds no network or model calls.
3. Copy the candidate bytes to `antigravity-local-preload.e2efd77a20016f108b6dbdb9f80cfed6a51945303ad72fddcd4b76fa3b2c9306.mjs` in this design directory, set mode `0444`, and independently verify that filename/content SHA256 and mode. Do not edit the frozen file. Parent alone announces readiness after verification. Do not create `run-1.events.jsonl` in advance: helper opens it exclusively with mode `0600`; an existing file is an intentional stop, not permission to retry/overwrite.
4. Parent uses its own validated, bounded outer command/custody mechanism, preserving source cwd and inherited environment. Native command inside that bound:

   `bun test --preload ABSOLUTE_PARENT_FROZEN_HELPER --timeout 30000 /Users/rynfar/Library/Caches/meridian-validation.noindex/1220-final-after-1505-20261104/src/__tests__/antigravity-idle-conversation.test.ts`

   Proposed new *outer diagnostic* wall allowance: 180 s; then at most 5 s TERM grace and 10 s KILL/reap/pipe-join grace. These are not changes to any test/probe/turn limit. If parent cannot own the test actor, its command pipes and the original detached fixture groups through cleanup, **do not execute**. No polling retries and no rerun-until-green.
5. Keep the original command handle and output pipes under custody. Natural completion requires the test actor reaped, stdout/stderr EOF and closed, and every logged matching fixture joined. On an outer bound/hook timeout/crash, retain artifacts, terminate only still-owned test/fixture actors/groups, escalate within the cleanup bound, and join the original pipes. Killing the Bun actor alone is insufficient: fixture children are detached by the unchanged runtime. Never remove workspaces/fixtures/output or declare completion merely because a wrapper stopped. If any join cannot be proven within the bound, record incomplete custody and retain the red gate; do not claim success or keep waiting unboundedly.
6. Retain native command output, exit code, actual duration, parent custody/cleanup record, frozen helper hash/mode, source hashes, and `run-1.events.jsonl`. Do not delete the historical failing evidence.

## What the helper observes

- A path-exact `spyOn(node:child_process, 'spawn')` Proxy delegates exactly once with `Reflect.apply(target, receiver, args)`, passing the same original argument objects; it returns the same ChildProcess and rethrows the same synchronous error. Unmatched calls pass through untouched. No explicit Node launcher or environment/option/argv replacement exists.
- Exact metadata argv are retained only for version, configuration and models. Conversation logs contain a kind, argc and allowlisted **flag names only**; never a model/prompt/workspace argument value, stdin content, full environment, stdout/stderr content, or arbitrary argv.
- Matching child/pipe emitter Proxies record spawn/error/exit/close/end/finish facts and emitted stdout/stderr byte counts. They do not add `data` listeners, call read/resume, write input, signal children, or alter flowing mode. The original emit receiver/arguments/return are delegated exactly. Stdin close/finish is recorded; stdin bytes are intentionally **not** observed (`null`). Byte counts are emitted-data counts, not kernel byte counters or evidence of interpreter entry.
- A factory-export spy calls the original factory exactly once and returns the identical server object. Only a server with the exact fixture runtime gets an `app.fetch` Proxy. This backend is **not Hono**: it returns a plain `app: { fetch }`.
- Only original `POST http://local/v1/messages` requests are observed. Original fetch is called once with unchanged receiver/arguments. The identical original Promise is returned, resolving to the identical original Response. On non-200 only, an asynchronous `response.clone().text()` records the full failed body without consuming/replacing the original. Success bodies are not read. The original test assertion and cleanup stay untouched.
- `afterAll` waits for matching original child close plus pipe closure and pending body capture, without an internal timer or a new timeout parameter. Parent's outer bound owns a stuck join/read. The helper's added hook is diagnostic custody, not a production/test limit change. `actor-exit` is a final synchronous snapshot, not proof parent has reaped/joined the test actor's own pipes.
- No child-entry/interpreter witness is supplied: adding one would require fixture/environment/dispatch changes. A shebang was passed unchanged; actual interpreter entry remains unproven.

## Required interpretation and limits

- The targeted isolated run does not recreate the full npm suite's load order. A green result is **inconclusive** and does not explain the historical 503, validate capture of a failure body, fix anything or clear the final npm red gate.
- Preloading imports the backend earlier. Export/fetch/emitter identities change; synchronous sparse JSONL writes, counter updates, an added Promise reaction/clone tee, and the custody hook perturb scheduling. No claim of zero perturbation is made.
- Bun ESM-export/builtin spying and emitter coverage are only source-designed, not executed or verified here. A missing `preload-installed` / `factory-observed`, zero matching spawn/HTTP witnesses, any `captureErrors`, uncounted data events, missing joins, or missing `actor-exit` means instrumentation/custody is incomplete, not evidence that the original path did not execute. A fully green original test normally supplies three factory observations and six HTTP responses; this is a coverage expectation, not a replacement test assertion.
- Do not silently switch mechanisms or modify the fixture if interception fails. Stop, preserve the failed diagnostic, and request separate approval for a new diagnostic worktree containing only a failed-body observation line before the unchanged status assertion, plus a passive spawn preload. That fallback is not authored/applied here.

## Negative control that would verify capture (not authorized/executed here)

Separately exercise the exact fetch-observation plumbing with a local `Response` containing a distinctive 503 body, without a model/account or production-runtime change. Verify one underlying call, strict original Promise/Response identity, original `bodyUsed === false` before its own consumer, an exact captured clone body, and unchanged readable original body. A separate bounded local pipe control emitting known byte lengths and closing proves emitter interception, count accuracy, no forced flowing mode, and that close/pipe witnesses precede `fixture-joined`. A deliberate rejected fetch checks observer errors do not replace original rejection identity. Such controls would validate the observer, **not** reproduce the original Antigravity failure; they must not be injected into the one unchanged-test diagnostic or implemented using a fake available model/account.

## Assumptions and constants

The supplied source worktree is the intended immutable final validation source. Its original test, fixture, backend, runtime, probe and package hashes were read without commands; fixture mode was `0755`. No existing constant changed. New diagnostic constants are only the fixed source/fixture/output paths, an exclusive output file, safe metadata allowlist, and the proposed parent outer custody bounds above. No root-project worktree, helper or source file was edited.
