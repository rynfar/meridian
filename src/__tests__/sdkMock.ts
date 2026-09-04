import { mock, beforeAll } from "bun:test"

/**
 * One process-global mock of the Claude Agent SDK, shared by every test file.
 *
 * ## Why this exists (#917)
 *
 * `mock.module` is process-global in bun, and every test file is *loaded*
 * before any test *runs*. When 75 files each called
 * `mock.module("@anthropic-ai/claude-agent-sdk", ...)` at module scope, all 75
 * registrations executed during the load phase and the last one won for the
 * whole process. Every other file then ran its tests against a stranger's mock,
 * which serves a different generator reading a different file's state — so
 * requests that should have returned 200/429/503 returned 500 instead.
 *
 * That produced the signature in #917: whole files failing as a block, a
 * failure set that is stable for a given file set but changes when the set or
 * its order changes, and nothing reproducing when a file runs on its own. It
 * is also why ten files are already split into their own `bun test`
 * invocations in the `test` script — the same bug, worked around one file at a
 * time.
 *
 * ## How this fixes it
 *
 * The registration happens exactly once, here. The exported functions are
 * stable wrappers that resolve the active implementation *at call time*, so
 * importers can bind to them once (as ESM does) and still reach whichever
 * implementation the running file installed.
 *
 * Each file calls `installSdkMock(factory)` at module scope instead. That
 * registers a file-scoped `beforeAll`, so the implementation is swapped in when
 * that file's tests begin rather than during the load-phase free-for-all.
 * Because bun runs files sequentially, exactly one implementation is ever
 * active.
 *
 * A consequence worth knowing: the factory is invoked at `beforeAll` time, not
 * at module scope, so it may safely close over `let` bindings declared further
 * down the file.
 */

/** Any SDK export. `never[]` params make every concrete function assignable
 *  (parameter contravariance) without reaching for `any`. */
type SdkExport = (...args: never[]) => unknown

/** All optional: a file mocks only the exports its subject actually reaches,
 *  and `resolve` raises a named error if something else is called. */
export interface SdkMockModule {
  query?: SdkExport
  createSdkMcpServer?: SdkExport
  tool?: SdkExport
}

let active: SdkMockModule | null = null
let activeOwner = "<none>"

function resolve(name: keyof SdkMockModule): SdkExport {
  if (!active) {
    throw new Error(
      `Claude Agent SDK mock: '${name}' was called before any test file installed an implementation. `
      + "Call installSdkMock(() => ({ query, createSdkMcpServer, tool })) at module scope.",
    )
  }
  const impl = active[name]
  if (!impl) {
    throw new Error(
      `Claude Agent SDK mock: '${name}' is not provided by the implementation installed in ${activeOwner}.`,
    )
  }
  return impl
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: never[]) => resolve("query")(...args),
  createSdkMcpServer: (...args: never[]) => resolve("createSdkMcpServer")(...args),
  tool: (...args: never[]) => resolve("tool")(...args),
}))

/**
 * Install this file's SDK mock for the duration of its tests.
 *
 * Call at module scope. `owner` is only used to name the file in error
 * messages when an export is missing.
 */
export function installSdkMock(factory: () => SdkMockModule, owner?: string): void {
  beforeAll(() => {
    active = factory()
    activeOwner = owner ?? "the current test file"
  })
}

/**
 * Install an implementation immediately, for the rare file that swaps its mock
 * from inside a test body. `installSdkMock` cannot be used there — bun rejects a
 * `beforeAll` registered inside a running test.
 */
export function setSdkMock(factory: () => SdkMockModule, owner?: string): void {
  active = factory()
  activeOwner = owner ?? "the current test file"
}
