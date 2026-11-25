/**
 * Signing a ChatGPT seat into the owned store (chatgpt/login.ts): the
 * authorize URL, both ways a sign-in finishes, and every refusal that must
 * leave the store untouched.
 */
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { __setChatGptLoginRedirectPortOverride, createChatGptLogin, parseCallbackInput, type LoopbackHandler } from "../proxy/chatgpt/login"
import { createOAuthCallbackRegistry } from "../proxy/oauthCallbacks"
import type { ChatGptConnectedAccount } from "../proxy/chatgpt/source"

const NOW = 1_800_000_000_000

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "none" })}.${part(payload)}.sig`
}

const ACCESS = jwt({
  exp: NOW / 1000 + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_account_user_id: "user-1__ws-1", chatgpt_plan_type: "pro" },
})
const ID_TOKEN = jwt({ email: "seat@example.test" })

interface TokenCall { url: string; body: URLSearchParams }

function harness(tokenResponse: () => Response = () => Response.json({ access_token: ACCESS, refresh_token: "rt-new", id_token: ID_TOKEN, expires_in: 3600 })) {
  const connected: ChatGptConnectedAccount[] = []
  const tokenCalls: TokenCall[] = []
  let handler: LoopbackHandler | undefined
  let closed = 0
  const login = createChatGptLogin({
    connect: account => { connected.push(account) },
    renderPage: result => (result.ok ? `ok ${result.email} ${result.returnTo}` : `err ${result.message}`),
    fetchImpl: async (url, init) => {
      tokenCalls.push({ url, body: new URLSearchParams(String(init.body)) })
      return tokenResponse()
    },
    now: () => NOW,
    listen: async h => { handler = h; return { close: () => { closed++ } } },
    log: () => {},
  })
  return { login, connected, tokenCalls, callback: () => handler!, closed: () => closed }
}

describe("ChatGPT sign-in", () => {
  it("asks for the Codex client's scopes, PKCE S256 and its fixed loopback redirect", async () => {
    const { login } = harness()
    const started = await login.start()
    const url = new URL(started.authorizeUrl)
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback")
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access api.connectors.read api.connectors.invoke")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true")
    expect(url.searchParams.get("state")).toBeTruthy()
    expect(started.loopback).toBe(true)
  })

  it("finishes from the loopback redirect: exchanges the code with the verifier and files the seat", async () => {
    const { login, connected, tokenCalls, callback, closed } = harness()
    const started = await login.start({ returnTo: "https://meridian.example/profiles" })
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    const page = await callback()(new URLSearchParams({ code: "code-1", state }))

    expect(page.status).toBe(200)
    expect(page.html).toBe("ok seat@example.test https://meridian.example/profiles")
    expect(tokenCalls).toHaveLength(1)
    const body = tokenCalls[0]!.body
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("code-1")
    const challenge = new URL(started.authorizeUrl).searchParams.get("code_challenge")
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge!)
    expect(connected).toEqual([{
      accountUserId: "user-1__ws-1", accountId: "ws-1", email: "seat@example.test",
      refreshToken: "rt-new", accessToken: ACCESS, expiresAt: NOW + 3_600_000,
    }])
    expect(login.status(started.connectId)).toEqual({ status: "completed", accountUserId: "user-1__ws-1", email: "seat@example.test" })
    // Nothing is waiting any more, so the redirect listener is closed.
    await Promise.resolve()
    expect(closed()).toBe(1)
  })

  it("finishes from a pasted callback address, and the code is spent only once", async () => {
    const { login, connected, tokenCalls } = harness()
    const started = await login.start()
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    const pasted = `http://127.0.0.1:1455/auth/callback?code=code-2&state=${state}`
    expect(await login.complete(started.connectId, pasted)).toEqual({ ok: true, accountUserId: "user-1__ws-1", email: "seat@example.test" })
    expect((await login.complete(started.connectId, pasted)).ok).toBe(false)
    expect(tokenCalls).toHaveLength(1)
    expect(connected).toHaveLength(1)
  })

  it("refuses an address from another sign-in without spending anything, and lets the paste be retried", async () => {
    const { login, connected, tokenCalls } = harness()
    const started = await login.start()
    const result = await login.complete(started.connectId, "http://127.0.0.1:1455/auth/callback?code=x&state=someone-else")
    expect(result).toMatchObject({ ok: false, code: "state_mismatch", retryable: true })
    expect(await login.complete(started.connectId, "not an address")).toMatchObject({ ok: false, code: "invalid_request", retryable: true })
    expect(tokenCalls).toHaveLength(0)
    expect(connected).toHaveLength(0)
    expect(login.status(started.connectId)?.status).toBe("waiting")
  })

  it("files nothing when the token endpoint refuses the code or answers without a refresh token", async () => {
    for (const answer of [
      () => new Response("{}", { status: 400 }),
      () => Response.json({ access_token: ACCESS, expires_in: 3600 }),
      () => Response.json({ access_token: "not-a-jwt", refresh_token: "rt", expires_in: 3600 }),
    ]) {
      const { login, connected } = harness(answer)
      const started = await login.start()
      const state = new URL(started.authorizeUrl).searchParams.get("state")!
      const result = await login.complete(started.connectId, `?code=c&state=${state}`)
      expect(result.ok).toBe(false)
      expect(connected).toHaveLength(0)
      expect(login.status(started.connectId)?.status).toBe("failed")
    }
  })

  it("reports a store that could not be written as a failed sign-in", async () => {
    const login = createChatGptLogin({
      connect: () => { throw new Error("no writer lease") },
      renderPage: () => "",
      fetchImpl: async () => Response.json({ access_token: ACCESS, refresh_token: "rt", expires_in: 3600 }),
      now: () => NOW,
      listen: async () => null,
      log: () => {},
    })
    const started = await login.start()
    expect(started.loopback).toBe(false)
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    expect(await login.complete(started.connectId, `?code=c&state=${state}`)).toMatchObject({ ok: false, code: "store_write_failed" })
  })

  it("answers a redirect for a sign-in it does not know without exchanging anything", async () => {
    const { login, tokenCalls, callback } = harness()
    await login.start()
    const page = await callback()(new URLSearchParams({ code: "c", state: "unknown" }))
    expect(page.status).toBe(400)
    expect(tokenCalls).toHaveLength(0)
  })

  it("reads code and state from a full address or a bare query", () => {
    expect(parseCallbackInput("http://127.0.0.1:1455/auth/callback?code=a&state=b")?.get("code")).toBe("a")
    expect(parseCallbackInput("code=a&state=b")?.get("state")).toBe("b")
    expect(parseCallbackInput("?error=access_denied")?.get("error")).toBe("access_denied")
    expect(parseCallbackInput("   ")).toBeNull()
    expect(parseCallbackInput("http://127.0.0.1:1455/auth/callback")).toBeNull()
  })

  it("signs a seat in again from its card when ChatGPT hands back that same seat", async () => {
    const contexts: Array<{ name: string | null; seat: string | null }> = []
    const login = createChatGptLogin({
      connect: (_account, context) => { contexts.push(context) },
      renderPage: () => "",
      fetchImpl: async () => Response.json({ access_token: ACCESS, refresh_token: "rt", id_token: ID_TOKEN, expires_in: 3600 }),
      now: () => NOW,
      listen: async () => null,
      log: () => {},
    })
    const started = await login.start({ expect: { seat: "user-1__ws-1", label: "work (seat@example.test · id:_ws-1)" } })
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    expect(await login.complete(started.connectId, `?code=c&state=${state}`)).toEqual({ ok: true, accountUserId: "user-1__ws-1", email: "seat@example.test" })
    expect(contexts).toEqual([{ name: null, seat: "user-1__ws-1" }])
  })

  it("refuses a re-login that comes back as another account or workspace, and files nothing", async () => {
    const { login, connected } = harness()
    const started = await login.start({ expect: { seat: "user-1__ws-2", label: "dh (seat@example.test · id:_ws-2)" } })
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    const result = await login.complete(started.connectId, `?code=c&state=${state}`)
    expect(result).toMatchObject({ ok: false, status: 409, code: "wrong_account" })
    if (result.ok) throw new Error("expected a refusal")
    expect(result.message).toContain("seat@example.test")
    expect(result.message).toContain("id:__ws-1")
    expect(result.message).toContain("dh (seat@example.test · id:_ws-2)")
    expect(result.retryable).toBeUndefined()
    expect(connected).toHaveLength(0)
    expect(login.status(started.connectId)).toMatchObject({ status: "failed" })
  })

  it("closes the redirect listener the moment its only sign-in is cancelled", async () => {
    const { login, connected, tokenCalls, closed } = harness()
    const started = await login.start()
    expect(login.cancel(started.connectId)).toBe(true)
    await Promise.resolve()
    expect(closed()).toBe(1)
    expect(login.status(started.connectId)?.status).toBe("failed")
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    expect((await login.complete(started.connectId, `?code=c&state=${state}`)).ok).toBe(false)
    expect(tokenCalls).toHaveLength(0)
    expect(connected).toHaveLength(0)
    expect(login.cancel(started.connectId)).toBe(false)
  })

  it("closes only once a code exchange already out has filed its seat", async () => {
    const connected: ChatGptConnectedAccount[] = []
    let answer!: () => void
    const answered = new Promise<void>(resolve => { answer = resolve })
    const login = createChatGptLogin({
      connect: account => { connected.push(account) },
      renderPage: () => "",
      fetchImpl: async () => {
        await answered
        return Response.json({ access_token: ACCESS, refresh_token: "rt-new", id_token: ID_TOKEN, expires_in: 3600 })
      },
      now: () => NOW,
      listen: async () => ({ close() {} }),
      log: () => {},
    })
    const started = await login.start()
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    const completing = login.complete(started.connectId, `?code=c&state=${state}`)
    await new Promise(resolve => setTimeout(resolve, 0))
    let closed = false
    const closing = login.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(closed).toBe(false)
    answer()
    await closing
    expect(connected).toHaveLength(1)
    expect((await completing).ok).toBe(true)
  })
})

describe("ChatGPT device-code sign-in", () => {
  interface Call { url: string; body: string }

  function deviceHarness(answers: Record<string, Array<() => Response>>) {
    const calls: Call[] = []
    const connected: Array<{ account: ChatGptConnectedAccount; name: string | null }> = []
    const pending: Array<() => void> = []
    let cancelled = 0
    const login = createChatGptLogin({
      connect: (account, context) => { connected.push({ account, name: context.name }) },
      renderPage: () => "",
      fetchImpl: async (url, init) => {
        calls.push({ url, body: String(init.body) })
        const queue = answers[url]
        const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
        return next ? next() : new Response("{}", { status: 500 })
      },
      now: () => NOW,
      listen: async () => { throw new Error("a device sign-in must not bind the redirect listener") },
      schedule: (run) => { pending.push(run); return { cancel: () => { cancelled++ } } },
      log: () => {},
    })
    const tick = async () => {
      const run = pending.shift()
      run?.()
      for (let i = 0; i < 10; i++) await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    return { login, calls, connected, tick, pending: () => pending.length, cancelled: () => cancelled }
  }

  const USERCODE = "https://auth.openai.com/api/accounts/deviceauth/usercode"
  const POLL = "https://auth.openai.com/api/accounts/deviceauth/token"
  const TOKEN = "https://auth.openai.com/oauth/token"
  const userCode = () => Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" })

  it("asks for a code the way the Codex CLI does, keeps polling while it is not entered, then files the seat under the typed name", async () => {
    const h = deviceHarness({
      [USERCODE]: [userCode],
      [POLL]: [() => new Response("", { status: 403 }), () => Response.json({ authorization_code: "auth-1", code_challenge: "ch", code_verifier: "ver-1" })],
      [TOKEN]: [() => Response.json({ access_token: ACCESS, refresh_token: "rt-dev", id_token: ID_TOKEN, expires_in: 3600 })],
    })
    const started = await h.login.startDevice({ name: "work" })
    expect(started).toMatchObject({ ok: true, userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" })
    expect(JSON.parse(h.calls[0]!.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" })
    if (!started.ok) throw new Error("device start failed")

    await h.tick()
    expect(h.login.status(started.connectId)?.status).toBe("waiting")
    expect(JSON.parse(h.calls[1]!.body)).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-1234" })

    await h.tick()
    const exchange = new URLSearchParams(h.calls[3]!.body)
    expect(h.calls[3]!.url).toBe(TOKEN)
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("code")).toBe("auth-1")
    expect(exchange.get("code_verifier")).toBe("ver-1")
    expect(exchange.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback")
    expect(h.connected).toEqual([{ account: expect.objectContaining({ accountUserId: "user-1__ws-1", refreshToken: "rt-dev" }), name: "work" }])
    expect(h.login.status(started.connectId)).toEqual({ status: "completed", accountUserId: "user-1__ws-1", email: "seat@example.test" })
    expect(h.pending()).toBe(0)
  })

  it("refuses a device re-login that comes back as another seat, and the page's poll reads why", async () => {
    const h = deviceHarness({
      [USERCODE]: [userCode],
      [POLL]: [() => Response.json({ authorization_code: "auth-1", code_challenge: "ch", code_verifier: "ver-1" })],
      [TOKEN]: [() => Response.json({ access_token: ACCESS, refresh_token: "rt-dev", id_token: ID_TOKEN, expires_in: 3600 })],
    })
    const started = await h.login.startDevice({ expect: { seat: "user-9__ws-9", label: "other" } })
    if (!started.ok) throw new Error("device start failed")
    await h.tick()
    const state = h.login.status(started.connectId)
    expect(state?.status).toBe("failed")
    expect(state && "message" in state ? state.message : "").toContain("not as other")
    expect(h.connected).toHaveLength(0)
  })

  it("stops polling on cancel and never exchanges a code", async () => {
    const h = deviceHarness({ [USERCODE]: [userCode], [POLL]: [() => new Response("", { status: 403 })] })
    const started = await h.login.startDevice({})
    if (!started.ok) throw new Error("device start failed")
    expect(h.login.cancel(started.connectId)).toBe(true)
    expect(h.cancelled()).toBe(1)
    expect(h.calls.filter(call => call.url === TOKEN)).toHaveLength(0)
    expect(h.connected).toHaveLength(0)
  })

  it("ends the sign-in on a poll the provider refuses outright", async () => {
    const h = deviceHarness({ [USERCODE]: [userCode], [POLL]: [() => new Response("{}", { status: 400 })] })
    const started = await h.login.startDevice({})
    if (!started.ok) throw new Error("device start failed")
    await h.tick()
    expect(h.login.status(started.connectId)?.status).toBe("failed")
    expect(h.pending()).toBe(0)
    expect(h.connected).toHaveLength(0)
  })

  it("reports a provider without device sign-in so the page can fall back to the browser sign-in", async () => {
    const h = deviceHarness({ [USERCODE]: [() => new Response("", { status: 404 })] })
    expect(await h.login.startDevice({})).toMatchObject({ ok: false, code: "device_unavailable" })
  })

  it("refuses to paste a redirect address into a device sign-in", async () => {
    const h = deviceHarness({ [USERCODE]: [userCode] })
    const started = await h.login.startDevice({})
    if (!started.ok) throw new Error("device start failed")
    expect(await h.login.complete(started.connectId, "?code=x&state=y")).toMatchObject({ ok: false, code: "invalid_request" })
  })
})

describe("ChatGPT sign-in through a relayed redirect", () => {
  function relayHarness(listenResult: "bound" | "taken" = "bound") {
    const clock = { now: NOW }
    const callbacks = createOAuthCallbackRegistry({ now: () => clock.now })
    const connected: ChatGptConnectedAccount[] = []
    const login = createChatGptLogin({
      connect: account => { connected.push(account) },
      renderPage: result => (result.ok ? `ok ${result.email}` : `err ${result.message}`),
      fetchImpl: async () => Response.json({ access_token: ACCESS, refresh_token: "rt-new", id_token: ID_TOKEN, expires_in: 3600 }),
      now: () => clock.now,
      listen: async () => (listenResult === "bound" ? { close: () => {} } : null),
      log: () => {},
      callbacks,
    })
    const relay = (id: string, path: string, query: string) => callbacks.dispatch(id, { method: "GET", path, query: new URLSearchParams(query) })
    return { login, callbacks, clock, connected, relay }
  }
  const stateOf = (started: { authorizeUrl: string }) => new URL(started.authorizeUrl).searchParams.get("state")!

  it("lists the listener with what a relay needs and nothing credential-bearing", async () => {
    const h = relayHarness()
    const started = await h.login.start()
    const listed = h.callbacks.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      provider: "chatgpt",
      redirect: { host: "127.0.0.1", port: 1455, path: "/auth/callback", url: "http://127.0.0.1:1455/auth/callback" },
      path: `/callback/${listed[0]!.id}`,
      expiresAtMs: started.expiresAt,
      localListener: true,
    })
    expect(JSON.stringify(listed)).not.toContain(stateOf(started))
  })

  it("finishes a sign-in from the relayed redirect and closes the callback", async () => {
    const h = relayHarness("taken")
    const started = await h.login.start()
    expect(started.loopback).toBe(false)
    const { id, localListener } = h.callbacks.list()[0]!
    expect(localListener).toBe(false)
    expect(await h.relay(id, "/favicon.ico", "")).toBeNull()
    const page = await h.relay(id, "/auth/callback", `code=one-time&state=${stateOf(started)}`)
    expect(page).toEqual({ status: 200, html: "ok seat@example.test" })
    expect(h.connected).toHaveLength(1)
    expect(h.login.status(started.connectId)?.status).toBe("completed")
    expect(h.callbacks.list()).toEqual([])
    expect(await h.relay(id, "/auth/callback", `code=again&state=${stateOf(started)}`)).toBeNull()
  })

  it("keeps one callback for concurrent sign-ins, serving each by its state", async () => {
    const h = relayHarness()
    const first = await h.login.start()
    const second = await h.login.start()
    const listed = h.callbacks.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.expiresAtMs).toBe(second.expiresAt)
    const id = listed[0]!.id
    expect((await h.relay(id, "/auth/callback", `code=c2&state=${stateOf(second)}`))?.status).toBe(200)
    expect(h.callbacks.list()).toHaveLength(1)
    expect((await h.relay(id, "/auth/callback", `code=c1&state=${stateOf(first)}`))?.status).toBe(200)
    expect(h.callbacks.list()).toEqual([])
  })

  it("refuses a relayed redirect whose state belongs to no waiting sign-in", async () => {
    const h = relayHarness()
    await h.login.start()
    const id = h.callbacks.list()[0]!.id
    expect((await h.relay(id, "/auth/callback", "code=c&state=forged"))?.status).toBe(400)
    expect(h.connected).toHaveLength(0)
  })

  it("closes the callback when the sign-in is cancelled, expires or the process shuts down", async () => {
    const cancelled = relayHarness()
    const started = await cancelled.login.start()
    const cancelledId = cancelled.callbacks.list()[0]!.id
    cancelled.login.cancel(started.connectId)
    expect(cancelled.callbacks.list()).toEqual([])
    expect(await cancelled.relay(cancelledId, "/auth/callback", `code=c&state=${stateOf(started)}`)).toBeNull()

    const expired = relayHarness()
    const late = await expired.login.start()
    expired.clock.now = NOW + 10 * 60_000
    expect(expired.login.status(late.connectId)?.status).toBe("failed")
    expect(expired.callbacks.list()).toEqual([])

    const shutdown = relayHarness()
    await shutdown.login.start()
    void shutdown.login.close()
    expect(shutdown.callbacks.list()).toEqual([])
  })

  it("redirects to the overridden test port, everywhere the port appears", async () => {
    __setChatGptLoginRedirectPortOverride(41455)
    try {
      const h = relayHarness()
      const started = await h.login.start()
      expect(new URL(started.authorizeUrl).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:41455/auth/callback")
      expect(h.callbacks.list()[0]!.redirect).toMatchObject({ port: 41455 })
    } finally {
      __setChatGptLoginRedirectPortOverride(null)
    }
  })

  it("signs in as before when no registry is wired", async () => {
    const { login, callback, connected } = harness()
    const started = await login.start()
    await callback()(new URLSearchParams({ code: "code-1", state: stateOf(started) }))
    expect(connected).toHaveLength(1)
  })
})
