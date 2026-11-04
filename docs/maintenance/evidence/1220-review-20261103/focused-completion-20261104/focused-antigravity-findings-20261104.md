# Focused Antigravity failure: minimal diagnostic handoff

Date: 2026-11-04

## READY and scope

**READY for parent-owned execution; no further test/source/helper edits will be made by this worker.** The parent has frozen the test at mode 0444, SHA256 `98a54d365ad3af4de83aa4ecac7a9d28c9d0b1b6183943302e0feec728783089`. This worker independently reread and verified the exact hash and one-line-only transformation.

Worktree: `/Users/rynfar/Library/Caches/meridian-validation.noindex/antigravity-focused-20261104`. Parent reports isolated maintainer branch from accepted main `16c21494`; candidate red originated at `ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a`. Git commands were not run by this worker. The parent owns the one selected original first case with `--timeout 30000`, its unchanged 70-second outer bound, and all execution/cleanup.

This is **test failure observability, not a production fix or an explanation of the historical 503**. The full-suite red remains recorded. No tests, builds, commands, helper execution, model requests, network calls, credential reads, commits or pushes were performed by this worker. The only edited existing file is the assigned idle test; this report is a new output.

## Exact test diff

```diff
--- a/src/__tests__/antigravity-idle-conversation.test.ts
+++ b/src/__tests__/antigravity-idle-conversation.test.ts
@@ -18,7 +18,7 @@
     closing.push(server.closeBackend)
     const send = async (body: unknown) => {
       const response = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
-      expect(response.status).toBe(200)
+      expect(response.status, await response.clone().text()).toBe(200)
       return await response.json() as { content: Array<{ type: string; text?: string }> }
     }
     const first = { model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: "SKIP_TOOLS hello" }] }
```

The unchanged expected status is 200. The message argument matches `antigravity-backend.test.ts:148` and reads a cloned response, leaving the original response for `response.json()`. It is the controlled synthetic-fixture response, not a real account/model diagnostic. As in the sibling pattern, the clone text is evaluated on successful responses too, but only appears as assertion failure context. Keep artifacts private until reviewed; a backend error string can contain interpreter/runtime diagnostics.

No fixture, interpreter selection, executable, argv, environment, original case body, `nap(400)`, retention/reuse assertions, 10,000 ms turn deadline, 20,000 ms probe deadline, or timeout/grace/retry constant changed. No preload, Proxy, spawn interception or helper framework was added.

## Source-backed localization and hypotheses

Read the complete idle test, fixture, `antigravityProbe.ts`, relevant runtime/account/close paths, `antigravityProcess.ts`, backend error mapping, sibling assertion pattern, static idle findings, prior #1504 probe findings and launcher reviews.

1. **A classified probe failure is plausible, but not established.** `antigravityProbe.ts:32–39` has a default 20,000 ms deadline and invokes `spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })`. Version has one attempt; configuration/models have two. `AntigravityRuntime.verifyAccountOnce():543–549` checks version before configuration. `probeFailed():536–541` maps non-cancelled `ProbeFailure` to a diagnostic 503. Historical 20,010 ms timing is compatible with first version-probe timeout but does not identify it. The new assertion body can reveal kind/reason/attempt/elapsed/deadline/exit/signal/outputBytes, or distinguish the generic backend 503 mapping (`antigravity.ts:20–22`).

2. **A pre-JavaScript shebang/loader stall is a concrete prior-host hypothesis, not this run's finding.** `agy-cli.cjs:1` is `#!/usr/bin/env node`; the version/configuration branches at `:9–15` return immediately and do not request a model. The idle test passes this executable path directly. Prior `/Volumes/DevSSD/meridian/review-1220-probe-findings.md` records a real original fixture child still identified as `/usr/bin/env`, with all 809 native samples at `_dyld_start +0` after 3.47 seconds, before env main/Node/fixture JavaScript. Its built-ins-only direct-script control timed out without fixture entry while explicit env/Node argv completed in 33–44 ms. That prior evidence localizes a Darwin/Bun executable-shebang boundary; it does not establish the underlying loader/security/Bun defect or prove the idle failure shares it. The #1504 launcher repair was restricted to its registered generated fixtures; it does not wrap `agy-cli.cjs`. No such hardening is authorized/applied here.

3. **Exit/pipe closure remains a separate possible delay.** `probeOnce` settles on `close`, not merely `exit` (`antigravityProbe.ts:64–76`), so elapsed timeout does not alone prove the child was still computing or that pipes were joined promptly. `signalAgProcess` sends to the actual detached POSIX process group (`antigravityProcess.ts:14–29`); runtime `closeOnce():674–681` aborts shutdown and awaits pending verification/checking/runs. Parent Bun process-group termination alone cannot prove these detached actors were reaped.

No local Bun/Darwin native spawn implementation source was supplied or immediately available. This review therefore reaches only the application `node:child_process.spawn`/detached-group boundary plus the preserved native sample. **The native launch defect remains unknown.** No account/Pro-plan attribution is supported; the implicated executable is fake CLI only. The rejected large preload design was read for constraints but not executed or revived.

## One discriminating next command, only if recurrence leaves a live actor

If a 503 recurs and the parent observes a still-live **original matching fixture child** during the stall or stuck original cleanup, retain its PID/process identity before signalling it and run once under the parent's bounded command ownership:

```sh
/usr/bin/sample <verified-original-fixture-pid> 1 10 -file /Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-idle-child.sample.txt
```

This samples for one second at 10 ms intervals. A fresh artifact path must be used; do not overwrite prior evidence. `/usr/bin/env` at `_dyld_start` would support pre-interpreter entry; a Node/runtime/JS stack would move the investigation past that boundary. It cannot prove which JS line ran. If the original probe already reaped the child by the time 503 appears, do not launch another test solely to obtain this sample: record that the witness is unavailable. A missing sample, exited PID, green first-case run, or parent actor exit does not establish cause or detached-child join.

Keep cleanup owned by the existing runtime/fixture `finally`. If it sticks, parent inspects then bounded-signals the verified original PID/group and records incomplete custody unless actual exit/close/reap is witnessed. No automatic assumption that killing the Bun actor joins detached children.

## Read source identities

These hashes cover the exact sources read, not a native runtime-source audit:

| Relative path | SHA256 |
| --- | --- |
| `src/__tests__/antigravity-idle-conversation.test.ts` | `98a54d365ad3af4de83aa4ecac7a9d28c9d0b1b6183943302e0feec728783089` |
| `src/proxy/backends/antigravityRuntime.ts` | `9459b719d6b7219619311905a3ac38eb0aab630e162de55b812ee1fd99199db5` |
| `src/proxy/backends/antigravityProbe.ts` | `cc34f458a529c7cfdb98ef81965222bc5706e79815330ead23d7c3ebf6aa1233` |
| `src/proxy/backends/antigravityProcess.ts` | `0c5eb50d5d27a350fcce00a9339ec2defa5fb2a57ca89f143003f7914d7e941e` |
| `src/__tests__/fixtures/agy-cli.cjs` | `16a72a01dfb315bf454b81a207f400472f1f067dada4dd7349ed7c5fe90ad9df` |
| `src/proxy/backends/antigravity.ts` | `dc245bf18012c4fffff84acf1910f78c60fedaedc20ce5e135d655075d839df1` |

## Assumptions and constants

Assumed the parent-supplied worktree and fake fixture are the intended scope. No constants changed. Parent-reported execution outcomes must be recorded separately; this report makes no passing test or fix claim.
