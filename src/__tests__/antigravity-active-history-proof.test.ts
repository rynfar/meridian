import { expect, it } from "bun:test"
import { inspectBudgetedHistory, isolatedProxyEnvironment } from "../../scripts/e2e-antigravity-active-history.mjs"
import { parseAgRequest, renderAgPromptWithinLimit } from "../proxy/backends/antigravityProtocol"

const request = () => parseAgRequest({ model: "fixture-model", messages: [
  { role: "user", content: "Write the report and verify it." },
  { role: "assistant", content: "prior detail ".repeat(20000) },
  { role: "assistant", content: [{ type: "tool_use", id: "seed", name: "read", input: { path: "source.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "seed", content: "source receipt" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "latest", name: "write", input: { path: "report.txt", content: "report" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "latest", content: "written" }] },
] })

it("the standalone live gate clears inherited auth, routing and input-limit overrides", () => {
  const inherited = { PATH: "/usr/bin", HOME: "/account", AGY_CLI_DISABLE_AUTO_UPDATE: "true", MERIDIAN_AGY_MAX_PROMPT_BYTES: "0", MERIDIAN_API_KEY: "fixture-only", ANTHROPIC_BASE_URL: "https://fixture.invalid", GOOGLE_API_KEY: "fixture-only" }
  const isolated = isolatedProxyEnvironment(inherited, "/fixture")
  expect(isolated).toMatchObject({ PATH: "/usr/bin", HOME: "/account", AGY_CLI_DISABLE_AUTO_UPDATE: "true", MERIDIAN_CONFIG_DIR: "/fixture/proxy-config", MERIDIAN_CREDENTIALS_READONLY: "1" })
  for (const name of ["MERIDIAN_AGY_MAX_PROMPT_BYTES", "MERIDIAN_API_KEY", "ANTHROPIC_BASE_URL", "GOOGLE_API_KEY"]) expect(Object.hasOwn(isolated, name)).toBe(false)
  expect(inherited.MERIDIAN_AGY_MAX_PROMPT_BYTES).toBe("0")
})

it("the live proof rejects lost instructions, changed results/identities and over-limit translation", () => {
  const parsed = request(), rendered = renderAgPromptWithinLimit(parsed)
  expect(inspectBudgetedHistory(rendered, parsed)).toMatchObject({ latestRequestExact: true, latestCallResultExact: true, toolIdentitiesExact: true })
  for (const [before, after] of [
    ["Write the report and verify it.", "Discard the request."],
    ["written", "different result"],
    ['"id":"seed"', '"id":"other"'],
    ["omitted by Meridian", "missing disclosure"],
  ] as const) {
    expect(rendered).toContain(before)
    expect(() => inspectBudgetedHistory(rendered.replaceAll(before, after), parsed)).toThrow()
  }
  expect(() => inspectBudgetedHistory("x".repeat(190001) + rendered, parsed)).toThrow("exceeds unchanged limit")
})

it("keeps newest assistant text protected even when older assistant text can shrink", () => {
  const parsed = request(), last = parsed.messages.at(-2)!
  if (!Array.isArray(last.content)) throw new Error("Expected latest tool call")
  last.content.unshift({ type: "text", text: "newest detail ".repeat(20000) })
  expect(() => renderAgPromptWithinLimit(parsed)).toThrow("prompt is too long")
})
