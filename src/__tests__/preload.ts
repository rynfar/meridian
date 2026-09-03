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

// SDK mocks do not spawn an operating-system child. Real proxy/E2E processes do not load this preload.
process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE = "1"
