# Complete-generation interrupt before final hook denial

Existing draft #1322 continues oldest original #1211. This packet qualifies a
public SDK/native mechanism; implementation and whole-change acceptance remain
HELD. Production, active observers, tests, package, plugin, lockfile, budgets and
canonical acceptance are unchanged at reviewed delivery `20336b22` and production
`15f44351`. The [qualification](QUALIFICATION.json) and
[adversarial review](ROOT_REVIEW.md) retain these limits.

The [all-held attempt](held-source/RESULTS.json) failed without completed case
facts. Its API count was not retained. The
[diagnostic follow-up](held-source-observed/RESULTS.json) also failed: one API
round, both complete public tool blocks and assistant metadata, but only the
first hook was dispatched and held. No interrupt was requested. Holding every
denial while waiting for every hook can prevent the later hooks from arriving.
Both failures and their original execution receipts remain here; neither fork
case ran.

The [terminal-hook source probe](held-terminal-source/RESULTS.json) releases
prefix denials only after the complete generation and metadata. It retains the
last observed hook until the owned public interrupt acknowledges, then releases
it. Its [installed-native counterpart](held-terminal-installed/RESULTS.json)
uses identical observer bytes. Both avoid another API round and preserve a
supported public fork. These first probes used the fixture's known call set in
their trigger, so they alone do not qualify a production boundary.

The final [source](public-terminal-source/RESULTS.json) and
[installed-native](public-terminal-installed/RESULTS.json) probes instead decide
from public stream IDs, all block closures, complete assistant metadata from
the same generation with its UUID, and the exact owned hook IDs and privately
matched inputs. The fixture's response IDs/count do not define stop completeness;
metadata membership is independently asserted during observation and counts
are checked after the result. Both use SDK 0.2.141; natives are 2.1.284 and 2.1.295. Each interrupted
query makes one directly counted API round, observes both tool results once,
and returns `error_during_execution`, `is_error: true`, `aborted_tools`, native
`num_turns: 4` and native exit one. The SDK iterator error exactly matches the
preceding result errors privately. The existing canonical predicate still
rejects the interrupted result.

After the original native and stdio physically join, public `getSessionMessages`
contains both calls once and the checkpoint UUID. Each subsequent fork makes
one API round, succeeds in a distinct session, contains both real client
results once without the denial tail, and leaves the original public history
JSON exactly unchanged. No private transcript file is inspected.

Ten exploratory SDK queries ran in six network-disabled containers. Nine API
rounds were directly recorded; the first failed probe's count is unknown, so no
aggregate round count is inferred. All original drivers, attachments, native
processes, stdio, iterators and listeners join; owned private runtimes and stopped
containers are removed. [Process receipts](PROCESS_JOINS.json) retain every
original handle. Zero real credential reads or model calls occurred. The
installed arms use installed SDK/native with frozen **source query options**;
they do not run the installed proxy or actual client.

Every arm escrows its exact runnable observer, dependencies, controller, frozen
input identities, original invocation and terminal facts. Replay requires the
qualified local image
`sha256:f1db2086f5f9bec7a0ad7bc034288d18093d943ba444d7f8d47e12792b421eb5`
and its exact source/installed artifact paths. Copy the selected arm into a fresh
evidence directory, create its empty `output/` directory, then run
`python3 run-control.py`; retain the original receipts unchanged. This is a Linux x64/Bun 1.3.11
discovery, not arbitrary-platform acceptance. The previous
[full local gates](../1211-handback-diagnostics-interrupt-20261009/LOCAL_GATES.json)
remain applicable to unchanged active code: 5,889 pass, 36 skip, zero fail,
typecheck and build pass. This documentation packet uses content, syntax, link,
identity and diff validation.

The [next implementation contract](PRODUCTION_STOP_CONTRACT.md) replaces the
all-held premise with completed-prefix release and a retained final hook. Its
attempt ownership, result/session/error binding, lifecycle failures, negative
controls and integrated verification are still required. The actual
[mixed-source failure](../1211-mixed-auto-handback-20261009/README.md) remains
24/27. All handback, cancellation/parent-abort, caption/reporter, platform/client,
package and final-head CI holds remain. Auth renewal is not assumed; use
`meridian profile login work` before a new authorized credential-bound run.
No new PR/worktree, merge, source closure, release or external comment follows.
