import { describe, expect, it } from "bun:test"
import { classifyError } from "../proxy/errors"

const rejection = "Claude Code 2.1.177 does not support this model; version 2.1.251 or newer is required."

describe("CLI model rejection boundaries", () => {
  for (const input of [
    rejection,
    `API Error: 400 ${rejection}`,
    `Error: API Error: 400 ${rejection}`,
    `Claude Code returned an error result: API Error: 400 ${rejection}`,
    `Claude Code process exited with code 1\nSubprocess stderr: API Error: 400 ${rejection}`,
    `Claude Code process exited with code 1\nSubprocess stderr:\nAPI Error: 400 ${rejection}`,
    "API Error: 400 Claude Code 3.1.2-preview.1 does not support this model; version 4.0.0 is required.",
  ]) {
    it(`recognizes the actionable rejection: ${input}`, () => {
      const result = classifyError(input)
      expect(result.status).toBe(400)
      expect(result.type).toBe("invalid_request_error")
      expect(result.message).toContain(input)
      expect(result.message).toContain("MERIDIAN_CLAUDE_PATH")
    })
  }

  for (const [input, status] of [
    [`Tool read failed: the file contains ${rejection}`, 500],
    [`API Error: 503 Upstream overloaded; documentation mentions ${rejection}`, 503],
    [`It is not true that ${rejection}`, 500],
    [`Tool read failed; quoted documentation follows:\n${rejection}`, 500],
    [`API Error: 503 Upstream overloaded\nDocumentation example:\n${rejection}`, 503],
    ['Error: this tool does not support streaming input', 500],
    ['API Error: 401 Invalid authentication credentials', 401],
    ["You've hit your usage limit for claude-fable-5-1", 429],
    ['Claude Code process exited with code 137', 502],
  ] as const) {
    it(`preserves unrelated error classification: ${input}`, () => {
      const result = classifyError(input)
      expect(result.status).toBe(status)
      expect(result.message).not.toContain("MERIDIAN_CLAUDE_PATH")
    })
  }
})
