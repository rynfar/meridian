/**
 * The cold-start seed (#1008).
 *
 * Discovery cannot start until OpenCode has assembled the catalog, so the first
 * request against a freshly started server saw only OpenCode's models.dev
 * entries and rejected a Meridian-only variant with `provider.no-route`.
 * Awaiting the catalog inside `setup` deadlocks the server, so the seed is a
 * file read synchronously before the first transform.
 */
import { describe, expect, test } from "bun:test"
import {
  parseCatalogCache,
  readCatalogCache,
  resolveCatalogModels,
  serializeCatalogCache,
  writeCatalogCache,
  type CachedProviderCatalog,
  type CatalogProviderProbe,
  type MeridianProviderModels,
} from "../../plugin/meridian-v2"

const NOW = 1_700_000_000_000
const MODELS = [
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, efforts: ["low", "xhigh"] },
]
const DOCUMENT = {
  version: 1,
  providers: { anthropic: { baseURL: "http://127.0.0.1:3466/v1", fetchedAt: NOW - 1_000, models: MODELS } },
}

/** `resolveCatalogModels` consults only provider existence, so that is all this needs. */
function draft(providerIDs: readonly string[]): CatalogProviderProbe {
  return { provider: { get: (providerID: string) => providerIDs.includes(providerID) ? { id: providerID } : undefined } }
}

describe("catalog cache document", () => {
  test("round-trips a discovered catalog", () => {
    const discovered: MeridianProviderModels[] = [
      { providerID: "anthropic", baseURL: "http://127.0.0.1:3466/v1", models: MODELS },
    ]
    const parsed = parseCatalogCache(JSON.parse(serializeCatalogCache(discovered, NOW)), NOW)
    expect(parsed.get("anthropic")).toEqual({ baseURL: "http://127.0.0.1:3466/v1", models: MODELS })
  })

  test("a discovery that fetched nothing writes no file at all", () => {
    const writes: string[] = []
    writeCatalogCache([], NOW, (_path, contents) => writes.push(contents))
    writeCatalogCache([{ providerID: "anthropic", models: [] }], NOW, (_path, contents) => writes.push(contents))
    expect(writes).toEqual([])
  })

  test("seeds nothing from a document it cannot trust", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      "{}",
      { version: 2, providers: DOCUMENT.providers },
      { version: 1 },
      { version: 1, providers: { anthropic: { baseURL: "not a url", fetchedAt: NOW, models: MODELS } } },
      { version: 1, providers: { anthropic: { baseURL: DOCUMENT.providers.anthropic.baseURL, models: MODELS } } },
      { version: 1, providers: { anthropic: { baseURL: DOCUMENT.providers.anthropic.baseURL, fetchedAt: NOW, models: [] } } },
      // An unknown provider must not be seeded even if the entry is well formed.
      { version: 1, providers: { openai: DOCUMENT.providers.anthropic } },
      // Effort levels the proxy does not accept.
      {
        version: 1,
        providers: {
          anthropic: {
            baseURL: DOCUMENT.providers.anthropic.baseURL,
            fetchedAt: NOW,
            models: [{ ...MODELS[0], efforts: ["turbo"] }],
          },
        },
      },
    ]
    for (const value of rejected) expect(parseCatalogCache(value, NOW).size).toBe(0)
  })

  test("expires a seed that is too old, and one dated in the future", () => {
    const stale = { ...DOCUMENT, providers: { anthropic: { ...DOCUMENT.providers.anthropic, fetchedAt: NOW - 8 * 24 * 60 * 60 * 1_000 } } }
    expect(parseCatalogCache(stale, NOW).size).toBe(0)
    const ahead = { ...DOCUMENT, providers: { anthropic: { ...DOCUMENT.providers.anthropic, fetchedAt: NOW + 1_000 } } }
    expect(parseCatalogCache(ahead, NOW).size).toBe(0)
  })

  test("an unreadable or corrupt file seeds nothing instead of throwing", () => {
    expect(readCatalogCache(NOW, () => { throw new Error("ENOENT") }).size).toBe(0)
    expect(readCatalogCache(NOW, () => "not json").size).toBe(0)
    expect(readCatalogCache(NOW, () => JSON.stringify(DOCUMENT)).get("anthropic")?.models).toEqual(MODELS)
  })

  test("a write that fails never interrupts the session", () => {
    expect(() => writeCatalogCache(
      [{ providerID: "anthropic", baseURL: "http://127.0.0.1:3466/v1", models: MODELS }],
      NOW,
      () => { throw new Error("EROFS") },
    )).not.toThrow()
  })
})

describe("what the transform writes", () => {
  const cached = new Map<string, CachedProviderCatalog>([
    ["anthropic", { baseURL: "http://127.0.0.1:3466/v1", models: MODELS }],
  ])

  test("live discovery wins over the seed", () => {
    const live: MeridianProviderModels[] = [{ providerID: "meridian", baseURL: "http://127.0.0.1:9/v1", models: MODELS }]
    expect(resolveCatalogModels(draft(["anthropic", "meridian"]), live, cached)).toEqual(live)
  })

  test("seeds a provider the catalog still has, before discovery lands", () => {
    expect(resolveCatalogModels(draft(["anthropic"]), [], cached)).toEqual([
      { providerID: "anthropic", baseURL: "http://127.0.0.1:3466/v1", models: MODELS },
    ])
  })

  test("seeds nothing for a provider the catalog no longer has", () => {
    expect(resolveCatalogModels(draft(["openai"]), [], cached)).toEqual([])
  })

  test("with no seed and no discovery nothing is written at all", () => {
    expect(resolveCatalogModels(draft(["anthropic"]), [], new Map())).toEqual([])
  })
})
