/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

import { beforeAll } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Auth middleware reads this at request time; clear it so tests don't need API keys
delete process.env.MERIDIAN_API_KEY

// Point settings.ts at a throwaway directory so the suite never reads the
// developer's real ~/.config/meridian/settings.json. A live
// `routing: "priority"` setting made the sticky- and priority-routing
// integration tests fail locally while passing in CI, because both fall back
// to getSetting("routing") when MERIDIAN_ROUTING is unset — so those tests
// were asserting against whatever the developer happened to have configured.
// Keyed by pid so concurrent runs don't share state.
process.env.MERIDIAN_CONFIG_DIR = join(tmpdir(), `meridian-test-settings-${process.pid}`)
mkdirSync(process.env.MERIDIAN_CONFIG_DIR, { recursive: true })

// Isolate durable session mappings and transcript lifecycle metadata too.
// Fresh SDK sessions are pre-journaled before spawn, so allowing tests to use
// the developer's real session root would both pollute it and exhaust the
// bounded ownership budget during the suite.
process.env.MERIDIAN_SESSION_DIR = join(tmpdir(), `meridian-test-sessions-${process.pid}`)
mkdirSync(process.env.MERIDIAN_SESSION_DIR, { recursive: true })

// ...and give every test FILE its own session root, not just every process (#917).
//
// The ownership budget above is bounded per session root (DEFAULT_MAX_PENDING =
// 256 in sessionLifecycle.ts). One root shared by ~179 files accumulates
// prepared transcripts until it is full, after which EVERY request in the
// process returns 500 `session transcript ownership backlog is full` —
// regardless of which file issued it.
//
// That is the whole of #917. It presents as unrelated files failing wholesale
// with impossible statuses (a 429 test getting 500, a "returns 200" test
// getting 500), with victims decided purely by position in the run, which is
// why the set is stable for a fixed file list and changes when the list does,
// and why nothing reproduces when a file runs alone and never approaches 256.
// It is also why ten files are quarantined into their own `bun test`
// invocations in the `test` script: a fresh process meant a fresh budget.
//
// getSessionStoreDir() resolves this lazily on each call, so rotating it in a
// per-file hook is enough; no production code is involved.
let sessionRootSeq = 0
beforeAll(() => {
  const dir = join(tmpdir(), `meridian-test-sessions-${process.pid}-${++sessionRootSeq}`)
  mkdirSync(dir, { recursive: true })
  process.env.MERIDIAN_SESSION_DIR = dir
})

// SDK mocks do not spawn an operating-system child. Real proxy/E2E processes do not load this preload.
process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE = "1"
