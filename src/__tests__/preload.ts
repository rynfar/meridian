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

// SDK mocks do not spawn an operating-system child. Real proxy/E2E processes do not load this preload.
process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE = "1"
