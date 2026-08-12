# Prime Agent support in Meridian

**Date:** 2026-08-12
**Status:** approved, in implementation
**Scope:** interactive sessions, RLM recursive subagents, and daemon/cron mode

## What Prime Agent is

`prime-agent` (npm, v0.7.2 at time of writing) is a **fork of Pi**, not Pi. Its
dependencies are `@earendil-works/pi-agent-core`, `pi-ai` and `pi-tui` —
republished Pi packages — and its `package.json` carries
`piConfig: { name: "prime-agent", configDir: ".prime/agent" }`.

The transport layer is Pi's, unchanged: the official `@anthropic-ai/sdk`,
`stream: true` on every request, and the same OAuth-vs-API-key client branch.

Everything above the transport is different, and that is what this design has to
account for.

### Measured, not assumed

The facts below came from capturing prime-agent's real traffic against a local
recording server (`/tmp/prime-probe/mock-anthropic.mjs`) — no tokens spent, no
account touched.

| Fact | Value |
|---|---|
| User-Agent (API-key mode) | `Anthropic/JS 0.91.1` — **not** `claude-cli/` |
| Session header | none |
| `metadata` on the wire | absent by default |
| Tools offered | exactly one: `ipython` (`{ code: string }`) |
| System prompt | ~17 KB, one text block |
| First line | `You are a general purpose agent that uses code to solve tasks.` |
| CWD line | `Working directory: <cwd>` (line 5) — **no** `Current` prefix |

The `Current working directory:` form does exist, but only in the
`customPrompt` branch of `buildSystemPrompt`, where it is appended near the end
after project context files. The default RLM prompt uses `Working directory:`
near the top.

## Decisions

### 1. Its own `prime` adapter, not a Pi instance or a widened Pi adapter

Reusing Pi would inherit two concrete defects:

- **CWD.** `extractPiCwd` matches `/Current working directory:/`. On
  prime-agent's default prompt that returns `undefined`, losing per-project
  fingerprint bucketing and the SDK subprocess chdir.
- **Tools.** The Pi adapter assumes `read/write/edit/bash/glob/grep`.
  prime-agent offers exactly one tool, `ipython`.

Widening the Pi adapter to cover both was rejected: it conflates two harnesses
under one name, gives prime-agent no row in `/settings` or the supported-harness
table, silently changes Pi's behaviour, and leaves future divergence between the
fork and upstream nowhere to live.

### 2. CWD parsing must be line-anchored

Prefer `Current working directory:` when present, else the **first**
line-anchored `Working directory:`.

Line anchoring is not cosmetic. The captured prompt contains, in prose:

> ... use kernel-level equivalents that survive across calls: `%cd <dir>` for the
> working directory and ...

An unanchored match would pick that up. The regex must require start-of-line.

### 3. File-change extraction covers `ipython`, and admits its limit

The only default tool is `ipython`, whose input is a Python/`%%bash` cell. The
adapter extracts:

- `%%bash` cell bodies, routed through the existing `extractFileChangesFromBash`
- `await edit(path=...)` calls, prime-agent's documented targeted-edit skill
- `bash` and `edit` as first-class tools, for users who enable them via `-t`

It deliberately does **not** attempt to parse arbitrary Python writes
(`open(path, "w").write(...)`, `pathlib.Path.write_text`, library calls). A
fragile parser that silently half-works is worse than a documented gap, and file
tracking is a reporting nicety here, not a correctness requirement. The gap goes
in the docs.

### 4. No User-Agent detection

In API-key mode prime-agent sends `Anthropic/JS <version>`, which every other
`@anthropic-ai/sdk` client also sends. A User-Agent rule would misroute
unrelated traffic. Selection is via `x-meridian-agent: prime` (set in the
provider config) or `MERIDIAN_DEFAULT_AGENT=prime`.

The existing `claude-cli/` env-var tiebreaker in `detectAdapter` already covers
the case where prime-agent is run with an OAuth token, since that branch sets
`user-agent: claude-cli/<version>`.

### 5. `codeSystemPrompt: false` by default

prime-agent ships ~17 KB of its own harness doctrine — RLM control semantics,
subagent delegation guidance, continual-harness state. Layering Claude Code's
~28 KB preset on top duplicates and contradicts it. Same rationale as
`codex`, `jcode` and `cherry`.

**Confirmed by measurement, 2026-08-13.** Six multi-round `ipython` loops per
arm, driven through Meridian with the real captured Prime Agent prompt and its
real single-tool schema, cells executed locally. Both arms scored identically on
what matters: every run called only `ipython`, ran all three requested steps in
order, and finished. The preset bought nothing measurable, so OFF stays — same
behaviour, ~28KB less prompt per request.

One caveat recorded rather than buried: most samples in *both* arms re-ran the
final cell before answering. Because it appears equally with the preset on, it
is a property of the task and model, not of this setting — but it is why the
strict "no duplicate cells" score was 1/6 and 2/6 rather than 6/6.

### 6. Session identity comes from the client, and needs no core change

This is the load-bearing decision for subagents and daemon mode.

prime-agent sends no session header and no `metadata`. Under passthrough every
tool round ends in `user[tool_result]`, which trips Meridian's
`isClientDrivenLoop` bypass (`src/proxy/server.ts:1108`):

```ts
const isClientDrivenLoop = adapterBase !== "claude-code" && !agentSessionId && lastIsToolResult
```

Those requests get no fingerprint resume and no cache write — a fresh SDK
session every tool round.

**Measured.** A 19-round tool loop with no session key logged `lineage=new
session=new` on every round, confirming the bypass fires for Prime Agent
traffic exactly as predicted.

**Why it matters — correctness, not just cost.** On a fresh (non-resume)
session Meridian sends the whole conversation (`server.ts:1291`) but flattens
it, and `flattenAssistantContent` (`server.ts:211`) drops every assistant
`tool_use` block by design (#111, #386). The model then sees tool *results*
with no record of having made the calls — the failure the comment at
`server.ts:232` names directly (#552). Observed live: asked to run three
distinct cells, the model called `2+2`, received `4`, and called `2+2` again,
seven times over.

Declaring a session key removes the whole class of problem, because a resumed
session sends only new messages and the SDK keeps the real `tool_use` blocks in
its own state. Proven with a deterministic two-turn A/B against Meridian:

| | turn 1 | turn 2 (ends in `tool_result`) |
|---|---|---|
| with `metadata.user_id` | `lineage=new session=new` | `lineage=continuation session=8d6857de` |
| without | `lineage=new session=new` | `lineage=new session=new` |

**Not measured.** #734 attributes prompt-cache decay to this shape, and an
earlier draft of this document asserted the same. That consequence was *not*
reproduced: `cache_read` sat flat at 7k across all 19 rounds while the
conversation grew to 37 messages, which is consistent with a static-prefix
floor but indistinguishable from "the conversation was too small to cache" —
the tool results in the probe were single digits. Establishing the cost claim
needs a run with substantial content in context. Until then the session churn
is the fact, and the cost consequence is reported-but-unverified at this scale.

**The bypass is correct and stays.** N concurrent RLM children, all headerless,
would otherwise collide on one `(firstUserMessage, cwd)` fingerprint and resume
each other's sessions. The fix is to give prime-agent a real session key, not to
weaken the guard.

The Pi adapter already reads `metadata.user_id` via
`extractClaudeCodeSessionId` (`adapters/claudecode.ts:55`), which accepts an
object or a JSON string carrying a non-empty `session_id`. The `prime` adapter
uses the same precedence: `x-session-affinity ?? extractClaudeCodeSessionId`.

Client side, a prime-agent extension supplies the key. **Verified working:**
`ctx.sessionManager.getSessionId()` returns a UUID (present even for
`--no-session` in-memory sessions), and a `before_provider_request` handler that
returns a modified payload puts it on the wire in exactly the expected shape:

```json
{"metadata": {"user_id": "{\"session_id\":\"019ff7d6-34fd-74cc-88fb-089a483a9f2d\"}"}}
```

`before_provider_request` rewrites the payload, not transport headers, which is
why `metadata` is the route rather than `x-session-affinity`.

### 7. The connection config registers a new provider, never overrides `anthropic`

```ts
pi.registerProvider("meridian", {
  name: "Meridian (Claude Max)",
  baseUrl: "http://127.0.0.1:3456",
  apiKey: "MERIDIAN_API_KEY",
  api: "anthropic-messages",
  headers: { "x-meridian-agent": "prime" },
  models: [ /* claude-opus-5, ... */ ],
})
```

Registering a *new* provider means nothing changes until a model is selected, so
an already-running prime-agent is unaffected by installing it.

## Scrub

**`pi-scrub` does not apply.** Proven, not inferred: run against the captured
17,227-byte prompt it returns a byte-identical string. Its two regexes target
Pi's `operating inside pi, a coding agent harness` identity line and its
`Pi documentation` block, neither of which exists in prime-agent's prompt.

Whether prime-agent needs a scrub *at all* is an open empirical question,
answered the same way OpenClaw was: capture the real prompt, establish a
negative control, replay section-by-section against a Max account, and identify
which sections — if any — trip `400 You're out of extra usage` on their own.

Prior suspicion, explicitly held as suspicion and not as a finding: the RLM
prompt is dense with the autonomous-bot shape that tripped OpenClaw — recursive
spawning, agent-to-agent messaging, scheduling, and literal
"this Prime Agent session" brand tells.

Outcome is one of: a new public `meridian-plugin-prime-scrub` repo (content-scoped
like `pi-scrub`, so it fires even when prime-agent traffic lands on another
adapter), or nothing.

**Measured 2026-08-14: nothing.** With `codeSystemPrompt` off (the shipped
default), the negative control passed, the full 18,588-byte prompt passed, and
the control passed again on re-check. No section tripped anything, so there was
nothing to bisect and no scrub to build.

An earlier run of the same script returned all-PASS while
`codeSystemPrompt` was left `true` from the preset comparison. That result was
discarded rather than reported: the Claude Code preset prepends ~28KB of Claude
Code identity, which is precisely what would mask a third-party fingerprint, so
a pass under those conditions says nothing about how Prime Agent actually ships.

The result is a dated snapshot of a system we cannot see. A PASS is weaker
evidence than a FAIL would be — a failure localises to specific text, a pass
only means "not flagged on this account at this moment", and the same classifier
changed its answer within a day during the OpenClaw work.

## Safety constraints on the work itself

The owner has a live prime-agent daemon running. Nothing in this work may touch
it.

- All testing runs under `PRIME_AGENT_CODING_AGENT_DIR=/tmp/prime-probe/agent`,
  giving separate sessions, leases and session-artifacts.
- **`PRIME_AGENT_CODING_AGENT_DIR` is NOT sufficient on its own.** The
  supervisor socket is global per UID — `$TMPDIR/prime-agent-<uid>/daemon.sock`
  — not per agent directory. Two runs with different agent dirs still contend
  for one supervisor and its launch lock. A test run hung indefinitely on
  `daemon.sock.lock` for exactly this reason once a second daemon was running.
  Every test run must also pass `--daemon-socket /tmp/prime-probe/test-daemon.sock`
  to get a genuinely private supervisor.
- **Never run `prime-agent shutdown`** without `--daemon-socket` pointed at the
  test socket — it stops the supervisor *and every worker* on that socket.
- **Never kill by process name.** `pkill -f prime-agent` matches the owner's
  daemon, its detached workers (whose argv is just `prime-agent`), and its
  IPython kernels. This was done once during this work and killed a live
  daemon. Stop test processes by task/PID, and check parentage before killing
  anything: the kernels that appear mid-run are usually the owner's, spawned by
  their worker, not the test's.
- **Never write to `~/.prime/agent/extensions/`** — global extensions are picked
  up by running workers on start or `/reload`. Extensions are passed with `-e`
  or kept project-local.
- The recording mock stands in for the API wherever a real completion is not
  required, so most verification costs nothing.

## Testing

**Unit.** Both CWD forms; the in-prose `working directory` false positive;
file-change extraction for `ipython` cells, `%%bash` bodies, `edit`, `bash`;
transform parity with the adapter; detection precedence; feature defaults.

**Integration** (HTTP layer, mocked SDK). Passthrough tool round-trip;
`metadata.user_id` producing a session key; two concurrent children not
colliding on one fingerprint.

**End-to-end** (isolated agent dir). Interactive turn; tool-driving turn; an RLM
child; the **session-key proof** — the same session resumes rather than
fresh-replaying across tool rounds, which is the #734 regression check;
prime-agent operating correctly with `codeSystemPrompt` off; daemon mode with a
short cron interval; one deliberately long idle gap to exercise the
`upstream_idle` path from #801.

## Out of scope

- Parsing arbitrary Python file writes out of IPython cells
- ACP mode, MCP integrations, the `prime-inference` provider
- Any change to the `isClientDrivenLoop` guard — it is correct as written
