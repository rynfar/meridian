# Upstream review handoff

Checkpoint: 2026-09-10, after incorporating contributor PRs #1003, #980 and
#1005.
Refresh
GitHub and origin/main before continuing; this is a dated checkpoint, not a
live queue.
The owner requested portable skills and agent instructions so either Claude,
Codex, or another repository agent can resume this work.

## Read first

Follow [meridian-upstream-review](../../.agents/skills/meridian-upstream-review/SKILL.md)
and [AGENTS.md](../../AGENTS.md). The last delivered item is contributor PR
#1005, incorporated as #1012 and merged as `c3dc2279`. Before that: #980 as
#1010 (`3db622fa`), #1003 as #1004 (`7028c697`), issue #820
(PRs #994 and #995), the OpenCode V1 plugin packaging fix (#988) and a
race-harness deflake (#997), plus #996 — a regression in our own #983, found
while validating #820 and fixed in #998.

**1.69.0 is published.** The owner authorized it explicitly; PR #970 was merged
and the publication is verified below. Nothing is in progress and nothing is
held. A future release still needs its own explicit authorization — this one
does not carry forward.

An earlier version of this block said PR #977 was "green on everything and
held for owner review". That was already stale when it was written: #977 merged
at 2026-09-09T03:18Z as `03fe5716` and appears in #970's changelog. The claim
was carried forward from the previous checkpoint without being rechecked, which
is the specific failure the "Read first" instruction above warns about — refresh
live GitHub state, do not trust the dated text.

Continue when the owner asks; this document does not start background work or
authorize two agents to work the same queue. A prior agent's
paused/blocked goal is not a claim that the backlog is complete.

Keep this checkpoint current after a delivered ticket or meaningful pause.
Record the item, disposition, original/delivery/base SHAs, author mapping,
worktree/branch, before/after proof, tests and E2E versions, CI URLs, merge and
closure status, limitations, and the exact next action. Put portable evidence in
the PR or linked review record; optional private local logs are not prerequisites
for discovering the workflow. Never invent test evidence if those logs are absent.

## Standing instruction, 2026-09-10: file a ticket

The owner asked that anything flagged as a real problem needing a fix becomes a
GitHub issue, not a line in a PR body or a doc: "i cant keep up with all of
this." Applied retroactively to the V2 cold-start race as #1008. Observations
that need no fix stay observations; a "known limitation" note is not a ticket.

## Delivered: disabled subscription entitlement, contributor PR #1005 as #1012

**Item.** [PR #1005](https://github.com/rynfar/meridian/pull/1005) by
StanChmielewski — an org admin can switch Claude Code subscription access off;
the refusal named no limit and no payment method, so `classifyError` fell
through to `api_error`, `isAccountFailoverError` said no, and priority routing
kept selecting an account that could serve nothing.

**Disposition.** Accepted with one maintainer correction. Merged 2026-09-10 as
`c3dc2279` with `Co-authored-by: Stan Chmielewski <s.chmielewski@it-tower.pl>`.
Author mapping `06a44e2a` → `2b6681e5`, AuthorDate preserved; maintainer commit
`0560d4a7`. Base `3db622fa`, worktree
`/Users/rynfar/repos/meridian-wt/org-entitlement`. #1005 head rechecked as
`06a44e2a` immediately before merge, then auto-closed.

**Reproduced on main before changing anything**: `sdk result` → 500 `api_error`,
`stderr exit1` → **401 `authentication_error`**, `api 403` → 500 `api_error`,
all with `failover=false`. The 401 is the sharp edge — a bare code-1 exit reads
as an expired login, so the operator is told to run `claude login` for an
entitlement only an admin can restore.

**The maintainer correction, and the lesson.** The PR claimed to cover the
API-key/gateway shape with `API Error: 403 Your organization has disabled ...`.
That string is not what reaches `classifyError`. The CLI actually emits:

```
Claude Code returned an error result: Failed to authenticate. API Error: 403
Your organization has disabled Claude subscription access for Claude Code · ...
```

A bare `Failed to authenticate.` sits between the CLI's wrapper and the upstream
status. It ends in a period, so it is not one of the recognised colon-wrappers,
and the anchored pattern never reached the entitlement string — that path was
still `api_error` and still did not fail over. **A hand-written example of a
wire string is not the wire string.** It was found by driving a real refusal
through the failover harness, not by reading the report.

**Evidence.** Ten adversarial classification cases pass, including the negatives
`has not disabled`, a mid-line quote, `disabled MCP servers`, the authenticate
notice alone, and the notice before a different capability. Live E2E through the
#836/#829 error-telemetry harness with only the refusal fixture swapped to the
org-disabled message at HTTP 403: pinned 402 `billing_error` (streaming and not),
failover 200 from real Claude Max with the receipt, `PASS`. That harness FAILED
at the pinned assertion before the maintainer fix. Gates: `npm test` 3880 pass /
0 fail / 1 pre-existing skip, typecheck, build; CI green on all four checks.

**Limitation.** An actual org-disabled account could not be reproduced here; the
contributor's own run against one is the primary evidence for the real-world
shape, and the harness drives the refusal instead.

## Delivered: Polytoken harness adapter, contributor PR #980 as #1010

**Item.** [PR #980](https://github.com/rynfar/meridian/pull/980) by jakewimmer —
a native adapter for [Polytoken](https://polytoken.dev), an Anthropic-Messages
coding agent that owns its tool loop.

**Disposition.** Accepted in part. Merged 2026-09-10 as `3db622fa` with
`Co-authored-by: Jake Wimmer`. Base `fb06c924`, worktree
`/Users/rynfar/repos/meridian-wt/polytoken`. #980 head rechecked as `f185e76e`
before merge, then auto-closed. Author mapping, all AuthorDates preserved:
`68a0092e`→`6878e515`, `1bbf7a4b`→`64fc6e68`, `f22856f4`→`639af5e2`,
`9b7b21d4`→`dd84557e`, `0edf2c63`→`58518d61`, `76f30fa9`→`58e307a8`,
`acc0c661`→`2a878eea`. Maintainer commit `1dff13fd`.

**Three commits were split out**, all preserved with authorship on the pushed
branch `codex/polytoken-extras` — do not retype them:

- `f185e76e` uncaptured-tool recovery. The only commit that does not apply to
  current main; conflicts with #998's rework of the same early-stop region. The
  contributor states it is "default OFF until canaried" with non-streaming
  parity deferred. Tracked in **#1009**.
- `1b2ba3a9` recover visible empty capped streams, and `016eb53c` classify abort
  causes in `sdk_termination`. Both clean and green, held so each gets its own
  changelog line and its own gate; the first lands in the #983 → #996 → #998
  path. Tracked in **#1011**.

The contributor's reported "1 failed" full suite does not reproduce — that flake
was fixed by #997, now in the base.

**Maintainer correction: a gate anyone can run.** #980's E2E was a manual Docker
image swap plus a personal systemd unit and a budget gateway, driven by scripts
deliberately not committed, and it overshot its own request budget (14 against a
cap of 12). Replaced with this repository's existing mechanism: Polytoken added
to `scripts/e2e-client-detection.mjs` (honouring `E2E_POLYTOKEN_BIN`) with its
real 0.8.6 headers recorded in `client-headers.json`, so
`client-detection-fixtures` pins the adapter in CI and a client-side change is a
git diff. This is the #733 class of bug, and a PR whose detection keys on a UA
plus a native header is exactly what that fixture protects.
`x-polytoken-session` joined the redacted-value set, or every re-capture would
churn on a fresh session id.

**Evidence, live against the real client.** Polytoken 0.8.6 macos-arm64
(sha256 `71353a6d…0793e7`, verified against the published `SHA256SUMS.macos`),
installed to `/tmp/pt`, real Claude Max on `claude-haiku-4-5`, disposable
Meridian on port 3468. A `polytoken exec` client-owned read returned `LINES=4`
in **four** client round-trips, `adapter=polytoken` throughout, `lineage=new`
then `lineage=continuation` on a stable `x-polytoken-session`. The read ran on
the Polytoken side — the proxy's own workdir has no such fixture. Repeated with
`MERIDIAN_PASSTHROUGH=0`: identical, so the global setting cannot hand the loop
to the SDK. Detection controls: `PolytokenImpostor/1.0` → `opencode`, blank
header → `opencode`, valid header → `polytoken`, UA alone → `polytoken`.
Captured wire identity: `user-agent: Polytoken v0.8.6`, `x-polytoken-session`,
`accept: text/event-stream`. Gates 3871 pass / 0 fail / 1 skip, typecheck,
build; CI green.

**Behavior change to remember.** A valid `x-polytoken-session` now outranks
automatic adapter-instance match rules (#476). Explicit `x-meridian-agent` still
wins over both.

**Polytoken install, for the next run.** `https://get.polytoken.dev` shell
installer, or `https://dl.polytoken.dev/<version>/<platform>/polytoken.zip` with
`SHA256SUMS.<os>`. Config is `config.yaml` in `--config-dir`; a Meridian
provider needs `kind.type: custom_anthropic_compatible`, `protocol:
anthropic_messages`, `auth.type: static_key`, and a model entry with both
`provider` (instance name) and `provider_name` (wire id) plus a `class`.

## Delivered: OpenCode V2 model discovery, contributor PR #1003 as #1004

**Item.** [PR #1003](https://github.com/rynfar/meridian/pull/1003) by
martinmiglio — read Meridian's `/v1/models` from the V2 plugin and write the
result into OpenCode V2's model catalog.

**Disposition.** Accepted with maintainer corrections. Delivered as
[PR #1004](https://github.com/rynfar/meridian/pull/1004), squash-merged
2026-09-10T14:46Z as `7028c697` with
`Co-authored-by: Martin Miglio <marmig0404@gmail.com>`. #1003 auto-closed at the
same second; its head was still `a6657962`, rechecked immediately before merge,
so no later contributor work was discarded.

Base `a1f04df6`. Branch `codex/opencode-v2-model-discovery` (deleted on merge),
worktree `/Users/rynfar/repos/meridian-wt/v2-model-discovery`. Author mapping:
`a6657962` → `9a25b773`, Author and AuthorDate (2026-09-02) preserved.
Maintainer commits `b98de38f`, `50b16f3c`, `a63b27a2`.

**Half the PR was already on main.** #1003 also packaged the V2 plugin as a
directory package. #988 landed that first, byte-for-byte for
`plugin/meridian-v2/`, plus a generalized `scripts/package-opencode-plugins.mjs`
covering V1 too. #1003 branched from `1ea97d01` and predates it, which is why it
was `CONFLICTING`. That half was dropped as superseded during the cherry-pick.

**The discovery half did not work, in two independent ways.** Both were found
live against the pinned `opencode2 0.0.0-beta-18866`, not by reading the diff.

- V2's Anthropic provider carries the API version in its base URL, so
  `http://127.0.0.1:3466/v1` was turned into a request for `/v1/v1/models`. That
  path answers 404 and `/v1/models` answers 200, so the fetch always failed.
- The skip guard read `catalog.provider.get(id).models` and treated a hit as
  user configuration. Inside a transform that map is the assembled models.dev
  catalog, which already lists all nine models Meridian serves — so every model
  was skipped even once the URL was fixed.

**What made the second fix safe, and it is worth remembering.** V2 layers
`providers.<id>.models` on top of plugin transforms. Verified directly: a
configured `claude-opus-5` override (`name: "USER OVERRIDE"`, context 12345)
survived a transform that wrote a different name and context to the same model,
while a model the user had not configured took the transform's value. A plugin
can therefore write authoritative values without clobbering user overrides — the
opposite of what #1003 assumed.

That correction matters beyond the variants: beta-18866 advertises a 1M Sonnet,
while Meridian deliberately serves Sonnet at 200k so a long turn is not billed
as Extra Usage.

**Evidence.** Same isolated config, Meridian unreachable versus reachable:

```
unreachable (= the pre-fix result)
  claude-sonnet-5    ctx=1000000  ['none','low','medium','high','xhigh','max']
  claude-haiku-4-5   ctx=200000   ['high','max']
reachable, fix applied
  claude-sonnet-5    ctx=200000   ['low','medium','high','xhigh','max']
  claude-haiku-4-5   ctx=200000   ['low','medium','high','xhigh','max']
  claude-sonnet-4-5  ctx=1000000  ['high','max']   <- not served by Meridian, untouched
```

Live E2E: `opencode2 0.0.0-beta-18866` (installed to `/tmp/oc2pin`, not the
user's global `~/.local/bin/opencode2`, which had self-updated to 19242 and is
outside the supported set), Meridian from source on isolated port 3466 with an
isolated session store, isolated `OPENCODE_CONFIG_DIR` and all four `XDG_*`
dirs, real Claude Max (`max`, profile `work`). Through a logging tap in front of
the proxy, `--model 'anthropic/claude-haiku-4-5#xhigh'` produced
`POST /v1/messages?beta=true model=claude-haiku-4-5 effort="xhigh" stream=true`
→ 200, and Meridian logged `agent=primary model=haiku` with
`source=subagent-title` detached separately. Negative control with the base URL
on a dead port: catalog untouched, nothing logged as an error.

Gates at head `a63b27a2`: `npm test` 3803 pass / 0 fail / 1 pre-existing skip
(bun 1.3.14), `npm run typecheck`, `npm run build`. CI green on `test`, `smoke`,
`windows-smoke`, `build-push`; `changelog-duplication` skipped. Failed-before /
passed-after retained for both new plugin regressions.

**Known limitation, documented in `docs/agents.md` and accepted by the owner.**
Discovery cannot read the catalog until OpenCode has assembled it — awaiting
`context.catalog.provider.get()` inside `setup` deadlocks the server, confirmed
by a probe plugin that hung the process with no output. So the first request
against a freshly started server still sees the built-in entries, and naming a
Meridian-only variant there (`anthropic/claude-haiku-4-5#xhigh`) fails with
`provider.no-route`; the next request succeeds. Reproducible, not intermittent.
The TUI picker is unaffected because it renders after discovery lands.

No OpenCode release fixes this. `@opencode-ai/plugin@0.0.0-beta-19271`, the
newest published beta, still declares `Transform` with a synchronous callback
(`CatalogDraft` merely renamed to `CatalogEditor`) and still exposes no config
domain. Closing the race would need a persisted catalog cache seeded during
setup — a separate design decision, not started.

**Also fixed while validating this.** `docs/agents.md` documented a V1-shaped
provider block for the V2 section. V2 reads `providers` and `settings`;
`provider` and `options` are silently ignored, which points the client at the
real Anthropic API instead of Meridian. The base URL also needs its `/v1`
suffix. The same section listed only beta-18314 while
`SUPPORTED_OPENCODE_V2_VERSIONS` accepts 18866 as well.

**Next action.** None outstanding for this item. 1.69.0 is published and a
release for `7028c697` needs its own explicit authorization.

## Delivered: OpenCode Desktop cannot load the V1 plugin, PR #988

Maintainer-originated fix, not a contributor PR. Owner-reported: OpenCode
Desktop on macOS could not use Meridian after a normal `meridian setup`.

Base `d3bfe795`, branch `codex/ship-compiled-opencode-v1-plugin`, worktree
`/Users/rynfar/repos/meridian-wt/opencode-v1-compiled-plugin`, delivery commit
`12ae3f74`. Disposition: accept as maintainer fix. **Rebased onto `ac8bd6c2`
and revalidated before merge** (3775 pass / 1 skip / 0 fail on bun 1.3.11,
typecheck, build, tarball rebuilt); merged as `d075cc7c`. No external
contributor is involved, so no author mapping or co-author trailer applies.

Cause: `findPluginPath` returned `plugin/meridian.ts` for every install. The Bun
CLI loads TypeScript, but OpenCode Desktop (`ai.opencode.desktop` 1.18.23,
Electron 42 / Node 24) runs the OpenCode server in-process under Node and ships
no Bun binary; its native modules are Node-ABI. Node refuses type stripping
under node_modules, so an installed package wrote a path the desktop client
cannot import: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Relocating the
`.ts` does not help either — `plugin/meridian.ts` imports
`./priority-attestation` without an extension, which is `ERR_MODULE_NOT_FOUND`
under Node ESM. OpenCode's loader dynamic-imports the spec with no
transpile step.

**Correction to an earlier version of this note.** It said the loader
"resolves a file spec to `pathToFileURL(...)`" full stop. That is only true for
a FILE spec. For a directory it reads the directory's `package.json` and
imports its `main`: `resolvePathPluginTarget` returns the directory URL when a
`package.json` exists, `readPluginPackage` reads it, `resolvePackageEntrypoint`
takes `packageMain(pkg)` for kind `server`, and `resolvePackagePath` returns
`pathToFileURL(join(dir, main)).href`. Read out of the Desktop server bundle
(`app.asar` → `out/main/chunks/node-BOFfwe6w.js`). This matters: a probe that
imports the bare directory gets `ERR_UNSUPPORTED_DIR_IMPORT` and reports a
false failure for a plugin that actually loads. That happened here before the
loader was read.

### Verified against the desktop runtime

#988 was already green and validated live against the OpenCode 1.18.29 Bun CLI,
but carried a recorded limitation: "not yet exercised through the OpenCode
Desktop GUI". That is now closed without a click-through, and the method is
worth reusing.

**OpenCode Desktop runs its server in an Electron utility process, not a Bun
sidecar.** `app.asar` → `out/main/sidecar.js` takes a `process.parentPort`
message, `await import("./chunks/node-BOFfwe6w.js")`, then `Server.listen(...)`.
No spawned `opencode` binary, so the plugin is loaded by Electron's bundled
Node — which is the premise the PR rests on, now verified rather than assumed.

**How that server resolves a directory plugin**, read out of the same bundle:
`resolvePathPluginTarget` returns the directory URL when the directory has a
`package.json`; `readPluginPackage` reads it; `resolvePackageEntrypoint` takes
`packageMain(pkg)` for kind `server`; `resolvePackagePath` returns
`pathToFileURL(join(dir, main)).href`. So the shim's `"main": "./index.js"` is
precisely what makes `dist/meridian` importable — and a probe that imports the
bare directory reports a false `ERR_UNSUPPORTED_DIR_IMPORT`. Mine did, before I
read the loader. Read the loader.

Replicating that resolution against an installed tarball:

```
runtime node=22.22.3 electron=none            (plain Node)
  OLD (plugin/meridian.ts)   => FAILED: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  NEW (dist/meridian)        => LOADED via meridian/index.js, default is function: true

runtime node=24.15.0 electron=42.3.3          (OpenCode Desktop 1.18.30's server runtime)
  OLD (plugin/meridian.ts)   => FAILED: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  NEW (dist/meridian)        => LOADED via meridian/index.js, default is function: true
```

Rebased onto `ac8bd6c2` and revalidated: 3775 pass / 1 skip / 0 fail, typecheck
and build clean, tarball rebuilt.

Still open on that item: `isMeridianEntry`'s `endsWith("/meridian-v2")` is
POSIX-separator-only, so source-install detection on Windows is a pre-existing
gap, deliberately left out of scope.


Fix mirrors the existing V2 shape: `plugin/meridian/` shim package compiled to
`dist/meridian/`, `findPluginPath` mirroring `findV2PluginPath` (source keeps
source, installed selects compiled, fail closed), `MissingV1PluginError`,
shared `hasPluginPackageEntry`, generalized
`scripts/package-opencode-plugins.mjs`, and `node --check dist/meridian/index.js`
in postbuild. Detection still matches legacy `meridian.ts` entries so older
installs keep reporting configured.

Proof, from an independently packed and installed tarball:
old path `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, new path imports with a
function default. `meridian setup` from that installed CLI writes
`node_modules/@rynfar/meridian/dist/meridian`.

Live E2E: OpenCode 1.18.29, `claude-opus-4-6`, isolated proxy port 3466,
isolated `XDG_CONFIG_HOME` and workdir, plugin loaded from the installed
tarball. Returned the expected sentinel; proxy recorded
`agent=primary model=opus[1m]` and `agent=subagent model=haiku`, no pluginless
warning. Gates: `npm test` 3713 pass / 0 fail / 1 pre-existing skip, typecheck,
build. All PR #988 checks green at head `12ae3f74`, mergeState CLEAN.

NOT YET DONE — do not merge until this is closed: no run through the OpenCode
Desktop GUI itself. The desktop runtime constraint is proven by the Node import
reproduction, not by a click-through. The desktop app would not stay running
when launched from the agent shell (`Contents/MacOS/OpenCode` is a launcher stub
and `open -a` did not survive), and screen capture is unavailable, so this needs
the owner to launch the app and send one message while watching for
`agent=primary` in the proxy log.

Unrelated observations from the same session, not addressed here: the OpenCode
client stalls on a repeating design-MCP OAuth discovery loop against the proxy
(`/.well-known/oauth-*`, `POST /register` logged as UNHANDLED); and
`isMeridianEntry`'s `endsWith("/meridian-v2")` is POSIX-separator-only, so V2
source-install detection on Windows is a pre-existing gap.

## Delivered: issue #967 triage, delivered as PR #969

**Item.** [Issue #967](https://github.com/rynfar/meridian/issues/967) —
"Passthrough tool forwards are undeliverable for headless bg-job subagents →
compounding respawn loop", reported by filipporovelli against 1.68.0.

**Disposition.** Accepted in part, as a maintainer fix from triage. Triage found
a real and distinct Meridian defect that produces the reported symptom exactly,
and it is fixed in
[PR #969](https://github.com/rynfar/meridian/pull/969) (branch
`codex/fix-oc-prefixed-client-tools`, worktree
`/Users/rynfar/repos/meridian-wt/oc-prefixed-client-tools`). Base
`38c1db2b25de70be873f4b1b6436334566107bff`; delivery commits
`4646b932` (fix + tests), `8ec39e41` (E43 gate + E2E.md), `6823b687` (this
checkpoint) and `9447f8a7` (doubled-name hardening). No contributor commits exist for
this item, so there is no cherry-pick author mapping; the reporter is credited
in the PR body. **#967 is NOT resolved and must stay open** — see below.

**The defect that was fixed.** Client tools are registered inside Meridian's own
`oc` MCP server, so a client whose tool names already start with `mcp__oc__` —
a Claude Code CLI job with an `oc` MCP server configured, for instance —
collides with that namespace. Registration advertised
`mcp__oc__mcp__oc__read`, which SDK 0.2.141 / CLI 2.1.263 lists but never
dispatches: the PreToolUse hook never fired, nothing was captured
(`tools=0/1`), non-streaming returned HTTP 500, and streaming ended
`stop_reason: max_tokens` with an inline `error` event while leaking a tool_use
the blind reverse strip had renamed to `read`. Fixed by registering colliding
tools under a collision-free alias and reversing through an explicit map.
Ordinary tool sets alias to themselves, so model-visible names and the prompt
cache are unchanged. Only the exact `mcp__oc__` collision was affected; a
foreign `mcp__*` namespace was and remains fine.

**Two of the issue's inferences were refuted. Do not chase them again.**

- A nested SDK transcript terminating at the forward stub is the **designed
  steady state** of every passthrough tool step, on every client — not evidence
  of a stall. `PASSTHROUGH_DENY_REASON` has exactly one call site, inside
  Meridian's own PreToolUse hook, and is never sent to a client as a
  `tool_result`; Meridian then resumes the checkpoint with `forkSession`, so the
  denial branch is deliberately dead history. E41 already asserts the active
  fork holds exactly one real answer and zero denials per delivered call. The
  issue's "18 of 20 newest transcripts terminate at the forward stub" therefore
  describes Meridian's own nested sessions.
- The compounding "strict prefix-extension" replay is
  [#767](https://github.com/rynfar/meridian/issues/767)'s signature: a fresh
  replay opens a new SDK session, hence a new transcript that is a
  prefix-extension of the last.

  **This bullet originally claimed the trailing-block shape was still unfixed
  on main via `hasOnlyNewToolResults`. That was wrong.** That symbol no longer
  exists: `9d283288` (2026-09-04, shipped in 1.68.0, incorporating #872 with
  Serge Baranov's credit) replaced it with `appendedBlocksAreNew`, which
  permits non-`tool_result` blocks appended to a slot that is already a
  tool-result turn. Verified directly against main: `user[tool_result,text]`
  returns `continuation`, and a plain `user[text]` turn gaining appended text
  returns `diverged / modified-history` by deliberate design ("the user edited
  their own turn").

  **Process lesson worth more than the fact:** the error came from reading
  `src/proxy/session/lineage.ts` out of the owner's checkout, which sits on a
  divergent feature branch (`237acbf7`, not an ancestor of main), and then
  asserting it as main's state. Read source for a claim about main from a
  worktree on main, or via `git show origin/main:<path>`; `git log -S <symbol>`
  settles when a rule changed in seconds.

The respawn decision itself is above Meridian — the reporter's own job records
show `respawnFlags: []`.

**Validation.** `npm test` 3624 pass / 0 fail / 1 pre-existing skip;
`npm run typecheck` and `npm run build` clean. Failed-before/passed-after on the
same assertions: `src/__tests__/proxy-passthrough-oc-prefixed-tools.test.ts`
fails 6/8 on the parent commit (delivering `read` and `read_2` where
`mcp__oc__read` was declared) and passes 8/8 with the fix; the 2 that pass
either way are the no-regression controls. New **E43** live gate
(`scripts/e2e-passthrough-namespaced-tools.mjs`) passed all four combinations —
haiku and `claude-opus-5`, streaming and non-streaming, subject plus an ordinary
and a foreign-namespace control. **E41 all four modes** (chain/parallel ×
stream/non-stream) PASS. Post-fix live accounting shows `captured=1` and
`sdk_termination_recovered` where the same probe previously logged `tools=0/1`
with `envelope=open`. Versions: SDK 0.2.141, bundled Claude Code 2.1.259, system
CLI 2.1.263, OpenCode 1.18.29, Node v22.22.3, macOS arm64.

The Opus E43 runs were made before `9447f8a7`, which only changes names
carrying two or more leading copies of the prefix — a shape the gate does not
exercise and whose single-prefix behavior is byte-identical. E43 was re-run on
haiku in both modes after that commit and stayed green.

**Known limitations and next action.**

- Attribution of the reporter's incident to this defect is **not established**,
  and is now actively doubtful. `opencode-with-claude` 1.10.1 was unpacked from
  npm and checked rather than assumed: ~7.7 KB, one exported OpenCode `Plugin`,
  no `mcp__` strings, no MCP server registration, no `child_process`/`spawn`,
  no task/subagent bridging. It starts Meridian and resolves profiles. So it
  does not bridge subagents to bg jobs as the report assumes, and the `oc`-named
  MCP server in that environment is Meridian's own passthrough registration —
  meaning the transcripts sampled there are Meridian's nested sessions.
  Findings and a correction were posted to #967; nothing was asked of the
  reporter. Determining a contributor's environment is our job, not theirs.
- #967 stays open. Closing it needs both the attribution above and #767's
  replay driver.
- #893 (the `oc` namespace ignoring `getMcpServerName()`) stays open and is
  untouched. If it lands, `buildPassthroughToolAliases` and the
  `passthroughEarlyStop.ts` prefix mirror must follow the same value.
- A pre-existing gap deliberately left alone: `isClientForwardedToolUse` treats
  a bare `mcp__*` name as an internal SDK tool, so a foreign-namespace client
  tool would not arm the early-stop tracker if the SDK emitted its bare form.
  It does not today; the E43 foreign-namespace control passes in both modes.
**Merge and closure status (verified after the fact).** PR #969 reached green
final-head CI on `3a83560d2af620b92ec176eddead25e442c2b192` (`test`, `smoke`,
`windows-smoke`, `build-push` success; `changelog-duplication` skipped) and was
squash-merged with `--match-head-commit` on that verified head as
[`282cbb0b`](https://github.com/rynfar/meridian/commit/282cbb0bd314b935195dc40bc209acb07131dfe0).
The merged tree `b3a853a0830bc227bdbb47948672e00a4989a99d` is byte-identical to
the validated tree, the squash body is blank and the subject is the PR title, so
the `PR_TITLE` / `BLANK` settings are intact. Post-merge CI on main was green
across `test`, `smoke`, `windows-smoke`, `build-push`, `changelog-duplication`
and `release-please`, with `docker` and `publish` correctly skipped. The
delivery branch `codex/fix-oc-prefixed-client-tools` was deleted; the worktree
was retained.

**Issue #967 is OPEN and must stay open.** It was auto-closed on merge and then
reopened. Cause worth knowing before writing another PR body: that body's
limitation line paired a closing keyword with the issue number in order to deny
it, and GitHub's closing-keyword parser does not read negation — it linked that
as a closing reference. **Never put a closing keyword next to an issue number
in a PR body or commit message, even to deny it**; write "issue NNN stays open"
instead. This paragraph deliberately does not quote the offending phrase, since
a verbatim copy carries the same hazard wherever it is pasted. Verify with
`grep -niE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+'` before
merging. The bodies have been corrected.

**Two fresh data points for #917 / #933, both timeout expiries rather than
logic failures.** Collected incidentally: each appeared on a *docs-only* diff
that cannot influence it, which is what makes them clean observations.

| where | test | duration | mechanism |
|---|---|---|---|
| `windows-smoke` | `process-incarnation.test.ts:123` | 10265 ms | `WINDOWS_PROBE_TIMEOUT_MS` is 10 s. The `powershell.exe` probe in `src/proxy/session/processIncarnation.ts` exceeded it, so `captureProcessIncarnation()` **failed closed and returned `undefined`** — which is the module's documented behavior — while the test asserts the capture is always defined on win32. |
| `test` | `failover-request-id.test.ts:76` | 5002.97 ms | No explicit `it` timeout, so bun's default 5 s applied and expired. An assertion failure would not land on the default boundary to the millisecond. |

Both went green on a later run of the same tree, so they are intermittent, not
newly broken. #917 describes "concurrency tests fail fast, never the same one
twice" — a pool of tests with fixed time budgets on a contended runner produces
exactly that: whichever one is unlucky trips, so the name changes every time.

This is a **candidate mechanism for part of** #917 / #933, not a proof of all of
it, and no frequency has been measured. Two distinct sub-problems if picked up:

- The incarnation test asserts something the module may legitimately not
  provide. That is a genuine test defect and should be corrected by accepting a
  fail-closed capture, not by widening the probe timeout.
- The failover test simply lacks a CI-realistic timeout.

Resist the reflex to loosen assertions across the suite to make CI quiet; that
would mask the concurrency failures #917 is actually about. Start by measuring
which tests run closest to their budget.

**Release Please opened [PR #970](https://github.com/rynfar/meridian/pull/970)
(`chore(main): release meridian 1.68.1`) automatically.** It is NOT authorized
by this review and was not merged. A release needs the owner's explicit
authorization and the release reference in the skill.

**New lead found while landing this checkpoint: `windows-smoke` is
intermittently red for a characterizable reason.** On the checkpoint PR — a
docs-only diff that cannot influence it — `windows-smoke` failed at
`src/__tests__/process-incarnation.test.ts:123`, with
`captureProcessIncarnation()` returning `undefined` after **10265 ms**. That
duration is exactly `WINDOWS_PROBE_TIMEOUT_MS` (10 s) in
`src/proxy/session/processIncarnation.ts`, whose Windows path shells out to
`powershell.exe` via `spawnSync`. The test's own comment budgets "two cold
PowerShell probes at up to 10s each" under a 25 s test timeout.

So the module did what it is designed to do — fail closed when the host probe
is uncertain — while the test asserts the capture is *always* defined on
win32. On a cold or contended GitHub Windows runner the probe exceeds its
timeout and the assertion fails. This is a test-strictness problem, not a
proven product defect, and it is a concrete candidate mechanism for part of
#917 / #933 ("intermittent CI failures", "flaky ~1 in 3").

Scope and honesty limits: this is **one** observation, not a measured
frequency, and it does not explain the concurrency-test failures #917
describes. `windows-smoke` was green on `3a83560d` and on main's `282cbb0b`
immediately before, so it is intermittent rather than newly broken. No fix was
attempted here — that is a separate bounded item, and it should start by
reproducing the timeout rather than by loosening the assertion.

- **Next action:** the remaining issues, in this order of tractability —
  **#861** (auto-defer threshold invalidating the prompt cache mid-session:
  #975 turned auto-defer off for Codex only, the general case stands),
  **#889** (`extractClientCwd` parsing an `<env>` block a plugin may legally
  remove), **#865** (suppressing one startup log, small), then **#820** (pi
  adapter divergence, the highest user impact and the least diagnosed).
  **#895** has a contributor patch in PR #896 that cannot be validated here: a
  real Windows E2E is impossible on this macOS host, and POSIX fixtures are not
  a Windows run. **#769** and **#650** are feature/infra asks needing a product
  decision. Issues **#967** and **#767** are carried with their evidence
  recorded; neither reproduces on main from here. The 21 open `feat` PRs still
  need a product decision each.

## Investigated: #767 does not reproduce live on main

Ran the original report's own recipe against main (`a0ee33f2`) rather than
reasoning from code: real `opencode` 1.18.29 → real Meridian on an isolated
port, isolated `XDG_*`/config/session-store/project dirs, `claude-opus-5`,
genuine read/edit/write/bash tool use, one continuous session per config.

| config | plugins | turns | msgs | opus lineage | `Stale session detected` |
|---|---|---|---|---|---|
| stock | Meridian only | 12 | 49 | 24 continuation / 1 new | 0 |
| plugin stack | + oh-my-openagent, opencode-memory, opencode-worktree, opencode-history-search, openslimedit | 7 | 31 | 15 continuation / 1 new | 0 |

The lone `new` in each is that session's first turn. Zero divergence
diagnostics fired. Cache shape is inverted from the report's fresh-replay
signature — `cacheRead` climbs with the transcript while `cacheCreation` stays
in the low hundreds per turn:

```
stock         cacheCreation  31,199   cacheRead   367,589   ratio 11.8x
plugin stack  cacheCreation  95,707   cacheRead 1,630,777   ratio 17.0x
```

The plugin stack pinned ~67.6k of cache-read on turn one, close to the report's
~54.5k, which is the evidence the stack was genuinely loaded and shaping the
prompt rather than silently absent.

Consistent with `9d283288` (in 1.68.0) having addressed the mechanism:
connor-grady's captures were on 1.62.7, and four of their six were the
`user[tool_result,text]` shape that `appendedBlocksAreNew` now permits. It also
fits tetipong2542's own correction that Opus alone was 82% clean and the failure
required a plugin interaction.

**Do not read this as resolved.** Bounded by: session scale (49 and 31 messages
versus overlaps of 776–797 in the captures); agent profile (default agent, not
oh-my-openagent's "Sisyphus - ultraworker", which drives far longer reasoning);
`opencode-pty` and `opencode-quota` not installed; and one run per config, which
is not a measured rate. Evidence and these limits were posted to #767, which
stays open. Nothing was asked of the reporters — reproduction is our job.

Reproduce with: `/tmp/e767` (stock) and `/tmp/e767b` (plugin stack) harness
layout, Meridian on ports 3499 / 3498. Both are disposable; recreate from the
recipe rather than trusting leftover dirs.

## Delivered: the Codex contributor cluster (#962-#966), all by @justprosh

Five contributor PRs, each cherry-picked with Author/AuthorDate preserved, each
with a separate maintainer commit where live validation demanded one, and each
carrying an explicit `Co-authored-by` trailer in the squash body.

| original | integration | on main | disposition |
|---|---|---|---|
| #962 tier refusal ending in prose | #974 | `94e88cf0` | merged, original closed |
| #963 Codex auto-defer | #975 | `dabd969b` | merged, original closed |
| #964 namespace/custom tools | #976 | `907a00ee` | merged, original closed |
| #965 thread session identity | #977 | — | OPEN, held for owner review |
| #966 mid-conversation developer message | #978 | `4a031b97` | merged, original closed |

**Credit mechanics matter here and are easy to get wrong.** Repository settings
are `PR_TITLE` / `BLANK`, so a plain squash **drops the cherry-picked author
entirely**. Every merge above passed
`--body "Co-authored-by: Aleksey Proshutinskiy <alexey.prosh@fluence.one>"`.
Verify that trailer on the resulting commit; do not assume it appears.

The inverse error also happened once and was caught: a maintainer gate commit
created immediately after a multi-commit cherry-pick **inherited the
contributor's author line**. Falsely crediting a contributor for maintainer test
code is the same class of fault as dropping their credit. Check
`git log --format='%an'` over the series before pushing.

**Two contributor branches track a `node_modules` symlink** pointing at
`/Users/aleksei/dev/meridian/node_modules` (#963 `b9bca255`, #964 `432bead6`).
Both authors' own follow-up commits remove it, so their heads are clean, but
cherry-picking *through* the middle commit replaces a local install with a
dangling link. It happened once here. Only final commits were incorporated where
possible, and main is unaffected.

**Live validation added five gates**, all real proxy plus real SDK: E44
tier-refusal failover, E45 Codex auto-defer, E46 Codex namespace/MCP round-trip,
E47 Codex thread identity (on the #977 branch, not yet on main), E48 Responses
developer-note cache.

**Where live E2E changed the outcome rather than confirming it.** Twice:

- The #962 change was correct for the banner as quoted but insufficient for the
  deployment it was reported from. A gateway profile never delivers the banner
  bare — the SDK splices `API Error: 400` in front, and that numeric status
  defeated the line anchor for every suffix, including the two that already
  worked. `classifyError` returned 429 for the bare string while a live request
  still 500'd. A separate maintainer commit allows exactly three digits.
- A real Codex capture showed the #964 report was understated: the dropped
  namespaces include Codex's own `multi_agent_v1`, so sub-agents were
  unavailable, not only user MCP servers.

**Two of my own gates initially proved nothing and were corrected before
landing.** Recorded because the failure mode is seductive — a check that passes
both before and after looks like evidence. E45's digest-turn count passes either
way at probe scale, so it is reported rather than asserted. E48's first version
asserted cache hit percentage, which barely moves in a 6.5k probe even when the
prefix is re-written; the invariant is the ratio of re-written tokens, 7.8x
pre-fix against 1.2x after. Always confirm a new gate fails against pre-fix
code.

**Verifying contributor claims by capture rather than by reading.** codex-cli
0.153.4 was driven against a recording endpoint under an isolated `CODEX_HOME`
with a real stdio MCP server. That settled the tool shapes
(`{"function":10,"namespace":2,"web_search":1}`), the metadata schema, and the
critical safety property behind #965: for a user-driven thread `thread_id`
equals `prompt_cache_key`, so keying on the thread cannot re-anchor an existing
session. Reproduce with the recipe in E2E.md E46 and E47.

**PR #977 is held, not blocked.** Green on everything: 3665 tests, E47's nine
checks, E41 all four modes, and E46 still 8/8 alongside it. Two honest gaps: a
genuine `thread_source: subagent` request could not be produced locally
(`codex exec` offers `multi_agent_v1.spawn_agent` but does not spawn, so it needs
Codex Desktop), and two of E47's nine checks are guards rather than
discriminators. Its conflict resolution against #976 also merits a second
reader: both conflicting regions were purely additive and both blocks were kept.

## Delivered: issue sweep

Ten issues addressed, each proven live before merge. Eight are now closed, two
(#917 and #933) left open deliberately.

| issue | PR | on main | note |
|---|---|---|---|
| #886 lineage mismatch diagnostic | #981 | `c3ea178b` | closed |
| #874 `max_tokens` not enforced | #982 + #984 | `15529b12`, `14fc9395` | closed, opt-in |
| #893 `mcp__oc__` on every adapter | #983 | `99fc2d7a` | closed |
| #917 / #933 CI flakiness | #986 | `d3bfe795` | left OPEN |
| #906 `/health` lies | #985 | `264cfc3a` | closed |
| #905 container `hostId` | #987 | `b5f73aed` | closed |
| #861 auto-defer flip mid-session | #991 | `68c0eca6` | closed |
| #889 degraded fingerprint invisible | #992 | `824bbbfa` | closed |
| #865 startup banner under MERIDIAN_QUIET | #993 | `0e773b56` | closed |
| #842 + #847 first-turn 400 | none | none | closed on evidence, no code change |

**#842 and #847 were retired on evidence rather than code.** Five fresh
real-OpenCode sessions on current main: 0 client-side 400s, 0 proxy
`session_turn_conflict`, and a maximum `sessionWait` of **7 ms** against the
6360 ms the report measured. The title agent now runs as `agent=subagent` with
its own key, so the collision those reports describe cannot occur — the #845
agent-scoping work already handled them. Limit stated on both: haiku for primary
and small; an Opus primary could not be dispatched under the isolated config.

**Three new Docker-based gates**, which this repo had none of before. E51 (boot
identity) and E52 (host identity) reproduce failures that are properties of the
HOST and unreachable from a single process; both skip cleanly without Docker and
cost no tokens. `oven/bun:1-slim` ships with no `/etc/machine-id`, which is
issue #906's environment verbatim.

**Where proving it changed the answer rather than confirming it.** Three times:

- Issue #874: the SDK exposes no output cap at all, and the CLI's
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` **throws** instead of truncating. Wiring it
  naively converts a satisfiable request into a hard error. It works only
  because the API really stops generating first — probed at a cap of 64, the
  turn produced real text and *then* threw.
- Issue #874 again: enforcing it broke the E44 gate at `max_tokens: 128`,
  because the cap counts thinking plus text. An A/B against pre-change source
  confirmed the regression was mine, which is why it shipped **off by default**.
- Issue #906: the first revision refused to start on the first failed probe.
  That is right for Linux, where identity is read from files, but darwin and
  win32 derive it from a subprocess with a 10s budget — and a 10265 ms expiry
  was recorded on Windows CI during this very run. Refusing on a transient
  timeout would turn a slow host into a dead one, so startup retries three times
  first.

**Issues #917 and #933 stay open on purpose.** Two sightings were diagnosed and
corrected — both time-budget expiries, and `failover-request-id` measured at
**4.05 s against bun's 5 s default**. A scan of every I/O test without an
explicit timeout found no other single test near the boundary. But neither is a
concurrency test, and #917 is specifically about concurrency tests failing fast
and never the same one twice. **Do not widen timeouts across the suite** to
quiet CI: that would mask exactly what #917 is about.

**Gate quality discipline, because it bit repeatedly.** Four gates written this
session initially asserted something that passed both before and after the
change, which reads as evidence and is not:

- E45's digest-turn count (now reported, not asserted).
- E48's cache **hit percentage** — barely moves in a 6.5k probe; the invariant
  is the **ratio of re-written tokens**, 7.8x pre-change against 1.2x after.
- E49's default-off check used an absolute token threshold; now relative to the
  capped run.
- E44 asserted the model echoed a receipt verbatim and was flaky at ~1 in 3.
  Instrumented: the model complied once in five runs while the fallback answered
  every time. It now asserts the fallback produced text.

**Always confirm a new gate fails against pre-change source.** Every gate above
has its measured before/after recorded in E2E.md.

## Delivered: issue #820, both halves

**Item.** [Issue #820](https://github.com/rynfar/meridian/issues/820) — "pi
adapter: 99.8% of long conversations diverge to `lineage=new` with no
diagnostic", reported by @odfalik, with independent reproductions from
@RobertoNegro and a second adapter's case from @StanChmielewski, plus a
structural analysis of the missing diagnostics from @connor-grady.

**Disposition.** Accepted, delivered as two maintainer PRs. No contributor
commits existed, so there is no cherry-pick author mapping; all four are
credited in the PR bodies and three carry `Co-authored-by` trailers on the
diagnostic commit (their extension code ships in the docs, and the
request-line design is @connor-grady's proposal).

| PR | on main | what |
|---|---|---|
| [#994](https://github.com/rynfar/meridian/pull/994) | `ac8bd6c2` | every divergence names itself; the bypass advice; docs; gate E54 |
| [#995](https://github.com/rynfar/meridian/pull/995) | `7375351` | the gateway-fronted Claude Code exemption; gate E55 |

#994 was based on `0e773b56`; #995 was rebased forward twice as main moved and
merged from `d075cc7c`. Worktrees
`/Users/rynfar/repos/meridian-wt/lineage-divergence-reasons` and
`/Users/rynfar/repos/meridian-wt/passthrough-cc-session`; the before-code
baseline is `/Users/rynfar/repos/meridian-wt/divergence-reason-baseline`
(detached at `0e773b56` — do not delete, it is the failed-before evidence).

**#994 — the diagnostic half.** The request line now carries `diverged=<reason>`
on every divergence, and `independent-request` names which of its four rules
fired. `isIndependentSession` is *derived* from the new pure
`independentRequestCause` rather than computed beside it, so the printed label
cannot drift from the decision it explains. `classifyLineage` also names
`unverifiable`, `replayed-request` and `unrelated-history`; `not-found` stays on
the request line only, because it is the first turn of every conversation. The
headerless tool-result bypass warns once per process, matching the
degraded-fingerprint precedent.

`diverged=` is a separate field rather than a wider `lineage=` value on purpose:
`e2e-passthrough-turns.mjs` and field log analysis match
`lineage=<value> session=` as one unit, and a test pins that adjacency.

**#995 — the gateway half.** The tool-loop exemption follows the *client* now,
not the adapter: `adapterBase === "claude-code" || isClaudeCodeClient(c)`, where
`isClaudeCodeClient` reads `x-claude-code-session-id`. Behind LiteLLM the
passthrough heuristic claims the request first, so Claude Code lost the
exemption, and LiteLLM does not forward `x-litellm-session-id` upstream on the
`anthropic/` provider route, so it had no key either.

**The live gate changed this fix — read this before revisiting it.** The obvious
change was to read `x-claude-code-session-id` as a session key in
`passthroughAdapter.getSessionId`. That was built first, and the header is
genuine: verified against Claude Code 2.1.266 that it is the CLI session UUID,
pinned exactly by `--session-id`. Driving the **real CLI** showed it makes
auxiliary requests under the same session id, so two unrelated first messages
land under one key — `unrelated-history`, then `HTTP 400 This session advanced
while the request was waiting`. That converts a silent inefficiency into a hard
client failure. Two of E55's ten checks exist solely to guard that approach.
Suggestion 2 from the report (routing on the header in `detect.ts`) was declined:
it would swap tool handling, MCP naming and prompt shape for every existing
LiteLLM user and move their cache prefix.

**Evidence.** `npm test` 3765 pass / 1 skip / 0 fail for #994 and 3775 / 1 / 0
for #995, both on bun 1.3.11 to match CI; typecheck and build clean; E41 all
four modes on both; E54 and E55 pass. Failed-before runs are recorded in each PR
body with the exact assertion output.

**Gates added.** E54 `e2e-lineage-divergence-reason.mjs` — a real headerless pi
tool loop against the same loop with `x-session-affinity`, asserting that no
divergence is silent and that the remedy the log names works. It reproduces the
report's cache signature at probe scale: `cache_read` pinned at 5789 while the
conversation grows against 6562 → 6811 → 6919 when keyed, and a per-round
cache-write ratio of 6.5x-7.2x across three runs. E55
`e2e-passthrough-claude-code-session.mjs` — the **real Claude Code CLI** as the
client against a passthrough Meridian, skipping cleanly when `claude` is absent.

**Two things E54 taught that are not in the report.** A headerless passthrough
loop recovers through the durable checkpoint *exactly once*: the checkpoint
upgrade rewrites the lineage result but leaves the request independent, so the
end-of-turn store is skipped and the checkpoint never advances past the first
tool call. That explains the reporter's 10 continuations against 6,019 `new` at
1000+ messages. And the bypass cannot be safely relaxed to "resume when lineage
verification passes": several identical concurrent loops match at the prefix,
which is the collision the guard exists to prevent.

**Found while validating, and it was ours: [#996](https://github.com/rynfar/meridian/issues/996).**
The passthrough adapter never resumed a client-driven tool round even with a
session key it does read. Filed as an unexplained asymmetry, then diagnosed as
a regression from #983 and fixed — see its own section below. #820 is closed on
its own asks.

**Local environment note for whoever runs the suite next.** CI uses bun 1.3.11
(`oven-sh/setup-bun@v2`). Two test files are bun-version-sensitive and will
report false failures on other versions: `dependency-uri-resolution.test.ts`
fails 4 on bun 1.3.14, and `fix-bun-exports.test.ts` fails 1 on bun 1.4.2. Both
pass on 1.3.11 and on unmodified main. Match CI's version before attributing a
failure to a change.

## Delivered: #996, a regression from our own #983

**Item.** [#996](https://github.com/rynfar/meridian/issues/996), filed during
the #820 validation: the `passthrough` adapter never resumed a client-driven
tool round, even with the session key it reads. `pi` and `opencode` resumed the
identical shape.

**Disposition.** Accepted as a maintainer fix. Delivered in
[PR #998](https://github.com/rynfar/meridian/pull/998), merged `0538a98b`, worktree
`/Users/rynfar/repos/meridian-wt/early-stop-namespace`, base `7375351`. The
before-code baseline is `/Users/rynfar/repos/meridian-wt/pre-983-baseline`
(detached at `15529b12` — do not delete, it is the bisect evidence).

**Cause, and it is ours.** #983 gave each adapter its own passthrough
client-tool namespace, so the LiteLLM adapter registers client tools as
`mcp__litellm__*`. The early-stop tracker freezes the resume checkpoint and
arms by matching those names, but `noteAssistantMessage` called
`noteAssistantContent` **without a prefix parameter**, so it only ever matched
the default `mcp__oc__`. `server.ts` threads `clientToolPrefix` into the two
`isClientForwardedToolUse` sites and could not thread it here. On the
passthrough adapter nothing entered `expected`: no checkpoint UUID, no stored
`passthroughToolCallIds`, so `advancesDurableCheckpoint` could never fire.

`isClientForwardedToolUse` is strict about foreign `mcp__*` names by design,
which is what made the missed call site silent. #983's own test file pins the
hazard — `it("would reject that same tool under the default prefix")` — so the
assertion existed and a call site that trips it was still missed.

**Bisect, `pi` as the control:**

```
15529b12 (pre-#983)   pi 3/3 continuation   passthrough 3/3 continuation
96dc5605 (main)       pi 3/3 continuation   passthrough 0/3
with the fix          pi 3/3 continuation   passthrough 3/3 continuation
```

**Gate E56** drives an identical keyed tool loop on `pi`, `passthrough` and
`opencode`. Its load-bearing assertion is that all three **agree** on the
tool-round shape. That is the transferable lesson: a single-adapter gate passed
throughout this entire regression, because each adapter looks self-consistent
on its own. Anything that makes behaviour per-adapter needs a cross-adapter
gate, not a deeper one.

Six unit tests in `early-stop-namespace.test.ts` pin the threading; three of
them fail on `main`.

## Delivered: race-harness deflake (#997), and what #917/#933 still need

PR #995's `test` check failed on
`does not refuse the user's turn that queued behind an in-flight title turn`.
Causality was established before anything was changed: for a request carrying
`x-opencode-session` the new term in `isClientDrivenLoop` cannot alter the
decision, and **the same test had already failed on main** at `264cfc3a`
([run 34315620193](https://github.com/rynfar/meridian/actions/runs/34315620193)),
hours before that branch existed.

**The shape, now named.** Poll to a short wall-clock deadline, then assert on
what the poll observed. The title-lease harness gave the user's turn 100 ms to
traverse the route handler and then asserted a boolean, so a loaded runner
fails with `Expected: true, Received: false` and says nothing about timing. It
occurs three times, all fixed in #997:

| file | was | now |
|---|---|---|
| `opencode-title-agent-collision` | 100 ms poll | a signal from the SDK mock |
| `proxy-stream-deny-hold` | 1.5 s, then `toContain` | 5 s, timeout names itself |
| `concurrency-hardening` | 3 s, then `toEqual` | 5 s, timeout names itself |

Two controls were added and **verified by inverting them**, because raising a
ceiling from 100 ms to 10 s could otherwise make the assertion unfalsifiable: a
non-title prompt in the title lease scope (contends, must report `false`), and a
second title turn on one session (must not reach the SDK call while the first is
held).

**#917 and #933 stay open, deliberately.** The same CI run also failed
`Session tool cache > updates cached tools when client sends a new set`, which
has no timing bound at all — three sequential requests and an assertion that the
third inherits the cached tool set — so this diagnosis does not cover it, and it
did not reproduce locally. Run 34315145910 failed
`Extra usage required fallback > does not use exponential backoff`, also
unexplained. **Leave #917 and #933 open; #997 does not settle them.**

## Completed checkpoint: Meridian 1.69.0

[Meridian 1.69.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.69.0)
shipped through [release PR #970](https://github.com/rynfar/meridian/pull/970),
authorized explicitly by the owner. **Published and installed-package
validated** — not merely merged. Do not republish it.

| | |
|---|---|
| Candidate tree | `04f65101` ([CI success](https://github.com/rynfar/meridian/actions/runs/34394242824)) |
| Release PR head | `e52f453c`, merged with `--merge --match-head-commit` |
| Release/tag commit | `3d38f6987632cd798b092c4d1dd83231f8ea3280` |
| npm | `1.69.0`, `latest` → `1.69.0` |
| Tarball integrity | `sha512-4ZN4BR9lFMRqFjzWdldT2+Z4weaDJVZWLGov6nW0xJBvVU3yn+jFywGMzPAnsPvljvOhpbCvacja79/Ca82iKg==` |
| SLSA provenance | `gitCommit: 3d38f698…`, workflow `.github/workflows/release-please.yml`, subject `pkg:npm/@rynfar/meridian@1.69.0` |
| Docker | `1.69.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release workflows on `3d38f698` | CI, Release Please, Docker, Sync bun.nix — all success |

Provenance was verified by **content, not presence**: the attestation's
`resolvedDependencies.digest.gitCommit` equals the tag commit. An attestation
that merely exists says nothing about what was built.

**Gates run before the merge, all green.** `npm test` 3793 pass / 1 skip / 0
fail on bun 1.3.11; typecheck; build; E41 all four modes; E54; E55 three runs;
E56; **E42 live+extended against both pinned betas** (`0.0.0-beta-18314` and
`0.0.0-beta-18866`, each verifying its own version in-output because the beta
CLI can self-update); `e2e-opencode-package-integrity.mjs` with and without
`--manifest`.

E42 was required here for a non-obvious reason worth remembering: this release
looks V1-only, but #988 generalized `package-meridian-v2-plugin.mjs` into
`package-opencode-plugins.mjs`, which also emits the **V2** manifest. The
pinned betas had to be reinstalled because the gate's isolated installs live
under `/tmp`.

**Installed-package validation** drove the published tarball, not the source
tree: a clean `npm install @rynfar/meridian@1.69.0`, the installed CLI started
as a real subprocess, `/health` reporting `1.69.0`, and the keyed tool loop run
on all three adapters:

```
  PASS  pi           toolRounds=3 resumed=3
  PASS  passthrough  toolRounds=3 resumed=3
  PASS  opencode     toolRounds=3 resumed=3
```

`passthrough resumed=3` is the load-bearing line: it proves #998's fix is in
the shipped artifact. #983 introduced that regression during this same cycle,
so no released version ever carried it — which is why both entries appear in
one changelog.

**One gate had to be corrected mid-validation.** E55 was asserting pre-#998
behaviour and failed on correct behaviour; fixed in #1001 before the release
merge. The process miss: #998 changed the passthrough tool loop and only the
new gate (E56) was re-run, not the existing gates on the same path. Re-run
every gate that touches a changed path, not just the one written for it.

## Previous checkpoint: Meridian 1.68.0

[Meridian 1.68.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.68.0)
shipped through [release PR #937](https://github.com/rynfar/meridian/pull/937).
Its release/main commit at this checkpoint was
`58f8a70402fce471712cd4650f721afcb80f05d7`, tree
`427fbc82761e163d6fbf9621a8fb2e88ac260081`. Do not republish it.

- [Release Please, npm and semver Docker publication](https://github.com/rynfar/meridian/actions/runs/33998609223): successful.
- [Post-merge CI](https://github.com/rynfar/meridian/actions/runs/33998609125),
  [Docker latest](https://github.com/rynfar/meridian/actions/runs/33998609160) and
  [Nix builds/cache uploads](https://github.com/rynfar/meridian/actions/runs/33998609115): successful, including the formerly pending cache uploads (rechecked September 8).
- Recorded release validation: 3601 tests passed, one existing skip, no failures;
  typecheck/build; all four real E41 modes; installed-package OpenCode V1 and
  extended V2 flows; structured output and package-integrity gates; published
  package live V2; verified registry signatures and SLSA provenance matching the
  release commit. This is historical evidence for that candidate, not a substitute
  for tests on future changes.
- Frozen install used SDK0.2.141/Claude Code2.1.259; fresh npm package gates used
  SDK0.2.141/Claude Code2.1.261. Actual clients: V1 1.18.11 and V2 beta18866
  (extended live, separate working directories), plus beta18314 scripted package
  compatibility. Do not describe the beta18314 release check as extended live.

Last completed implementation: [#961](https://github.com/rynfar/meridian/pull/961),
merged `1ae1810dc2a24250c4a3f4d21546b03e56b9b388`, incorporating original #836 and
resolving #829. Original `57e3091c` retained as
`abd410192cfcb706c7649ce3e0f65f5fa73e6008` with Trevor Walker's author/date;
maintainer corrections `25b895a6ccb9e1182257bd3089d7b055d4085132`. The final tree
`19ecf09794f9545b93f5119af35255ab9fecd99d` matched the merge. Actual SDK billing
refusal/failover and account/model telemetry were verified in both response modes.
Original #836 and issue #829 are closed.

Immediately preceding it, [#960](https://github.com/rynfar/meridian/pull/960)
incorporated #868 and merged `6365ae0ed5445fbf6ea5c89055919570a7c76406`.
Actual V1/beta18866 idle retry bounds and recovery, beta18314 compatibility,
four E41 modes and full tests passed. Original #868 is closed.

Earlier delivered integration PRs in this review run: #938, #939, #940, #941,
#944, #945, #948, #949, #950, #952, #953, #954, #955, #956, #957, #958 and #959.
Inspect their final diffs and linked original PRs before redoing overlapping
work. In particular, #953 did **not** establish that #917/#933 were fixed.
The already-merged structured-output implementation #930 was validated and
released; original #898 was closed as superseded.

## Next item to triage on resumption

Live at this checkpoint: **9 open issues, 31 open PRs.** Refresh both; do not
act on these counts. #820 and #996 are both fully addressed and were closed
once #998 merged, so the live issue list should be shorter than this table.

| issue | state at this checkpoint |
|---|---|
| #996 passthrough never resumes a tool round | filed, bisected to our own #983, fixed in [#998](https://github.com/rynfar/meridian/pull/998), `0538a98b` |
| #917 / #933 CI flakiness | one mechanism removed in #997; two failures still unexplained. Do NOT close on #997 |
| #967 headless bg-job respawn loop | Meridian half fixed in #969; the rest needs the reporter's tool list |
| #895 Windows session GC | contributor PR #896 exists and **cannot be validated here** — no Windows host, and POSIX path fixtures are not a Windows run |
| #820 pi/gateway lineage | both halves delivered (#994, #995); remainder is #996 |
| #767 Opus resume divergence | investigated, does not reproduce live on main; evidence recorded above |
| #769 OpenClaw scrub plugin | feature proposal, needs a product decision |
| #650 plugin-input bumps | infrastructure proposal, needs a product decision |

**#917/#933 is the strongest remaining engineering item**, and it needs a
different approach from the one that has been tried. #997 removed one confirmed
mechanism; the two remaining failures
(`Session tool cache > updates cached tools when client sends a new set`, and
`Extra usage required fallback > does not use exponential backoff`) have no
timing bound and did not reproduce locally. Neither is a concurrency test in
the sense #917's title claims, which is itself worth noting: the issue's own
framing may be wrong. Consider capturing a failing CI run's full ordering
rather than reasoning from the assertion text.

**A caution from #996, which was our own regression.** Anything that makes
behaviour per-adapter needs a **cross-adapter** gate. A single-adapter gate
passed through that entire regression because each adapter looked
self-consistent on its own, and the defect was only visible as an asymmetry.

Roughly 21 of the open PRs are `feat` proposals, mostly from one contributor.
The owner asked to skip those during the issue sweep; each still needs a
per-PR product decision about whether the behavior is wanted before any
technical review is worth doing.

Pick one bounded item. Each is a report or proposal, **not a verified root
cause, a proven regression, or an approved implementation**. Reproduce with
bounded attempts and isolated fixtures, establish which component owns the
behavior, and validate the affected model/client versions — a passing Haiku run
neither disproves nor resolves an Opus report. Do not read private SDK
transcript files referenced in an issue; use supported APIs and controlled
reproduction.

### A closing keyword closed an issue this checkpoint was told to keep open

PR #997's body contained a sentence of the form "It does not `resolve` `#917`",
written specifically to say the issue stays open. GitHub's linked-issue parser
matches the keyword-then-number pattern and ignores the negation, so merging
merging #997 shut #917. #933 survived only because the second number in the
same sentence had no keyword in front of it. #917 has been reopened, the phrasing is
edited out of #997's body, and the issue carries a comment explaining that its
status did not change.

This is the second occurrence of the same hazard in this backlog — #969 shut #967 with a
"Does not `close` `#967`" line. The guard exists and was not applied at the
right moment: it had been run against issue comments and not against PR bodies.

**Before creating or merging any PR whose body discusses an issue it does not
fix**, grep the body for
`(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#[0-9]+`
and require zero hits. Prefer "issue NNN stays open"; never place the keyword
adjacent to a number, even inside a quotation documenting the hazard.

### Two environment facts that will otherwise cost an hour

**Match CI's bun version before attributing a test failure to a change.** CI
uses bun 1.3.11 (`oven-sh/setup-bun@v2`). Two files are bun-version-sensitive
and report false failures elsewhere: `dependency-uri-resolution.test.ts` fails
4 on bun 1.3.14, and `fix-bun-exports.test.ts` fails 1 on bun 1.4.2. Both pass
on 1.3.11 and on unmodified main.

**Commit as the repository's configured identity.** `main` has
`required_signatures` enabled. A commit authored under an email that is not on
the GitHub account verifies as `no_user`, and the merge is refused with "the
base branch policy prohibits the merge" with no mention of signatures. Use the
repo's `user.email`; do not substitute one from the environment.

## Restart safely

Fetch origin/main and refresh the selected PR/issue, its exact head and related
merged work. Preserve the user's current checkout; use a new isolated worktree
from current main. Existing worktrees may be completed deliveries or deliberate
before-code baselines. Do not reset or delete them on the assumption they are
abandoned. Verify current tool/client versions and use the current E2E.md.

Then work one bounded item through the skill: decide whether we want the behavior,
reproduce, retain contributor authorship, correct separately, run real affected-flow
E2E plus npm test/typecheck/build, inspect exact-head CI and finish only within the
owner's authorized scope. If the required model/platform/environment or product
decision is missing, record the precise blocker and leave that item incomplete.
