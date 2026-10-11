# E72 independent owned-interrupt observer — R7

Existing draft #1322 continues oldest original #1211. Observer/test code is
`052c6449ea1d9055164212d32c63bdea1388caaa`; production remains `bae7ada3`.
This packet qualifies only the opt-in observer and offline native integration.
Whole-change, affected-client/model and merge acceptance remain held.

The maintained harness accepts `--checkpoint-protocol owned-interrupt-v1`.
It witnesses public Query events, original hook invocation/return, public
interrupt call/settlement, the exact result and corresponding iterator error,
iterator settlement and close. It independently requires complete generation,
closed blocks, tool metadata/UUID, matching session/name/JSON inputs, the final
retained hook, acknowledgement before that hook returns, every denial result
once, and unchanged generation cap. It neither invokes the production controller
nor trusts its qualification log. HTTP/tool/model/client/cost/custody gates remain
additional requirements. Private IDs, inputs and error prose stay in memory;
the observer summary and proof contain scalar facts.

The flag is optional; existing legacy counter predicates are unchanged. Native
2.1.296 is admitted only through this explicitly versioned protocol with SDK
0.2.141. The version selector also retains the historical 2.1.295 tuple as
eligible, but the new observer on native 2.1.295 remains UNEXECUTED; this packet
runs only 2.1.284 and 2.1.296. Eligibility is not runtime acceptance. The strict mixed
handback delivery predicate is unchanged. Choosing the new terminal protocol
does not accept a structured handback that previously failed delivery.

`runs/native-source` remains **FAIL**, despite four successful original product
cases: the observer incorrectly required a buffered denial result to arrive
after its awaiting hook wrapper settled. SDK event delivery and callback promise
settlement are separate public channels. Corrected ordering retains the result
privately and requires the eventual exact hook output. Unit controls reproduce
that scheduling order and reject an eventual unrelated refusal. Adversarial
inspection also separated the final retained hook's acknowledgement requirement
from earlier prefix wrappers settling during the control call. Both corrections
have explicit negative controls; the failed native run is preserved.

Final `runs/native-source-final` and `runs/native-installed-final` use the exact
committed observer and each pass one/three tools × stream/nonstream. Four owned
stops and four successful continuations per arm retain exact calls/results,
public UUID, distinct durable fork, unchanged supported source history and no
denial tail. Source uses SDK0.2.141/native2.1.284; installed uses
SDK0.2.141/native2.1.296 and its actual package entrypoint. Forty native SDK/API
requests across all five recorded runs are directly witnessed. No real grant,
model or coding client ran. Every original attach joined, input hashes matched,
container/runtime was removed and native census was empty. The setup-copy
permission failure preceded any query and is recorded separately.

Maintained-harness synthetic positive and unrelated-error negative each retain
thirteen fake SDK queries and physical driver/client/relay cleanup receipts.
The fake product deliberately consumes an unrelated error; nativeReceipts still
fails. Synthetic controls cannot establish real client/model acceptance.

Replay in a fresh owned output directory with the retained exact local images:

```sh
python3 docs/maintenance/evidence/1211-owned-observer-20261009/replay.py --arm integrated-http-source-textdecode --image sha256:5c6c12b979458a102211392bee139ae1803c8d6d699c1d8c7d5bf6b89e5bf2d1 --output /absolute/fresh/source-proof
python3 docs/maintenance/evidence/1211-owned-observer-20261009/replay.py --arm integrated-http-installed --image sha256:832db10cd5ea47922e0e5199daf383051bfa1e5c991940e8685b98b4af3bb1a9 --output /absolute/fresh/installed-proof
```

The [prior packet](../1211-attempt-owned-stop-20261009/README.md) owns those images' reproducible build contexts and installed
package identity. This replay mounts only frozen fixture code, a synthetic
machine-id and owned output; network is disabled and root is read-only.

Renewal of `work` is **not assumed** (`meridian profile login work`). Prior actual
mixed source stays FAIL 24/27. Actual changed-code E41/E71/E72, handback delivery,
cancellation/parent-abort independence, caption/reporter, broader client/platform/
package, historical count/wait attribution and final-head CI remain open. Owner
checkout/index/twelve dirty files and eighteen authored records remain exact.
No new PR/worktree, source closure, merge, release or community comment.

[Final local gates](final-local-gates/LOCAL_GATES.json) at clean `052c6449`: **5,972 pass / 36 skip / zero fail**, twenty-two isolated npm batches plus pretest, standalone typecheck/build pass. All original processes joined. [Scoped root review](ROOT_REVIEW.md) records findings/corrections; [source identity](SOURCE_IDENTITY.json) and exact packet manifest preserve the reviewed bytes.
