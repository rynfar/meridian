# Internal attempt-owned stop correction

The final public-event probes provide a viable timing boundary. They supersede
the all-denials-held premise in the previous design; the implementation remains
pending. Keep the actual 24/27 source failure and unchanged canonical acceptance,
budget, operator override and kill switch. No public plugin/configuration change
is needed.

Attach an internal control to exactly one Query after native admission. Tag
hook callbacks and every event with that attempt. Cleanup must detach it, release
its own held hooks and join outstanding control work before transcript/process
and semaphore ownership ends. Retries and managed forks get distinct controls;
an old callback must never interrupt a replacement query. Preserve the first
failure through control, native, stdio and transcript cleanup failures.

Collect the public generation ID, every client-forwarded tool ID and completed
block, and full assistant metadata from that same generation. Record the latest
complete tool-bearing assistant UUID. Require all blocks closed, the final
generation boundary, equal stream/metadata ID sets, and accepted forwarded-hook
input ownership. Do not use a fixture's response body, fixed call count, assumed
hook order, a first assistant fragment, or merely a `message_delta` as proof.
ToolSearch/discovery-only generations, SDK-owned advisor/StructuredOutput work,
mixed unsupported tool ownership, malformed or incomplete metadata, dropped
calls and client aborts cannot qualify this path.

Hold forwarded denials until this generation is complete. If the complete hook
set has not arrived, release only the complete observed prefix so serial hook
dispatch can continue. On the final observed hook, retain its denial, freeze
the exact generation/UUID/forwarded-ID candidate and request the public Query
interrupt. Concurrent dispatch must remain safe: any retained terminal subset
belongs only to that same complete candidate. Acknowledgement precedes release
of the retained final hook(s); all hooks eventually settle or fail within the
existing lifecycle bounds. Failure to prove completeness or acknowledgement
must retain ordinary failure/fencing behavior, without silently publishing.

Continue consuming the original iterator. Require every forwarded tool result
exactly once and a terminal result bound to the admitted SDK session, retained
stop intent and acknowledgement. The discovered terminal tuple is
`error_during_execution`/`is_error: true`/`aborted_tools`; qualify only an exact
owned native result/error relationship. Do not accept any arbitrary execution
error, process exit, aborted stream, unrelated tool failure, later-generation
result or controller cancellation. Result-before-acknowledgement and unowned
acknowledgement races must fail closed. Native count four here represents one
API round, so preserve independent generation/cap checks without inventing
provider-count equality. Publication still requires original native/stdio and
transcript joins through the existing lifecycle path.

Keep this logic in an internal module with downward dependencies, direct pure
state tests, and mocked-SDK HTTP integration for both stream modes. Exercise
partial parallel blocks/metadata, withheld or missing hook, mismatched input,
serial/concurrent/reversed dispatch, discovery/internal work, operator cap and
kill switch, acknowledgement timeout/failure/race, wrong session/subtype/flag/
reason/error, retry/fork reuse, caller abort/shutdown and join failure. Verify
that an unrelated first failure survives later cleanup. Normal success and
existing capped recovery must retain their behavior.

Then qualify the actual integrated source and independently installed artifact:
all four E41 modes, supported fork/resume history and unchanged source/cache,
E71 side calls, E72 foreground/background/mixed classifiers, root/scoped/nested
cancellation, incidental parent-abort independence and caption/reporter cache,
overlap/abort/baseline behavior. Freeze current artifact, observer, controller,
model/client/SDK/native pins, profile-qualified read-only credential admission
and unchanged budgets before any new real run. The `work` login is not assumed
renewed. Broader platform/client/package and final-head CI remain separate.
Adversarial whole-change review and all required gates precede merge or source
closure; release authorization is separate.
