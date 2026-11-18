import { beforeEach, describe, expect, it } from "bun:test"
import { clearAccountModels, fetchAccountModels, toAccountModelList } from "../proxy/accountModels"
import { buildModelList } from "../proxy/openai"

const MYTHOS = {
  type: "model",
  id: "claude-mythos-5-2",
  display_name: "Claude Mythos 5.2",
  created_at: "2026-11-01T00:00:00Z",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: { image_input: { supported: true } },
}
const SONNET = {
  type: "model",
  id: "claude-sonnet-4-6",
  display_name: "Claude Sonnet 4.6",
  created_at: "2026-02-17T00:00:00Z",
  max_input_tokens: 1_000_000,
  max_tokens: 64_000,
}

type Call = { url: string; headers: Headers }

function upstream(responses: Array<() => Response>) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: new Headers(init?.headers) })
    const next = responses.shift()
    if (!next) throw new Error("unexpected upstream call")
    return next()
  }
  return { calls, fetchImpl }
}

const ok = (data: unknown[]) => () => Response.json({ data, has_more: false })

beforeEach(() => clearAccountModels())

describe("fetchAccountModels", () => {
  it("lists the account's models with its own token and caches them per profile", async () => {
    const { calls, fetchImpl } = upstream([ok([MYTHOS, SONNET])])
    const auth = async () => ({ Authorization: "Bearer token-team" })

    const first = await fetchAccountModels({ cacheKey: "team", auth, fetchImpl })
    const second = await fetchAccountModels({ cacheKey: "team", auth, fetchImpl })

    expect(first?.map(model => model.id)).toEqual(["claude-mythos-5-2", "claude-sonnet-4-6"])
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000")
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer token-team")
    expect(calls[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01")
  })

  it("keeps separate lists for separate profiles", async () => {
    const { calls, fetchImpl } = upstream([ok([MYTHOS, SONNET]), ok([SONNET])])

    const team = await fetchAccountModels({ cacheKey: "team", auth: async () => ({ Authorization: "Bearer t" }), fetchImpl })
    const max = await fetchAccountModels({ cacheKey: "max", auth: async () => ({ Authorization: "Bearer m" }), fetchImpl })

    expect(team?.map(model => model.id)).toContain("claude-mythos-5-2")
    expect(max?.map(model => model.id)).toEqual(["claude-sonnet-4-6"])
    expect(calls).toHaveLength(2)
  })

  it("fetches again once the cache entry is ten minutes old", async () => {
    const { calls, fetchImpl } = upstream([ok([SONNET]), ok([MYTHOS])])
    let now = 1_000_000
    const auth = async () => ({ Authorization: "Bearer t" })

    await fetchAccountModels({ cacheKey: "team", auth, fetchImpl, now: () => now })
    now += 9 * 60_000
    await fetchAccountModels({ cacheKey: "team", auth, fetchImpl, now: () => now })
    now += 2 * 60_000
    const fresh = await fetchAccountModels({ cacheKey: "team", auth, fetchImpl, now: () => now })

    expect(calls).toHaveLength(2)
    expect(fresh?.map(model => model.id)).toEqual(["claude-mythos-5-2"])
  })

  it("refreshes the credential once on a 401 and retries with the new token", async () => {
    const { calls, fetchImpl } = upstream([() => new Response("{}", { status: 401 }), ok([MYTHOS])])
    let token = "old"
    let refreshes = 0

    const models = await fetchAccountModels({
      cacheKey: "team",
      auth: async () => ({ Authorization: `Bearer ${token}` }),
      refresh: async () => { refreshes++; token = "new"; return true },
      fetchImpl,
    })

    expect(models?.map(model => model.id)).toEqual(["claude-mythos-5-2"])
    expect(refreshes).toBe(1)
    expect(calls.map(call => call.headers.get("authorization"))).toEqual(["Bearer old", "Bearer new"])
  })

  it("answers null without a credential, on an upstream error, and on a malformed body", async () => {
    const noCredential = upstream([])
    expect(await fetchAccountModels({ cacheKey: "a", auth: async () => ({}), fetchImpl: noCredential.fetchImpl })).toBeNull()
    expect(noCredential.calls).toHaveLength(0)

    const failing = upstream([() => new Response("{}", { status: 500 })])
    expect(await fetchAccountModels({ cacheKey: "b", auth: async () => ({ Authorization: "Bearer t" }), fetchImpl: failing.fetchImpl })).toBeNull()

    const malformed = upstream([() => Response.json({ models: [] })])
    expect(await fetchAccountModels({ cacheKey: "c", auth: async () => ({ Authorization: "Bearer t" }), fetchImpl: malformed.fetchImpl })).toBeNull()

    const thrown = upstream([() => { throw new Error("offline") }])
    expect(await fetchAccountModels({ cacheKey: "d", auth: async () => ({ Authorization: "Bearer t" }), fetchImpl: thrown.fetchImpl })).toBeNull()
  })

  it("does not retry a failed profile on every call", async () => {
    const { calls, fetchImpl } = upstream([() => new Response("{}", { status: 503 })])
    const auth = async () => ({ Authorization: "Bearer t" })

    await fetchAccountModels({ cacheKey: "team", auth, fetchImpl })
    expect(await fetchAccountModels({ cacheKey: "team", auth, fetchImpl })).toBeNull()

    expect(calls).toHaveLength(1)
  })

  it("forgets one profile's list on clear", async () => {
    const { calls, fetchImpl } = upstream([ok([SONNET]), ok([MYTHOS])])
    const auth = async () => ({ Authorization: "Bearer t" })

    await fetchAccountModels({ cacheKey: "team", auth, fetchImpl })
    clearAccountModels("team")
    const fresh = await fetchAccountModels({ cacheKey: "team", auth, fetchImpl })

    expect(calls).toHaveLength(2)
    expect(fresh?.map(model => model.id)).toEqual(["claude-mythos-5-2"])
  })
})

describe("toAccountModelList", () => {
  const staticModels = buildModelList(true, 0)

  it("maps each model to the /v1/models entry shape with its own limits", () => {
    const [mythos] = toAccountModelList([MYTHOS], staticModels, { disable1mContext: false, now: 5 })

    expect(mythos).toEqual({
      id: "claude-mythos-5-2",
      object: "model",
      created: Date.parse("2026-11-01T00:00:00Z") / 1000,
      owned_by: "anthropic",
      display_name: "Claude Mythos 5.2",
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      capabilities: { image_input: { supported: true } },
    })
  })

  it("keeps the static capabilities of a model Meridian already knows", () => {
    const [sonnet] = toAccountModelList([SONNET], staticModels, { disable1mContext: false, now: 5 })
    const known = staticModels.find(model => model.id === "claude-sonnet-4-6")

    expect(sonnet!.capabilities).toEqual(known!.capabilities!)
    expect(sonnet!.context_window).toBe(1_000_000)
    expect(sonnet!.max_output_tokens).toBe(64_000)
  })

  it("caps every window at 200k when the 1M context is disabled", () => {
    const models = toAccountModelList([MYTHOS, SONNET], staticModels, { disable1mContext: true, now: 5 })

    expect(models.map(model => model.context_window)).toEqual([200_000, 200_000])
  })

  it("fills a missing name, date and window from what is known", () => {
    const [bare] = toAccountModelList([{ id: "claude-opus-4-7" }], staticModels, { disable1mContext: false, now: 5 })

    expect(bare).toMatchObject({ id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created: 5, context_window: 1_000_000 })
    expect(bare!.max_output_tokens).toBeUndefined()
  })
})
