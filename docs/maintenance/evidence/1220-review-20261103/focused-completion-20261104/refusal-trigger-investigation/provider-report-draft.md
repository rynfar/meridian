# Draft provider report — not sent

## Possible false-positive cyber refusal on an owned-file regression test

Request ID: `req_011CgiEbrKMNczsLEAvajW27`
Message ID: `msg_011CgiEbraDzwxFScjJPjgAJ`
Observed UTC: 2026-11-04 16:52:37
Model: `claude-opus-5-5`; Claude Agent SDK 0.2.141; selected Claude Code 2.1.296; Darwin arm64.

The task reads three application-owned text fixtures in sequence. They contain only `alpha`, `bravo`, `charlie`. One read tool is advertised, with a required string file_path. The first response correctly calls read for a.txt. The next user input is exactly one tool_result for that original ID with content `REALOUTPUT[alpha]`. The native SDK resumes a fork at the assistant call checkpoint. The saved fork contains the original request, that assistant call, and the real result, with no error result, extra instructions or duplicated assistant content.

That continuation returns `stop_reason: "refusal"` and:

```json
{
  "type": "refusal",
  "category": "cyber",
  "explanation": "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback."
}
```

The same test passed through the nonstreaming client-response path. The visible SDK input and native conversation prefix match after owned path/session/tool-ID normalization. Actual OpenCode read/result/continuation also passed on the same selected model and native version. These observations do not establish the provider's trigger or prove a false positive.

Please investigate the recorded request/message IDs for the refusal rationale. Is an unintended system/tool/history field involved, or is this a classifier false positive? No harmful task or payload is intended. We have not disabled safeguards, reworded the task to evade classification, switched models, or retried the failed candidate arm.

No credentials, access tokens, private customer transcripts or private SDK files are attached. This is a draft only; external submission needs owner approval.
