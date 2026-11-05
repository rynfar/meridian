# 1.89.0 release — publication paused

Owner authorized release after #1220 merged, then new PR/issue backlog. Candidate `e6c5604309fb9aa870e1200321cde4e1072aa3c8` / mergedmain`41d7b3e3a2ead7e95e2790cc473b469bd3e9b567`. Nowaker credit and synchronous-boundary notes corrected. No publication yet.

## Current gates
- Final-head CI42073931849 and relevant Windows/Docker/desktop/Nixchecks PASS. [Receipt](finalhead-ci-receipt.json).
- Full localnpm **8293pass/65skip/1fail**, live lifecycle candidate at reservedNULmigration. Later27groups not reached. [Redreceipt](final-local-failure-receipt.json), original[log](final-local-failed-npm-test.log.gz). Independenttypecheck/certifiedbuildpass is notfullsuitepass.
- Independent review proves a mutable-test-directory GC drift mechanism, not originalcaller attribution. [Review](lock-residue-independent-review.md). [Heldforeigncandidatecontrol](contract-isolation-control-receipt.json): sameprocessmigrationrefuses, isolatedunchangedcontract6/0whileheld, parentmigrationREADYafterGCjoined. Narrowtestprocessisolation **#1507**`d0904187c89631a459fa60a112332632b7fd75c4` validating fullnpm/typecheck/build+CI42078024708. No runtime/dependency/assertion/deadline/constantchange. [Plan](test-isolation-correction-plan.json), [implementation](contract-isolation-implementation.md).
- Independenttarball703artifactSHA+integrityPASS; [packagedNode22runtime](candidate-packaged-runtime-receipt.json)PASS migration/twoHTTP/restart/export/SIGKILL/bootstrap. [E79all6fixturecases](candidate-e79-receipt.json)PASS actualPi1.4/OpenCode2.2+matchingintegrations. Scriptedupstream, notlive-modelstopproof.
- CandidateactualOpenCodeV1/SDK.141/native.296/Opus5.5read/result/continuation **NOTRUN**: freshreadonlyusageHTTP429beforeinference. [Receipt](candidate-actualclient-blocked-receipt.json). No refresh/ownercredentialwrites/modelcalls. InitialpreflighthelperreuseEEXISTpreserved; freshwriteonceoutputreceiptHTTP429.

## Retained scope
[Full-range source review](full-range-final-review.md) foundno newmaterialruntimebug. [Namedcoveragegaps](range-review-receipt.json)remainvisible, notnewpasses. Previousowneraccepted#1220risks preserved. No providercontact. [Nextqueue](../next-backlog-20261105/README.md)helduntilreleaseisstable.

Next: finish#1507gates/review, normalexactheadsquash, refreshReleasePleasehead andfinalheadgates; actualclient evidence remainsopen. NormalReleasePleasepublicationonlyaftergates; thenregistryintegrity/provenance/freshinstall/client,Dockerarchitectures/tags anddesktopverification. No manualversion/tag/npmpublication.
