# Per-call tool results resume the checkpoint — #1201 (2026-10-13)

Contributor PR #1201 by @XInTheDark, landed as their own PR. The fix is
entirely theirs. The only maintainer commit on their branch is a conflict-free
merge of `main`, needed to run CI against the current base; this live gate and
record are a separate maintainer change.

## Live before/after

`bun scripts/e2e-responses-per-call-results.mjs`, same script on both trees.
macOS arm64, `/v1/responses` with the Codex adapter in passthrough, Claude
Agent SDK 0.2.141, native Claude Code 2.1.296, requested model
`claude-opus-5-5`, Claude Max. Each arm is a new conversation in which the real
model emits two tool calls in one response.

| Follow-up history | Unchanged `main` `58c4126c3` | PR tree |
|---|---|---|
| Grouped: call A, call B, output A, output B (control) | resumed | resumed |
| Per call: call A, output A, call B, output B | **not resumed**, cache read 1,038 — FAIL | resumed, cache read 1,699 — PASS |
| Per call with output B missing (negative control) | not resumed | not resumed |
| Result | FAIL (exit 1) | PASS (exit 0) |

Every request returned HTTP 200 on both trees; the defect is the lost resume,
not an error.

## Local gates

`npm test` with typecheck and `npm run build` on their commit merged with
`main`; final-head CI on the PR.

## Review findings

- The matcher stays strict: a later echo may hold only unseen calls from the
  checkpoint batch, only tool results may precede it, and once a client echoes,
  each result must follow its own echo. The contributor's six rejection tests
  cover these, and the missing-output arm above confirms one of them live.
- No material finding against the change.

## Not covered

- The reporter's own client (Meowbert) was not run. Its current version already
  sends the grouped order, and the original deployment's model and SDK versions
  are unknown. This gate sends the per-call order by hand over the same public
  Responses route, with the model the client's fix commit names.
- macOS arm64 only. Streaming and the Anthropic-shaped route are covered by the
  mocked integration test, not live.
