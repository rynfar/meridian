# HTTP error bodies in the usage-zero CI assertion

The original [43 ms failure](https://github.com/rynfar/meridian/actions/runs/33367983207/job/99412557456)
at `0fc79a733539693d35773718315c55dc486b1361` returned HTTP 500 before
`Integration: Non-stream usage propagation > falls back to zeros when no SDK
assistant message is produced` reached its zero-usage assertions. Its response
body was discarded. The original error producer remains unknown.

The existing assertion now compares `{ status, body }`, cloning response text
only when status differs from 200. It runs before the original JSON parsing so
a non-JSON failure retains its body too. HTTP 200 does not clone/read diagnostic
text and still consumes the original JSON once, with the same two zero-usage
assertions. Production code, expected status and timeout are unchanged. The
absolute-path plugin assertion is unchanged: its historical failure had HTTP
200 and a missing `[MARKED]`, so this diagnostic would not address that failure.

## First diagnostic controls

The [baseline](baseline.test.ts.txt) and [corrected](corrected.test.ts.txt) files
copy the respective assertion expressions and use known JSON/plain HTTP 500
Responses. Both runs deliberately exit 1 with zero passes and two failures.
Baseline JSON reports only expected 200 / received 500; baseline plain text
fails JSON parsing. The corrected actual Received diff retains each full error
body. Baseline source-context text can also display the plain fixture constant;
that is not error-body assertion capture.

See [baseline stderr](baseline.stderr.txt), [corrected stderr](corrected.stderr.txt),
[commands](COMMANDS.txt) and [machine results](results.json). Logs replace the fixture's absolute directory with `<fixture>` and trim trailing
spaces on blank source-code-frame lines; actual diagnostic bodies are unchanged.
The first staged whitespace-check failure and unsanitized local results remain
retained. Text suffixes keep these deliberately failing fixtures
outside source test discovery. Run them using the command record, not npm test.

Focused guarded checks at `c7b3d619f76cea6ae592ac0e6299bac126cd616d` plus the
unchanged diagnostic passed the entire existing integration file: 13 tests,
135 assertions, zero failures; standalone typecheck passed. Rebase onto
`048c5e195d237508d71a2723c1249081eb9b4d91` preserves the identical diagnostic.
Bun was 1.3.11 (`af24e281`) on macOS arm64 with existing dependencies. No package
was installed and no per-test timeout was overridden. The guarded integration
initialization reported its existing default-account auth-status probe exiting
1 with `loggedIn: false`; this is not a universal zero-native/auth claim. SDK
query responses were mocked, with no real-client/model E2E claim.

## Current CI issue disposition

The original eleven-victim #933 ownership-backlog cluster is covered by #935's
test-only one-million pending ceiling, supported by captured error bodies and
the targeted before/after cluster. Its surviving 132 ms concurrent HTTP 500
remains unclassified; #1306 supplies held-writer and response-body diagnostics,
not a historical reproduction. The two later #917 examples have concrete
5-second timeout and obsolete 500 ms elapsed-assertion classes addressed by
#990. Five of seven original #917 receipts are matched; two remain missing.
Other fast HTTP 500 and marker causes remain unknown. Existing MCP/SDK-limiter
and concurrent diagnostics are retained without duplication.

[#1312](https://github.com/rynfar/meridian/pull/1312) merged as
`048c5e195d237508d71a2723c1249081eb9b4d91`, restoring explicit source-test
discovery and the isolated priority-session-store stage. It improves test
coverage; it does not resolve either flakiness issue. Keep #917 and #933 open.
This small test-only change is diagnostic evidence, not a product fix. Independent
review, full local npm/typecheck/build and exact final-head CI remain delivery
gates; report those at the final delivery head rather than treating these
pre-rebase focused results as their substitute.
