import { describe, expect, test } from "bun:test"
import {
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

describe("Meridian OpenCode V2 model discovery", () => {
  test("preserves a configured base URL path when finding the models endpoint", () => {
    expect(meridianModelsURL("http://127.0.0.1:3456/meridian")).toBe(
      "http://127.0.0.1:3456/meridian/v1/models",
    )
    expect(meridianModelsURL("not a URL")).toBeUndefined()
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

  test("adds discovered models but preserves exact user-defined overrides", () => {
    const updates: Array<{ providerID: string; modelID: string; name: string; context: number; variants: string[] }> = []
    const catalog = {
      provider: {
        get: () => ({
          provider: { settings: {} },
          models: new Map([["claude-haiku-4-5", { name: "Fast alias" }]]),
        }),
      },
      model: {
        update: (providerID: string, modelID: string, update: (model: { name: string; limit: { context: number } }) => void) => {
          const model = { name: modelID, limit: { context: 200_000 }, variants: [] as Array<{ id: string }> }
          update(model)
          updates.push({ providerID, modelID, name: model.name, context: model.limit.context, variants: model.variants.map(variant => variant.id) })
        },
      },
    }

    applyMeridianModels(catalog, "meridian", parseMeridianModels(MERIDIAN_MODELS) ?? [])

    expect(updates).toEqual([{
      providerID: "meridian",
      modelID: "claude-fable-5",
      name: "Claude Fable 5",
      context: 1_000_000,
      variants: ["low", "high"],
    }])
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
