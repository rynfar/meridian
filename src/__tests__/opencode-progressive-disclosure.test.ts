import { describe, it, expect } from "bun:test"
import { stripWorkflowGuidance } from "../proxy/adapters/opencode"

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
    expect(result).not.toContain("This should be removed")
    expect(result).not.toContain("Development workflow")
    expect(result).not.toContain("This too")
    expect(result).toContain("Code Rules")
    expect(result).toContain("Some important rule")
    expect(result).toContain("Stable API Contract")
    expect(result).toContain("This stays")
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
    expect(result).not.toContain("This should go away")
    expect(result).not.toContain("Troubleshooting")
    expect(result).not.toContain("Gone")
    expect(result).not.toContain("Release config")
    expect(result).not.toContain("Also gone")
    expect(result).toContain("Testing")
    expect(result).toContain("References")
    expect(result).toContain("Keep this")
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
## Releasing

And this release content

   `

    const result = stripWorkflowGuidance(input)
    expect(result).not.toContain("Releasing")
    expect(result).not.toContain("And this release content")
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
