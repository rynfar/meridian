# Scoped root adversarial review: independent background controls

Disposition: TEST_CORRECTION_FIT; WHOLE_CHANGE_HELD.

The failed exact-ed3 full gate is preserved verbatim: 5,548 pass, 36 skip, one failure/error; npm exit 1. The failing aggregate test executed four serial independently bounded harnesses under one 30-second test deadline. Each harness has a 10-second execution allowance plus joined cleanup. This deadline cannot cover all permitted serial delays. The baseline isolated test passes; this does not erase its failed full-load run.

The correction creates four separately named tests with the same 30-second per-test deadline, original modes, default 10-second harness bound, and all five original case assertions. The shared run function is unchanged: it joins the original harness and both pipes; checks synthetic-only acceptance, unchanged grant, every owned client join/exit/close/pipe settlement and signal failure, empty cleanup errors and removed owned private runtime. Splitting the test does not make incorrect task ownership, unbounded waits, missing completion or early completion acceptable.

Adversarial checks: compared every old mode/assertion to its replacement; verified each mode occurs once and labels are unique; confirmed no harness, application, fixture or acceptance predicate changes. The targeted four cases pass, with 128 assertions. Original focused/typecheck command session 46288 exited 0. The broader previously launched name-filter run passes 13 cases/407 assertions; its missing process handle is treated as terminal, not as a reason to restart it. Full clean-head npm test/typecheck/build must follow the commit.

No delegated review or whole-change acceptance is asserted. R11/R15 unexplained native-stop failures, wider cancellation/reporter/client/platform gates and exact delivery-head CI remain open. Passing R16/R17 diagnostic-overlay cases do not establish their cause.
