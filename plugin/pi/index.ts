/**
 * Meridian Pi extension.
 *
 * Registers a `meridian` provider whose models come from Meridian's catalog,
 * and delegates streaming, thinking, tools, usage and cancellation to Pi's
 * built-in Anthropic implementation. Requests carry the identity the Pi adapter
 * reads:
 *   1. Session affinity from Pi's own session ID (`x-session-affinity`)
 *   2. Side calls marked independent (`x-meridian-source: fork-side-call`), and
 *      the base model tier for delegated children (`x-meridian-source: subagent-*`)
 *   3. A signed human-turn attestation for `next-user-turn` priority failback
 *
 * Install once:
 *   meridian setup --client pi
 *
 * Point Pi at another Meridian with MERIDIAN_BASE_URL, or with
 * `providers.meridian.baseUrl` in Pi's models.json (Pi 1.3 and newer). Set
 * MERIDIAN_API_KEY when Meridian requires an API key.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  BUILTIN_CATALOG,
  buildModels,
  cacheOnlyModels,
  catalogStoreEntry,
  fetchCatalog,
  normalizeBaseUrl,
  restoreModels,
  type MeridianModelConfig,
} from "./catalog"
import { childSourceFromEnvironment, requestOptions, type RequestState } from "./headers"

export const PROVIDER = "meridian"
const DISCOVERY_TIMEOUT_MS = 3_000

export default function meridian(pi: ExtensionAPI): void {
  const anthropic = builtinProviders().find((provider) => provider.id === "anthropic")
  if (!anthropic) throw new Error("Pi does not provide the built-in Anthropic provider")
  const anthropicModels = anthropic.getModels()
  const state: RequestState = { childSource: childSourceFromEnvironment(process.env) }

  pi.on("session_start", (_event, ctx) => {
    state.session = ctx.sessionManager
  })

  /**
   * Pi calls this cache-only (`allowNetwork: false`) at startup, then with
   * network access in interactive and RPC modes. The cache-only answer never
   * contacts Meridian and is never empty (`cacheOnlyModels`). A failed
   * discovery falls back to a fresh stored catalog, or throws so Pi records
   * the error.
   */
  const refreshModels = async (context: RefreshModelsContext): Promise<MeridianModelConfig[]> => {
    const baseUrl = normalizeBaseUrl(context.baseUrl ?? process.env.MERIDIAN_BASE_URL)
    const now = Date.now()
    if (!context.allowNetwork) {
      return cacheOnlyModels(context.stored, baseUrl, now, buildModels(BUILTIN_CATALOG, anthropicModels, baseUrl))
    }
    const restored = restoreModels(context.stored, baseUrl, now)

    const apiKey = context.credential?.type === "api_key" ? context.credential.key : process.env.MERIDIAN_API_KEY
    try {
      const catalog = await fetchCatalog(
        baseUrl,
        apiKey,
        AbortSignal.any([context.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
      )
      const models = buildModels(catalog, anthropicModels, baseUrl)
      await context.publish({ persist: catalogStoreEntry(PROVIDER, models, Date.now()) })
      return models
    } catch (error) {
      if (restored) return restored
      throw error
    }
  }

  pi.registerProvider(PROVIDER, {
    name: "Meridian (Claude)",
    apiKey: process.env.MERIDIAN_API_KEY ? "$MERIDIAN_API_KEY" : "meridian",
    api: "anthropic-messages",
    headers: { "x-meridian-agent": "pi" },
    models: [],
    refreshModels,
    streamSimple: (model, context, options) =>
      anthropic.streamSimple(model, context, requestOptions(context, options, state)),
  })
}
