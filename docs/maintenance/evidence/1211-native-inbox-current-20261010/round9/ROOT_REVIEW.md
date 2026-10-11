Scoped adversarial review of e8c3002f diagnostics

The source target stays at 6d773781; production remains bae7ada3. The only code delta adds public scalar handback encoding facts, exposes them beside existing facts, and adds four direct tests. Full acceptance predicates, fixture prompts, scenario, SDK/native/client pins, request/cost/time bounds and installed admission remain unchanged.

Falsification checks: raw expected input alone satisfies the existing strict predicate; JSON-quoted, literal-backslash-newline, CRLF, trailing-linefeed, different report, nested/array/prose JSON, empty/missing and oversized input do not gain acceptance. Direct whole JSON delivery can be diagnosed separately from fixture equality. Serialized summaries contain no input, report, actor identifier or generated prose. The helper does not read private SDK storage or normalize values for acceptance.

Fifteen selected tests pass, with 26 deliberately filtered out; typecheck passes. The earlier lost test handle is missing, so its result is not used; the logged repeat is the authoritative focused gate. Full stable-head gates and actual diagnostic run remain separate. This is a root scoped review, not a delegated review or whole-change acceptance.

The R8 actual source run FAIL remains authoritative (25/27). All eight owned stops qualify, but exact handback input/delivery do not. Both offline rehearsals pass; installed live remains unexecuted. The diagnostic run can identify a cause; an unexplained passing rerun cannot establish a fix. No merge, closure or release is authorized by this review.
