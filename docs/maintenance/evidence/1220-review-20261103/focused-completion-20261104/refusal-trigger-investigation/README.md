# Native refusal trigger — 2026-11-05

## Finding

The immediate trigger is a **received Anthropic Messages API refusal**: `stop_reason: "refusal"`, `stop_details.type: "refusal"`, `stop_details.category: "cyber"`. Supported SDK history retains the same metadata and its generic explanation. The selected native 2.1.296 formatter consumes these fields directly; it does not derive the cyber category from local keyword matching. Its “this session” sentence is canned diagnostic text, not proof of a persistent session flag.

The provider explanation says the request triggered restrictions on violative cyber content. **It does not identify the triggering input span.** The owned regression task reads alpha/bravo/charlie text files; the visible SDK prompt and conversation are correct. A provider false positive is plausible, not established. No product defect supporting a safe source patch was found. No refusal fix is claimed.

## Verified boundaries

- [Native branch with exact binary offsets and identity](native-refusal-trigger.md)
- [Supported SDK stop details](supported-native-stop-details.json), [read-only probe](supported-stop-details-67a3c9e4c76a.mjs)
- [System prompt, tools and configuration audit](model-input-trigger.md)
- [Owned supported-history projection](../sse-owned-supported-history.json)
- [Official documentation](official-refusal-documentation.json)
- [Diagnosis receipt](trigger-diagnosis-receipt.json)

OpenCode defaults to the Claude Code preset, plus constant Meridian cwd/git/replay/scratchpad notes. The full Meridian append was reconstructed; native preset expansion was not historically captured. Project settings, memory and plugins are disabled by the fixture's loading contract. No malformed tool input or evidence of sibling credential files entering context was found. The same private fixture ancestor passed both JSON arms and the actual client; moving it would not establish a refusal fix.

## Execution and acceptance

One new-request read-only personal admission check returned **HTTP429**. No inference, credential refresh, owner credential write, quota polling, account switch, prompt rewording or guard/fallback change occurred. A supported-history read made zero model calls. Product source and constants are unchanged. Local final qualification remains **8857/65 skip/0 fail + typecheck + certified build**; required CI is green. Candidate SSE refusal and incomplete parallel modes remain unresolved; #1220 is open and no release occurred.

## Next action

[Provider report draft](provider-report-draft.md) includes the exact request/message IDs and harmless owned scenario. **Not sent**: external provider contact needs owner approval. Provider investigation is required to identify the private classifier trigger; a speculative code or prompt change would not be an evidenced fix.
