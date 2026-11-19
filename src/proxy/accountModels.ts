/**
 * The Claude models one account may use, as Anthropic lists them for its own
 * credential (`GET /v1/models`).
 *
 * Accounts differ: a Team account lists models a personal Max account does
 * not (Claude Mythos), so a client choosing a model for a pinned profile needs
 * that account's own list rather than Meridian's static one. Cached per
 * profile for ten minutes because the list changes approximately never and
 * clients read it on every start. Policy and contract: profiles-routing.spec.md,
 * "A pinned model list is that account's own".
 *
 * Leaf module: no imports from server.ts or session/. The credential never
 * leaves the request headers; nothing here logs or returns it.
 */

import { z } from "zod"
import { claudeLog } from "../logger"
import { oauthUserAgent } from "./oauthUsage"
import type { ModelCapabilities, OpenAiModel } from "./openai"

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000"
const OAUTH_BETA_HEADER = "oauth-2025-04-20"
const ANTHROPIC_VERSION = "2023-06-01"
export const ACCOUNT_MODELS_TTL_MS = 10 * 60_000
/** Floor between two attempts for a profile whose last one failed. */
const FAILURE_RETRY_AFTER_MS = 60_000
const CAPPED_CONTEXT_WINDOW = 200_000

const anthropicModel = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  created_at: z.string().optional(),
  max_input_tokens: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
})
const anthropicModelList = z.object({ data: z.array(anthropicModel).min(1) })

export type AnthropicModel = z.infer<typeof anthropicModel>

/** One `/v1/models` entry for an account: the static shape plus its output limit. */
export interface AccountModel extends Omit<OpenAiModel, "capabilities"> {
  max_output_tokens?: number
  capabilities?: ModelCapabilities | Record<string, unknown>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface CacheEntry {
  readonly models: AnthropicModel[] | null
  readonly at: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<AnthropicModel[] | null>>()

export interface FetchAccountModelsOpts {
  /** The profile the list belongs to. */
  readonly cacheKey: string
  /** The account's auth headers; empty when it has no usable credential. */
  readonly auth: () => Promise<Record<string, string>>
  /** Renew the credential after a 401; true when a new one was stored. */
  readonly refresh?: () => Promise<boolean>
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
}

/**
 * The account's models, or null when they cannot be read (no credential,
 * upstream refused, malformed answer). The caller falls back to the static
 * list; null is cached for a minute so a broken account is not asked on
 * every read.
 */
export async function fetchAccountModels(opts: FetchAccountModelsOpts): Promise<AnthropicModel[] | null> {
  const now = opts.now ?? Date.now
  const cached = cache.get(opts.cacheKey)
  if (cached && now() - cached.at < (cached.models ? ACCOUNT_MODELS_TTL_MS : FAILURE_RETRY_AFTER_MS)) return cached.models
  const pending = inflight.get(opts.cacheKey)
  if (pending) return pending
  const request = readModels(opts)
    .then(models => {
      if (inflight.get(opts.cacheKey) === request) cache.set(opts.cacheKey, { models, at: now() })
      return models
    })
    .finally(() => {
      if (inflight.get(opts.cacheKey) === request) inflight.delete(opts.cacheKey)
    })
  inflight.set(opts.cacheKey, request)
  return request
}

async function readModels(opts: FetchAccountModelsOpts): Promise<AnthropicModel[] | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const failed = (reason: string, status?: number): null => {
    claudeLog("account_models.unavailable", { profile: opts.cacheKey, reason, ...(status === undefined ? {} : { status }) })
    return null
  }
  try {
    let auth = await opts.auth()
    if (Object.keys(auth).length === 0) return failed("no_credential")
    let response = await callModels(auth, fetchImpl)
    if (response.status === 401 && opts.refresh && await opts.refresh()) {
      auth = await opts.auth()
      if (Object.keys(auth).length === 0) return failed("no_credential_after_refresh")
      response = await callModels(auth, fetchImpl)
    }
    if (!response.ok) return failed("upstream_error", response.status)
    const parsed = anthropicModelList.safeParse(await response.json())
    if (!parsed.success) return failed("malformed")
    claudeLog("account_models.read", { profile: opts.cacheKey, count: parsed.data.data.length })
    return parsed.data.data
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
}

function callModels(auth: Record<string, string>, fetchImpl: FetchLike): Promise<Response> {
  return fetchImpl(MODELS_URL, {
    headers: {
      ...auth,
      ...("Authorization" in auth ? { "anthropic-beta": OAUTH_BETA_HEADER } : {}),
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
      "User-Agent": oauthUserAgent(),
    },
    signal: AbortSignal.timeout(10_000),
  })
}

/**
 * Map the account's models to Meridian's `/v1/models` entries. A model the
 * static list already describes keeps its static capabilities, name and
 * window fallback; the account's own limits win where Anthropic gives them.
 */
export function toAccountModelList(
  models: readonly AnthropicModel[],
  staticModels: readonly OpenAiModel[],
  opts: { readonly disable1mContext: boolean; readonly now: number },
): AccountModel[] {
  const known = new Map(staticModels.map(model => [model.id, model]))
  return models.map((model): AccountModel => {
    const staticModel = known.get(model.id)
    const createdMs = model.created_at ? Date.parse(model.created_at) : Number.NaN
    const window = model.max_input_tokens ?? staticModel?.context_window ?? CAPPED_CONTEXT_WINDOW
    const capabilities = staticModel?.capabilities ?? model.capabilities
    return {
      id: model.id,
      object: "model",
      created: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : opts.now,
      owned_by: "anthropic",
      display_name: model.display_name ?? staticModel?.display_name ?? model.id,
      context_window: opts.disable1mContext ? Math.min(window, CAPPED_CONTEXT_WINDOW) : window,
      ...(model.max_tokens === undefined ? {} : { max_output_tokens: model.max_tokens }),
      ...(capabilities === undefined ? {} : { capabilities }),
    }
  })
}

/** Forget one profile's list (a new login may be another account), or all of them. */
export function clearAccountModels(cacheKey?: string): void {
  if (cacheKey === undefined) {
    cache.clear()
    inflight.clear()
    return
  }
  cache.delete(cacheKey)
  inflight.delete(cacheKey)
}
