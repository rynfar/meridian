import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

// Both pages poll /v1/usage/quota/all, which reaches Anthropic for every
// profile once Meridian's 30 s usage cache lapses. Run each page's actual poll
// function against a fixture document instead of restating its condition.
function pageFunction(html: string, name: string): string {
  const source = html.match(new RegExp(`^function ${name}\\(\\)[^]*?^\\}`, "m"))?.[0]
  if (!source) throw new Error(`Missing rendered page function ${name}`)
  return source
}

function tick(html: string, name: string, visibilityState: string) {
  const fixture = {
    refreshes: 0, timers: 0,
    document: { visibilityState },
    meridianReorder: { dragging: () => false },
    infoPopOpen: () => false,
    activeLogin: null, activeAdd: null, activeChatGptRelogin: null,
    updatePollTimer: null as unknown,
    refresh: () => { fixture.refreshes++ },
    setTimeout: () => ++fixture.timers,
  }
  runInNewContext(`${pageFunction(html, name)}\n${name}();`, fixture)
  return fixture
}

for (const [page, html] of Object.entries({ landingHtml, profilePageHtml })) {
  test(`${page} skips the usage poll while its tab is hidden`, () => {
    expect(tick(html, "pollRefresh", "hidden").refreshes).toBe(0)
    expect(tick(html, "pollRefresh", "visible").refreshes).toBe(1)
  })
}

test("profilePageHtml holds the updating-card poll while hidden and resumes it when shown", () => {
  const hidden = tick(profilePageHtml, "pollUpdate", "hidden")
  expect(hidden.refreshes).toBe(0)
  expect(hidden.updatePollTimer).toBe(1)
  const visible = tick(profilePageHtml, "pollUpdate", "visible")
  expect(visible.refreshes).toBe(1)
  expect(visible.updatePollTimer).toBeNull()
})
