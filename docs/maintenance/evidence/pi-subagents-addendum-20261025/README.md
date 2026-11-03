# Pi extension: in-process pi-subagents children and session resume (2026-10-25)

Continues the #1408 Pi extension record in [E2E.md](../../../../E2E.md#pi-extension-1408),
which left saved-session resume, in-process pi-subagents and a live
`next-user-turn` promotion unqualified.

## Setup

- Darwin arm64, Claude Max 20x subscription, Paid Extra Usage off.
- Meridian: the owner's launchd service, running an npm pack of `main` at
  `cb767de` (package version 1.85.0) in passthrough mode, with
  `@rynfar/meridian-plugin-pi-scrub` 0.2.0 loaded.
- Pi 1.4.0 with the extension from `meridian setup --client pi`.
- pi-subagents 0.82.1, installed with `pi install` into a scratch
  `PI_CODING_AGENT_DIR` holding only it and the Meridian extension.
- [`record-pi-requests.mjs`](record-pi-requests.mjs) sat between Pi and Meridian
  (`MERIDIAN_BASE_URL=http://127.0.0.1:3497`) and recorded each request's
  `x-meridian-source`, whether it carried a priority attestation, and where an
  `<active_agent>` marker appears in its system text. It records no prompt
  text in the retained summary.

## Saved-session resume

In a scratch directory, `pi -p --model meridian/claude-haiku-5-5` asked Claude
to remember a codeword, and `pi -c -p` asked for it back. The resumed run
answered `TANGERINE-42`. Meridian's telemetry recorded the first request as
`adapter=pi lineage=new` and the resumed one as `lineage=continuation`,
`isResume=true`, with 3,905 cache-read tokens.

## In-process pi-subagents child

The prompt asked Pi to run pi-subagents' builtin `delegate` agent in the
foreground with the task `Reply with exactly: CHILD-OK-…`. Foreground children
run as sessions inside the parent Pi process, so only the prompt marker can
identify them.

**Before (`main` `cb767de`):** the child answered, but Meridian logged it as
`source=fork-side-call model=opus[1m]`. `delegate` uses
`systemPromptMode: append`; pi-subagents passes its tagged prompt as
`appendSystemPrompt`, which Pi renders inside an `<addendum>` section about
3,000 characters into the system prompt:

```
…</docs>\n\n<addendum>\n<active_agent name="delegate"/>\n\nYou are a delegated agent. …
```

The extension only matched the marker at the start of the system text, so the
child's own session ID made it a side call, which keeps the conversation's 1M
tier.

**After (branch `fix/pi-active-agent-addendum`), Opus 5.5 parent:**
[`requests-fixed.json`](requests-fixed.json) shows the parent's two requests
unmarked and signed, and the child's request with
`x-meridian-source: subagent-delegate`, unsigned, marker at offset 2976.
Meridian logged:

```
adapter=pi profile=work(priority) model=opus[1m] … lineage=new
adapter=pi source=subagent-delegate profile=work(priority) model=opus … agent=subagent
adapter=pi profile=work(priority) model=opus[1m] … lineage=continuation
```

The child answered `CHILD-OK-79`. After review, the matcher was revised to
read Pi's structured `sections` as well as a forced flat prompt, to accept the
marker only at the start of the addendum (pi-subagents replaces a child's
APPEND_SYSTEM.md with the tagged prompt), and to ignore an addendum layout
quoted after Pi's own sections. The same run with the final extension gave the
same three requests and `CHILD-OK-81`.

pi-subagents forces the child's prompt, so this live path sends it flat. The
structured-sections, root APPEND_SYSTEM.md and quoted-layout cases are covered by
`src/__tests__/pi-extension.test.ts`.

## Still unqualified

A live `next-user-turn` promotion needs the priority account to exhaust its
allowance. Every primary Pi request above carried a `pi1` attestation; the
promotion path is covered by `src/__tests__/priority-routing-integration.test.ts`.
