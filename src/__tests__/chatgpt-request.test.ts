/**
 * Task 6 - the outbound ChatGPT request, as a pure construction.
 *
 * Two properties, and the second is why this function takes no inbound
 * headers at all.
 *
 * THE ORIGIN IS A CONSTANT. A bearer token aimed at an operator-supplied host
 * is credential disclosure, so there is no base-URL option to supply.
 *
 * THE HEADER SET IS AN ALLOWLIST, EXPRESSED STRUCTURALLY. The reference
 * implementation builds its headers from the INBOUND request's headers and
 * then deletes the ones it does not want, which is safe only for as long as
 * the delete list keeps pace with what clients send. This builds from
 * nothing, so a header reaches ChatGPT only because it is named here. The
 * assertions below pin the whole set rather than individual members,
 * because "these are present" cannot say "and nothing else is".
 */
import { describe, expect, it } from "bun:test"
import { buildCodexRequest, CODEX_RESPONSES_URL } from "../proxy/chatgpt/request"

const ACCOUNT = {
  accountId: "05cd9f04-1111-2222-3333-444444989a40",
  accessToken: "access-token-for-this-seat",
}

const BASE_HEADERS = [
  "accept",
  "authorization",
  "chatgpt-account-id",
  "content-type",
  "openai-beta",
  "originator",
]

/** The tiers the reference implementation sends the responses-lite hint for. */
const LITE_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-cyber",
  "gpt-6-astra",
  "gpt-daybreak-blue",
  "gpt-daybreak-red",
]

function names(headers: Headers): string[] {
  return [...headers.keys()].sort()
}

describe("buildCodexRequest - where it goes", () => {
  it("always targets the one compile-time endpoint", () => {
    const { url } = buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT)

    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(CODEX_RESPONSES_URL).toBe(url)
  })

  it("does not vary its target with anything in the request", () => {
    const wishful = { model: "gpt-5-codex", base_url: "https://example.invalid", url: "https://example.invalid" }

    expect(buildCodexRequest(wishful, ACCOUNT).url).toBe(CODEX_RESPONSES_URL)
  })
})

describe("buildCodexRequest - the exact header set", () => {
  it("sends these headers and no others when there is no cache key", () => {
    const { headers } = buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT)

    expect(names(headers)).toEqual(BASE_HEADERS)
    expect(headers.get("authorization")).toBe(`Bearer ${ACCOUNT.accessToken}`)
    expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT.accountId)
    expect(headers.get("openai-beta")).toBe("responses=experimental")
    expect(headers.get("originator")).toBe("codex_cli_rs")
    expect(headers.get("accept")).toBe("text/event-stream")
    expect(headers.get("content-type")).toBe("application/json")
  })

  it("adds cache affinity under both names the provider expects", () => {
    const { headers } = buildCodexRequest(
      { model: "gpt-5-codex", prompt_cache_key: "conv-9f04" },
      ACCOUNT,
    )

    expect(names(headers)).toEqual([...BASE_HEADERS, "conversation_id", "session_id"].sort())
    expect(headers.get("conversation_id")).toBe("conv-9f04")
    expect(headers.get("session_id")).toBe("conv-9f04")
  })

  it("omits cache affinity rather than inventing a key", () => {
    for (const key of [undefined, null, "", 42]) {
      const { headers } = buildCodexRequest({ model: "gpt-5-codex", prompt_cache_key: key }, ACCOUNT)

      expect(headers.get("conversation_id")).toBeNull()
      expect(headers.get("session_id")).toBeNull()
    }
  })
})

describe("buildCodexRequest - the organization header stays off", () => {
  it("omits it even when an organization id is available", () => {
    const { headers } = buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT, {
      organizationId: "org-should-not-be-sent",
    })

    // Off unless deliberately switched on: the reference implementation gates
    // it behind its own opt-in, and sending it changes how upstream bills and
    // scopes the request.
    expect(headers.get("openai-organization")).toBeNull()
    expect(names(headers)).toEqual(BASE_HEADERS)
  })

  it("sends it only when explicitly enabled AND an id exists", () => {
    const enabledWithout = buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT, {
      sendOrganizationHeader: true,
    })
    expect(enabledWithout.headers.get("openai-organization")).toBeNull()

    const enabledWith = buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT, {
      sendOrganizationHeader: true,
      organizationId: "org-explicit",
    })
    expect(enabledWith.headers.get("openai-organization")).toBe("org-explicit")
  })
})

describe("buildCodexRequest - the responses-lite hint", () => {
  // Measured against the provider on 2026-09-05: this header selects a MODE
  // with body preconditions, not a free optimisation. Sent with an ordinary
  // body it is answered `400 ... requires reasoning.context to be all_turns`,
  // and once that is satisfied, `400 ... requires parallel_tool_calls to be
  // false`. This path is raw passthrough, so the body belongs to the client
  // and must not be edited to suit a header Meridian chose to add.
  const READY = { reasoning: { context: "all_turns" }, parallel_tool_calls: false }

  it("is sent when the client's own body already satisfies both preconditions", () => {
    for (const model of LITE_MODELS) {
      const { headers } = buildCodexRequest({ model, ...READY }, ACCOUNT)

      expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true")
      expect(names(headers)).toEqual(
        [...BASE_HEADERS, "x-openai-internal-codex-responses-lite"].sort(),
      )
    }
  })

  it("is absent for an ordinary Codex body, which it would otherwise 400 on every request", () => {
    // Exactly the shape this repo captured from Codex 0.143, recorded under
    // "Codex Responses wire contract" in spec `proxy-core` (src/proxy/SPEC.md):
    // parallel_tool_calls true, no reasoning.context at all. gpt-5.6-sol is in
    // the lite set and is a model the operator actually runs.
    for (const model of LITE_MODELS) {
      const { headers } = buildCodexRequest({ model, parallel_tool_calls: true }, ACCOUNT)

      expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull()
      expect(names(headers)).toEqual(BASE_HEADERS)
    }
  })

  it("needs BOTH preconditions rather than either", () => {
    for (const half of [
      { reasoning: { context: "all_turns" } },
      { parallel_tool_calls: false },
      { reasoning: { context: "all_turns" }, parallel_tool_calls: true },
      { reasoning: { context: "auto" }, parallel_tool_calls: false },
    ]) {
      const { headers } = buildCodexRequest({ model: "gpt-5.6-sol", ...half }, ACCOUNT)

      expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull()
    }
  })

  it("reads both preconditions strictly, never inferring one from an absence", () => {
    // An absent `parallel_tool_calls` is not a false one, and what upstream
    // defaults it to is unobserved. Guessing wrong costs a 400 on every
    // request; omitting the header costs an optimisation and nothing else.
    for (const body of [
      { model: "gpt-5.6-sol", reasoning: { context: "all_turns" } },
      { model: "gpt-5.6-sol", reasoning: { context: "all_turns" }, parallel_tool_calls: 0 },
      { model: "gpt-5.6-sol", reasoning: { context: "all_turns" }, parallel_tool_calls: null },
      { model: "gpt-5.6-sol", reasoning: "all_turns", parallel_tool_calls: false },
      { model: "gpt-5.6-sol", reasoning: null, parallel_tool_calls: false },
    ]) {
      const { headers } = buildCodexRequest(body, ACCOUNT)

      expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull()
    }
  })

  it("is absent for every other model, even with a body that would satisfy it", () => {
    for (const model of ["gpt-5-codex", "codex-max", "codex", "gpt-5.4", "gpt-5.1", undefined]) {
      const { headers } = buildCodexRequest({ model, ...READY }, ACCOUNT)

      expect(headers.get("x-openai-internal-codex-responses-lite")).toBeNull()
      expect(names(headers)).toEqual(BASE_HEADERS)
    }
  })
})

describe("buildCodexRequest - it cannot forward what it never sees", () => {
  it("takes no inbound headers, so a client header has no path to the provider", () => {
    // Fields a client might send in the BODY that share a name with a header
    // it must not be able to set. A builder that read from the request at all
    // is what this shape rules out.
    const { headers } = buildCodexRequest({
      model: "gpt-5-codex",
      authorization: "Bearer client-supplied",
      "x-api-key": "client-supplied",
      cookie: "session=client-supplied",
    }, ACCOUNT)

    expect(headers.get("authorization")).toBe(`Bearer ${ACCOUNT.accessToken}`)
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
    expect(names(headers)).toEqual(BASE_HEADERS)
  })

  it("returns a fresh Headers each call, so one request cannot edit another's", () => {
    const first = buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT).headers
    first.set("authorization", "Bearer tampered")

    expect(buildCodexRequest({ model: "gpt-5-codex" }, ACCOUNT).headers.get("authorization"))
      .toBe(`Bearer ${ACCOUNT.accessToken}`)
  })
})

describe("buildCodexRequest - header-unsafe prompt_cache_key resilience", () => {
  it("ignores a prompt_cache_key with invalid HTTP header characters instead of throwing", () => {
    const { headers } = buildCodexRequest({
      model: "gpt-5-codex",
      prompt_cache_key: "bad\nkey\u0000value",
    }, ACCOUNT)
    expect(headers.get("conversation_id")).toBeNull()
    expect(headers.get("session_id")).toBeNull()
  })
})
