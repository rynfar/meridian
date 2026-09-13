# Behavior verification

## Prove the fix and protect existing behavior

- Reproduce the actual defect before changing it whenever possible. Retain failed-before and passed-after evidence for the same meaningful assertion. A changed fixture or reduced assertion must be explained; an unreproduced bug stays explicitly unproven.
- Run targeted pure/unit tests and HTTP integration tests through the mocked SDK where appropriate. The full gate is `npm test`, not a bare all-files `bun test`: the npm script isolates process-global SDK/module mocks. Also run `npm run typecheck` and `npm run build`.
- Every accepted behavior change requires live E2E with the real SDK/model and affected client flow before it is called complete. Mocks alone do not prove a fix. Consult current [E2E.md](../../../../E2E.md); use the exact installed client/SDK/CLI versions and record them, flags, model, workdir, artifact, exit status and log path.
- For changes to passthrough, lineage, resume, tool hooks, or request identity, run all four E41 modes: sequential/parallel × streaming/nonstreaming. Check exact call/result pairing, durable resume/fork history, unchanged source history and cache continuity. For relevant V2 changes run E42 with each supported pinned beta, live extended flows and separate client/proxy working directories. Test both source and independently installed package when packaging/plugin behavior is involved.
- Include adversarial controls: ordinary success, invalid inputs, retry bounds, cancellation, concurrent sessions, changed requests and retained tool results as relevant. Test the actual implicated model and platform; Haiku success is not Opus validation, and POSIX path fixtures are not a real Windows run.
- Use isolated ports, config/session directories and fixture workdirs. Keep credentials and customer transcripts out of logs. Inspect SDK sessions only through supported APIs such as getSessionMessages/listSessions; never read or edit private SDK transcript files. Preserve failed logs as well as passing logs.
- Prefer committed E2E gates with their existing port reservation, auth and isolated state. Validate any new probe against a known-good control before treating its failure as a product defect.
- When a fix depends on runtime host/SDK object shape, inspect the actual shape rather than relying on a draft type or remembered API.
- Assert deterministic facts, not model wording. A gate that requires specific generated text fails at random; check the request, header, effort, status or recorded trace instead, and record the prose without asserting it.
- Do not call a flaky failure fixed because a rerun passes. Establish causality, otherwise retain an unresolved status and its limitation. If actual E2E is unavailable, record the missing requirement and leave the item incomplete rather than substituting mocks.
- Aim for no regressions and only useful improvements; state the evidence and remaining uncertainty instead of promising universal absence of bugs.
