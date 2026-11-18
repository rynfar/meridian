import { describe, expect, it } from "bun:test"
import { openCodeInstructionSections } from "../proxy/adapters/opencodeInstructionSections"
import {
  diffInstructionSections, hashInstructionSections, isInstructionSectionState, planInstructionSections,
  renderInstructionSectionReminder,
} from "../proxy/session/instructionSections"
import { withTrailingText } from "../proxy/replay"

const system = (agents: string, project: string, tail = "Skills provide specialized instructions and workflows for specific tasks.\n- skill-a") => [
  "You are OpenCode.",
  "<env>\n  Working directory: /work\n  Today's date: Wed Nov 18 2026\n</env>",
  `Instructions from: /home/user/.config/opencode/AGENTS.md\n${agents}\n`,
  `Instructions from: /work/AGENTS.md\n${project}`,
  "<mcp_instructions>\n  <server name=\"x\">\n    use it\n  </server>\n</mcp_instructions>",
  tail,
].join("\n")

describe("openCodeInstructionSections", () => {
  it("splits each instruction file into a section keyed by path, excluding the parts OpenCode adds around them", () => {
    const sections = openCodeInstructionSections(system("# Global\nBe terse.", "# Project\nRun npm test."))
    expect(sections).toEqual([
      { key: "/home/user/.config/opencode/AGENTS.md", text: "Instructions from: /home/user/.config/opencode/AGENTS.md\n# Global\nBe terse." },
      { key: "/work/AGENTS.md", text: "Instructions from: /work/AGENTS.md\n# Project\nRun npm test." },
    ])
  })

  it("ends the last file at the skill listing when the client sends no MCP instructions", () => {
    const text = ["Instructions from: /work/AGENTS.md", "rules", "Skills provide specialized instructions and workflows for specific tasks.", "- dynamic"].join("\n")
    expect(openCodeInstructionSections(text)).toEqual([{ key: "/work/AGENTS.md", text: "Instructions from: /work/AGENTS.md\nrules" }])
  })

  it("gives a repeated path its own key and returns nothing for a prompt without instruction files", () => {
    const text = "Instructions from: /a.md\none\nInstructions from: /a.md\ntwo"
    expect(openCodeInstructionSections(text).map(section => section.key)).toEqual(["/a.md", "/a.md#2"])
    expect(openCodeInstructionSections("You are OpenCode.\n<env>x</env>")).toEqual([])
    expect(openCodeInstructionSections(undefined)).toEqual([])
  })

  it("keeps section digests stable when only dynamic prompt parts change", () => {
    const before = hashInstructionSections(openCodeInstructionSections(system("g", "p")))
    const after = hashInstructionSections(openCodeInstructionSections(
      system("g", "p", "Skills provide specialized instructions and workflows for specific tasks.\n- skill-a\n- skill-b")
        .replace("Wed Nov 18 2026", "Thu Nov 19 2026")))
    expect(after).toEqual(before)
  })
})

describe("instruction section state", () => {
  const sections = [{ key: "/a.md", text: "Instructions from: /a.md\nA1" }, { key: "/b.md", text: "Instructions from: /b.md\nB1" }]

  it("stores only sha256 digests", () => {
    const digests = hashInstructionSections(sections)
    expect(Object.keys(digests)).toHaveLength(2)
    for (const [key, value] of Object.entries(digests)) {
      expect(key).toMatch(/^[a-f0-9]{64}$/)
      expect(value).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(JSON.stringify(digests)).not.toContain("/a.md")
    expect(isInstructionSectionState({ seen: digests })).toBe(true)
    expect(isInstructionSectionState({ seen: {} })).toBe(true)
    expect(isInstructionSectionState({ seen: { "/a.md": "x" } })).toBe(false)
    expect(isInstructionSectionState({ seen: digests, extra: 1 })).toBe(false)
    expect(isInstructionSectionState([])).toBe(false)
  })

  it("reports changed, added and removed sections", () => {
    const seen = hashInstructionSections(sections)
    const next = [{ key: "/a.md", text: "Instructions from: /a.md\nA2" }, { key: "/c.md", text: "Instructions from: /c.md\nC1" }]
    const change = diffInstructionSections(seen, next)
    expect(change.changed.map(section => section.key)).toEqual(["/a.md", "/c.md"])
    expect(change.removed).toBe(1)
    expect(diffInstructionSections(seen, sections)).toEqual({ changed: [], removed: 0 })
  })

  it("publishes current sections for a fresh session and keeps the stored ones on resume", () => {
    const stored = { seen: hashInstructionSections(sections) }
    const edited = [{ key: "/a.md", text: "Instructions from: /a.md\nA2" }, sections[1]!]
    expect(planInstructionSections(stored, edited, false)).toEqual({
      state: { seen: hashInstructionSections(edited) }, change: { changed: [], removed: 0 },
    })
    const resumed = planInstructionSections(stored, edited, true)
    expect(resumed.state).toBe(stored)
    expect(resumed.change.changed.map(section => section.key)).toEqual(["/a.md"])
  })

  it("adopts the current sections as the baseline of a mapping published without them", () => {
    expect(planInstructionSections(undefined, sections, true)).toEqual({
      state: { seen: hashInstructionSections(sections) }, change: { changed: [], removed: 0 },
    })
  })
})

describe("instruction section reminder", () => {
  it("carries every changed file whole and states removals by the files that remain", () => {
    const a = { key: "/a.md", text: "Instructions from: /a.md\nA2" }
    const reminder = renderInstructionSectionReminder({ changed: [a], removed: 1 }, [a])
    expect(reminder.startsWith("<system-reminder>\n")).toBe(true)
    expect(reminder.endsWith("\n</system-reminder>")).toBe(true)
    expect(reminder).toContain("Instructions from: /a.md\nA2")
    expect(reminder).toContain("current instruction files are: /a.md.")
    expect(renderInstructionSectionReminder({ changed: [], removed: 2 }, [])).toContain("sends no instruction files")
    expect(renderInstructionSectionReminder({ changed: [a], removed: 0 }, [a])).not.toContain("no longer apply")
  })

  it("appends text after tool results and converts string content", () => {
    const tool = { type: "tool_result", tool_use_id: "t", content: "r" }
    const [structured] = withTrailingText<{ message: { content: unknown } }>([{ message: { content: [tool] } }], "R")
    expect(structured!.message.content).toEqual([tool, { type: "text", text: "R" }])
    const [plain] = withTrailingText<{ message: { content: unknown } }>([{ message: { content: "q" } }], "R")
    expect(plain!.message.content).toEqual([{ type: "text", text: "q" }, { type: "text", text: "R" }])
    const [empty] = withTrailingText<{ message: { content: unknown } }>([{ message: { content: "" } }], "R")
    expect(empty!.message.content).toEqual([{ type: "text", text: "R" }])
  })
})
