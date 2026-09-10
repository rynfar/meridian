import { describe, expect, test } from "bun:test"
import type { CatalogDraft } from "@opencode-ai/plugin/promise/catalog"
import type { DeepMutable } from "@opencode-ai/plugin/promise/types"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { VALID_EFFORTS } from "../proxy/effort"
import {
  MERIDIAN_V2_EFFORTS,
  applyMeridianModels,
  fetchMeridianModels,
  loadMeridianModels,
  meridianModelsURL,
  parseMeridianModels,
} from "../../plugin/meridian-v2"

const MERIDIAN_MODELS = {
  object: "list",
  data: [
    {
      id: "claude-fable-5",
      display_name: "Claude Fable 5",
      context_window: 1_000_000,
      capabilities: { effort: { low: { supported: true }, high: { supported: true } } },
    },
    { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", context_window: 200_000 },
  ],
}

/**
 * Stand-in for V2's catalog draft, built from the SDK's own model factory so the
 * entries carry the real shape. `model.update` creates a missing entry the way
 * beta-18866 does, and records what the transform wrote.
 */
function makeCatalogDraft(existing: readonly string[]) {
  const models = new Map<string, DeepMutable<Model.Info>>(
    existing.map(id => [id, { ...Model.Info.default(Provider.ID.make("meridian"), Model.ID.make(id)), name: `existing ${id}` }]),
  )
  const written: DeepMutable<Model.Info>[] = []
  const catalog: CatalogDraft = {
    provider: {
      list: () => [],
      // applyMeridianModels reads the catalog only through model.update.
      get: () => undefined,
      update: () => {},
      remove: () => {},
    },
    model: {
      get: (_providerID, modelID) => models.get(modelID),
      update: (providerID, modelID, update) => {
        const entry = models.get(modelID)
          ?? { ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID)) }
        update(entry)
        models.set(modelID, entry)
        written.push(entry)
      },
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
    },
  }
  const wrote = () => written.map(entry => ({
    modelID: String(entry.id),
    name: entry.name,
    context: entry.limit.context,
    variants: entry.variants.map(variant => ({ id: String(variant.id), body: variant.body })),
  }))
  return { catalog, wrote }
}

describe("Meridian OpenCode V2 model discovery", () => {
  // The plugin cannot import from src/, so the effort vocabulary is duplicated.
  // A drift here would advertise a variant the proxy drops, or hide one it takes.
  test("advertises exactly the effort levels the proxy accepts", () => {
    expect(MERIDIAN_V2_EFFORTS).toEqual([...VALID_EFFORTS])
  })

  test("preserves a configured base URL path when finding the models endpoint", () => {
    expect(meridianModelsURL("http://127.0.0.1:3456/meridian")).toBe(
      "http://127.0.0.1:3456/meridian/v1/models",
    )
    expect(meridianModelsURL("not a URL")).toBeUndefined()
  })

  // The V2 Anthropic provider is configured with the API version already in the
  // base URL, which is what the packaged V2 gate writes. Appending `v1/models`
  // there asked Meridian for `/v1/v1/models` and got a 404, so discovery never
  // ran on the documented configuration.
  test("does not double the version segment of an already-versioned base URL", () => {
    expect(meridianModelsURL("http://127.0.0.1:3456/v1")).toBe("http://127.0.0.1:3456/v1/models")
    expect(meridianModelsURL("http://127.0.0.1:3456/v1/")).toBe("http://127.0.0.1:3456/v1/models")
    expect(meridianModelsURL("http://127.0.0.1:3456")).toBe("http://127.0.0.1:3456/v1/models")
    // Only an exact trailing `v1` segment counts.
    expect(meridianModelsURL("http://127.0.0.1:3456/apiv1")).toBe(
      "http://127.0.0.1:3456/apiv1/v1/models",
    )
  })

  test("accepts only a complete, unique model list", () => {
    expect(parseMeridianModels(MERIDIAN_MODELS)).toEqual([
      { id: "claude-fable-5", name: "Claude Fable 5", contextWindow: 1_000_000, efforts: ["low", "high"] },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, efforts: [] },
    ])
    expect(parseMeridianModels({ data: [{ id: "claude-fable-5" }] })).toBeUndefined()
    expect(parseMeridianModels({ data: [MERIDIAN_MODELS.data[0], MERIDIAN_MODELS.data[0]] })).toBeUndefined()
  })

  test("fetches the configured Meridian provider", async () => {
    const controller = new AbortController()
    const urls: string[] = []
    const models = await fetchMeridianModels(
      "http://127.0.0.1:3456",
      controller.signal,
      async (input) => {
        urls.push(String(input))
        return new Response(JSON.stringify(MERIDIAN_MODELS), { status: 200 })
      },
    )

    expect(urls).toEqual(["http://127.0.0.1:3456/v1/models"])
    expect(models).toHaveLength(2)
  })

  test("leaves the existing catalog untouched when provider lookup or fetch fails", async () => {
    const controller = new AbortController()
    const failingCatalog = {
      provider: { get: async () => { throw new Error("provider unavailable") } },
      reload: async () => { throw new Error("must not reload") },
    }
    expect(await loadMeridianModels(failingCatalog, controller.signal)).toEqual([])

    const models = await fetchMeridianModels(
      "http://127.0.0.1:3456",
      controller.signal,
      async () => new Response("down", { status: 503 }),
    )
    expect(models).toBeUndefined()
  })

  test("waits for a usable Meridian provider before fetching models", async () => {
    const controller = new AbortController()
    let meridianLookups = 0
    const urls: string[] = []
    const catalog = {
      provider: {
        get: async ({ providerID }: { providerID: string }) => {
          if (providerID !== "meridian") return undefined
          meridianLookups += 1
          return meridianLookups === 1 ? undefined : { settings: { baseURL: "http://127.0.0.1:3456" } }
        },
      },
      reload: async () => {},
    }

    const discovered = await loadMeridianModels(catalog, controller.signal, async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify(MERIDIAN_MODELS), { status: 200 })
    })

    expect(meridianLookups).toBeGreaterThan(1)
    expect(urls).toEqual(["http://127.0.0.1:3456/v1/models"])
    expect(discovered).toEqual([{ providerID: "meridian", models: parseMeridianModels(MERIDIAN_MODELS) ?? [] }])
  })

  // OpenCode's built-in models.dev catalog already carries every model Meridian
  // advertises, so skipping known ids applied nothing at all on the documented
  // provider. It also disagrees with the proxy: beta-18866 lists a 1M Sonnet
  // while Meridian pins Sonnet to 200k. Existing entries must be corrected.
  test("corrects catalog entries that already exist for models Meridian serves", () => {
    const { catalog, wrote } = makeCatalogDraft(["claude-haiku-4-5"])

    applyMeridianModels(catalog, "meridian", parseMeridianModels(MERIDIAN_MODELS) ?? [])

    // Both models are written, including the one the catalog already had, and
    // the effort level lands in the request body the proxy reads.
    expect(wrote()).toEqual([
      {
        modelID: "claude-fable-5",
        name: "Claude Fable 5",
        context: 1_000_000,
        variants: [
          { id: "low", body: { effort: "low" } },
          { id: "high", body: { effort: "high" } },
        ],
      },
      {
        modelID: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        context: 200_000,
        variants: [],
      },
    ])
  })

  test("supports the legacy local Anthropic provider without fetching a direct Anthropic endpoint", async () => {
    const controller = new AbortController()
    const providerLookups: string[] = []
    const urls: string[] = []
    const catalog = {
      provider: {
        get: async ({ providerID }: { providerID: string }) => {
          providerLookups.push(providerID)
          return {
            settings: {
              baseURL: providerID === "anthropic" ? "http://localhost:3456" : undefined,
            },
          }
        },
      },
      reload: async () => {},
    }

    const discovered = await loadMeridianModels(catalog, controller.signal, async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify(MERIDIAN_MODELS), { status: 200 })
    })

    expect(providerLookups.sort()).toEqual(["anthropic", "meridian"])
    expect(urls).toEqual(["http://localhost:3456/v1/models"])
    expect(discovered).toEqual([{
      providerID: "anthropic",
      models: parseMeridianModels(MERIDIAN_MODELS) ?? [],
    }])
  })
})
