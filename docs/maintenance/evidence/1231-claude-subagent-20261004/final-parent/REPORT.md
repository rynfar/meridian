# Final-parent native Agent local gate escrow

Exact clean tested source `aff1f20125e9c9b8320e2a03fc0b7f02c49ff8a7`, tree `1d9125f77601c0f48ba4efe6b7fea72bd0c06c7a`, is stacked
on approved final auxiliary parent `e731a2dfae4931d0c7718e99098cc4ab4a3355a2`. [REBASE.json](REBASE.json)
preserves the five source/initial/final author mappings and sixteen unchanged
Author/AuthorDate/subject tuples. The original 139 non-E2E layer files and parent
E71 section/source/test survived the rebase. E2E `3cd83e74` belongs to exact
rebase `1f754311`; current qualified E2E `6e357ea7fea1d7bcd31c17e96d16ffea738d8b6d21ce8aab8c3a465005958db2` belongs
to the subsequent documentation-only `aff1f201` supplement.

## Executed gates

All seven commands below observed process termination with exit 0 and all 1,448
frozen tracked source files unchanged. [GATES.json](GATES.json) preserves commands,
PIDs, elapsed time, log hashes and raw-to-gzip mappings; [GATE_ARTIFACTS.json](GATE_ARTIFACTS.json)
seals every selected artifact. Original logs are unchanged inside deterministic gzip.

| Gate | Result |
| --- | --- |
| Focused identity/tree/namespace/adapter (five files) | 86 pass / 231 assertions |
| Focused mocked-SDK HTTP cancellation/mapping | 8 pass / 144 assertions |
| Complete E72 synthetic harness | 27 pass / 913 assertions |
| Focused standalone typecheck | exit 0 |
| Full `npm test` with pretest typechecking, 19 stages | **5,502 pass / 36 skip / 0 fail / 29,310 assertions**, 629.634 seconds |
| Final standalone `npm run typecheck` | exit 0, 5.246 seconds |
| Final `npm run build` | exit 0, 4.341 seconds |

The full skip count is 35 established suite skips plus the opt-in E71 compiled
context control. Parent compiled controls remain attributed to their exact
parent; this child run does not claim that skipped current compiled control
executed. All synthetic harness acceptance stays false. No first failure or
rerun occurred in these seven frozen-head commands.

The original freeze's Darwin/x86_64 is Python-wrapper metadata. Actual Node
**22.22.3** and Bun **1.3.14** both report **Darwin/arm64**, with exact public
executable hashes retained in [runtime identities](local-gates/actual-runtime-identities.json).
Installed public packages are Agent SDK **0.2.141**, Claude Code **2.1.284**,
TypeScript **5.9.3** and libsql **0.5.29**. Local checks do not establish Linux
x64 native acceptance.

Fresh build certificate `236121e903e60819bc2d06a688878860633c6772367e40ef1a17a74d5769fad5` identifies clean
`aff1f201`, source hash `90ff72ed756eaba550a56ad2afcdc8e8bdfafa8367dada315a699038bb015b52`. The actual Git build-store record
and **all 409 actual dist files** match its artifact inventory, independently
rechecked from Python. Seven owned gate process groups have no remaining member.
The certificate and detailed verification are preserved as exact raw archives.

## Review and delivery qualification

[Independent audit](independent-audit/AUDIT.md) at exact `aff1f201` passes the
rebase, authorship and public-boundary review, verifies 139 child paths, 1,307
unaffected parent objects, all 74 original snapshot artifacts and original
failure/source mappings. Its full-gates-pending wording is historical: the
terminal results above occurred later and are preserved separately. Its two
metadata actions are resolved by actual Node/Bun identities and the final
reviewable PR body. Original audit bytes and SHA `be13e954cf9f6840f1e857ff5efdf60ac3615014ee67cc99e6b584c40f0a120a`
remain unchanged.

[TESTED_SOURCE_IDENTITIES.json](TESTED_SOURCE_IDENTITIES.json) records all tested
code, scripts, E2E/package/architecture/design identities. The final escrow
commit contains maintenance evidence only. These results and the fresh build
belong to actual tested `aff1f201`; they are not relabeled as a build of the later
documentation head. Before a future compiled native run, build the exact clean
selected target and require its matching certificate.

Actual Linux x64 / CLI2.1.287 / SDK0.2.141 / exact requested+served Sonnet E72
baseline/fixed, background overlap, mixed-auto traffic, root/scoped/nested cancel,
incidental abort independence and all E41 modes remain acceptance gates. Current
E72 foreground/default-permission model checks remain unchanged. SQL namespace
codec/facade reconciliation is separately held. Required exact final-head CI
remains a merge gate after draft publication. Source #1231 stays open. No
native/auth/model/login, private-history access, GitHub mutation or release was
performed by this delivery task.
