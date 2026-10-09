# Scoped adversarial review: owned checkpoint interruption

Reviewed production delta `46ff481f..bae7ada3`, including all seven main/fresh/
silent-recovery call sites, the new internal control and its direct/HTTP tests.
This is a root adversarial pass, not a delegated review or whole-change approval.
The previous mixed source failure and all inherited acceptance holds remain.

Three material objections against initial implementation `44ae1bc2` were confirmed
and corrected in separate maintainer commit `bae7ada3`:

1. Mixed SDK-owned/forwarded work faulted on its client hook, replacing the normal
   SDK drain with a proxy error. It now skips that generation's control, releases
   holds and permits a later supported root generation. The original pure
   reproduction and failing regression assertion are retained.
2. Nested SDK events faulted even before stop intent. Pre-intent nested events
   and native subagent hooks now suppress control without replacing native work.
   Nested work after retained intent still refuses qualification. Hook session
   identity must match the admitted init session; a matching ID/input from another
   session cannot request control.
3. Native turn counters were incorrectly bounded by the API-generation cap; the
   HTTP positive invented a native count equal to cap one. The original native
   cap-one run FAILs with acknowledged owned interruption, one provider request,
   both results/history and physical joins, but rejected `error_max_turns` /
   `aborted_tools` / count two. The corrected cap-one tuple requires that exact
   subtype/count, one observed generation, session/intent/ack and exact iterator
   cause. Ordinary max-turn reasons, unrelated transport/exit errors, missing
   results, wrong flags/session/reason and caller abort still fail.

The independent native matrix observes one API request in all eight cap/tool
combinations. Cap two/two tools reports four native turns; cap four/three tools
reports five. The original Query cap remains unchanged. Public-generation bounds
and complete block/metadata/hook sets are independently enforced. The former
counter-greater-than-cap unit assertion was invalidated by these exact receipts;
invalid-counter and over-cap-generation negatives remain. These observations do
not infer historical real-provider counts from SDK counters or generation IDs.

Reviewed stale callbacks, serial/reversed/concurrent dispatch, input identity,
assistant metadata snapshots, missing UUID/blocks/hooks, internal discovery,
operator cap and kill switch, pre-intent native errors, acknowledgement failure/
timeout/terminal races, caller abort and cleanup failures. Each admitted Query
gets a private control; retirement is synchronous before cleanup awaits. Raw
pending control cannot claim a join. Unjoined native/control custody retains the
transcript fence; a cleanup failure refuses publication and retains the first
attempt error as its cause. Customer inputs/native error text remain private;
only primitive qualification facts are logged. Dependencies point downward.
No public plugin/configuration contract, profile selection or production cap changes.

Forty-six focused tests and typecheck pass. Real SDK/native component and integrated
scripted-provider source/independently installed package probes pass their stated
scope. The source/package integrated observer preserves its initial machine-id
failure and missing-text-delta failure; the latter has an isolated before/after
decoder reproduction. No test success erases either failed original attempt.
The first full-suite run overlapped source correction and is unqualified; its two
HTTP failures remain. Stable-head final gates pass at `bae7ada3`: 5,935 pass / 36 skip / zero fail,
all 22 isolated npm batches plus pretest; standalone typecheck/build pass,
all original processes join. [Exact receipts](final-local-gates/LOCAL_GATES.json).

No material objection remains to this scoped correction from this review. Actual
model/client acceptance, mixed handback, cancellation/parent abort, caption/reporter,
broader platform/package and final-head CI are still open. Do not merge, close
source PRs or publish on the strength of this offline packet.
