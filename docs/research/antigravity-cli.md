# Subscription-backed Antigravity CLI research

2026-09-18. Research branch based on `origin/main` at `4c9ebbb6`.

**Verdict: a subscription-account CLI bridge is realistic. A client-owned tool
round trip has worked against the live model. Production compatibility is not
yet established.** This branch adds an opt-in experiment, not a Meridian provider.

## Scope and authentication

Only the official installed `agy` executable sends model requests. No Python
SDK, Gemini API key, copied credentials, private model endpoint, or transcript
modification is involved. The CLI uses its existing signed-in Google account.
The effective settings reported an empty `modelProvider` and
`useG1Credits: false`; no API-provider environment overrides were present.
This establishes the account-authenticated route, not an independently audited
subscription tier or quota debit. No API-key fallback is implemented.

The initial manual smoke test used CLI 1.2.5. The installed executable changed
to 1.2.6 before the scripted probes, without an update command from this work.
Record versions per experiment; do not silently generalize across upgrades.
Scripted live tests used **1.2.6, macOS arm64, gemini-3.8-flash-low**.
Other models and operating systems remain untested.

## Evidence

| Experiment | Observed result |
| --- | --- |
| Headless account-authenticated request | Exact `MERIDIAN_AGY_READY` response; incremental NDJSON text and terminal success |
| Explicit conversation ID, new process | Random memory token recalled correctly; same conversation ID |
| Two prompts in one process | Both succeeded; context retained |
| Two simultaneous independent calls | Distinct conversations and correct, distinct random responses |
| Native `tool_result` on stdin | Rejected with exit 1: only text blocks supported |
| SIGINT after text generation began | Process group exited in 432 ms; terminal status `ERROR`, error `interrupted` |
| Workspace MCP config with default launch | No MCP requests; model said tool unavailable |
| Explicit project plus workspace directory | MCP initialization and tool listing succeeded; model requested fixture tool |
| Hook `allow`, default permissions | MCP execution denied in headless mode; terminal result still `SUCCESS` with `denied_actions` |
| Hook `allow` plus `permissionOverrides` | Same permission denial |
| Per-process auto-approval plus deny hook | Client-owned tool handoff succeeded, exactly one MCP call |
| New process after completed tool loop | Random tool receipt recalled from native conversation history |
| Deny hook under auto-approval | Requested `view_file` failed; fixture file contents never appeared in output |
| Exact formatting after tool completion | Failed: assistant added creation/completion timestamps before the receipt |

The first tool experiment's exact-string assertion failed on those timestamps.
The final probe measures receipt integrity and formatting separately: the
random receipt must occur exactly once, the native tool output must equal it,
and `exactFormatting` records the stricter outcome. The formatting failure is
not considered fixed by the successful transport test.

Basic calls carried approximately 14,000 input tokens of harness context.
One two-invocation tool loop reported approximately 31,000 input tokens.
These samples reported zero cache reads. This is an observation, not a stable
cost estimate or evidence that caching is unavailable. Persistent-process result
usage accumulated across turns; a provider must avoid counting cumulative
totals as fresh per-request usage.

## The working tool handoff

```text
Synthetic HTTP client       Research wrapper           Official agy
       |                           |                         |
       | POST /v1/messages         | --print + stream-json   |
       |-------------------------->|------------------------>|
       |                           |<---- MCP tools/call ----|
       |<----- tool_use -----------|                         |
       |                           | holds MCP response open |
       | POST tool_result          |                         |
       |-------------------------->|---- MCP result -------->|
       |                           |<---- final text --------|
       |<----- final answer -------|                         |
```

The client creates a random receipt only after receiving `tool_use`. The
wrapper waits 1.5 seconds before accepting the client result. There is no
fixture receipt in the original prompt or agent workspace. The MCP call's
native output and the assistant answer both contain the client receipt.
The agent process remains alive between the two HTTP requests. A subsequent
CLI process resumes the completed conversation without re-executing the tool.

This sidesteps the unsupported native `tool_result` stdin block: results enter
through the supported MCP response channel. It does **not** prove restoration
of a pending call after process death. A production wrapper would need to keep
pending calls alive across HTTP boundaries, enforce deadlines, correlate
results, and cancel abandoned work.

The HTTP client and server here are purpose-built fixtures. They demonstrate
the tool ownership boundary, not full Anthropic compatibility or an actual
OpenCode/Pi/Claude Code integration. There is no production SSE encoder,
tool catalog mutation, parallel tool batch handling, authentication, routing,
or persistent wrapper state in this script.

## Reproduce

Requires Node 22+, a POSIX machine, installed `agy`, and an existing CLI account
login. The probes consume account quota. They reject configured API-provider
overrides and paid overage credits. They preserve the user's settings and
credentials. The CLI itself persists conversations and new project metadata
under its normal account directories. Global CLI customizations still apply.
Temporary workspace artifacts remain for inspection.

```sh
node scripts/research/agy-probe.mjs basic
node scripts/research/agy-probe.mjs input
node scripts/research/agy-probe.mjs cancel

# Expected permission failure on the configuration tested here:
node scripts/research/agy-probe.mjs tools

# Explicit research-only auto-approval, with a workspace hook allowing only
# the fixture MCP tool and denying every other proposed tool call:
AGY_RESEARCH_AUTO_APPROVE=1 node scripts/research/agy-probe.mjs tools
```

`AGY_RESEARCH_MODEL` and `AGY_RESEARCH_BIN` override the model and executable.
Each run prints its artifact directory and writes `report.json`, CLI NDJSON,
and stderr; tool runs also record hook and MCP protocol events. Review raw
artifacts before sharing: hooks include local paths and conversation IDs.
The committed [evidence summary](antigravity-cli-evidence.json) omits those
paths and IDs. No credentials or user configuration dumps are committed.

## Remaining feasibility gates

1. **Scoped permission configuration.** The successful fixture uses
   `--dangerously-skip-permissions` with a restrictive hook. The hook denied
   a built-in read, but this is not a complete isolation proof or a recommended
   production default. Establish project-scoped grants and fail-closed hook
   loading without changing global user permissions.
2. **Pending-call lifecycle.** Test longer client delays, disconnects,
   cancellation during tools, parallel calls, duplicates, stale IDs, process
   death and wrapper restart. Current cancellation evidence is text generation
   only, and it does not establish upstream billing cancellation.
3. **Real client compatibility.** Run the implicated client through an
   experimental provider: SSE order, client-owned file operations, system
   instructions, errors, stop reasons, schemas and token accounting.
4. **History fidelity.** Explicit resume works for ordinary and completed-tool
   turns. Undo, fork, compaction, revised history, model switches and replay are
   unproven. CLI interactive rewind/fork commands are not evidence of headless
   support. Never reuse Claude-specific transcript lifecycle operations.
5. **Capability limits.** Text-only stdin, inherited harness instructions,
   timestamp additions, arbitrary client tools, images, built-in tool hiding,
   output limits and schema fidelity need explicit handling.
6. **Account isolation and limits.** A fresh HOME could not access the existing
   login (`agy models` requested sign-in). Separate authentication from config
   isolation using supported mechanisms; do not copy tokens. Multi-profile
   routing, throttling, quota exhaustion and sustained concurrency are untested.

## Meridian design implication

Add a runtime backend boundary alongside the existing client adapter boundary.
Keep the current Claude implementation intact while the experiment matures.
Meridian's `AgentAdapter` identifies incoming clients; it is not the right place
to replace the upstream execution engine. A future Antigravity backend would
own process lifetime, MCP rendezvous, native conversation IDs, model discovery,
usage normalization and provider-specific errors. Shared protocol and pure
lineage logic can remain above that boundary.

Do not promise drop-in parity yet. The next milestone is one real client with
text and client-owned tools, with explicit unsupported-capability errors and
documented pending-process behavior. A production API change would follow the
repository's API-contract and affected-flow E2E requirements.

## Local verification

- `node --check scripts/research/agy-probe.mjs`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 3,677 passed, two skipped, two failed in the first suite stage.
  Both failures are in unchanged `session-lifecycle-windows-gc.test.ts`:
  deletion-child termination reports `kill() failed: EPERM: Operation not
  permitted`, rather than the expected timeout message. A focused rerun
  reproduced both failures (three passed, one skipped, two failed). Later
  chained test stages did not run. No production or existing test files differ
  from the base commit; this is a recorded validation gap, not a green gate.

This research branch is intended for draft review, not merging or release.

## Official references

- [Headless CLI protocol](https://www.antigravity.google/docs/cli/headless/)
- [Account authentication](https://www.antigravity.google/docs/cli/install/)
- [MCP configuration](https://antigravity.google/docs/mcp)
- [Hook contracts](https://antigravity.google/docs/hooks)
- [Projects](https://www.antigravity.google/docs/projects?tab=cli)

Documentation guided the tests. Where an expectation differs from observed
CLI behavior, the observations and retained failure cases above take precedence.
