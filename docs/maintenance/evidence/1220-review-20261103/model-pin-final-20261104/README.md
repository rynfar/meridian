# Model-pin final acceptance after supporting merge

Exact head`5708dfd19062e4aff35d284e7971661fd11d8bf6` over accepted main`2297d61e4f157ad6448dc787c64849f565f4377f`. Additive main integration only; all four product/spec/test hashes unchanged from prior review. Source delta is only the explicit-versioned-model refusal alternate-model opt-out; genuine refusals/same-model retries/SDK fallback/aliases remain unchanged. No externally injected opt-out in final actual-client verification.

Full local npm/typecheck/certified build and required CI`41796586620` running; final installed actual OpenCode flow followsbuild. Oldlocalred retained in earlier evidence; no limit/SQLite/cachefloor weakening or speculative fingerprint fix. #1220 remainsunmerged, original E41/historicalacceptance notclaimed.

## Corrected final head `19bf2128916c6aefc9e7128011bc9c201de27a07`

The previous final local gate failed group0:8270pass/65skip/1fail; shell hook quoting test spawned Bun via process.execPath, then hit unchanged5s bound withoutoutput. Latergroups/typecheck/build skipped. Failure retained. Concrete fixture mismatch: shipped package is Node, but that quoting test launched Bun. The test now resolves actual Node viaBun.which, preserves platform shell/quoted space-containing script/5000ms/percentnegative, and adds marker+Node-version+noBunwitness. Same witness with originalBunexecutable fails5pass/1fail (observesBun1.3.14); correctedNode6pass/0fail+typecheck. This proves runtimechoice, notcauseoftheblankoutputhang.

Only testfixture changes after5708dfd1; fourproduct/spec/testhashesremainunchanged. Freshcorrectedfullnpm/typecheck/certifiedbuildandCI41798125923running. Actualinstalledclientpendingcertifiedbuild. No timeoutincrease/productionchange/greenretry; exact red/green logs and receipts retained.

## Corrected local acceptance PASS

Finalhead`19bf2128916c6aefc9e7128011bc9c201de27a07` full local28processes **8829pass/65skip/0fail**, typecheck and **certified build PASS** fromcleanvalidation.noindexcheckout. [Localreceipt](corrected-local-receipt.json) and [buildprovenance](corrected-build-provenance.json) retainexactidentity. IndependentlyinstalledcertifiedpackagewithexactSDK0.2.141isnowrunningactualOpenCode1.18.34/native2.1.296/Opus5.5qualificationwithfrozenhelper,matchingV1plugin+scrub0.3.0,nativepin/flagwitness,readonlyaccess-onlygrant/includedusage. Noexternallyinjectedno-switchflag. RequiredcorrectedCI andactualclientmustbothpassbeforemerge.

## Final corrected gates and external authentication hold

RequiredCI41798125923 **PASS8866pass/28skip/0fail**,28processes plusadditionalprobes/build; full local **8829pass/65skip/0fail**,typecheck+certifiedbuildPASS. Independent finalproduct and Nodefixture reviewsfindnomaterialissue.

Finalcertifiedartifact independentlyinstalledwithSDK0.2.141; actualOpenCode1.18.34/native2.1.296/5.5 gate **FAIL_AUTHENTICATION**: officialnative reports **“Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.”** MatchingV1plugin/config/routing/session+agentheaders andscrub0.3.0wereverifiedfirst; bothnativegatescontainproduct5.5pin/flag1,observererrors0,andalloriginalchildren/pipesjoined. No modelcompletion/history/continuationacceptance. No retry/refresh/credentialwrite/paidfallback/alternateaccount. The olderrorclassification api_error is not a safety-refusal finding. [Exact sanitized auth failure](actual-client-auth-failure.json), [frozen helper/report/diagnostic proof](actual-client-auth-failure-proof.tar.gz), [memberhashes](actual-client-proof-manifest.json).

Ownerwasaskedtonormallysigninagainwithsameaccount,keepExtraUsageoff,notpasteatoken. No #1505/#1220mergeorreleasebeforemissinglivegateisresolved. Independentaccepted-mainintegration/localchecksfor#1220continue; maintainerPR1505sourceisnotcopiedtocontributorbranchbeforeacceptance.
