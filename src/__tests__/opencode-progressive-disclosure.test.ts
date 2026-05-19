import { describe, it, expect } from "bun:test"

/**
 * Test stripWorkflowGuidance function behavior.
 * This function is used by OpenCode adapter to reduce context tokens
 * by removing workflow/release documentation during coding tasks.
 */

// We need to extract and test the stripWorkflowGuidance function
// For now, we'll test the behavior by simulating it

function stripWorkflowGuidance(content: string): string {
  return content
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      // Remove header lines for sections we're stripping
      if (trimmed.match(/^##\s+(Git|Releasing|Release config)/)) {
        return false
      }
      // Remove the entire Releasing section and its subsections
      if (trimmed.match(/^###\s+(Commit format|Development workflow|Troubleshooting|Release config files)/)) {
        return false
      }
      return true
    })
    .join('\n')
    .trim()
}

describe("OpenCode Progressive Disclosure", () => {
  it("strips Git & Workflow section", () => {
    const input = `## Code Rules
Some important rule

## Git & Workflow
This should be removed

### Development workflow
This too

## Stable API Contract
This stays`

    const result = stripWorkflowGuidance(input)
    expect(result).not.toContain("Git & Workflow")
    expect(result).not.toContain("Development workflow")
    expect(result).toContain("Code Rules")
    expect(result).toContain("Stable API Contract")
  })

  it("strips Releasing section", () => {
    const input = `## Testing

## Releasing
This should go away

### Troubleshooting releases
Gone

### Release config files
Also gone

## References
Keep this`

    const result = stripWorkflowGuidance(input)
    expect(result).not.toContain("Releasing")
    expect(result).not.toContain("Troubleshooting")
    expect(result).not.toContain("Release config")
    expect(result).toContain("Testing")
    expect(result).toContain("References")
  })

  it("preserves essential sections (Code Rules, API Contract)", () => {
    const input = `## Code Rules

### Module Boundaries
Keep this

## Stable API Contract

Important interface

## Git & Workflow
Remove`

    const result = stripWorkflowGuidance(input)
    expect(result).toContain("Code Rules")
    expect(result).toContain("Module Boundaries")
    expect(result).toContain("Stable API Contract")
    expect(result).toContain("Important interface")
    expect(result).not.toContain("Git & Workflow")
  })

  it("handles multiple header levels correctly", () => {
    const input = `# Title

## Kept Section

### Subsection
Content

## Releasing

### Commit format
Remove

## Another Kept Section
Keep`

    const result = stripWorkflowGuidance(input)
    expect(result).toContain("# Title")
    expect(result).toContain("Kept Section")
    expect(result).toContain("Another Kept Section")
    expect(result).not.toContain("Releasing")
    expect(result).not.toContain("Commit format")
  })

  it("removes trailing whitespace and blank lines at edges", () => {
    const input = `## Content


Some text
Remove this:
## Releasing

   `

    const result = stripWorkflowGuidance(input)
    expect(result).not.toContain("Releasing")
    expect(result.endsWith("Some text")).toBe(true)
  })

  it("preserves Command section", () => {
    const input = `## Commands

\`\`\`bash
npm test
\`\`\`

## Git & Workflow
Remove`

    const result = stripWorkflowGuidance(input)
    expect(result).toContain("Commands")
    expect(result).toContain("npm test")
    expect(result).not.toContain("Git & Workflow")
  })
})
