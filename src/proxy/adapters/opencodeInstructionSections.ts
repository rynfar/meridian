import type { InstructionSection } from "../session/instructionSections"

const SECTION_START = /^Instructions from: (\S.*)$/
/** Lines OpenCode itself places after its instruction files (MCP server
 * instructions, then the skill listing). Text a plugin appends after the last
 * instruction file without one of these stays in that section, which can only
 * report a change the file did not have, never miss one. */
const SECTION_END = [
  (line: string) => line === "<mcp_instructions>",
  (line: string) => line.startsWith("Skills provide specialized instructions and workflows for specific tasks."),
]

/** NOTE: OpenCode-specific. OpenCode renders every AGENTS.md, CLAUDE.md and
 * `instructions` entry as `Instructions from: <path>` followed by the file,
 * joined into one system string with the environment, MCP and skill parts.
 * Each file is one section keyed by its path, so a change to one file is
 * detected without hashing the dynamic parts of the prompt. */
export function openCodeInstructionSections(systemText: string | undefined): InstructionSection[] {
  if (!systemText) return []
  const sections: InstructionSection[] = []
  const occurrences = new Map<string, number>()
  let open: { key: string; lines: string[] } | undefined
  const close = () => {
    if (open) sections.push({ key: open.key, text: open.lines.join("\n").replace(/\n+$/, "") })
    open = undefined
  }
  for (const line of systemText.split("\n")) {
    const start = SECTION_START.exec(line)
    if (start) {
      close()
      const path = start[1]!.trim()
      const seen = occurrences.get(path) ?? 0
      occurrences.set(path, seen + 1)
      open = { key: seen === 0 ? path : `${path}#${seen + 1}`, lines: [line] }
    } else if (open && SECTION_END.some(ends => ends(line))) {
      close()
    } else {
      open?.lines.push(line)
    }
  }
  close()
  return sections
}
