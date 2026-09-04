import { mock, beforeAll } from "bun:test"

/**
 * One process-global mock of `../logger`, shared by every test file.
 *
 * Same problem and same shape as `./sdkMock` — see that file for the full
 * explanation of the load-phase last-wins race (#917).
 *
 * Deliberately its own module rather than part of `sdkMock`: importing a module
 * is what registers its mock, so a file that never mocked the logger must not
 * acquire one just by wanting the SDK mocked.
 *
 * With no implementation installed this is a silent no-op rather than an error.
 * A test that never asked about logging still wants silence, not a crash from
 * the first log line.
 */

type LogFn = (...args: never[]) => unknown

export interface LoggerMockModule {
  claudeLog?: LogFn
  /** Method syntax deliberately: its parameters are bivariant, so a file may
   *  narrow `fn` to its own handler's return type without a variance error. */
  withClaudeLogContext?(ctx: unknown, fn: () => unknown): unknown
}

let active: LoggerMockModule | null = null

mock.module("../logger", () => ({
  claudeLog: (...args: never[]) => active?.claudeLog?.(...args),
  withClaudeLogContext: (ctx: unknown, fn: () => unknown) =>
    active?.withClaudeLogContext ? active.withClaudeLogContext(ctx, fn) : fn(),
}))

/** Install this file's logger mock. Call at module scope. */
export function installLoggerMock(factory: () => LoggerMockModule): void {
  beforeAll(() => { active = factory() })
}

/**
 * Install an implementation immediately, for the rare file that swaps its mock
 * from inside a test body. `installLoggerMock` cannot be used there — bun rejects a
 * `beforeAll` registered inside a running test.
 */
export function setLoggerMock(factory: () => LoggerMockModule): void {
  active = factory()
}
