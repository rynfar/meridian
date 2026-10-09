# Antigravity support and recovery

Meridian uses the official, signed-in `agy` CLI for subscription-backed generation.
It does not use a Google model SDK, copy credentials, or fall back to a paid API.
The validated CLI version is **1.2.7**. The tested clients are **Pi 0.72.1** and
**OpenCode V1 1.18.31** on macOS arm64. See [live evidence](../E2E.md) and the
[setup guide](antigravity.md). New CLI versions require validation.

## Everyday supported use

- Incremental text, coding tools, client approvals, questions, cancellation,
  client-owned plugins and delegation in the tested Pi/OpenCode versions.
- Model selection and available low/medium/high Gemini effort variants.
- Client tool batches, exact result correlation, forced tools and validated JSON
  schemas; tools execute in the client with its permissions.
- Anthropic Messages, OpenAI Chat Completions and the documented Responses subset.
- Images, public HTTPS images and locally adapted documents/audio/video.
- Web/macOS provider setup, separate provider status and quota presentation,
  combined navigation and activity reporting.
- Live conversation reuse, eligible completed-session restoration, completed
  history replay and bounded saved-answer/tool-delivery recovery.

These are specific supported flows, not universal API or plugin compatibility.

## Unfinished work

Antigravity is a preview in Meridian 1.74.0 and later. Use the
[installation instructions](../README.md#try-antigravity) and the tested versions
above when reproducing a problem.

The remaining engineering and acceptance work is:

- **Crash reconciliation:** a client-facing workflow to inspect uncertain tool
  outcomes and decide what to resume. Saved answers and conflict guards exist;
  automatic reconciliation and active CLI reattachment do not.
- **Additional contracts:** adapters and actual-client tests for more native
  plugins, hosted-tool/file semantics and client versions. Current compatibility
  applies to the documented subset.
- **Platform acceptance:** authenticated Linux and Windows runs with the actual
  CLI and clients. Fixture tests alone do not establish support.

Other gaps require new official CLI capabilities or cooperation from executing
tools. They are listed below rather than treated as promised wrapper features.

## What cannot be supported right now

| Capability | Current behavior / alternative | What would close the gap |
| --- | --- | --- |
| Exact output-token or quota cap | `max_tokens` is advisory. Enforce a turn deadline and client loop limits instead. | An official CLI generation-budget control. |
| Exact token counting | Estimates are labeled; upstream reported usage is preserved where available. | An official tokenizer/count interface matching the selected model. |
| Exact numeric thinking budget | Optional adaptation selects low/medium/high effort; it is not a token allocation. | An official numeric budget control. |
| `temperature`, `top_p`, `top_k` | Unsupported values are rejected; use model/effort selection and instructions. | Official sampling controls. |
| Private/signed reasoning | No private transcript, signatures or encrypted reasoning are fabricated. | An official compatible reasoning interface. |
| Native PDF citations | Rendered pages carry page labels; model-written page references are not native citation objects. | An official document/citation interface. |
| Continuous video, non-speech audio, generated media | Video frames carry measured source timestamps; local Whisper supplies an estimated SRT speech transcript. Brief visual events and other sounds can be missed. | Official native modalities, or separately scoped client tools with their own dependencies. |
| Resume an active CLI process/background job after service death | Completed snapshots may survive; unfinished identified Messages requests return an explicit conflict. | Official active-task reattachment plus durable client execution coordination. |
| Exactly-once arbitrary external actions | Stable IDs and saved responses prevent covered duplicate-delivery cases. An action may finish before the client records its result. | Idempotency or verifiable outcomes in each executing tool; no universal solution for arbitrary shell commands. |
| Provider-hosted OpenAI tools and uploaded file IDs | Use supported client-owned function/custom tools and inline attachments. | Explicit adapters and acceptance tests for each tool/storage contract. They would not become OpenAI-hosted services. |
| Claude SDK hooks, profile pools and signed lineage | Provider-specific plugins and telemetry are available; agy uses its own signed-in account. | Official matching CLI capabilities. No unofficial account isolation. |
| Arbitrary native plugin MCP tools / every client version | Client-owned Pi/OpenCode plugins work through the supported bridge; native grants are explicit. | Per-capability permission design and actual-client testing. OpenCode 1.2.15's unsupported `top_p` is not accepted. |
| Authenticated Linux/Windows acceptance | CI fixtures exist; Windows production use remains gated. | Real account/CLI/client testing on those platforms. |
| Eliminate upstream outages and CLI faults | Bounded read-only timeout recovery, failure diagnostics and a short failure cooldown. Active generation is not blindly restarted. | Upstream fixes; Meridian can contain failures, not repair the service. |

## Recovering an interrupted session

Configure `MERIDIAN_AGY_STATE_PATH` to a private SQLite file, using a different
file per running service, and install the bundled client integration via
`meridian setup --antigravity`. Without persistence, saved state is process-local.
Keep the client's own conversation history.

1. **Interrupted delivery with a saved answer:** the supported integration can
   retrieve the same answer/tool IDs. It checks the already displayed text before
   appending a recovered suffix. It does not run a second model to invent a suffix.
2. **A tool completed and its result is in client history:** Meridian supplies
   the recorded calls and results when recovering through full history replay.
   A fresh model can still request a successful action again. The
   [retained long-history probe](https://github.com/rynfar/meridian/blob/cd6b31a752e2f2d20240fee1e63ea46a39830dd9/docs/maintenance/antigravity-history-1314-proof.md)
   with Pi 1.1.0, agy 1.2.7 and Gemini 3.8 Flash Low on macOS observed two
   identical successful writes after backend replacement. Review repeated actions
   against their recorded results and external state before executing them again.
3. **Service died before saving the identified response:** the same request gets
   HTTP 409 with an uncertain-outcome explanation, before any CLI probe or
   generation. A cache-only lookup still returns 404 when no snapshot exists.
   Review client history and affected files/services. Start a new
   turn only after deciding what remains to do. Do not automatically generate a
   new request ID to evade the guard.
4. **A tool may have run but has no recorded result:** inspect the outcome where
   possible. Check a file's contents or query a job's status. For a command whose
   effect cannot be checked, ask before executing it again. Meridian cannot infer
   that every missing result means the action never happened.

The unfinished-request guard covers explicitly identified Anthropic Messages
requests with native browser/subagent grants disabled. It stores only scoped
identity/fingerprint hashes, expires after 30 minutes and admits at most 128
unfinished requests. It refuses new admission instead of evicting an unresolved
guard. Saved answers have separate count/size bounds. Retention expiry, client
crashes, native actions and OpenAI background jobs do not acquire an exactly-once
or active-resume guarantee. No automatic client-side reconciliation UI is claimed.

## Practical execution budgets

`MERIDIAN_AGY_TURN_TIMEOUT_MS` bounds an active CLI turn (default 300,000 ms).
`MERIDIAN_AGY_TOOL_TIMEOUT_MS` bounds idle waiting for a client result
(default 60,000 ms); a late result can recover through completed history.
`MERIDIAN_AGY_MAX_CONCURRENT` bounds concurrent CLI processes (default 4).
Request/response/attachment buffers are also bounded; see the backend guide.

These controls do not cap the entire multi-turn task's tokens, number of tool
rounds, or external tool execution duration. Set those in the executing client or
tool when available. A long shell command belongs to the client's cancellation
and timeout policy. Cancelling generation does not refund tokens already used.

After a CLI version/configuration/model probe fails, Meridian returns an error
with `Retry-After` and holds new account checks for five seconds. It then requires
fresh successful checks. Unsupported versions or disallowed account settings
must be corrected; successful old authorization is never used as a fallback.
Only timed-out read-only config/model probes get one automatic retry. Active
generation failures require the applicable recovery path above.
