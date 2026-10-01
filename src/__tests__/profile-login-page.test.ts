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
