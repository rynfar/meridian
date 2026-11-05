# Final #1505 local gate — bounded diagnosis

Final source93b188f6 local npm test fails group0:8247pass/65skip/2fail.
Its exact-head required CI test passes. Local failure remains a gate.

- [Fingerprint static findings](fingerprint-static-findings.md): post-build full
  source snapshot exceeds unchanged2s bound. Preflight/pre-build snapshots passed;
  the stack crosses in consume after a read, before hashing the current chunk.
  Real scheduling/I/O/CPU/input cause is not established. One metadata-only frozen
  preload build is proposed; no production deadline or partial certification.
- [Concurrent static findings](concurrent-static-findings.md): all request/ownership
  assertions pass, GC cleanup exceeds5s, backend later joins same maintenance.
  Shared whole-store sweep and actual host transcript locators are a concrete
  isolation hole; exact delayed resource/phase is unresolved. It is not evidence
  of a permanent child leak, async-context bug or model-pin cause.
- Independent test-only changes narrow the CLI behavior tests to their real Node
  entrypoint and move concurrent ownership cases into an explicit isolated test
  process with owned namespaces. The changes keep original behavioral assertions
  and deadlines; their tests/review/full gate are not yet complete.
- The [independently installed actual packaged Node CLI](packaged-cli-lifecycle.json)
  passes original lifecycle assertions on Node22.22.3 through two migration cycles.
  [Exact no-model harness](packaged-cli-lifecycle.mjs). This separate package check
  prevents a narrow test bundle from masquerading as packaging evidence.

#1504 remains merged; #1505/#1220 remain unmerged and release conditional.
No E41 matrix continuation or new live model call follows these failures.
