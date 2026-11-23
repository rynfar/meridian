import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"
import { providerPageHtml } from "../telemetry/providerPage"

// These pages poll /v1/usage/quota/all (/providers through /providers/view),
// which reaches Anthropic for every profile once Meridian's 30 s usage cache
// lapses. Run each page's actual poll function against a fixture document
// instead of restating its condition.
function pageFunction(html: string, name: string): string {
  const source = html.match(new RegExp(`^(?:async )?function ${name}\\(\\)[^]*?^\\}`, "m"))?.[0]
  if (!source) throw new Error(`Missing rendered page function ${name}`)
  return source
}

function tick(html: string, name: string, visibilityState: string, tableDragging = false) {
  let timer: (() => void) | undefined
  const update: { updatePollTimer: number | null } = { updatePollTimer: 1 }
  const fixture = {
    refreshes: 0, timers: 0,
    document: { visibilityState },
    meridianReorder: { dragging: () => false },
    meridianProfileTable: { dragging: () => tableDragging },
    infoPopOpen: () => false,
    activeLogin: null, activeAdd: null, activeChatGptRelogin: null, redeemingReset: null,
    get updatePollTimer() { return update.updatePollTimer },
    set updatePollTimer(value) { update.updatePollTimer = value },
    refresh: () => { fixture.refreshes++ },
    loadProviders: () => { fixture.refreshes++ },
    setTimeout: (callback: () => void) => { timer = callback; return ++fixture.timers },
  }
  runInNewContext(`${pageFunction(html, name)}\n${name}();`, fixture)
  return { fixture, releaseDrag: () => { tableDragging = false }, retry: () => timer?.() }
}

for (const [page, html] of Object.entries({ landingHtml, profilePageHtml, providerPageHtml })) {
  test(`${page} skips the usage poll while its tab is hidden`, () => {
    expect(tick(html, "pollRefresh", "hidden").fixture.refreshes).toBe(0)
    expect(tick(html, "pollRefresh", "visible").fixture.refreshes).toBe(1)
  })

  test(`${page} runs its timed poll and its visibilitychange refresh through that guard`, () => {
    expect(html).toMatch(/setInterval\(pollRefresh, ?10000\)/)
    expect(html).toMatch(/addEventListener\('visibilitychange', ?pollRefresh\)/)
  })
}

test("profilePageHtml holds the updating-card poll while hidden and resumes it when shown", () => {
  expect(profilePageHtml).toMatch(/if \(anyUpdating && !updatePollTimer\) \{\s*updatePollTimer = setTimeout\(pollUpdate, 1500\)/)
  const hidden = tick(profilePageHtml, "pollUpdate", "hidden").fixture
  expect(hidden.refreshes).toBe(0)
  expect(hidden.updatePollTimer).toBe(1)
  const visible = tick(profilePageHtml, "pollUpdate", "visible").fixture
  expect(visible.refreshes).toBe(1)
  expect(visible.updatePollTimer).toBeNull()
})

test("profilePageHtml holds its poll while a free reset is being redeemed", () => {
  const fixture = {
    refreshes: 0,
    document: { visibilityState: "visible" },
    meridianReorder: { dragging: () => false },
    meridianProfileTable: { dragging: () => false },
    activeLogin: null, activeAdd: null, activeChatGptRelogin: null, redeemingReset: "sub1",
    refresh: () => { fixture.refreshes++ },
  }
  runInNewContext(`${pageFunction(profilePageHtml, "pollRefresh")}\npollRefresh();`, fixture)
  expect(fixture.refreshes).toBe(0)
})

test("the updating-profile poll retries after a column drag instead of consuming its timer", () => {
  const poll = tick(profilePageHtml, "pollUpdate", "visible", true)
  expect(poll.fixture.refreshes).toBe(0)
  expect(poll.fixture.updatePollTimer).toBe(1)

  poll.releaseDrag()
  poll.retry()
  expect(poll.fixture.refreshes).toBe(1)
  expect(poll.fixture.updatePollTimer).toBeNull()
})

for (const [page, html] of Object.entries({ home: landingHtml, profiles: profilePageHtml })) {
  test(`${page} does not fetch or redraw during a column drag and resumes afterwards`, async () => {
    let dragging = false
    let requests = 0
    let draws = 0
    const content = { innerHTML: "dragged column" }
    const response = { ok: true, json: async () => ({ profiles: [] }) }
    const pending = Promise.withResolvers<typeof response>()
    const source = [page === "profiles" ? pageFunction(html, "profileRenderPaused") : "",
      pageFunction(html, "refresh"), pageFunction(html, "pollRefresh"),
      "const refreshPage = refresh; let pendingPoll; refresh = () => { pendingPoll = refreshPage(); };",
      "() => { pendingPoll = undefined; pollRefresh(); return pendingPoll; }"].join("\n")
    const poll: () => Promise<void> | undefined = runInNewContext(source, {
      document: { visibilityState: "visible", getElementById: () => content },
      meridianReorder: { adopt() {}, dragging: () => false }, meridianProfileTable: { dragging: () => dragging },
      infoPopOpen: () => false, detailFactFocused: () => false, editingProfile: null, removingProfile: null,
      activeLogin: null, activeAdd: null, activeChatGptRelogin: null, redeemingReset: null, refreshesIssued: 0, refreshDrawn: 0,
      lastQuota: null, lastProfiles: null, lastProfilesRequestedAt: null, adoptChatGpt() {}, noticeNewChatGptSeats() {},
      render: () => { draws++; content.innerHTML = "updated table" },
      fetch: () => ++requests === 1 ? pending.promise : Promise.resolve(response),
    })

    const inFlight = poll()
    expect(requests).toBeGreaterThan(0)
    dragging = true
    pending.resolve(response)
    await inFlight
    expect(draws).toBe(0)
    expect(content.innerHTML).toBe("dragged column")

    const requestsBefore = requests
    await poll()
    expect(requests).toBe(requestsBefore)

    dragging = false
    await poll()
    expect(draws).toBe(1)
    expect(content.innerHTML).toBe("updated table")
  })
}
