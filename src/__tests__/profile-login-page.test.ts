import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { profilePageHtml } from "../telemetry/profilePage"

function pageFunction(name: string): string {
  const definition = profilePageHtml.match(new RegExp(`(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0]
  if (!definition) throw new Error(`Missing rendered page function ${name}`)
  return definition
}

function pageDictionary(name: string): string {
  const declaration = profilePageHtml.match(new RegExp(`^var ${name} = [^\\n]+;`, "m"))?.[0]
  if (!declaration) throw new Error(`Missing rendered page dictionary ${name}`)
  return declaration
}

// Execute the page's actual minting functions rather than another copy of its
// algorithm. Only the transport/DOM boundaries are fixtures; no OAuth starts.
function pageFixture() {
  const requests: string[] = []
  const ids = ["ordinary", "__proto__", "constructor"]
  const source = [pageDictionary("loginLinks"), pageDictionary("mintingLinks"),
    "var loginBlocked = null; var loopbackOk = false; function applyLoginHrefs() {}",
    pageFunction("mintLoginLink"), pageFunction("loginHrefFor"), pageFunction("ensureLoginLinks"),
    "async function exercise() { await ensureLoginLinks(profiles); await ensureLoginLinks(profiles); return profiles.map(p => loginHrefFor(p.id)); } exercise();"].join("\n")
  const result = runInNewContext(source, {
    profiles: ids.map(id => ({ id, type: "claude-max" })),
    fetch: async (_url: string, init: { body: string }) => {
      const body: { profile: string } = JSON.parse(init.body)
      requests.push(body.profile)
      return { ok: true, json: async () => ({ mode: "paste", loginId: "fixture-" + body.profile,
        pasteAuthorizeUrl: "https://fixture.invalid/" + body.profile, expiresAt: Date.now() + 600000 }) }
    },
  })
  return { requests, result, ids }
}

test("all valid profile IDs mint links once, including Object prototype names", async () => {
  const { requests, result, ids } = pageFixture()
  const hrefs = await result
  expect(requests).toEqual(ids)
  expect(hrefs).toEqual(ids.map(id => "https://fixture.invalid/" + id))
})

function pendingAddFixture() {
  const stored = new Map<string, string>()
  const slot = { innerHTML: "", querySelector: (selector: string) => selector === ".add-input"
    ? { value: "live-verification" } : { addEventListener() {}, focus() {} } }
  const context = { activeAdd: null, sessionStorage: {
    setItem: (key: string, value: string) => stored.set(key, value),
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => stored.delete(key),
  }, Date, URL, document: { getElementById: () => slot }, window: { open() {} },
    renderAddPanel: () => "PENDING AUTHORIZATION", setPanelMsg() {},
    fetch: async () => ({ ok: true, json: async () => ({ addId: "isolated-add-id",
      authorizeUrl: "https://claude.com/cai/oauth/authorize?state=synthetic-state", expiresAt: Date.now() + 600000 }) }) }
  return { context, stored, slot }
}

test("pending account creation survives returning from the authorization page without storing its code", async () => {
  const { context, stored, slot } = pendingAddFixture()
  const helpers = profilePageHtml.includes("function savePendingAdd(") ? pageFunction("savePendingAdd") : ""
  await runInNewContext([pageFunction("addSlot"), helpers, pageFunction("startAdd"), "startAdd();"].join("\n"), context)
  expect(stored.size).toBe(1)
  expect([...stored.values()].some(value => value.includes("isolated-add-id"))).toBe(true)
  expect([...stored.values()].some(value => value.includes('"code"'))).toBe(false)
  slot.innerHTML = ""
  const restored = runInNewContext([pageFunction("addSlot"), pageFunction("savePendingAdd"), pageFunction("restorePendingAdd"),
    "restorePendingAdd(); activeAdd;"].join("\n"), { ...context, activeAdd: null })
  expect(restored.profile).toBe("live-verification")
  expect(restored.addId).toBe("isolated-add-id")
  expect(slot.innerHTML).toBe("PENDING AUTHORIZATION")
})

for (const invalid of [
  { profile: "live-verification", addId: "expired", authorizeUrl: "https://claude.com/cai/oauth/authorize", expiresAt: 1 },
  { profile: "live-verification", addId: "unsafe", authorizeUrl: "javascript:alert(1)", expiresAt: Date.now() + 600000 },
  { profile: "../unsafe", addId: "bad-name", authorizeUrl: "https://claude.com/cai/oauth/authorize", expiresAt: Date.now() + 600000 },
]) {
  test(`returning account form discards ${invalid.addId} pending state`, () => {
    const { context, stored, slot } = pendingAddFixture()
    stored.set("meridian.pendingAdd", JSON.stringify(invalid))
    const result = runInNewContext([pageFunction("addSlot"), pageFunction("savePendingAdd"), pageFunction("restorePendingAdd"),
      "restorePendingAdd();"].join("\n"), context)
    expect(result).toBe(false)
    expect(stored.size).toBe(0)
    expect(slot.innerHTML).toBe("")
  })
}

test("account creation remains usable when browser storage is disabled", async () => {
  const { context, slot } = pendingAddFixture()
  const disabled = { ...context, sessionStorage: { setItem() { throw Error("storage disabled") } } }
  await runInNewContext([pageFunction("addSlot"), pageFunction("savePendingAdd"), pageFunction("startAdd"), "startAdd();"].join("\n"), disabled)
  expect(slot.innerHTML).toBe("PENDING AUTHORIZATION")
  expect(disabled.activeAdd).not.toBeNull()
})

// Draws the page's real render() over a profile that lost its login and one
// whose quota read found no token, the two ways / flags an account that cannot
// serve. Everything around the cards is a stub.
function renderCards(profiles: Array<Record<string, unknown>>, quota: Array<Record<string, unknown>>, active: string) {
  const content = { innerHTML: "" }
  const isUnusable = profilePageHtml.match(/^function isUnusable\(p\)\{.*\}$/m)?.[0]
  if (!isUnusable) throw new Error("Missing rendered page function isUnusable")
  const none = () => ""
  runInNewContext([isUnusable, pageFunction("render"), "render(data, quota);"].join("\n"), {
    data: { profiles, activeProfile: active }, quota: { profiles: quota },
    document: { getElementById: () => content },
    meridianReorder: { sortProfiles: (list: unknown[]) => list, focusAnchor: none, envPinned: () => true,
      noteHtml: none, handleHtml: none, restoreFocus: none },
    esc: (value: unknown) => String(value), profileAnchorElementId: (id: string) => "profile-" + id,
    renderSpentBadge: none, renderSpentNote: none, factRows: none, profileFacts: () => [],
    loginHrefFor: none, renderUsageSection: none, applyLoginHrefs: none, ensureLoginLinks: none,
    afterRender: none, loginSlot: () => null, activeLogin: null, editingProfile: null, renameError: null,
    ICON_PENCIL: "", ICON_CHECK: "", ICON_X: "", ICON_TRASH: "",
  })
  const cards = content.innerHTML.split(/<div class="profile-card(?=[ "])/).slice(1)
  return Object.fromEntries(cards.map(card => [card.match(/data-id="([^"]+)"/)?.[1], card]))
}

test("a profile that cannot serve gets the needs-login border and badge, as on /", () => {
  const cards = renderCards(
    [{ id: "lapsed", type: "claude-max", loggedIn: false }, { id: "tokenless", type: "claude-max", loggedIn: true },
      { id: "healthy", type: "claude-max", loggedIn: true }, { id: "api", type: "api", loggedIn: true }],
    [{ id: "tokenless", error: "no_token" }, { id: "api", error: "not_oauth" }],
    "healthy",
  )
  for (const id of ["lapsed", "tokenless"]) {
    expect(cards[id]).toStartWith(' needs-login"')
    expect(cards[id]).toContain('class="profile-badge badge-needs-login"')
    expect(cards[id]).toContain(">needs login</span>")
  }
  for (const id of ["healthy", "api"]) {
    expect(cards[id]).not.toContain("needs-login")
  }
  expect(cards.healthy).toStartWith(' active"')
})

test("the needs-login border is solid red, and an active card keeps its accent ring", () => {
  expect(profilePageHtml).toContain(".profile-card.needs-login { border-color: var(--red); }")
  expect(profilePageHtml).toContain(".profile-card.active.needs-login { box-shadow: 0 0 0 1px var(--accent); }")
  expect(profilePageHtml).toContain(".badge-needs-login { background: rgba(248,81,73,0.12); color: var(--red);")
  expect(profilePageHtml).not.toContain("dashed")
})
