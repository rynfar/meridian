# Agent-Specific Logic & Guidelines

## Overview

Meridian adapts its behavior for different agents (OpenCode, ForgeCode, Claude Code, etc.). Each agent has unique requirements for session tracking, tool configuration, and context handling.

## OpenCode Agent

OpenCode is Anthropic's built-in agent in Claude Code. Session affinity via `x-opencode-session` or `x-session-affinity` headers.

**Key Features:**
- Fuzzy-matches subagent names (from Task tool description) to valid agent list
- PreToolUse hook ensures exact agent names passed to SDK
- System context appended with valid agent list for disambiguation
- File change tracking disabled (OpenCode shows edits in its own UI)
- Passthrough-capable for fallback behavior

**Context Budget:** Progressive disclosure strips workflow/release docs for coding tasks (~15-20% token reduction).

## ForgeCode Agent

ForgeCode uses XML-based working directory hints and supports advanced patch/shell operations.

**Key Features:**
- XML CWD extraction from request body
- Passthrough enabled for complex tool interactions
- Custom tool allowlist for patch operations
- PostToolUse: appends "Files changed:" summary block

## Claude Code (Native)

Claude Code is a direct SDK agent with native support for thinking, tool use, and subagents.

**Key Features:**
- No session affinity needed (SDK manages state)
- Full tool access
- Thinking mode support
- Native subagent definition building

## Adding New Agents

To add a new agent adapter:

1. Create `src/proxy/adapters/{agent}.ts` implementing `AgentAdapter` interface
2. Add detection logic to `src/proxy/adapters/detect.ts`
3. Register in `src/proxy/agentDefs.ts` if it needs custom tool/agent definitions
4. Write integration test in `src/__tests__/{agent}.test.ts`
5. Update this file with agent-specific behavior

## Future: Adapter Pattern Abstraction

Currently, agent-specific logic is scattered across `adapter.ts`, `opencode.ts`, etc. with inline `NOTE:` comments. Future work will:

- Extract agent-specific logic into a cleaner plugin architecture
- Use composition instead of conditional checks
- Provide a stable interface for third-party agent adapters

See `DEFERRED.md` for details on this refactoring.

## Code Rules for Agent-Specific Logic

When modifying agent-specific behavior:

- Add a `NOTE: <Agent>-specific.` comment marking the code
- Do not spread agent-specific logic into new modules
- Prefer modifying existing adapter methods over adding new ones
- Document the agent's requirements in this file
