/**
 * Meridian OpenCode plugin for the V2 beta line.
 *
 * OpenCode V2 runs hidden title and summary requests in the parent session,
 * often in parallel with the visible first turn. V2's core gives all of those
 * requests the same session-affinity headers. Meridian must detach the hidden
 * one-shots before they reach the proxy or they can advance the visible
 * conversation's durable lineage.
 *
 * The model hook applies the identity as early as V2 permits. The HTTP hook
 * enforces it again at the final request boundary. This removes stale or
 * spoofed control headers regardless of header casing.
 *
 * NOTE: OpenCode-specific. Keep this separate from plugin/meridian.ts: V1
 * expects a default plugin function and V2 expects a Plugin.define() object.
 */

import * as Plugin from "@opencode-ai/plugin/promise/plugin"
import { Model } from "@opencode-ai/schema/model"
import type { CatalogDraft } from "@opencode-ai/plugin/promise/catalog"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  PRIORITY_ATTESTATION_HEADER,
  createPriorityAttestation,
  deleteHeader,
  getHeader,
  meridianConfigDirectory,
  setHeader,
  type MutableHeaders,
} from "./priority-attestation"

/** SDK contract used to compile this plugin; setup gates separately validated host versions. */
export const SUPPORTED_OPENCODE_V2_VERSION = "0.0.0-beta-18314"

const MERIDIAN_PROVIDERS = new Set(["anthropic", "meridian"])
const MERIDIAN_CATALOG_PROVIDER = "meridian"
const PARENT_SESSION_ONE_SHOTS = new Set(["title", "summary"])
const ATTACHED_COMPACTION_AGENT = "compaction"
const MODEL_DISCOVERY_TIMEOUT_MS = 3_000
const PROVIDER_READY_POLL_MS = 25

/**
 * Catalog cache, for the cold-start gap (#1008).
 *
 * Discovery cannot begin until OpenCode has finished assembling the catalog, so
 * the first request against a freshly started server used to see only
 * OpenCode's built-in models.dev entries and rejected a Meridian-only variant
 * with `provider.no-route`. Awaiting the catalog inside `setup` deadlocks the
 * server, so the seed has to come from somewhere that is not the catalog: a
 * plain file, read synchronously before the first transform runs.
 *
 * The entry records the base URL it was discovered from and is only applied to a
 * provider still pointed at that URL, so repointing OpenCode at a different
 * Meridian cannot apply another one's models.
 */
const CATALOG_CACHE_FILE = "opencode-v2-catalog.json"
const CATALOG_CACHE_VERSION = 1
/** Bounds how stale a seed can be if discovery never succeeds again. */
const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
// The plugin tree does not import from src/, so this mirrors VALID_EFFORTS in
// src/proxy/effort.ts. A test asserts the two stay identical. Filtering in this
// order also gives every model its variants low -> max regardless of the order
// the proxy happens to serialise its capability object in.
const MERIDIAN_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export const MERIDIAN_V2_EFFORTS: readonly string[] = MERIDIAN_EFFORTS

const SESSION_AFFINITY_HEADERS = [
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "x-parent-session-id",
] as const

const MERIDIAN_CONTROL_HEADERS = [
  "x-meridian-source",
  "x-opencode-agent-name",
  "x-opencode-agent-mode",
  PRIORITY_ATTESTATION_HEADER,
] as const

export interface AgentTraits {
  mode: "primary" | "subagent"
  hidden: boolean
}

const BUILTIN_AGENT_TRAITS: Record<string, AgentTraits> = {
  build: { mode: "primary", hidden: false },
  plan: { mode: "primary", hidden: false },
  general: { mode: "subagent", hidden: false },
  explore: { mode: "subagent", hidden: false },
  // Exact beta-18314 defines all three hidden internal agents as primary.
  title: { mode: "primary", hidden: true },
  summary: { mode: "primary", hidden: true },
  compaction: { mode: "primary", hidden: true },
}

export function fallbackAgentTraits(agent: string): AgentTraits {
  return BUILTIN_AGENT_TRAITS[agent] ?? { mode: "primary", hidden: false }
}

function safeAgentName(agent: string): string {
  return agent.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"
}

export function shouldDetachFromParentSession(agent: string, _traits: AgentTraits): boolean {
  // The exact built-in ID is authoritative. `hidden` is presentation config:
  // making the built-in visible does not stop V2 from running its parent-
  // session title/summary job concurrently with the primary turn.
  return PARENT_SESSION_ONE_SHOTS.has(agent)
}

/**
 * Rewrite one V2 request's identity without changing its body or model input.
 * This pure helper is shared by model.request and http.request.
 */
export function applyMeridianV2Headers(
  headers: MutableHeaders,
  input: { sessionID: string; agent: string; traits: AgentTraits },
): void {
  for (const name of SESSION_AFFINITY_HEADERS) deleteHeader(headers, name)
  for (const name of MERIDIAN_CONTROL_HEADERS) deleteHeader(headers, name)

  const name = safeAgentName(input.agent)
  const detached = shouldDetachFromParentSession(input.agent, input.traits)

  if (detached) {
    setHeader(headers, "x-meridian-source", `subagent-${name}`)
  } else {
    // Set every V2 affinity spelling from the trusted hook input. Do not retain
    // provider-config values that can bind this request to another session.
    setHeader(headers, "x-opencode-session", input.sessionID)
    setHeader(headers, "x-session-affinity", input.sessionID)
    setHeader(headers, "x-session-id", input.sessionID)
    if (input.agent === ATTACHED_COMPACTION_AGENT) {
      // Source selects the base model tier without making the adapter append
      // `#compaction` to the primary session key.
      setHeader(headers, "x-meridian-source", "subagent-compaction")
    }
  }

  const internalMode = PARENT_SESSION_ONE_SHOTS.has(input.agent)
    ? "subagent"
    : input.agent === ATTACHED_COMPACTION_AGENT ? "primary" : input.traits.mode
  setHeader(headers, "x-opencode-agent-name", name)
  setHeader(headers, "x-opencode-agent-mode", internalMode)
}

const INTERNAL_ROUTING_AGENT_IDS = new Set(["title", "summary", "compaction"])
const AGENT_CACHE_MAX = 256
const AGENT_CACHE_TTL_MS = 5_000
const LOOKUP_TIMEOUT_MS = 250
const MAX_CONTEXT_ENTRIES = 2_048
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

type ExactAgentMode = "primary" | "subagent" | "all"
type ResolvedAgentMetadata = {
  readonly traits: AgentTraits
  readonly exactMode: ExactAgentMode | undefined
  readonly authoritative: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface MeridianModel {
  id: string
  name: string
  contextWindow: number
  efforts: string[]
}

export interface MeridianProviderModels {
  providerID: string
  /** The URL these models came from, so a cached seed is never applied to another. */
  baseURL?: string
  models: MeridianModel[]
}

type MeridianCatalogClient = {
  provider: {
    get(input: { providerID: string }): Promise<unknown>
  }
  reload(): Promise<void>
}

type ModelFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function meridianModelsURL(baseURL: unknown): string | undefined {
  if (typeof baseURL !== "string" || baseURL.length === 0) return undefined
  try {
    const url = new URL(baseURL)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    url.search = ""
    url.hash = ""
    if (!url.pathname.endsWith("/")) url.pathname += "/"
    // OpenCode's Anthropic provider carries the API version in the base URL
    // (`http://127.0.0.1:3456/v1`), which is also the shape the V2 package gate
    // configures. Appending `v1/models` there requests `/v1/v1/models`, a 404
    // that silently disables discovery, so resolve `models` against an existing
    // version segment instead.
    const endpoint = /(?:^|\/)v1\/$/.test(url.pathname) ? "models" : "v1/models"
    return new URL(endpoint, url).toString()
  } catch {
    return undefined
  }
}

export function parseMeridianModels(value: unknown): MeridianModel[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined

  const models: MeridianModel[] = []
  const ids = new Set<string>()
  for (const item of value.data) {
    if (!isRecord(item)) return undefined
    const id = item.id
    const name = item.display_name
    const contextWindow = item.context_window
    if (
      typeof id !== "string"
      || id.length === 0
      || id.length > 256
      || /[^\x21-\x7E]/.test(id)
      || ids.has(id)
      || typeof name !== "string"
      || name.trim().length === 0
      || name.length > 256
      || typeof contextWindow !== "number"
      || !Number.isSafeInteger(contextWindow)
      || contextWindow <= 0
    ) {
      return undefined
    }
    const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined
    const effort = capabilities && isRecord(capabilities.effort) ? capabilities.effort : undefined
    const efforts = MERIDIAN_EFFORTS.filter((level) => isRecord(effort?.[level]) && effort[level].supported === true)
    ids.add(id)
    models.push({ id, name, contextWindow, efforts })
  }
  return models
}

export async function fetchMeridianModels(
  baseURL: unknown,
  signal: AbortSignal,
  fetcher: ModelFetcher = globalThis.fetch,
): Promise<MeridianModel[] | undefined> {
  const url = meridianModelsURL(baseURL)
  if (!url || signal.aborted) return undefined

  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, MODEL_DISCOVERY_TIMEOUT_MS)
  timeout.unref?.()
  signal.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetcher(url, { signal: controller.signal })
    if (!response.ok) return undefined
    return parseMeridianModels(await response.json())
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
  }
}

function meridianProviderBaseURL(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  const provider = isRecord(value.data) ? value.data : value
  if (!isRecord(provider.settings)) return undefined
  return provider.settings.baseURL
}

function isLegacyMeridianBaseURL(baseURL: unknown): boolean {
  if (typeof baseURL !== "string") return false
  try {
    const { hostname } = new URL(baseURL)
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  } catch {
    return false
  }
}

export interface MeridianCatalogLoad {
  /** Providers whose base URL still looks like Meridian, reachable or not. */
  readonly configured: string[]
  readonly discovered: MeridianProviderModels[]
}

export async function loadMeridianModels(
  catalog: MeridianCatalogClient,
  signal: AbortSignal,
  fetcher: ModelFetcher = globalThis.fetch,
): Promise<MeridianCatalogLoad> {
  const deadline = Date.now() + MODEL_DISCOVERY_TIMEOUT_MS
  while (!signal.aborted) {
    const providers = await Promise.all([...MERIDIAN_PROVIDERS].map(async (providerID) => {
      try {
        const baseURL = meridianProviderBaseURL(await catalog.provider.get({ providerID }))
        if (providerID === MERIDIAN_CATALOG_PROVIDER && meridianModelsURL(baseURL) === undefined) return undefined
        if (providerID !== MERIDIAN_CATALOG_PROVIDER && !isLegacyMeridianBaseURL(baseURL)) return undefined
        return { providerID, baseURL }
      } catch {
        return undefined
      }
    }))
    const configured = providers.flatMap(provider => provider ? [provider] : [])
    if (configured.length > 0) {
      const discovered = await Promise.all(configured.map(async ({ providerID, baseURL }) => {
        const models = await fetchMeridianModels(baseURL, signal, fetcher)
        return models ? { providerID, baseURL: typeof baseURL === "string" ? baseURL : undefined, models } : undefined
      }))
      return {
        configured: configured.map(provider => provider.providerID),
        discovered: discovered.flatMap(result => result ? [result] : []),
      }
    }
    if (Date.now() >= deadline) return { configured: [], discovered: [] }
    await new Promise<void>((resolve) => setTimeout(resolve, PROVIDER_READY_POLL_MS))
  }
  return { configured: [], discovered: [] }
}

export interface CachedProviderCatalog {
  readonly baseURL: string
  readonly models: readonly MeridianModel[]
}

export function catalogCachePath(): string {
  return join(meridianConfigDirectory(), CATALOG_CACHE_FILE)
}

/**
 * Validate a cache document as strictly as a discovery response.
 *
 * A corrupt or hand-edited file must seed nothing rather than write junk into
 * the catalog, so every failure returns an empty map.
 */
export function parseCatalogCache(value: unknown, now: number): Map<string, CachedProviderCatalog> {
  const entries = new Map<string, CachedProviderCatalog>()
  if (!isRecord(value) || value.version !== CATALOG_CACHE_VERSION) return entries
  if (!isRecord(value.providers)) return entries
  for (const [providerID, entry] of Object.entries(value.providers)) {
    if (!MERIDIAN_PROVIDERS.has(providerID) || !isRecord(entry)) continue
    const { baseURL, fetchedAt } = entry
    if (typeof baseURL !== "string" || meridianModelsURL(baseURL) === undefined) continue
    if (typeof fetchedAt !== "number" || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) continue
    if (fetchedAt > now || now - fetchedAt > CATALOG_CACHE_TTL_MS) continue
    const models = parseCachedModels(entry.models)
    if (!models || models.length === 0) continue
    entries.set(providerID, { baseURL, models })
  }
  return entries
}

function parseCachedModels(value: unknown): MeridianModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const models: MeridianModel[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const { id, name, contextWindow, efforts } = item
    if (
      typeof id !== "string"
      || id.length === 0
      || id.length > 256
      || /[^\x21-\x7E]/.test(id)
      || ids.has(id)
      || typeof name !== "string"
      || name.trim().length === 0
      || name.length > 256
      || typeof contextWindow !== "number"
      || !Number.isSafeInteger(contextWindow)
      || contextWindow <= 0
      || !Array.isArray(efforts)
      || efforts.some(effort => typeof effort !== "string" || !MERIDIAN_EFFORTS.includes(effort as never))
    ) {
      return undefined
    }
    ids.add(id)
    models.push({ id, name, contextWindow, efforts: efforts as string[] })
  }
  return models
}

export function serializeCatalogCache(
  discovered: readonly MeridianProviderModels[],
  now: number,
): string {
  const providers: Record<string, unknown> = {}
  for (const entry of discovered) {
    if (typeof entry.baseURL !== "string" || entry.models.length === 0) continue
    providers[entry.providerID] = { baseURL: entry.baseURL, fetchedAt: now, models: entry.models }
  }
  return `${JSON.stringify({ version: CATALOG_CACHE_VERSION, providers }, null, 2)}\n`
}

/**
 * Drop the seed. Called when no Meridian-shaped provider is configured any
 * more, so a later cold start cannot describe a provider this catalog no longer
 * points at. Best effort, like the write.
 */
export function removeCatalogCache(remove: (path: string) => void = path => rmSync(path, { force: true })): void {
  try {
    remove(catalogCachePath())
  } catch {
    // Ignored on purpose: a stale seed is corrected by the next discovery.
  }
}

/** Read the seed. Any failure — missing, unreadable, corrupt — seeds nothing. */
export function readCatalogCache(
  now: number,
  read: (path: string) => string = path => readFileSync(path, "utf-8"),
): Map<string, CachedProviderCatalog> {
  try {
    return parseCatalogCache(JSON.parse(read(catalogCachePath())), now)
  } catch {
    return new Map()
  }
}

/**
 * Persist the seed for the next cold start. Best effort: a cache we cannot write
 * costs a deferred catalog on the next start, which is the old behaviour, so it
 * must never interrupt a working session.
 */
export function writeCatalogCache(
  discovered: readonly MeridianProviderModels[],
  now: number,
  write: (path: string, contents: string) => void = (path, contents) => {
    // Rename onto the target so a concurrent reader never sees a partial file.
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, contents, { encoding: "utf-8", mode: 0o600 })
    renameSync(temporary, path)
  },
): void {
  try {
    const contents = serializeCatalogCache(discovered, now)
    if (contents.includes('"providers": {}')) return
    write(catalogCachePath(), contents)
  } catch {
    // Ignored on purpose: see above.
  }
}

/**
 * The only thing choosing a seed needs from the draft: whether a provider is
 * still in the catalog. Narrower than `CatalogDraft` on purpose, so the decision
 * stays unit-testable without standing up a whole branded provider record.
 */
export interface CatalogProviderProbe {
  readonly provider: { get(providerID: string): unknown }
}

/**
 * Choose what the transform should write: live discovery when it has landed,
 * otherwise the cached seed.
 *
 * The seed cannot be validated against the provider's configured URL here. A
 * draft `Provider.Info` exposes only `id`, `name`, `activation`, `package`,
 * `integrationID` and `headers` — verified on beta-18866, where the whole
 * record contains no URL at all. So the seed is applied optimistically to any
 * Meridian provider that still exists in the catalog, and `discoverModels`
 * corrects or drops it once it can read the real URL.
 */
export function resolveCatalogModels(
  catalog: CatalogProviderProbe,
  discovered: readonly MeridianProviderModels[],
  cached: ReadonlyMap<string, CachedProviderCatalog>,
): MeridianProviderModels[] {
  if (discovered.length > 0) return [...discovered]
  const seeded: MeridianProviderModels[] = []
  for (const providerID of MERIDIAN_PROVIDERS) {
    const entry = cached.get(providerID)
    if (!entry) continue
    if (!catalog.provider.get(providerID)) continue
    seeded.push({ providerID, baseURL: entry.baseURL, models: [...entry.models] })
  }
  return seeded
}

/**
 * Write Meridian's advertised models over the assembled V2 catalog.
 *
 * Meridian is authoritative for what it will actually serve: the context window
 * follows the signed-in subscription (Sonnet stays 200k so a 1M turn is not
 * billed as Extra Usage), and the effort levels are the ones the proxy accepts.
 * OpenCode's built-in models.dev entries disagree — beta-18866 advertises a 1M
 * Sonnet — so an entry that already exists must be corrected, not skipped.
 *
 * This does not overwrite user configuration. V2 layers `providers.<id>.models`
 * on top of plugin transforms, verified live on beta-18866: a configured
 * `claude-opus-5` override survived a transform that wrote a different name and
 * context to the same model.
 */
export function applyMeridianModels(
  catalog: CatalogDraft,
  providerID: string,
  models: readonly MeridianModel[],
): void {
  for (const model of models) {
    catalog.model.update(providerID, model.id, (entry) => {
      entry.name = model.name
      entry.limit.context = model.contextWindow
      entry.variants = model.efforts.map((effort) => ({
        id: Model.VariantID.make(effort),
        headers: {},
        body: { effort },
      }))
    })
  }
}

async function withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function isRootV2Session(value: unknown, sessionID: string): boolean {
  return isRecord(value)
    && value.id === sessionID
    && value.parentID === undefined
    && value.fork === undefined
}

/**
 * Find the exact host message ID that initiated the active model loop.
 * Assistant/tool steps and selection records belong to the current loop and
 * are skipped. A synthetic/compaction/shell/skill/system or unknown initiator
 * fails closed instead of reusing an older human ID.
 */
type V2HumanTurn = { readonly id: string; readonly issuedAt: number }

export function findLatestV2HumanTurn(value: unknown): V2HumanTurn | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTEXT_ENTRIES) return undefined
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = value[index]
    if (!isRecord(message) || typeof message.type !== "string") return undefined
    if (
      message.type === "assistant"
      || message.type === "agent-switched"
      || message.type === "model-switched"
      || message.type === "location-switched"
    ) {
      continue
    }
    if (message.type !== "user" || typeof message.id !== "string" || !SAFE_ID_PATTERN.test(message.id)) {
      return undefined
    }
    const time = isRecord(message.time) ? message.time : undefined
    const createdAt = time?.created
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) return undefined
    return { id: message.id, issuedAt: Math.floor(createdAt / 1000) }
  }
  return undefined
}

export function findLatestV2HumanMessageId(value: unknown): string | undefined {
  return findLatestV2HumanTurn(value)?.id
}

const MeridianV2Plugin = Plugin.define({
  id: "meridian",
  setup: async (context) => {
    const traitsByAgent = new Map<string, {
      expiresAt: number
      request: symbol
      pending: Promise<ResolvedAgentMetadata>
    }>()
    const registered: Array<{ dispose: () => Promise<void> }> = []
    const modelDiscoveryController = new AbortController()
    let discoveredModels: MeridianProviderModels[] = []
    let discoveryStarted = false
    // Read synchronously, before the first transform can run. Awaiting the
    // catalog here would deadlock the server, which is why the seed is a file
    // and not a catalog read (#1008).
    const cachedModels = readCatalogCache(Date.now())

    registered.push(await context.catalog.transform((catalog) => {
      for (const entry of resolveCatalogModels(catalog, discoveredModels, cachedModels)) {
        applyMeridianModels(catalog, entry.providerID, entry.models)
      }
    }))

    const discoverModels = async () => {
      if (discoveryStarted || modelDiscoveryController.signal.aborted) return false
      const loaded = await loadMeridianModels(context.catalog, modelDiscoveryController.signal)
        .catch((): MeridianCatalogLoad => ({ configured: [], discovered: [] }))
      if (modelDiscoveryController.signal.aborted) return false
      if (loaded.configured.length === 0) {
        // Nothing here points at Meridian any more — the user repointed the
        // provider. A seed from a previous run would describe a different
        // endpoint, so drop it and rebuild the catalog without it.
        if (cachedModels.size > 0) {
          cachedModels.clear()
          removeCatalogCache()
          await context.catalog.reload()
        }
        return false
      }
      // Configured but unreachable: keep the seed. It is the last thing Meridian
      // actually served, which beats OpenCode's models.dev entries.
      if (loaded.discovered.length === 0) return false
      discoveryStarted = true
      discoveredModels = loaded.discovered
      // Seed the next cold start before the reload, so a crash mid-reload still
      // leaves the catalog available to the following process.
      writeCatalogCache(loaded.discovered, Date.now())
      await context.catalog.reload()
      return true
    }

    const catalogEvents = context.event.subscribe({ signal: modelDiscoveryController.signal })
    void (async () => {
      for await (const event of catalogEvents) {
        if (event.type !== "catalog.updated") continue
        if (await discoverModels()) return
      }
    })().catch(() => {})

    const resolveAgentTraits = (agent: string, refresh = false): Promise<ResolvedAgentMetadata> => {
      const cached = traitsByAgent.get(agent)
      if (!refresh && cached && cached.expiresAt > Date.now()) return cached.pending
      if (refresh) traitsByAgent.delete(agent)

      const request = Symbol(agent)
      const pending = (async (): Promise<ResolvedAgentMetadata> => {
        const controller = new AbortController()
        try {
          const result = await withTimeout(
            context.agent.get({ agentID: agent }, { signal: controller.signal }),
            LOOKUP_TIMEOUT_MS,
          )
          const data = result?.data
          if (
            !data
            || (data.mode !== "primary" && data.mode !== "subagent" && data.mode !== "all")
            || typeof data.hidden !== "boolean"
          ) {
            if (traitsByAgent.get(agent)?.request === request) traitsByAgent.delete(agent)
            return { traits: fallbackAgentTraits(agent), exactMode: undefined, authoritative: false }
          }
          return {
            traits: {
              mode: data.mode === "subagent" ? "subagent" : "primary",
              hidden: data.hidden,
            },
            exactMode: data.mode,
            authoritative: true,
          }
        } catch {
          // Retry a transient failure at the final HTTP boundary or next turn.
          if (traitsByAgent.get(agent)?.request === request) traitsByAgent.delete(agent)
          return { traits: fallbackAgentTraits(agent), exactMode: undefined, authoritative: false }
        } finally {
          controller.abort()
        }
      })()
      traitsByAgent.delete(agent)
      traitsByAgent.set(agent, { request, expiresAt: Date.now() + AGENT_CACHE_TTL_MS, pending })
      while (traitsByAgent.size > AGENT_CACHE_MAX) {
        const oldest = traitsByAgent.keys().next().value
        if (oldest === undefined) break
        traitsByAgent.delete(oldest)
      }
      return pending
    }

    const apply = async (
      input: { sessionID: string; agent: string; model: { providerID: string } },
      headers: MutableHeaders,
      refreshTraits = false,
    ): Promise<ResolvedAgentMetadata | undefined> => {
      if (!MERIDIAN_PROVIDERS.has(String(input.model.providerID))) return undefined
      const agent = String(input.agent)
      const metadata = await resolveAgentTraits(agent, refreshTraits)
      applyMeridianV2Headers(headers, {
        sessionID: String(input.sessionID),
        agent,
        traits: metadata.traits,
      })
      return metadata
    }

    const resolveHumanTurn = async (
      input: { sessionID: string; agent: string },
      headers: MutableHeaders,
      metadata: ResolvedAgentMetadata,
    ): Promise<V2HumanTurn | undefined> => {
      const sessionID = String(input.sessionID)
      const agent = String(input.agent)
      if (
        !metadata.authoritative
        || metadata.exactMode !== "primary"
        || metadata.traits.hidden
        || INTERNAL_ROUTING_AGENT_IDS.has(agent)
        || safeAgentName(agent) !== agent
        || getHeader(headers, "x-meridian-profile") !== undefined
      ) {
        return undefined
      }

      const controller = new AbortController()
      try {
        const result = await withTimeout(Promise.all([
          context.session.get({ sessionID }, { signal: controller.signal }),
          context.session.context({ sessionID }, { signal: controller.signal }),
        ]), LOOKUP_TIMEOUT_MS)
        if (!result || !isRootV2Session(result[0], sessionID)) return undefined
        return findLatestV2HumanTurn(result[1])
      } catch {
        return undefined
      } finally {
        controller.abort()
      }
    }

    try {
      for (const providerID of MERIDIAN_PROVIDERS) {
        registered.push(await context.session.hook("model.request", async (input) => {
          // Apply lineage/tier identity early, but never emit the routing
          // attestation before the final HTTP boundary.
          await apply(input, input.headers)
        }, { providerID }))
        registered.push(await context.session.hook("http.request", async (input) => {
          // Re-read exact visibility/mode at the final boundary. The model-hook
          // cache is capability-only and must never authorize a stale visible
          // primary after a config reload.
          const metadata = await apply(input, input.request.headers, true)
          if (!metadata) return
          const humanTurn = await resolveHumanTurn(input, input.request.headers, metadata)
          if (!humanTurn) return
          const token = createPriorityAttestation({
            generation: "oc2b18314",
            sessionId: String(input.sessionID),
            agentId: String(input.agent),
            humanMessageId: humanTurn.id,
            issuedAt: humanTurn.issuedAt,
          })
          if (token) setHeader(input.request.headers, PRIORITY_ATTESTATION_HEADER, token)
        }, { providerID }))
      }
    } catch (error) {
      // Setup never returns its cleanup on this path, so the discovery
      // subscription and its poll loop would otherwise outlive the failure.
      modelDiscoveryController.abort()
      await Promise.allSettled(registered.map(({ dispose }) => dispose()))
      throw error
    }

    return async () => {
      modelDiscoveryController.abort()
      const results = await Promise.allSettled(registered.map(({ dispose }) => dispose()))
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Meridian V2 hooks")
    }
  },
})

export default MeridianV2Plugin
