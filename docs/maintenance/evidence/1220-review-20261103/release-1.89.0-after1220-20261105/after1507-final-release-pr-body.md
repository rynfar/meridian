:robot: I have created a release *beep* *boop*
---


## [1.89.0](https://github.com/rynfar/meridian/compare/meridian-v1.88.0...meridian-v1.89.0) (2026-11-05)


### Features

* keep a stopped turn's session when the client discarded its output ([#1480](https://github.com/rynfar/meridian/issues/1480)) ([3a700e3](https://github.com/rynfar/meridian/commit/3a700e365fef08b4549642746a9ccbf59c64d95e))


### Bug Fixes

* avoid occupied store-lock writes and isolate native test fixtures ([#1506](https://github.com/rynfar/meridian/issues/1506)) ([2297d61](https://github.com/rynfar/meridian/commit/2297d61e4f157ad6448dc787c64849f565f4377f))
* keep explicit models on refusal fallback ([#1505](https://github.com/rynfar/meridian/issues/1505)) ([16c2149](https://github.com/rynfar/meridian/commit/16c214941bf3f05aa4015a70d8b81bd94857a88f))
* **session:** make JSON session-store lock waits and durable filesystem writes asynchronous to reduce stalls for other requests; reads, parsing and serialization remain synchronous ([#1220](https://github.com/rynfar/meridian/pull/1220)) ([63f5419](https://github.com/rynfar/meridian/commit/63f54197)); thanks to [@Nowaker](https://github.com/Nowaker).
* **session:** clear repopulated cache entries at the durable cleanup boundary and invalidate evicted JSON cache entries after durable commit ([5721c3d](https://github.com/rynfar/meridian/commit/5721c3db)) ([67d02f5](https://github.com/rynfar/meridian/commit/67d02f56ba69b7e738aea67119ba5b1376ef0db0))

## [1.88.0](https://github.com/rynfar/meridian/compare/meridian-v1.87.0...meridian-v1.88.0) (2026-11-02)

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).

---

## Maintainer release qualification — 2026-11-05

Owner explicitly authorized 1.89.0 after #1220. Current final candidate **`f4c1dcbcfd8c2d01cfd3c4eaa49479c25560aef2`**, base **`cafdcf780f1b40c8f0dee17481132f47b4cbb353`**. Corrected Nowaker/#1220 notes and accurate synchronous-read/parse/serialization boundary retained after Release Please regeneration. No runtime/dependency/version change beyond the planned1.89.0bump.

**#1507 merged** at`cafdcf780f1b40c8f0dee17481132f47b4cbb353`: mandatory unchanged6contracttests now run in their own Bunprocess. Final local8857pass/65skip/0fail/29groups+typecheck/certifiedbuild and CI8894pass/28skip/0fail/29groups pass. Normalexactheadsquash; signedlandedtreeequalsreviewed. Originalreleasefullsuite8293/65skip/1failarchived. Heldforeigncandidatecontrolprovesisolationboundary, nothistoricalcallerattribution. No assertion/deadline/constant/runtimechange.

Fresh exact-release-head full localnpm→typecheck→build and hostedCI are running. Independentdelta review underway. Priorcandidate703artifacthash/integrity, Node22packagedstorage/recovery and all6E79model-freefixtures passed; actualPi1.4.0extension/OpenCode2.2.0generationmatchingV2config+runtimeheader witnesses retained. These are notreal-modelstopproof.

**LivecandidateOpenCode1.18.34/V1/scrub0.3.0/SDK.141/native.296/Opus5.5read/result/continuationNOTRUN**: freshreadonlyusageHTTP429beforeinference. No credentialrefresh/ownerwrites/modelcall. EarlierHTTP200ExtraUsageOFFnotfreshproof. Knownowneraccepted#1220current/historicalverificationrisks remain named, notfixed/passed. Additionalunqualifiedpublication/E71/E72/awaitedclear/real-modelstopextensions retained. Providercontactdeclined.

**Publication has not started.** Actualclientgate remains open; afterfinalgates use normalexactheadReleasePleasemergeonly, thenverifytag/npmversionlatestintegrityprovenance/freshregistryinstalledflow/Dockerarchitectures+tags/desktop separately. Nextauthorizedqueue helduntilreleasestable.

[Durablereleaseevidence](https://github.com/rynfar/meridian/tree/docs/review-1220-20261103/docs/maintenance/evidence/1220-review-20261103/release-1.89.0-after1220-20261105), [currenthandoff](https://github.com/rynfar/meridian/blob/docs/review-1220-20261103/docs/maintenance/REVIEW_HANDOFF.md).
