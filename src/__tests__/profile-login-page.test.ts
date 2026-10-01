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
