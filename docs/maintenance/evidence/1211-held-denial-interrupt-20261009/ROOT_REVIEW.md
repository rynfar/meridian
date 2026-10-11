# Scoped adversarial review

Disposition: **MECHANISM_QUALIFIED_IMPLEMENTATION_AND_ACCEPTANCE_HELD**.
Reviewed delivery is `20336b22`; production remains `15f44351` and current main
`11dc1556`. This review covers the new runnable discovery packet, its changes
from the retained R4 probes, assertions, original execution receipts, supported
public history checks, and the proposed internal stop contract. It does not
accept the whole integration.

1. **All-held hook protocol can stall.** The initial query failed with no case
   facts. Adding bounded pre-cleanup diagnostics retained both complete tool
   blocks, both assistant metadata fragments and a UUID, but only one held hook
   and no interrupt through the case deadline. Holding that hook prevented the
   complete hook set from arriving in this pinned runtime. Both failures remain
   FAIL and their forks remain UNEXECUTED. The corrected probe releases completed
   prefix denials while retaining the final observed hook; source and installed
   native probes then complete with one API round per query. Do not infer that
   production hooks are always serial or have stream order.

2. **A fixture oracle cannot define production completeness.** The first
   terminal-hook correction used scripted response IDs and a known tool count
   in the trigger. Those controls alone were insufficient. The final exact-byte
   source/installed pair decides using public stream IDs, all block closures,
   same-generation assistant metadata and UUID, exact hook IDs and privately
   equal inputs. Fixture IDs/count do not define completeness. The observer
   also asserts fixture metadata membership during observation and counts after
   the result; production must omit that fixture-only identity assertion.
   Both owned iterator tool results appear once. These facts qualify a mechanism
   for this fixture, not production discovery-only, mixed internal-tool,
   advisor, structured-output, retry or cancellation paths.

3. **Interrupted errors remain errors until the integrated ownership proof
   exists.** Every interrupted result remains `error_during_execution` with
   `is_error: true`, `aborted_tools`, native count four and exit one. Existing
   acceptance is false. The probe retains exact preceding-result/iterator-error
   equality privately and joins native/stdio before public history reads. It
   does not establish production init/result session binding, attribution of
   every possible native error, or a general rule for `aborted_streaming`.
   Broad error suppression and a larger cap remain unacceptable corrections.

4. **Missing first-attempt count stays missing.** The first failure's API count
   was not escrowed. Later diagnostics cannot reconstruct it. The aggregate
   reports ten queries and nine directly recorded rounds plus one unknown
   attempt count, without inventing a total.

All six original drivers and attachments are terminal; all owned native/stdios,
iterators and listeners join; private runtimes and stopped containers are
removed. The final public forks preserve both tools and client results exactly
once, distinct session identity, and exact unchanged original history. Installed
arms use installed SDK/native with source options, not installed proxy execution.
No real credentials or models were used.

No material scoped packet finding remains after the oracle correction. The
production implementation and all prior product/affected-client/CI gates remain
open. Owner head/index/status/all twelve dirty-file identities and all eighteen
raw contributor Author/AuthorDate/full-message/ancestry records match. Expanded
#1231 remains excluded; original source reports stay open. No merge is authorized
by this discovery disposition.
