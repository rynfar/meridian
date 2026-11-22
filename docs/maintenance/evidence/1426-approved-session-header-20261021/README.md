# Approved generic OpenAI conversation identity: #1426

Owner approval on 2026-10-21 is recorded in [tracking issue #1441](https://github.com/rynfar/meridian/issues/1441). The implementation remains Alex Gleason's own [PR #1426](https://github.com/rynfar/meridian/pull/1426), original signed source `337ccc9cb9264c84bdcf77a68862958aeff01d72`, current candidate `88dee56ab569520315cf3ee99920b1809e64574c`, reviewed against main `075e9e4736d3457e12dda1a0108531b9b5843e96`. No release is authorized here.

## Contract and adversarial findings

Generic OpenAI chat completions accept a nonblank `x-session-id` as conversation identity, distinct per chat. Existing resolved OpenCode/session-affinity keys and agent scoping take precedence. Blank values keep the headerless path. The adapter boundary resolves the alias; the internal hop preserves it. Existing append-only history, serialization, edit/fork and billed retry semantics apply. Other adapters, request-body fields, CORS and durable-store contracts are unchanged.

The complete introduced diff and callers were reviewed for conflicting headers, identity leakage, concurrent conversations, tool-result matching, retries and unchanged headerless behavior. The old adapter failed the new tests. Added HTTP controls cover independent keys, precedence, blank values, retries and existing browser preflight. A stale adapter comment and an untyped context fixture were corrected; owned HTTP fixtures join backend cleanup.

Hosted run 39622084321 on `f5abfe73` failed a process-wide capture spy assertion in an unrelated lifecycle test. The assertion now follows only the refused invocation with AsyncLocalStorage, retaining capture producers. A forced unrelated microtask fails the old assertion and passes the scoped assertion; forbidden synchronous and post-await captures both still fail at the capture assertion. The original CI producer stack was not retained, so its exact producer is not claimed. This reuses the maintainer's own earlier test-only correction `92222508`; no contributor async-writer implementation was copied. The older `337ccc9` CI failure observed an empty worker receipt; current main already includes atomic publication corrections `92aa60944`/`f923e9df3`. Historical scheduler interleavings are not claimed reproduced.

## Exact-head gates

- Final local `npm test`: **8,096 pass / 36 skip / 0 fail**, all **26** configured invocations, with pinned Bun1.4.3, patched SQLite3.53.4 and verified1.84.0 compatibility tar. Typecheck and build pass. R1 passed with27 opt-in compatibility skips; those27 subsequently passed separately and are enabled in the final full run.
- All eight executed hosted checks on `88dee56ab569520315cf3ee99920b1809e64574c` pass, including `test`; optional changelog check is skipped. Actual check URLs and signatures are in the archive.
- Initial targeted identity tests:78 pass. The scoped lifecycle file:18 pass. Five discriminating capture controls have expected results. One isolated invocation omitted the patched SQLite setting and was rejected before initialization; the configured run passes without a source change.

## Actual affected-flow proof

All **7** cases and **46** real generation forwards pass on Darwin arm64, SDK0.2.141 and explicit nativeCLI2.1.306 (SHA256 in the toolchain record). Node22.22.3 and Bun1.4.3 are arm64; the Python controller runs under x86_64. Installed dependency CLI2.1.296 was not the selected executable.

| Flow | Actual model | Assertions |
| --- | --- | --- |
| E41 chain/parallel × JSON/stream, four modes | Sonnet5.5 | Installed V1 client hook + scrub0.2.3 preflight and runtime witnesses; exact three call/result pairs, durable forks, unchanged parents, saved follow-up, ≥95% prior cached prefix and awaited clear/fresh-session control |
| Generic OpenAI `x-session-id`, JSON and stream | Haiku4.5 `claude-haiku-4-5-20251001` | Caller echoes actual tool IDs; three results appear exactly once; durable continuation, unchanged parents, ≥95% prior cached prefix, distinct-chat isolation and unchanged headerless packed control |
| Original E58 headerless tool loop and packed control | Same Haiku4.5 | All original cache/lineage assertions; ≥90% prior prompt reuse in loop, zero cache reads in packed controls, two observed unsettled-checkpoint resumes |

These are real SDK/provider HTTP protocol fixtures. E41 loads the installed OpenCode V1 plugin; it does not execute the OpenCode binary. The OpenAI fixture is a generic HTTP client, not the Shakespeare browser application. No Windows, other model, provider-pool exhaustion, held Opus diagnosis or independently installed package claim is inferred. Packaging/plugin installation behavior did not change.

Provider request/response IDs and canonical model annotations correlate with native events and supported SDK history where applicable. No private SDK transcript files were inspected. All child actors join, fixtures are removed, the access-only grant is removed, and the selected native binary is unchanged. The usage endpoint returned429; capacity stayed labelled unknown. Fresh metadata kept paid Extra Usage disabled; one explicitly bounded included-capacity account was used, with no refresh, owner credential write, account/model fallback or refusal retry. No provider refusal occurred. Older held failures remain held.

Live cases executed on `f5abfe73c5eac5a2cae9e53c1a3021bd751fad75`. The final candidate changes only the scoped lifecycle test; every runtime byte is identical. This equivalence and exact-head local/hosted gates qualify the final candidate without additional inference.

## Reproduction and artifacts

[Exact scripts, sanitized reports and logs](proof.tar.gz), [member hashes](manifest.json). Verify the archive SHA256, extract into an owned directory, and use a frozen checkout plus private access-only grant/admission files, isolated HOME/config, explicit native path and plugin preflight. `qualified-e41/run-e41.mjs`, `run-openai.mjs` and `run-e58.mjs` retain the actual assertions; their controller commands and sealed script hashes are included. Controllers are task-bound and name now-disposable paths; rebind owned paths and account admission deliberately before another run. Never blindly restart an old controller or infer an earlier held gate from these different cases.

The original user checkout and12 dirty hashes were preserved. Two bounded task checkouts share one dependency installation while #1440 proceeds; final cleanup is recorded separately. No task Docker resources were created. Merge/Author verification is a separate post-merge gate.
