# Passthrough auto-compaction — live OpenCode evidence (2026-11-18)

Change: passthrough queries set `DISABLE_AUTO_COMPACT=1`, so the Claude Code CLI
never summarizes history the client owns.

## Setup

- Harness: [`scripts/e2e-passthrough-autocompact-opencode.mjs`](../../../scripts/e2e-passthrough-autocompact-opencode.mjs),
  the same script for both arms. Node v26.10.0, Linux x64.
- Meridian: one scratch `startProxyServer` per arm on a loopback port, built from
  unchanged main `55e8daeb` (before) and the candidate (after). Disposable
  HOME, config and session directories; one live account through
  `MERIDIAN_CREDENTIALS_READONLY=1`; `MERIDIAN_PASSTHROUGH=1`. The operator's
  running instances were not touched.
- Server plugin: `@rynfar/meridian-plugin-opencode-scrub` 0.3.0, the only
  server plugin, active, `onRequest` invoked on every request with 0 errors
  (16 and 18 invocations).
- Client: OpenCode `1.19.5-vt-530-006d837c50` (V1), disposable XDG
  directories, Meridian V1 plugin installed by each arm's own `setup --v1`. The
  effective config had exactly one Meridian entry (that arm's `dist/meridian`)
  and the provider `baseURL` was the arm's proxy. Every request carried the
  plugin's session and agent headers.
- Model: `claude-haiku-4-5-20251001`, declared to OpenCode with a 200,000-token
  window and a 1,024-token output cap, so OpenCode compacts on its own only at
  ~199k. Each turn adds ~13.4k tokens of filler and asks for `ACK <n>`; every
  turn after the first resumes the same SDK session (`lineage=continuation`).

## Results

Context is the request's input + cache read + cache write, as OpenCode and
Meridian's telemetry both recorded it.

| Turn | Before (55e8daeb) | After (candidate) |
|------|-------------------|-------------------|
| 0 | 21,199 | 21,189 |
| 6 | 101,591 | 101,635 |
| 12 | 181,835 | 182,047 |
| 13 | 195,237 | 400 `invalid_request_error` "Prompt is too long" → OpenCode compaction request 164,634 → continued with 48,043 |
| 14 | **22,434** (resumed, cache read 6,991) | 61,430 (resumed), `ACK 14`, exit 0 |

- **Before:** on turn 14 OpenCode sent ~208k tokens of history; the CLI
  summarized the resumed session and reported 22,434. OpenCode never compacted
  (no summary message) and kept its full history, believing ~22k was in use.
  Gate `E2E_EXPECT=sdk-compacts`: PASS.
- **After:** the context only grew until the next turn no longer fit; that
  turn failed with the canonical prompt-too-long error, OpenCode recorded a
  `ContextOverflowError`, compacted (its summary message), replayed the turn
  on a fresh session and answered it, and the following turn resumed normally.
  Gate `E2E_EXPECT=client-compacts`: PASS.

## Not covered

- A 1M-window model; the thresholds scale with the window, so Haiku's 200k
  window was used to keep the run cheap.
- OpenCode V2 and other passthrough clients.
