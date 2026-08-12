import type { Transform } from "../transform"
import { openCodeTransforms } from "./opencode"
import { crushTransforms } from "./crush"
import { droidTransforms } from "./droid"
import { piTransforms } from "./pi"
import { primeTransforms } from "./prime"
import { forgeCodeTransforms } from "./forgecode"
import { passthroughTransforms } from "./passthrough"
import { cherryTransforms } from "./cherry"
import { codexTransforms } from "./codex"
import { claudeCodeTransforms } from "./claudecode"

const ADAPTER_TRANSFORMS: Record<string, readonly Transform[]> = {
  opencode: openCodeTransforms,
  crush: crushTransforms,
  droid: droidTransforms,
  pi: piTransforms,
  // Prime Agent is a Pi fork with a different tool surface (one `ipython`
  // tool, not Pi's read/write/edit/bash/glob/grep), so it needs its own
  // config rather than sharing Pi's.
  prime: primeTransforms,
  forgecode: forgeCodeTransforms,
  passthrough: passthroughTransforms,
  cherry: cherryTransforms,
  // Keyed by adapter.name ("claude-code", not "claudecode"). Without this the
  // Claude Code CLI falls through to the empty default — built-ins unblocked,
  // passthrough off — and the SDK re-executes every tool call on the proxy host.
  "claude-code": claudeCodeTransforms,
  // The OpenAI-compatible endpoint reuses OpenCode's transforms verbatim so
  // tool/passthrough behaviour is identical; only the preset default differs
  // (see sdkFeatures.ADAPTER_DEFAULTS.openai).
  openai: openCodeTransforms,
  // Jcode rides the same OpenAI-compatible endpoint, so it needs the identical
  // tool config. Without this entry it falls through to the empty default —
  // built-ins unblocked under bypassPermissions, passthrough off.
  jcode: openCodeTransforms,
  // Codex (/v1/responses): OpenCode's tool config + a follow-on transform
  // that forces passthrough (Codex executes its own tools). See #475.
  codex: [...openCodeTransforms, ...codexTransforms],
}

export function getAdapterTransforms(adapterName: string): readonly Transform[] {
  return ADAPTER_TRANSFORMS[adapterName] ?? []
}
