# #1211 / #1322 pinned native counter control

Twenty-four network-disabled cases completed: SDK 0.2.141 with native CLI
2.1.284 from source and CLI 2.1.295 from the independently installed package.
Both arms produced the same twelve observations. Each arm made eighteen
scripted `/v1/messages` requests and owned thirteen native processes including
its version probe. No real credentials, model calls or actual client were used.
This is bounded counter evidence, not background or whole-change acceptance.
The [source receipts](source-qualified/COUNTER_DISCOVERY.json) and
[installed receipts](installed-qualified/COUNTER_DISCOVERY.json) retain all
observations. [Attempt one](source-attempt1/COUNTER_DISCOVERY.json) and
[attempt two](source-attempt2/COUNTER_DISCOVERY.json) retain the earlier failures.

| Response / permission | Cap | API requests | Distinct public message IDs | Native `num_turns` | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Text | 1 | 1 | 1 | 1 | success |
| One tool / deny | 1 | 1 | 1 | 2 | error_max_turns |
| One tool / deny, partial SDK events disabled | 1 | 1 | 1 | 2 | error_max_turns |
| Three parallel tools / deny | 1 | 1 | 1 | 2 | error_max_turns |
| One tool then text / deny | 2 | 2 | 2 | 2 | success |
| Three parallel tools then text / deny | 2 | 2 | 2 | 4 | success |
| One tool / allow | 1 | 1 | 1 | 2 | error_max_turns |
| Three parallel tools / allow | 1 | 1 | 1 | 2 | error_max_turns |
| One tool then text / allow | 2 | 2 | 2 | 2 | success |
| Repeated one-tool responses / deny | 2 | 2 | 2 | 3 | error_max_turns |
| Repeated three-tool responses / deny | 2 | 2 | 2 | 3 | error_max_turns |
| One tool then text / deny | 3 | 2 | 2 | 2 | success |

Every scripted response ID matches the observed public SDK model-message ID
set exactly. Starts and assistant fragments share IDs and do not add model
requests. Three parallel tools can produce three assistant events from one
message. All model API requests are captured at the owned loopback endpoint;
all remain within the configured cap. The no-partials case still uses upstream
SSE, as its request receipt records: it does not claim an upstream JSON control.
These observations disprove equality between the result counter and API rounds
for these tuples; they do not define that field for every SDK/CLI version.

The first two discovery attempts stopped after their second case. The first
incorrectly required a clean iterator after a max-turn result. The second
incorrectly expected a plain process-exit exception. Public SDK source shows
that 0.2.141 replaces this exception with its preceding native result's error
text. The corrected discovery compares that text privately, retains only an
exact binding boolean, and independently requires the actual native exit code
one, no signal, the max-turn error flag/reason and physical joins. Other iterator
errors remain failures. Both initial failures and complete scripts are retained.
No E72 acceptance predicate was changed to accommodate them.

The SDK entry bytes match between the installed control and the earlier source
native proof: SHA256
`48bde6aeabf7e71ad5528bf52c8feb1642c21f505ea2495c70f39db7df226d97`.
The source control uses the immutable candidate's query-options builder; the
installed control explicitly uses that same source builder with the installed
SDK and CLI. It does not run the installed Meridian proxy and cannot qualify
package behavior. [QUALIFICATION.json](QUALIFICATION.json) checks all observed
tuples, identities, catalog/hook receipts, request bounds and joins.

Each container was read-only with `--network=none`, a private runtime, a fake
noncredential API key and only owned loopback traffic. All native exit/close,
stdout/stderr end/close, SDK iterator and listener witnesses joined. Signaling
attempts were zero. The private runtimes and stopped containers were removed;
read-only probe inputs remained exact. Original driver/attach terminal receipts
are retained, including failures; no handle was restarted after a timeout.

The reproducible sanitized probes and host commands accompany each arm below.
Use a fresh private proof directory and the recorded immutable image, or
rebuild and requalify the existing source/package runtime recipes before use.
The installed probe takes explicit `--source-root`, `--options-root`,
`--claude-executable` and `--expected-cli-version` inputs; source-root selects
the SDK, options-root selects `src/proxy/query.ts`. The recorded commands use
the same SDK and actual native binaries as the prior E72 proof. The Docker image
is a local prerequisite, not a publicly published artifact.

Anthropic's [2.1.277 changelog](https://github.com/anthropics/claude-code/blob/602df92bf481ed904533e95c09f740f40aab5aed/CHANGELOG.md#21277)
records removal of TaskOutput in favor of Read on the background output file.
The earlier actual client catalogs independently confirm Read present and
TaskOutput absent for Claude Code 2.1.287. This explains why requiring that
removed tool cannot establish current completion. The original twenty-check
background gate and its failures remain intact. [READ_COMPLETION_DESIGN.md](READ_COMPLETION_DESIGN.md)
defines a separate versioned proof with owned handles, exact results and
completion ordering; it is not implemented or executed yet.

Next implement that maintained proof and its negative controls, run required
local gates, then qualify unchanged baseline, candidate source and installed
package with the actual Claude Code 2.1.287/Sonnet5-5 flow. The historical
9,256 ms lease wait remains un-attributed; a previous 7 ms run is not a fix.
Background, mixed-auto, cancellation, caption, reporter/client/model/platform/
gateway, broader package and final-head CI holds remain. No merge, closure,
new PR or release occurred. Owner HEAD/index/twelve dirty files and all eighteen
contributor identities remain exact; worktree cleanup remains three checkouts.
