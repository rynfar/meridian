# Proposed E72 background-read-v2 proof

Status: implementation and actual-client execution UNEXECUTED. This is the next
bounded proof for existing #1322/source #1211; it supplies no merge or release
acceptance. Keep the existing foreground and strict background modes, including
their original checks and failed native receipts, unchanged. Add an explicit
`background-read-v2` scenario rather than silently substituting a Read result
inside the TaskOutput assertion.

The real Claude Code 2.1.287 catalogs already advertise Read and omit TaskOutput.
Pin that actual client and `claude-sonnet-5-5`, SDK 0.2.141 and the explicit
source/installed native 2.1.284/2.1.295 versions, retaining served-model receipts.
The separate scenario must affirm these capability facts from every incoming
catalog and retain per-query public MCP readiness. It uses the same two
general-purpose Agent children, each launched in the background in one message;
the alpha child runs `sleep 2 && echo alpha-1` followed by a separate
`echo alpha-2`, and beta runs the corresponding beta commands. The parent runs
exactly `echo parent-overlap` while the children work. After actual completion,
the parent reads each launched task's own advertised output file once. A later
parent invocation resumes its original session. Preserve parent-child and
child-child HTTP response-body overlap, distinct own session chains, initial
owned-parent fork qualification, later child and main resume, complete routing
decisions and the existing wait/cost/query/time limits.

Each completion has to bind the original SDK tool block, original hook fate,
canonical HTTP tool terminal and actual client tool result. Require exactly
two Agent launch receipts, four exact child Bash command/result receipts, one
parent Bash receipt and two Read completion receipts: nine forwarded receipts.
Require no unknown tools, reused tool IDs, changed tool results or cross-actor
pairing. Generated completion words do not substitute for these receipts.

Keep the returned agent IDs and output paths private. A launch must contain one
unambiguous actual agent handle, mapped to the same child wire actor that ran
its two commands, and one explicit public output-file field. Recognize only
observed native field syntax, with direct tests; do not guess filenames, derive
paths from an unowned ID or read the client's private state. The Read file-path
argument must equal that launch's declared path. Do not strip separators,
normalize a foreign path into a match or accept substring ownership. Missing,
duplicate, malformed or shared handles/paths fail.

Read must be issued after its launch result was received and after that child's
final observed response body completed, and its tool result must arrive later
on the parent actor with a successful error flag. The Read result must contain
that child's final assistant report, bound to the already observed owned child
HTTP end-turn response. Parse the actual public Read response's record/line
format and distinguish assistant content from user prompts, tool arguments and
earlier tool results; do not accept a substring search for output labels, since
the initial task prompt already contains them. Require one unambiguous matching
final assistant record, after the child's execution records, containing both
outputs. Keep the four independent Bash execution receipts as well. A result
containing only the prompt, a quoted report, an early partial read, a read
belonging to the other child, missing
second output, wrong actor, preissued result or a foreground Agent report fails.
Only inspect these public client request/tool-response frames in memory; do not
open SDK transcript/session files or emit paths, IDs, prompts or model prose.
If completion notifications are used to trigger Read, observe their actual
public shape and bind task ID/path/status to this same launch. Merely seeing a
notification or a matching-looking path is not completion evidence.

The native-result rule is separately versioned. Successful results retain all
existing flag/model/positive-usage/cost/session/MCP/hook/HTTP/iterator checks.
For a capped tool handoff, allow the measured counter-two form only for the
qualified SDK 0.2.141/native 2.1.284 or 2.1.295 tuples, maxTurns exactly one,
`error_max_turns`, boolean is_error true, a valid max-turn terminal reason,
one complete distinct public model-message generation, and the owned canonical
HTTP tool terminal with exact hook custody. Do not raise the production cap,
accept an arbitrary error or treat the native counter alone as authority.
Missing IDs, overflow, conflicting tool ownership, uncorrelated hooks, zero or
multiple public generations, an unknown tuple or malformed flags remain
failures. Keep native counters and distinct-generation facts separately in the
report; counter-one compatibility must itself be qualified rather than assumed.
The runtime control proves actual API counts only for scripted responses; the
real-model gate reports observed public generation bounds and that limitation.

Before running a native model case, add direct pure controls for ownership,
ordering and result classification, plus an integration control through the
maintained harness. Positive controls must pass for source/installed supported
tuples with multiple fragments from one model-message ID. Negatives must reject
two generations despite counter two, missing/foreign generation IDs, map
overflow, orphan/conflicting hooks, wrong tuple/cap, malformed result flags,
unrelated result errors, wrong canonical HTTP terminal, absent/shared/swapped
launch paths, output from another child, early/preissued completion, missing
outputs, prompt-only output with both labels, a quoted or foreign final report,
incomplete child final response, changed commands, reused tool IDs,
missing routing receipts, borrowed parent state, serial children and parent work
after children finish. The original strict counter-two failure must still fail
in original foreground/background modes.

Run the full final local code gates after these changes, then prepare zero-query
source and installed rehearsals with original owned-process, private grant,
read-only identity and physical cleanup witnesses. Execute the same actual
client/model assertions on unchanged baseline and candidate source; require
meaningful prior lineage defects on the baseline and the full asserted flow on
the candidate. Admit the independently installed package only after source
audit passes. Preserve every failed attempt; no unexplained green rerun or
weaker fixture establishes a fix. Final-head CI remains independent. Keep the
historical long lease wait un-attributed and all other held scenarios explicit.
