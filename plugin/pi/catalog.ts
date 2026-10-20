import type { AnyModel, Model, ModelsStoreEntry, ThinkingLevelMap } from "@earendil-works/pi-ai"
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent"

type ProviderChatModelConfig = Exclude<ProviderModelConfig, { type: "image" } | { type: "classifier" }>
type AnthropicCompat = NonNullable<Model<"anthropic-messages">["compat"]>

/** A Pi chat model definition served by Meridian through Pi's Anthropic API. */
export type MeridianModelConfig = ProviderChatModelConfig & {
  api: "anthropic-messages"
  baseUrl: string
  compat: AnthropicCompat
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:3456"
/** Bounds how stale a stored catalog can be if discovery never succeeds again. */
export const STORED_CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1_000

const UNKNOWN_MAX_TOKENS = 8_192
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
// Mirrors VALID_EFFORTS in src/proxy/effort.ts; a test asserts the two stay identical.
export const MERIDIAN_PI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

type Effort = (typeof MERIDIAN_PI_EFFORTS)[number]

export interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  imageInput?: boolean
  thinking?: boolean
  adaptiveThinking?: boolean
  enabledThinking?: boolean
  efforts?: readonly Effort[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function supported(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.supported === "boolean" ? value.supported : undefined
}

/**
 * Meridian's server root, without a trailing slash or `/v1`. Pi users copy the
 * Anthropic-style `/v1` URL by habit, and appending `v1/models` to it would
 * request `/v1/v1/models`, a 404 that silently disables discovery.
 */
export function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "")
}

/**
 * Read the Anthropic models out of Meridian's `/v1/models` response.
 *
 * Meridian appends ChatGPT models (`owned_by: "openai"`, no capabilities)
 * when ChatGPT seats are configured. Those are served on `/v1/responses`, not
 * the Messages API, so they are skipped one by one rather than rejecting the
 * catalog. Malformed and duplicate entries are skipped the same way.
 */
export function parseCatalog(value: unknown): CatalogModel[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined
  const models: CatalogModel[] = []
  const ids = new Set<string>()
  for (const item of value.data) {
    if (!isRecord(item) || item.owned_by !== "anthropic") continue
    const { id, display_name: name, context_window: contextWindow } = item
    if (
      typeof id !== "string"
      || !/^[\x21-\x7E]{1,256}$/.test(id)
      || ids.has(id)
      || typeof name !== "string"
      || name.trim().length === 0
      || name.length > 256
      || typeof contextWindow !== "number"
      || !Number.isSafeInteger(contextWindow)
      || contextWindow <= 0
    ) {
      continue
    }
    ids.add(id)
    const capabilities = isRecord(item.capabilities) ? item.capabilities : {}
    const thinking = isRecord(capabilities.thinking) ? capabilities.thinking : undefined
    const types = thinking && isRecord(thinking.types) ? thinking.types : undefined
    const effort = isRecord(capabilities.effort) ? capabilities.effort : undefined
    models.push({
      id,
      name,
      contextWindow,
      imageInput: supported(capabilities.image_input),
      thinking: thinking && typeof thinking.supported === "boolean" ? thinking.supported : undefined,
      adaptiveThinking: supported(types?.adaptive),
      enabledThinking: supported(types?.enabled),
      efforts: effort ? MERIDIAN_PI_EFFORTS.filter((level) => supported(effort[level]) === true) : undefined,
    })
  }
  return models
}

export async function fetchCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CatalogModel[]> {
  const response = await fetcher(`${baseUrl}/v1/models`, {
    headers: apiKey ? { "x-api-key": apiKey } : {},
    signal,
  })
  if (!response.ok) throw new Error(`Meridian model discovery failed with HTTP ${response.status}`)
  const models = parseCatalog(await response.json())
  if (!models) throw new Error("Meridian returned a malformed model catalog")
  return models
}

function isAnthropicModel(model: AnyModel): model is Model<"anthropic-messages"> {
  return (model.type ?? "chat") === "chat" && model.api === "anthropic-messages"
}

/**
 * Pi model definitions for a Meridian catalog.
 *
 * The catalog is authoritative for availability, context window, image input,
 * thinking and effort levels. A model Pi already knows keeps Pi's output limit,
 * cost and compatibility metadata. `promptCache` is never set: Pi only warms
 * caches for models that declare it, and a warming request through Meridian
 * spends subscription quota without keeping an Agent SDK session warm.
 */
export function buildModels(
  catalog: readonly CatalogModel[],
  anthropicModels: readonly AnyModel[],
  baseUrl: string,
): MeridianModelConfig[] {
  const known = new Map<string, Model<"anthropic-messages">>()
  for (const model of anthropicModels) if (isAnthropicModel(model)) known.set(model.id, model)

  return catalog.map((entry) => {
    const builtIn = known.get(entry.id)
    const reasoning = entry.thinking ?? builtIn?.reasoning ?? false
    let thinkingLevelMap: ThinkingLevelMap | undefined = builtIn?.thinkingLevelMap
    if (reasoning && entry.efforts) {
      const efforts = new Set(entry.efforts)
      thinkingLevelMap = { off: entry.enabledThinking === false ? null : builtIn?.thinkingLevelMap?.off }
      for (const level of MERIDIAN_PI_EFFORTS) thinkingLevelMap[level] = efforts.has(level) ? level : null
      thinkingLevelMap.minimal = thinkingLevelMap.low
    }
    // Claude Code owns tool registration on Meridian's backend, so tools that
    // appear mid-conversation must arrive in the request-level tool list.
    const compat: AnthropicCompat = {
      ...builtIn?.compat,
      supportsMidConvoToolChanges: false,
    }
    if (entry.adaptiveThinking !== undefined) compat.forceAdaptiveThinking = entry.adaptiveThinking

    return {
      id: entry.id,
      name: `${entry.name} (Meridian)`,
      api: "anthropic-messages",
      baseUrl,
      reasoning,
      thinkingLevelMap,
      input: entry.imageInput === undefined
        ? [...(builtIn?.input ?? ["text"])]
        : entry.imageInput ? ["text", "image"] : ["text"],
      cost: builtIn?.cost ?? ZERO_COST,
      contextWindow: entry.contextWindow,
      maxTokens: builtIn?.maxTokens ?? Math.min(UNKNOWN_MAX_TOKENS, entry.contextWindow),
      compat,
    }
  })
}

export function catalogStoreEntry(
  provider: string,
  models: readonly MeridianModelConfig[],
  now: number,
): ModelsStoreEntry {
  return { models: models.map((model) => ({ ...model, provider, api: "anthropic-messages" })), checkedAt: now }
}

/**
 * Models from Pi's stored catalog snapshot, or undefined when there is none
 * usable. A snapshot discovered from another base URL describes another
 * Meridian and is never applied; one older than the TTL is treated as gone.
 */
export function restoreModels(
  stored: Readonly<ModelsStoreEntry> | undefined,
  baseUrl: string,
  now: number,
): MeridianModelConfig[] | undefined {
  const checkedAt = stored?.checkedAt
  if (!stored || checkedAt === undefined || checkedAt > now || now - checkedAt > STORED_CATALOG_TTL_MS) return undefined
  const models: MeridianModelConfig[] = []
  for (const model of stored.models) {
    if (!isAnthropicModel(model) || model.baseUrl !== baseUrl) return undefined
    const { provider: _provider, type: _type, compat, ...definition } = model
    models.push({ ...definition, compat: { ...compat } })
  }
  return models.length > 0 ? models : undefined
}
