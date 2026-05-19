# ADR: Context-Window Optimization via md-codebase Progressive Disclosure

**Status:** Proposed  
**Date:** 2026-05-19  
**Deciders:** Davi (meridian project lead)  

---

## Problem Statement

Meridian forwards OpenCode requests to Claude Max with unfiltered CLAUDE.md context. Analysis shows:

1. **CLAUDE.md is ~160 lines** — well-written, but exceeds best practice (<300 ideal ~60)
2. **OpenCode agents get 100% context, use ~30%** — e.g., release/workflow docs irrelevant to code agents
3. **Each request pays full Token cost** — ~2-3K tokens of unneeded context per OpenCode→Meridian→Claude Max call
4. **No Progressive Disclosure** — task-specific docs (ARCHITECTURE.md, E2E.md) are referenced but not extracted from CLAUDE.md

**Root Cause:** Meridian acts as a passthrough proxy rather than applying md-codebase best practices to itself.

---

## Context: The md-codebase Pattern (2026)

Industry standard for agentic coding:
- **CLAUDE.md** stays lean (~50-100 lines): universally applicable rules only
- **Progressive Disclosure:** Task-specific guidance in separate files (ARCHITECTURE.md, DEFERRED.md, E2E.md)
- **Context Budget:** Frontier LLMs reliably follow 150-200 total instructions. System prompt ~50 → CLAUDE.md budget ~100-150
- **Token Impact:** Naive context + irrelevant detail = 20-30% performance + cost penalty

See `/home/claude/vault/wiki/living-seed/md-codebase.md` for full analysis.

---

## Proposed Decision

**Implement Progressive Disclosure on meridian's CLAUDE.md:**

1. **Refactor CLAUDE.md** (current ~160 lines → ~80 lines):
   - Keep: Module boundaries, Code rules (style + testing), Stable API Contract, Git workflow
   - Move to separate files:
     - `docs/ARCHITECTURE.md` → detailed module map + architectural decisions
     - `docs/AGENT-GUIDELINES.md` → agent-specific logic, adapter pattern details
     - Keep existing `E2E.md` (already referenced, already separate)

2. **Add Context-Budget Adapter** (~15 lines in `adapters/opencode.ts`):
   - Detect request type: "coding task" vs. "workflow/release"
   - For coding tasks: strip release/workflow docs from context
   - Impact: ~15-20% token reduction per OpenCode request

3. **Document decision in CLAUDE.md Section 0**:
   ```
   ## Context Strategy
   This proxy follows md-codebase patterns (2026). CLAUDE.md is kept lean;
   task-specific guidance lives in docs/ files. OpenCode adapters apply
   Progressive Disclosure to optimize context window.
   ```

---

## Technical Breakdown

### Phase 1: Refactor CLAUDE.md (~30 min)

**Before:** 160 lines  
**After:** ~80 lines  

Move these sections:
- Lines 50-68 (Architecture Quick Reference) → `docs/ARCHITECTURE.md`
- Lines 26-32 (Agent-Specific Logic details) → `docs/AGENT-GUIDELINES.md`
- Keep: Commands, Code Rules (essential), Stable API Contract, Git Workflow, Releasing

**Files to create:**
- `docs/ARCHITECTURE.md` — module map + design patterns (copy from CLAUDE.md lines 50-68, expand)
- `docs/AGENT-GUIDELINES.md` — OpenCode/ForgeCode differences, adapter pattern, future work

### Phase 2: Add Context-Budget Adapter (~20 min)

In `adapters/opencode.ts`, after normalizeContent:

```typescript
// Progressive Disclosure: strip non-essential context for coding tasks
if (isCodeTask(lastMessage)) {
  messages = messages.map(m => ({
    ...m,
    content: stripWorkflowGuidance(m.content)  // removes release/deprecation sections
  }))
}

function stripWorkflowGuidance(content: string): string {
  // Remove: Git & Workflow, Releasing, Release config files sections
  return content
    .split('\n')
    .filter(line => !line.match(/^##\s+(Git|Releasing|Release config)/))
    .join('\n')
}
```

**Impact:** ~500 tokens saved per request for typical coding tasks.

### Phase 3: Update CLAUDE.md Section 0 (~5 min)

Add explanatory note:
```
## Context Strategy

This proxy implements md-codebase patterns (2026 best practice):
- CLAUDE.md is kept lean (~80 lines) for stateless LLM sessions
- Task-specific guidance: see docs/ARCHITECTURE.md, docs/AGENT-GUIDELINES.md
- OpenCode adapter applies Progressive Disclosure (strips workflow docs for code tasks)

See /docs/ARCHITECTURE.md for full module map.
```

---

## Consequences

### Positive
- **Token savings:** 15-20% per OpenCode request (code tasks)
- **Performance:** Faster response time (less context to process)
- **Cost:** Measurable cost reduction for meridian users
- **Alignment:** Meridian follows 2026 industry best practices
- **Maintenance:** Cleaner CLAUDE.md = easier for future agents to understand

### Negative
- **Code change:** ~35-40 lines added/modified
- **Testing:** Must verify OpenCode agent still gets necessary context (integration test)
- **Migration:** None (backward compatible; no API changes)

### Risk Mitigation
- **Test:** E2E test: run OpenCode agent on real project before/after, measure token usage
- **Conservative:** Phase 2 (Context-Budget Adapter) is optional; Phase 1 (refactor) is safe alone
- **Rollback:** Git revert works cleanly; no runtime dependencies

---

## Alternatives Considered

### A) Do Nothing
- **Pro:** No code changes
- **Con:** Meridian inefficient; OpenCode agents pay unnecessary cost; pattern-antinode in 2025 ecosystem

### B) Add Templating System (Templating Framework)
- **Pro:** More flexible than hardcoded exclusions
- **Con:** Overkill; adds complexity; ~100+ lines code for 1-2 use cases

### C) Strip Everything, Let OpenCode Provide Context (Agent-Provided Context)
- **Pro:** Minimal meridian code
- **Con:** Requires OpenCode refactor; OpenCode agent authors may not know best practices; doesn't align with OpenCode's design (Meridian owns context management)

**Selected:** Option (Progressive Disclosure) — balances engineering simplicity + impact.

---

## Implementation Plan

1. **Draft PR:** Phases 1 & 2 (recommended: combined PR, single commit)
2. **Code Review:** Verify context budget is actually reduced (print tokens before/after)
3. **Test:** 
   - Unit test `stripWorkflowGuidance()` (5 test cases)
   - Integration test: OpenCode agent on example project (E2E.md flow)
4. **Merge:** Squash merge to main
5. **Release:** Batched in next Release Please cycle (no urgency)

**Effort:** ~2-3 hours design + implementation + testing

---

## Open Questions

1. **Metrics:** Can we measure token savings in production? (Requires logging OpenCode context size)
2. **Scope expansion:** Should we also optimize ForgeCode adapter, or code-task detection?
3. **Versioning:** Should this bump minor version (since it changes behavior), or patch?

---

## References

- `/home/claude/vault/raw/research/2026-05-19 — md-codebase.md` — Full md-codebase pattern analysis
- `/home/claude/vault/wiki/living-seed/md-codebase.md` — Vault synthesis (if available after pipeline run)
- [md-codebase on GitHub](https://github.com/alpha912/codebase-md) — CodebaseMD v2.0.3 reference
