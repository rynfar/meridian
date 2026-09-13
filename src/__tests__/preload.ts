/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Take the operator's whole configuration namespace away from the suite.
//
// Every runtime knob is read through `env()`, i.e. `MERIDIAN_<X>` with a
// `CLAUDE_PROXY_<X>` fallback, so anything a developer exports to run their own
// proxy silently reconfigures the code under test. Two real examples from this
// machine: `MERIDIAN_NO_FILE_CHANGES=1` turns off the PostToolUse hook and
// fails the three "other adapters still track" cases in
// proxy-file-changes.test.ts, and `MERIDIAN_TELEMETRY_PERSIST=1` makes the
// global telemetry store the real ~/.config/meridian/telemetry.db — which the
// suite then DELETEs, because tests call `telemetryStore.clear()` and
// `diagnosticLog.clear()`. (Redirecting the config dir does not save it:
// telemetry resolves its path from `env("TELEMETRY_DB")` alone.)
//
// CI runs with none of these set, so stripping the namespace is what makes a
// local run mean the same thing as a CI run. Tests that need a knob set it
// themselves, in-process, after this point.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}

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
// This is the knob server.ts already reads (`envInt("SESSION_GC_MAX_PENDING",
// 256)` at sessionGcOptions), so no production code changes. Unset in
// production, where the default of 256 applies unchanged.
//
// Two earlier attempts were wrong and are recorded so they are not retried.
// Rotating the session root per test: preload hooks are process-scoped, so
// `beforeAll` fires once for the entire run (a no-op rename) and `beforeEach`
// fires per test, which breaks files whose tests deliberately carry session
// state forward. Lowering the default constant in sessionLifecycle.ts: dead
// code, because server.ts always passes `maxPending` explicitly.
process.env.MERIDIAN_SESSION_GC_MAX_PENDING = "1000000"

// SDK mocks do not spawn an operating-system child. Real proxy/E2E processes do not load this preload.
process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE = "1"
