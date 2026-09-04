import { mock, beforeAll } from "bun:test"

/**
 * One process-global mock of `../mcpTools`, shared by every test file.
 *
 * Same problem and same shape as `./sdkMock` — see that file for the full
 * explanation of the load-phase last-wins race (#917). This module is the one
 * that decides an adapter's MCP server name, so a stray winner renamed another
 * adapter's tools and failed its entire file.
 *
 * Deliberately its own module rather than part of `sdkMock`: importing a module
 * is what registers its mock, so a file that never mocked mcpTools must not
 * acquire one just by wanting the SDK mocked.
 *
 * With no implementation installed this returns the default OpenCode stub —
 * the shape 59 of the 70 mocking files used — rather than throwing. Before this
 * harness those files were silently sharing one another's stub anyway, so
 * failing here would be stricter than the behaviour being replaced.
 */

type McpFn = (...args: never[]) => unknown

export interface McpToolsMockModule {
  createOpencodeMcpServer?: McpFn
}

let active: McpToolsMockModule | null = null

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: (...args: never[]) =>
    active?.createOpencodeMcpServer
      ? active.createOpencodeMcpServer(...args)
      : { type: "sdk", name: "opencode", instance: {} },
}))

/** Install this file's mcpTools mock. Call at module scope. */
export function installMcpToolsMock(factory: () => McpToolsMockModule): void {
  beforeAll(() => { active = factory() })
}

/**
 * Install an implementation immediately, for the rare file that swaps its mock
 * from inside a test body. `installMcpToolsMock` cannot be used there — bun rejects a
 * `beforeAll` registered inside a running test.
 */
export function setMcpToolsMock(factory: () => McpToolsMockModule): void {
  active = factory()
}
