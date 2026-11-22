/**
 * Tests for the Pi extension's model catalog: parsing Meridian's /v1/models,
 * building Pi model definitions and restoring Pi's stored snapshot.
 */
import { describe, expect, test } from "bun:test"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { VALID_EFFORTS } from "../proxy/effort"
import { buildModelList } from "../proxy/openai"
import { chatGptModelList } from "../proxy/chatgpt/catalog"
import {
  BUILTIN_CATALOG,
  DEFAULT_BASE_URL,
  MERIDIAN_PI_EFFORTS,
  STORED_CATALOG_TTL_MS,
  buildModels,
  cacheOnlyModels,
  catalogStoreEntry,
  fetchCatalog,
  normalizeBaseUrl,
  parseCatalog,
  restoreModels,
} from "../../plugin/pi/catalog"

const anthropicModels = builtinProviders().find(provider => provider.id === "anthropic")!.getModels()
const BASE = "http://127.0.0.1:3456"

function meridianCatalog(options: { chatGpt?: boolean } = {}) {
  const chatGpt = options.chatGpt
    ? chatGptModelList([{ slug: "gpt-6.1", displayName: "GPT-6.1", contextWindow: null, plans: null }], 0)
    : []
  return { object: "list", data: [...buildModelList(true, 0), ...chatGpt] }
}

describe("Pi extension base URL", () => {
  test("defaults to Meridian's loopback port", () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_BASE_URL)
    expect(normalizeBaseUrl("  ")).toBe(DEFAULT_BASE_URL)
  })

  test("strips trailing slashes and an Anthropic-style /v1 suffix", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:3458/")).toBe("http://127.0.0.1:3458")
    expect(normalizeBaseUrl("http://127.0.0.1:3458/v1")).toBe("http://127.0.0.1:3458")
    expect(normalizeBaseUrl("http://127.0.0.1:3458/v1/")).toBe("http://127.0.0.1:3458")
    expect(normalizeBaseUrl("http://host/meridian")).toBe("http://host/meridian")
  })
})

describe("Pi extension catalog parsing", () => {
  // The plugin cannot import from src/, so the effort vocabulary is duplicated.
  test("knows exactly the effort levels the proxy accepts", () => {
    expect([...MERIDIAN_PI_EFFORTS]).toEqual([...VALID_EFFORTS])
  })

  // Likewise the built-in catalog: it must be what this Meridian's /v1/models
  // serves without the legacy Opus 4.6 1M entitlement or the 1M opt-out.
  test("ships exactly the Claude models the proxy serves by default", () => {
    expect(BUILTIN_CATALOG).toEqual(parseCatalog({ object: "list", data: buildModelList(false, 0) })!)
  })

  test("reads every Claude model Meridian advertises", () => {
    const parsed = parseCatalog(meridianCatalog())!
    expect(parsed.map(model => model.id)).toEqual(buildModelList(true, 0).map(model => model.id))
    const opus = parsed.find(model => model.id === "claude-opus-5-5")!
    expect(opus).toMatchObject({
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      imageInput: true,
      thinking: true,
      adaptiveThinking: true,
      enabledThinking: false,
    })
    expect(opus.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("skips ChatGPT models instead of rejecting the catalog", () => {
    const parsed = parseCatalog(meridianCatalog({ chatGpt: true }))!
    expect(parsed.some(model => model.id === "gpt-6.1")).toBe(false)
    expect(parsed.length).toBe(buildModelList(true, 0).length)
  })

  test("skips malformed and duplicate entries one by one", () => {
    const valid = { id: "claude-new", object: "model", owned_by: "anthropic", display_name: "New", context_window: 1000 }
    const parsed = parseCatalog({
      object: "list",
      data: [
        valid,
        { ...valid, display_name: "Duplicate" },
        { ...valid, id: "bad id" },
        { ...valid, id: "no-name", display_name: " " },
        { ...valid, id: "no-window", context_window: 0 },
        { ...valid, id: "fractional", context_window: 1.5 },
        "not an object",
        null,
      ],
    })
    expect(parsed).toEqual([{
      id: "claude-new",
      name: "New",
      contextWindow: 1000,
      imageInput: undefined,
      thinking: undefined,
      adaptiveThinking: undefined,
      enabledThinking: undefined,
      efforts: undefined,
    }])
  })

  test("rejects a response that is not a model list", () => {
    expect(parseCatalog({ error: "nope" })).toBeUndefined()
    expect(parseCatalog(null)).toBeUndefined()
  })
})

describe("Pi extension model definitions", () => {
  test("routes every model to the Meridian base URL through Pi's Anthropic API", () => {
    const models = buildModels(parseCatalog(meridianCatalog())!, anthropicModels, BASE)
    for (const model of models) {
      expect(model.api).toBe("anthropic-messages")
      expect(model.baseUrl).toBe(BASE)
      expect(model.name.endsWith(" (Meridian)")).toBe(true)
      expect(model.compat?.supportsMidConvoToolChanges).toBe(false)
      expect("promptCache" in model).toBe(false)
    }
  })

  test("keeps Pi's output limit and cost for a model Pi knows, with Meridian's context window", () => {
    const known = anthropicModels.find(model => model.id === "claude-opus-4-6")!
    const [model] = buildModels([{ id: "claude-opus-4-6", name: "Opus", contextWindow: 12345 }], anthropicModels, BASE)
    expect(model!.contextWindow).toBe(12345)
    expect(model!.maxTokens).toBe(known.maxTokens)
    expect(model!.cost).toEqual(known.cost)
  })

  test("gives an unknown model a conservative output limit and zero cost", () => {
    const [large, small] = buildModels([
      { id: "claude-future", name: "Future", contextWindow: 500_000 },
      { id: "claude-tiny", name: "Tiny", contextWindow: 4096 },
    ], anthropicModels, BASE)
    expect(large!.maxTokens).toBe(8192)
    expect(small!.maxTokens).toBe(4096)
    expect(large!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(large!.reasoning).toBe(false)
    expect(large!.input).toEqual(["text"])
  })

  test("maps Meridian's effort levels and thinking modes onto Pi thinking levels", () => {
    const [model] = buildModels([{
      id: "claude-future",
      name: "Future",
      contextWindow: 200_000,
      thinking: true,
      adaptiveThinking: true,
      enabledThinking: false,
      efforts: ["low", "high"],
    }], anthropicModels, BASE)
    expect(model!.reasoning).toBe(true)
    expect(model!.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    })
    expect(model!.compat?.forceAdaptiveThinking).toBe(true)
  })

  test("takes image input from the catalog when it says, otherwise from Pi", () => {
    const [withImages, withoutImages, fallback] = buildModels([
      { id: "claude-a", name: "A", contextWindow: 1000, imageInput: true },
      { id: "claude-opus-4-6", name: "B", contextWindow: 1000, imageInput: false },
      { id: "claude-c", name: "C", contextWindow: 1000 },
    ], anthropicModels, BASE)
    expect(withImages!.input).toEqual(["text", "image"])
    expect(withoutImages!.input).toEqual(["text"])
    expect(fallback!.input).toEqual(["text"])
  })
})

describe("Pi extension discovery request", () => {
  test("requests /v1/models with the API key and returns the parsed catalog", async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: new Headers(init?.headers) })
      return Response.json(meridianCatalog({ chatGpt: true }))
    }) as typeof fetch
    const models = await fetchCatalog(BASE, "secret", AbortSignal.timeout(1000), fetcher)
    expect(requests[0]!.url).toBe(`${BASE}/v1/models`)
    expect(requests[0]!.headers.get("x-api-key")).toBe("secret")
    expect(models.length).toBe(buildModelList(true, 0).length)
  })

  test("sends no API key header when none is configured", async () => {
    let headers: Headers | undefined
    const fetcher = (async (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return Response.json(meridianCatalog())
    }) as typeof fetch
    await fetchCatalog(BASE, undefined, AbortSignal.timeout(1000), fetcher)
    expect(headers!.has("x-api-key")).toBe(false)
  })

  test("reports HTTP failures and malformed bodies", async () => {
    const status = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch
    await expect(fetchCatalog(BASE, undefined, AbortSignal.timeout(1000), status)).rejects.toThrow("HTTP 401")
    const malformed = (async () => Response.json({ nope: true })) as unknown as typeof fetch
    await expect(fetchCatalog(BASE, undefined, AbortSignal.timeout(1000), malformed)).rejects.toThrow("malformed")
    const chatGptOnly = (async () => Response.json({
      object: "list",
      data: chatGptModelList([{ slug: "gpt-6.1", displayName: "GPT-6.1", contextWindow: null, plans: null }], 0),
    })) as unknown as typeof fetch
    await expect(fetchCatalog(BASE, undefined, AbortSignal.timeout(1000), chatGptOnly)).rejects.toThrow("no usable Claude models")
  })
})

describe("Pi extension stored catalog", () => {
  const models = buildModels(parseCatalog(meridianCatalog())!, anthropicModels, BASE)

  test("round-trips through Pi's model store entry", () => {
    const entry = catalogStoreEntry("meridian", models, 1_000)
    expect(entry.checkedAt).toBe(1_000)
    expect(entry.models.every(model => model.provider === "meridian")).toBe(true)
    expect(restoreModels(entry, BASE, 2_000)).toEqual(models)
  })

  test("never applies a snapshot discovered from another Meridian", () => {
    expect(restoreModels(catalogStoreEntry("meridian", models, 1_000), "http://127.0.0.1:3458", 2_000)).toBeUndefined()
  })

  test("treats a snapshot older than the TTL, or from the future, as gone", () => {
    const entry = catalogStoreEntry("meridian", models, 1_000)
    expect(restoreModels(entry, BASE, 1_000 + STORED_CATALOG_TTL_MS)).toEqual(models)
    expect(restoreModels(entry, BASE, 1_001 + STORED_CATALOG_TTL_MS)).toBeUndefined()
    expect(restoreModels(entry, BASE, 999)).toBeUndefined()
  })

  test("restores an expired snapshot when asked for one of any age", () => {
    const entry = catalogStoreEntry("meridian", models, 1_000)
    expect(restoreModels(entry, BASE, 1_001 + STORED_CATALOG_TTL_MS, Number.POSITIVE_INFINITY)).toEqual(models)
    expect(restoreModels(entry, "http://127.0.0.1:3458", 1_001 + STORED_CATALOG_TTL_MS, Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(restoreModels(entry, BASE, 999, Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test("answers the cache-only phase with a fresh, then a complete expired, then the built-in catalog", () => {
    const builtIn = buildModels(BUILTIN_CATALOG, anthropicModels, BASE)
    const expiredAt = 1_001 + STORED_CATALOG_TTL_MS
    const partial = models.filter(model => model.id !== "claude-haiku-5-5")
    expect(cacheOnlyModels(catalogStoreEntry("meridian", partial, 1_000), BASE, 2_000, builtIn)).toEqual(partial)
    expect(cacheOnlyModels(catalogStoreEntry("meridian", models, 1_000), BASE, expiredAt, builtIn)).toEqual(models)
    // An expired catalog missing a model the extension knows predates its Meridian version.
    expect(cacheOnlyModels(catalogStoreEntry("meridian", partial, 1_000), BASE, expiredAt, builtIn)).toEqual(builtIn)
    expect(cacheOnlyModels(catalogStoreEntry("meridian", models, 1_000), "http://127.0.0.1:3458", 2_000, builtIn)).toEqual(builtIn)
    expect(cacheOnlyModels(undefined, BASE, 0, builtIn)).toEqual(builtIn)
  })

  test("ignores a missing or empty snapshot", () => {
    expect(restoreModels(undefined, BASE, 0)).toBeUndefined()
    expect(restoreModels({ models: [], checkedAt: 0 }, BASE, 0)).toBeUndefined()
    expect(restoreModels({ models: catalogStoreEntry("meridian", models, 0).models }, BASE, 0)).toBeUndefined()
  })
})
