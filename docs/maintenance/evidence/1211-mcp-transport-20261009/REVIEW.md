# Root adversarial increment review

Disposition: bounded per-query MCP source correction and native transport controls
qualified; whole-change live/client/package/final-head CI acceptance held.

The production change replaces one cached SDK MCP server with cached tool
definitions and a server factory. `buildQueryOptions` constructs an instance per
query. Both streaming and nonstreaming retry loops construct options inside the
attempt loop, so retry admission cannot reconnect the previous instance. Namespace,
allowed tool names, schemas, aliases and defer decisions remain unchanged.
`server.ts` changes comments/log terminology only. No exported plugin API changes.

The unchanged native probe and deliberate shared-server negative control fail for
the same observed cause; the corrected overlap succeeds with the same complete
first catalog. Canonical result success alone would miss the original tool loss,
so catalog and native server readiness assertions are material. Cancellation,
failed start, timeout and forced-kill controls retain original process ownership.
Their evidence is local scripted transport, not external model acceptance.

One real full-suite finding was an obsolete caption server-identity assertion.
The separate maintainer test correction preserves definition ownership, verifies
all queried server identities differ, and retains independent caption definitions.
Focused42 cases/274 assertions and final full5,774/35/0 pass with typecheck/build.
The failed full attempt is retained instead of treating an unexplained rerun as a fix.

The fresh source15f snapshot and independently installed tarball match all432
compiled files and1,849 tracked source rows. Current693 only changes this test.
Both actual original E55 arms pass11 assertions each on exact Sonnet5-5/SDK141,
client287 and source284/installed295. Original closure and private cleanup facts
are audited. Actual MCP readiness per real query is not observed here.

Complete current delivery still inherits earlier source-only review scopes and
open acceptance gates. The previous E71/E72/E41 live results are retained at their
older production heads; current dependency code cannot borrow them. Current-head
E41/source-installed and impact-appropriate native side-call/cancellation proofs,
actual reporter tuple and final-head CI remain required before merge. No delegated
review, new PR, merge, source closure or release occurred. The owner's HEAD/index,
status and all twelve dirty-file identities remain unchanged; all eighteen
contributor raw Author/AuthorDate/full-message records are exact and in ancestry.
