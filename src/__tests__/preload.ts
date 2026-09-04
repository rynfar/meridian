/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

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

// Raise the pending-transcript ceiling for the suite (#917).
//
// The ceiling is bounded per session root, and the root above is shared by the
// whole process. Prepared transcripts accumulate across ~179 files until it is
// full, after which EVERY request returns 500 `session transcript ownership
// backlog is full` regardless of which file issued it -- so unrelated files
// fail wholesale with impossible statuses (a 429 test receiving 500, a
// "returns 200" test receiving 500), with victims decided purely by position
// in the run. Hence a failing set that is stable for a fixed file list, shifts
// when the list changes, and never reproduces on a file run alone that never
// approaches the limit. It is also why ten files are quarantined into their
// own `bun test` invocations: a fresh process meant a fresh budget.
//
// Rotating the root per test was tried and is wrong: preload hooks are
// process-scoped, so `beforeAll` fires once for the entire run, and
// `beforeEach` fires per test, which breaks files whose tests deliberately
// carry session state forward.
process.env.MERIDIAN_MAX_PENDING_TRANSCRIPTS = "1000000"

// SDK mocks do not spawn an operating-system child. Real proxy/E2E processes do not load this preload.
process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE = "1"
