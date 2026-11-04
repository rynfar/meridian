# Focused offline JSON/SSE SDK-boundary parity regression proposal

Status: proposal only. No command, test, build, model or network call was run. No repository source edit. Parent approval needed to implement/run.

## Smallest useful change

Extend `src/__tests__/passthrough-early-stop-integration.test.ts` using its existing SDK mock and HTTP host, rather than a new harness. Parameterize the existing assistant-boundary test over JSON and SSE and use `parseAssistantResponse` + `replayAssistantBlocks` to construct the next client request from the *actual HTTP output*. Script Q1 with `mcp__oc__read`, fragmented tool input deltas, assistant UUID, synthetic forwarded denial and canonical `error_max_turns` result. Feed the fixture's exact user request and `REALOUTPUT[alpha]`; use a synthetic owned workdir. Q2 may return a normal second read for parity; a separate Q2 script returns the synthetic native safeguard refusal + error result and iterator failure.

Assert at captured SDK `query` boundary:

1. Q1 normalized prompt equality; Q2 exactly one SDK user input, with one correct native `tool_result`, no `is_error`, no denial text, no assistant replay or new instruction.
2. Resume names Q1 source, `resumeSessionAt` equals Q1 assistant UUID (never denial UUID), `forkSession=true`, target differs and is preallocated. Stored mapping remains on the original source if Q2 fails before publication.
3. Compare actual options per field: `systemPrompt`, `tools`, allowed/disallowed tools, `includePartialMessages`, maxTurns, model, settings, settingSources, plugins, thinking/effort presence, fallbackModel, betas, outputFormat. Normalize only owned roots and consistently paired generated IDs. Assert hook function source equality; invoke each PreToolUse hook with the same synthetic tool input and compare its returned block decision/reason. Assert fresh MCP server instances expose identical registered read schema/name; do not compare opaque instance object identity.
4. Compare a strict allowlist of generated nonsecret env policy values (explicit model pin, refusal-fallback-disable, attachments suppression, output cap, tool search, setting defaults). Never snapshot inherited env or credentials. Abort controllers and process-gate functions are runtime handles, not model prompt data.
5. Refusal arm must dispatch no Q3, expose error before terminal `message_stop`, and neither recover as tool_use nor invoke silent-turn recovery. Assert no false success/cache continuity claim for the failure. These tests prove boundary/error behavior, not why Anthropic's guard refused.

The existing `src/__tests__/e41-assistant-response.test.ts` already covers opaque thinking/signatures, tool IDs/nested input, usage, and malformed JSON. Do not duplicate that suite or add prompt relaxation, retries, model substitution, timeouts, a new helper framework, or acceptance-threshold changes.

## Discriminating interpretation

A failing offline parity assertion yields a concrete field/path to fix. A passing parity test plus the now hash-proven actual Q2 input closes Meridian's visible construction hypothesis for this incident; it does not explain the provider's private guard decision. Preserve E41 red. No further live/model diagnostic is proposed by this worker; parent owns the remaining acceptance decision.
