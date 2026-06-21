import type { Transform } from "../transform"
import { openCodeTransforms } from "./opencode"
import { crushTransforms } from "./crush"
import { droidTransforms } from "./droid"
import { piTransforms } from "./pi"
import { forgeCodeTransforms } from "./forgecode"
import { passthroughTransforms } from "./passthrough"
import { openAiTransforms } from "./openai"

const ADAPTER_TRANSFORMS: Record<string, readonly Transform[]> = {
  opencode: openCodeTransforms,
  crush: crushTransforms,
  droid: droidTransforms,
  pi: piTransforms,
  forgecode: forgeCodeTransforms,
  passthrough: passthroughTransforms,
  // The OpenAI-compatible endpoint reuses OpenCode's transforms (tool/passthrough
  // behaviour is identical; only the preset default differs — see
  // sdkFeatures.ADAPTER_DEFAULTS.openai) plus a stripper that removes Hermes
  // Agent system-prompt boilerplate the SDK chokes on (see ./openai).
  openai: openAiTransforms,
}

export function getAdapterTransforms(adapterName: string): readonly Transform[] {
  return ADAPTER_TRANSFORMS[adapterName] ?? []
}
