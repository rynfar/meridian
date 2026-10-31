import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

// Both pages poll /v1/usage/quota/all, which reaches Anthropic for every
// profile once Meridian's 30 s usage cache lapses. Run each page's actual poll
// tick against a fixture document instead of restating its condition.
function pollTick(html: string) {
  const source = html.match(/^function pollRefresh\(\)[^]*?^\}/m)?.[0]
  if (!source) throw new Error("Missing rendered page function pollRefresh")
  return (visibilityState: string) => {
    let refreshes = 0
    runInNewContext(source + "\npollRefresh();", {
      document: { visibilityState },
      meridianReorder: { dragging: () => false },
      infoPopOpen: () => false,
      activeLogin: null, activeAdd: null, activeChatGptRelogin: null,
      refresh: () => { refreshes++ },
    })
    return refreshes
  }
}

for (const [page, html] of Object.entries({ landingHtml, profilePageHtml })) {
  test(`${page} skips the usage poll while its tab is hidden`, () => {
    const tick = pollTick(html)
    expect(tick("hidden")).toBe(0)
    expect(tick("visible")).toBe(1)
  })
}
