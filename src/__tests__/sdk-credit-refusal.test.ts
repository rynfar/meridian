import { describe, expect, it } from "bun:test"
import { classifyError, isAccountFailoverError, isQuotaRefusal } from "../proxy/errors"

describe("SDK credit refusal", () => {
  it.each([
    "Credit balance is too low",
    "Claude Code returned an error result: Credit balance is too low",
    "Error: Claude Code returned an error result: Credit balance is too low.",
  ])("recognizes the CLI's shortened refusal: %s", (message) => {
    const error = classifyError(message)
    expect(error.status).toBe(402)
    expect(error.type).toBe("billing_error")
    expect(isAccountFailoverError(error.type)).toBe(true)
    expect(isQuotaRefusal(error.type)).toBe(false)
  })

  it.each([
    "Tool failed while documenting Credit balance is too low",
    "Credit balance is too low is an example error string",
    "Claude Code returned an error result: could not find 'Credit balance is too low' in fixture.txt",
    "Error: ENOENT: /repo/Credit balance is too low.txt",
  ])("does not exhaust accounts for incidental text: %s", (message) => {
    expect(isAccountFailoverError(classifyError(message).type)).toBe(false)
  })
})
