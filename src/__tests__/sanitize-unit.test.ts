/**
 * Unit tests for the per-block content sanitizer.
 *
 * Verifies that orchestration wrappers injected by agent harnesses are
 * stripped from individual text content blocks before prompt flattening,
 * while preserving legitimate user content.
 *
 * Related: https://github.com/rynfar/meridian/issues/167
 */

import { describe, it, expect } from "bun:test"
import { sanitizeTextContent } from "../proxy/sanitize"

// ── Orchestration tag stripping ──

describe("sanitizeTextContent", () => {
  // --- Droid ---

  it("strips <system-reminder> blocks (Droid CWD injection)", () => {
    const input = '<system-reminder>\nUser system info\n% pwd\n/home/user\n</system-reminder>\nactual question'
    expect(sanitizeTextContent(input)).toBe("actual question")
  })

  it("strips multiline <system-reminder> with attributes", () => {
    const input = 'hello\n<system-reminder id="sr-1">\nline one\nline two\n</system-reminder>\nworld'
    expect(sanitizeTextContent(input)).toBe("hello\n\nworld")
  })

  // --- OpenCode / Crush ---

  it("strips <env> blocks (OpenCode environment context)", () => {
    const input = '<env>\n  Working directory: /home/user/project\n  Platform: darwin\n</env>\nwhat is this project?'
    expect(sanitizeTextContent(input)).toBe("what is this project?")
  })

  // --- ForgeCode ---

  it("strips <system_information> wrapper and children", () => {
    const input = '<system_information>\n<operating_system>Darwin</operating_system>\n<current_working_directory>/path</current_working_directory>\n<default_shell>/bin/zsh</default_shell>\n<home_directory>/Users/dev</home_directory>\n</system_information>\ndo the thing'
    expect(sanitizeTextContent(input)).toBe("do the thing")
  })

  it("strips standalone <current_working_directory>", () => {
    const input = '<current_working_directory>/Users/dev/project</current_working_directory>read file.ts'
    expect(sanitizeTextContent(input)).toBe("read file.ts")
  })

  // --- OpenCode orchestration ---

  it("strips <task_metadata> blocks", () => {
    const input = '<task_metadata>{"id":"task-1","status":"running"}</task_metadata>actual content'
    expect(sanitizeTextContent(input)).toBe("actual content")
  })

  it("strips <tool_output> wrappers with attributes", () => {
    const input = 'before<tool_output name="bash">result here</tool_output>after'
    expect(sanitizeTextContent(input)).toBe("beforeafter")
  })

  it("strips self-closing <tool_exec> wrappers", () => {
    const input = 'text<tool_exec name="read" />more'
    expect(sanitizeTextContent(input)).toBe("textmore")
  })

  it("strips paired <tool_exec> wrappers", () => {
    const input = '<tool_exec name="bash">ls -la</tool_exec>output'
    expect(sanitizeTextContent(input)).toBe("output")
  })

  it("strips <skill_content> blocks", () => {
    const input = '<skill_content name="gh">skill instructions</skill_content>rest'
    expect(sanitizeTextContent(input)).toBe("rest")
  })

  it("strips <skill_files> blocks", () => {
    const input = 'before<skill_files>\nfile1.ts\nfile2.ts\n</skill_files>after'
    expect(sanitizeTextContent(input)).toBe("beforeafter")
  })

  it("strips <directories> blocks", () => {
    const input = '<directories>\n  src/\n  lib/\n</directories>after'
    expect(sanitizeTextContent(input)).toBe("after")
  })

  it("strips <available_skills> blocks", () => {
    const input = '<available_skills>\n  skill1\n  skill2\n</available_skills>after'
    expect(sanitizeTextContent(input)).toBe("after")
  })

  it("strips leaked <thinking> tags (text content, not structured blocks)", () => {
    const input = 'text<thinking>model thoughts leaked here</thinking>more text'
    expect(sanitizeTextContent(input)).toBe("textmore text")
  })

  // --- Non-XML markers ---

  it("strips OMO_INTERNAL_INITIATOR comment", () => {
    const input = "<!-- OMO_INTERNAL_INITIATOR -->proceed"
    expect(sanitizeTextContent(input)).toBe("proceed")
  })

  it("strips OH-MY-OPENCODE system directive", () => {
    const input = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE use tool X]do the thing"
    expect(sanitizeTextContent(input)).toBe("do the thing")
  })

  it("strips background_output markers", () => {
    const input = "⚙ background_output [task_id=abc123]\nreal content"
    expect(sanitizeTextContent(input)).toBe("real content")
  })

  it("strips Files changed blocks (meridian's own summary)", () => {
    const input = "response text\n---\nFiles changed:\n  - edited /path/to/file.ts\n  - wrote /path/to/other.ts"
    expect(sanitizeTextContent(input)).toBe("response text")
  })

  // --- Multiple patterns in one block ---

  it("handles multiple patterns in one string", () => {
    const input = '<system-reminder>x</system-reminder>\n<task_metadata>y</task_metadata>\nnormal content'
    expect(sanitizeTextContent(input)).toBe("normal content")
  })

  it("returns empty string for all-wrapper input", () => {
    const input = '<system-reminder>everything is internal</system-reminder>'
    expect(sanitizeTextContent(input)).toBe("")
  })

  // --- False positive safety ---

  it("is a no-op for clean text", () => {
    const input = "Just a normal user message with no wrappers."
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("is a no-op for empty string", () => {
    expect(sanitizeTextContent("")).toBe("")
  })

  it("preserves standard HTML tags", () => {
    const input = '<div>content</div><span>text</span><p>paragraph</p>'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves self-closing HTML tags", () => {
    const input = 'line one<br/>line two<hr/>end'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves code with angle brackets", () => {
    const input = "Use Array<string> and Map<K,V> in TypeScript"
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves H: and A: in content", () => {
    expect(sanitizeTextContent("H: hydrogen is atomic number 1")).toBe("H: hydrogen is atomic number 1")
    expect(sanitizeTextContent("A: the answer is 42")).toBe("A: the answer is 42")
  })

  it("preserves legitimate XML with underscores that aren't orchestration tags", () => {
    const input = '<first_name>John</first_name><last_name>Doe</last_name>'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves web component tags with hyphens", () => {
    const input = '<my-component>content</my-component>'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves user discussing system-reminder concept in prose", () => {
    const input = "The system-reminder tag is used by Droid to inject CWD info"
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves img and input self-closing tags", () => {
    const input = '<img src="photo.jpg" /><input type="text" />'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  // --- Regression: the exact scenario from issue #167 ---

  it("strips the compound leakage pattern from #167", () => {
    const input = [
      '<system-reminder>',
      '  Current dir: /home/user',
      '</system-reminder>',
      '<thinking>The user wants me to handle the case...</thinking>',
      '<task_metadata>{"id":"t1"}</task_metadata>',
      '<!-- OMO_INTERNAL_INITIATOR -->',
      'What is 2+2?',
    ].join("\n")
    expect(sanitizeTextContent(input)).toBe("What is 2+2?")
  })
})
