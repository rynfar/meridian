# Meridian Pi extension: #1408

Accepted with maintainer corrections and merged as `bd021733deb054bbb95cacc0383fa816469e5773` (squash at verified head `388b05bbc3ca3c756ab9292d537ecdb2fc690272`, parent `9d94a3542f2e31edace685118d56e6e293feb4bd`). Git Author is Nate Berkopec, with a `Co-authored-by` trailer for the maintainer. Nate's signed original `33357ce4f794262e013ccb883a24071a28f4c929` and eight separate signed maintainer commits stay on his `feat/pi-extension` branch. They were added by fast-forward under maintainer edits; nothing was force-pushed. The merged tree is byte-identical to the validated head. [Post-merge receipt](POST-MERGE.json).

## Owner decisions

- The three public-contract additions requested in the PR are approved and recorded in `.agents/references/api-contract.md`: `pi1` on `x-meridian-opencode-turn`, `plugin.pi` in `/health`, and the `MERIDIAN_SOURCE` child-process convention.
- On this account, Claude refuses every Pi request through Meridian with an Extra Usage 402, including on unchanged main through the old `models.json` route. The owner chose to merge on live wire-identity evidence and record the generation gap, rather than enable paid Extra Usage.

## Maintainer corrections

1. **Side-call tier.** Side calls (compaction, branch summaries) sent `x-meridian-source: subagent-generate`, which selects the 200k subagent tier for Opus and Fable. A compaction request carries the history it summarizes, so a long 1M session could not compact. They now send `fork-side-call`: still independent of the conversation, never signed or promotable, but on the conversation's tier. A mocked-SDK test fails before and passes after (`opus[1m]`). The live harness shows the new header on the wire.
2. **Setup backup.** `meridian setup --client pi` deleted any existing `extensions/meridian`. A directory Meridian did not write is now moved to `meridian-extension-backup-*` beside `extensions/` and reported, including when a later setup step fails. Tests fail before and pass after.
3. **CLI and paths.** `--client=pi` is accepted, unknown or empty `--client` values are rejected, and a leading `~` in `PI_CODING_AGENT_DIR` is expanded as Pi does. CLI tests use a fake supported `pi`. The `=` cases fail before and pass after.
4. **Docs.**
   - Migration from the `models.json` setup. Bare model IDs are ambiguous in Pi 1.3 and newer; verified against real Pi.
   - Known limits, `E2E.md`, `ARCHITECTURE.md`, the API contract, and corrected warning and comment text.
   - The test `as any` was replaced with a typed `SystemMessage`.

## Adversarial reviews

Two independent reviewers were each given the code and the claims to falsify (the PR's claims, then the corrections' claims), not the maintainer's verdicts.

**First pass (contributor head).** It found the side-call tier, CLI, path and `as any` defects fixed above. Verified and recorded as known limits in `docs/agents.md` rather than changed:

- Messages injected by other extensions are signed as human turns.
- Forks of unsaved `--no-session` sessions are signed.
- Pi's `/bug` summary reuses the conversation's session ID (verified in Pi source).
- The forced `x-meridian-agent: pi` cannot select a custom Pi-based adapter instance.
- The print-mode catalog stays stale for up to seven days.
- Children on the base tier see the catalog's 1M window.

It also checked the pi-subagents markers against `pi-subagents@0.82.1`: `PI_SUBAGENT_CHILD === "1"` and a leading `<active_agent name=…/>` prompt are both real.

**Second pass (corrections).** It found no blocking defect. Its stale warning text, unreported backup on failure, wording, harness hygiene and PATH-dependent CLI-test findings were fixed in `388b05b`.

Recorded follow-ups, not changed here:
- A side call keyed apart from its conversation does not see that conversation's `[1m]` rate-limit pause. It costs one failed `[1m]` attempt before stripping.
- `antigravitySetup.ts` still resolves `PI_CODING_AGENT_DIR` without `~` expansion.
- OpenCode V2 still sends compaction as `subagent-compaction`, the 200k tier on Opus and Fable 1M. This needs an owner decision.
- Meridian treats a copy as its own by checking only `index.ts`, so files a user adds inside it are replaced.

## Live evidence

Darwin arm64, Bun 1.3.14, Node 22.22.3. Pi 1.4.0 (the global install) and Pi 1.3.0 (the dev pin) were each run through explicit wrappers, because a version manager picks a project-local Pi from the working directory.

| Gate | Head | Result |
| --- | --- | --- |
| `scripts/e2e-pi-extension-side-calls.mjs` (real Pi RPC, recording stub) | before tier fix | Pi 1.4.0 and 1.3.0: three prompts keyed by the Pi session, each with its own verified `pi1` turn; two compaction requests on fresh keys, unsigned, `subagent-generate` |
| same | `388b05b` | Pi 1.4.0 and 1.3.0: same, with compaction on `fork-side-call` |
| `scripts/e2e-pi-extension.mjs` (real Pi print mode, in-process Meridian, real Claude) | `33357ce` and `388b05b` | All identity assertions pass on Pi 1.4.0. Discovery returned 12 models. Meridian selected the `pi` adapter and recorded `subagent-e2e`. Primary attestations verify. All three generations (Haiku tool loop, child, Opus 5.5 at high effort) were refused with a 402 `billing_error` Extra Usage refusal. |
| Baselines | unchanged main `9d94a35` | Pi through the built-in `anthropic` provider was refused the same way. Plain `/v1/messages` (default and `x-meridian-agent: pi`) returned 200 OK. |
| Control | the owner's installed Meridian 1.79.0 | The same Pi request was not refused, but Pi's reply said it received no content. Unexplained and not investigated here. |

The refusal predates the extension, and the extension delegates request construction to Pi's own Anthropic implementation. Still unqualified on this account:
- generation;
- tool-loop and resume continuity;
- in-process pi-subagents;
- a live `next-user-turn` promotion (the mocked-SDK integration tests cover it).

## Local and hosted gates at `388b05b`

- `npm run typecheck` and `npm run build` pass.
- All 26 `npm test` invocations were run independently through `harness/run-groups.py`: **8,131 pass, 63 skip, 14 fail**. 25 groups pass.
- Group 0's 14 failures are SQLite bookkeeping tests that spawn real child processes, plus one claude-code cwd control. Bun here links system SQLite 3.51.0, and the child processes miss the 3.53.4 preload shim. The same 14 fail identically on unchanged main (`logs/main-compare.log`: 28 pass, 14 fail).
- All final-head hosted checks pass (12 pass, 2 skipped), including `test`.

## Release candidate

#1438 (1.86.0, head `49245d4e25901b3923707a5076ed2199f4557533`) was built, packed and installed into an isolated npm prefix. [Receipt](proof.tar.gz) at `reports/release-candidate-49245d4/rc-validation.json`. Tarball sha256: `6b46030af8625112064ae38309ad0b95f0311670bf8a7a1483353337b7f0f5cb`.

- The installed `meridian setup --client pi` copied byte-identical files and created the key with mode 0600.
- The installed server reported `version: 1.86.0` and `plugin.pi: configured`.
- A negative control (altered installed copy) produced the out-of-date startup warning, proving `dist/cli.js` finds the packaged `plugin/`.
- Pi 1.4.0 discovered all 12 models from the installed server, and a plain Haiku request returned 200.

## 1.86.0 release review (not published)

The owner authorized merging #1408 only. Publication still needs a separate owner decision. An independent adversarial review of `meridian-v1.85.0..bd021733d` plus #1438 recommends publishing once the candidate's own CI is green:

- **Code, packaging, changelog:** no defect found.
- **Candidate CI:** the Release Please head's workflows were waiting at `action_required` and have been approved; their results are tracked on #1438.
- **#1426 upgrade note:** a generic `/v1/chat/completions` client that already sends `x-session-id` now gets strict per-conversation rules (owner-approved in #1441, documented in `docs/configuration.md`). Clients that reuse one ID across parallel calls queue, or get a 400 for the losing call. The release notes should warn existing users.
- **#1436:** publication is pinned to Bun 1.4.3 while `packageManager` still says 1.3.11. 1.85.0 was already published from the same pinned job, so 1.86.0 does not change the bundler compared with npm `latest`.
- **Desktop Mac signing/notarization:** still fails on missing secrets, as before. It is separate from npm and Docker publication.

The reviewer's own 1.4.3-built tarball install also ran `meridian setup --client pi` from the installed `dist/cli.js`. The maintainer's tarball above was built with Bun 1.3.14. Remaining publication gates: green candidate CI, then after publication verify npm version/latest/integrity/provenance, a fresh registry install with the Pi setup and discovery flow, and Docker tags.

## Artifacts

[proof.tar.gz](proof.tar.gz) holds the baseline/stub/runner harnesses, the SQLite test shim, reports per head, and logs. Its archive and member hashes are in [manifest.json](manifest.json). The committed harnesses are `scripts/e2e-pi-extension.mjs` and `scripts/e2e-pi-extension-side-calls.mjs`. No credentials, transcripts or private SDK files are included.
