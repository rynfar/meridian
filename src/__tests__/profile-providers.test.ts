/**
 * Provider groups, chips and brand colours on / and /profiles.
 *
 * profileProviders.ts ships browser source, so the module tests evaluate that
 * exact text, as profile-facts.test.ts does. The page tests run each page's
 * own inline script against a stub document and call its render functions,
 * so what is asserted about a card is the markup the browser receives.
 */
import { describe, expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { themeCss } from "../telemetry/profileBar"
import { profilePageHtml } from "../telemetry/profilePage"
import {
  HIDDEN_PROVIDERS_KEY,
  PROFILE_PROVIDERS,
  PROVIDERS_NONE_SHOWN_HTML,
  profileProvidersCss,
  profileProvidersJs,
} from "../telemetry/profileProviders"

interface Group { provider: string; items: unknown[] }
interface Slot { item: unknown; provider: string; place: number; size: number }
interface Providers {
  providerOf(p: unknown): string
  group(items: unknown[], keyOf: (item: never) => string): Group[]
  slots(groups: Group[]): Slot[]
  readHidden(storage: unknown): string[]
  visibleIn(id: string, present: string[], hidden: string[]): boolean
  isHidden(id: string): boolean
  visible(id: string, present: string[]): boolean
  fromLocation(): void
  setHidden(id: string, hide: boolean): void
  showAll(): void
  anyShown(present: string[]): boolean
  chipsHtml(groups: Group[]): string
  headingHtml(group: Group, hidden: boolean): string
  badgeHtml(id: string, extraClass?: string): string
  syncChips(root: unknown): void
  onClick(target: unknown): string | null
}

class MemoryStorage {
  readonly data = new Map<string, string>()
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null }
  setItem(key: string, value: string): void { this.data.set(key, String(value)) }
  removeItem(key: string): void { this.data.delete(key) }
}

function loadProviders(storage?: unknown, at?: Address): Providers {
  return new Function("localStorage", "location", "history", profileProvidersJs + "\nreturn meridianProviders;")(storage, at?.location, at?.history) as Providers
}

/**
 * A page address the scripts can read and rewrite: location follows the
 * href, and history.replaceState moves it and records the new address.
 */
interface Address {
  location: { href: string; hash: string; search: string; pathname: string; origin: string; port: string; hostname: string; host: string }
  history: { state: unknown; replaceState(state: unknown, title: string, url: string): void }
  replaced: string[]
}

function address(href: string): Address {
  let url = new URL(href)
  const replaced: string[] = []
  const location = {
    get href() { return url.toString() }, set href(v: string) { url = new URL(v, url) },
    get hash() { return url.hash }, set hash(v: string) { url.hash = v },
    get search() { return url.search },
    get pathname() { return url.pathname },
    get origin() { return url.origin },
    get port() { return url.port },
    get hostname() { return url.hostname },
    get host() { return url.host },
  }
  const history = {
    state: null as unknown,
    replaceState(_state: unknown, _title: string, next: string) { url = new URL(next, url); replaced.push(url.toString()) },
  }
  return { location, history, replaced }
}

const claude = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "claude-max", loggedIn: true, ...extra })
const seat = (id: string, extra: Record<string, unknown> = {}) => ({ id, provider: "chatgpt", type: "chatgpt", seat: `seat-${id}`, loggedIn: true, ...extra })
/** The saved order interleaves the providers on purpose: the pages must group it anyway. */
const mixed = () => [seat("g1"), claude("c1", { isActive: true }), seat("g2", { isActive: true }), claude("c2")]

describe("which provider an account belongs to", () => {
  const p = loadProviders()

  test("a seat says chatgpt; a Claude account says nothing and is Claude", () => {
    expect(p.providerOf({ provider: "chatgpt" })).toBe("chatgpt")
    expect(p.providerOf({ type: "chatgpt" })).toBe("chatgpt")
    expect(p.providerOf({ type: "claude-max" })).toBe("claude")
    expect(p.providerOf({ type: "api" })).toBe("claude")
    expect(p.providerOf({})).toBe("claude")
    expect(p.providerOf(null)).toBe("claude")
  })

  test("a provider id no entry claims is not a provider", () => {
    expect(p.providerOf({ provider: "constructor" })).toBe("claude")
    expect(p.providerOf({ provider: "toString" })).toBe("claude")
  })
})

describe("grouping", () => {
  const p = loadProviders()
  const ids = (groups: Group[]) => JSON.parse(JSON.stringify(groups.map(g => [g.provider, g.items.map(i => (i as { id: string }).id)])))

  test("groups come in registry order, each keeping its items' order", () => {
    expect(ids(p.group(mixed(), p.providerOf))).toEqual([["claude", ["c1", "c2"]], ["chatgpt", ["g1", "g2"]]])
  })

  test("a provider with no accounts has no group", () => {
    expect(ids(p.group([seat("a"), seat("b")], p.providerOf))).toEqual([["chatgpt", ["a", "b"]]])
  })

  test("a key no provider claims keeps its cards, after the known groups", () => {
    const items = [{ id: "x", k: "elsewhere" }, { id: "y", k: "chatgpt" }, { id: "z", k: "claude" }]
    expect(ids(p.group(items, (i: { k: string }) => i.k))).toEqual([["claude", ["z"]], ["chatgpt", ["y"]], ["elsewhere", ["x"]]])
  })

  test("slots flatten the groups in drawing order, with each card's place in its own group", () => {
    const slots = p.slots(p.group(mixed(), p.providerOf)).map(s => [(s.item as { id: string }).id, s.provider, s.place, s.size])
    expect(JSON.parse(JSON.stringify(slots))).toEqual([
      ["c1", "claude", 0, 2], ["c2", "claude", 1, 2], ["g1", "chatgpt", 0, 2], ["g2", "chatgpt", 1, 2],
    ])
  })
})

describe("the chip choice is remembered", () => {
  test("hiding a provider persists it, and the next page load reads it back", () => {
    const storage = new MemoryStorage()
    const first = loadProviders(storage)
    expect(first.isHidden("chatgpt")).toBe(false)
    first.setHidden("chatgpt", true)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["chatgpt"]')
    const reloaded = loadProviders(storage)
    expect(reloaded.isHidden("chatgpt")).toBe(true)
    expect(reloaded.isHidden("claude")).toBe(false)
    reloaded.showAll()
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe("[]")
    expect(loadProviders(storage).isHidden("chatgpt")).toBe(false)
  })

  test("garbage, unknown ids and duplicates in storage hide nothing they should not", () => {
    const p = loadProviders()
    const stored = (raw: string | null) => JSON.parse(JSON.stringify(p.readHidden({ getItem: () => raw })))
    expect(stored(null)).toEqual([])
    expect(stored("{not json")).toEqual([])
    expect(stored('{"chatgpt":true}')).toEqual([])
    expect(stored('["chatgpt","chatgpt","antigravity",7,"constructor"]')).toEqual(["chatgpt"])
    expect(JSON.parse(JSON.stringify(p.readHidden({ getItem: () => { throw new Error("blocked") } })))).toEqual([])
  })

  test("blocked storage still toggles for the page in hand", () => {
    const blocked = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") } }
    const p = loadProviders(blocked)
    p.setHidden("claude", true)
    expect(p.isHidden("claude")).toBe(true)
  })
})

describe("chips", () => {
  test("a lone provider gets no chips and cannot be hidden", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const p = loadProviders(storage)
    const groups = p.group([seat("a"), seat("b")], p.providerOf)
    expect(p.chipsHtml(groups)).toBe("")
    expect(p.visible("chatgpt", ["chatgpt"])).toBe(true)
    expect(p.anyShown(["chatgpt"])).toBe(true)
  })

  test("one chip per provider with accounts, pressed while shown, with its count", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const p = loadProviders(storage)
    const html = p.chipsHtml(p.group([...mixed(), seat("g3")], p.providerOf))
    const chips = [...html.matchAll(/data-provider-chip="([^"]+)" aria-pressed="(true|false)"/g)].map(m => [m[1], m[2]])
    expect(chips).toEqual([["claude", "true"], ["chatgpt", "false"]])
    expect(html).toContain('class="provider-chip provider-chatgpt"')
    expect(html).toContain('<span class="provider-chip-count">3</span>')
    expect(html).toContain('title="Show ChatGPT seats"')
    expect(html).toContain('title="Hide Claude accounts"')
  })

  test("with every chip off nothing is shown, and Show all brings everything back", () => {
    const storage = new MemoryStorage()
    const p = loadProviders(storage)
    const present = ["claude", "chatgpt"]
    p.setHidden("claude", true)
    expect(p.visible("claude", present)).toBe(false)
    expect(p.visible("chatgpt", present)).toBe(true)
    p.setHidden("chatgpt", true)
    expect(p.anyShown(present)).toBe(false)
    const showAll = { closest: () => ({ getAttribute: () => "*" }) }
    expect(p.onClick(showAll)).toBe("*")
    expect(p.anyShown(present)).toBe(true)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe("[]")
    expect(PROVIDERS_NONE_SHOWN_HTML).toContain('data-provider-chip="*"')
  })

  test("a click on a chip toggles its provider; a click elsewhere is not a chip click", () => {
    const p = loadProviders(new MemoryStorage())
    const chip = { closest: () => ({ getAttribute: () => "chatgpt" }) }
    expect(p.onClick(chip)).toBe("chatgpt")
    expect(p.isHidden("chatgpt")).toBe(true)
    expect(p.onClick(chip)).toBe("chatgpt")
    expect(p.isHidden("chatgpt")).toBe(false)
    expect(p.onClick({ closest: () => null })).toBeNull()
  })

  test("syncChips updates the chips in place", () => {
    const p = loadProviders(new MemoryStorage())
    const attrs: Record<string, Record<string, string>> = { claude: {}, chatgpt: {} }
    const chip = (id: string) => ({
      getAttribute: (k: string) => (k === "data-provider-chip" ? id : null),
      setAttribute: (k: string, v: string) => { attrs[id]![k] = v },
    })
    const root = { querySelectorAll: () => [chip("claude"), chip("chatgpt")] }
    p.setHidden("claude", true)
    p.syncChips(root)
    expect(attrs.claude).toEqual({ "aria-pressed": "false", title: "Show Claude accounts" })
    expect(attrs.chatgpt).toEqual({ "aria-pressed": "true", title: "Hide ChatGPT seats" })
  })
})

describe("brand colours", () => {
  const token = (name: string) => themeCss.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()
  const rgbOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

  test("Claude is #c15f3c and ChatGPT #74aa9c, the latter clear of the violet --accent2", () => {
    expect(token("claude")).toBe("#c15f3c")
    expect(token("chatgpt")).toBe("#74aa9c")
    expect(token("accent2")).toBe("#bc8cff")
  })

  test("every provider has its three tokens, and -rgb and -bright derive from the brand", () => {
    for (const { id } of PROFILE_PROVIDERS) {
      const brand = token(id)
      expect(brand, `--${id}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(token(`${id}-rgb`), `--${id}-rgb`).toBe(rgbOf(brand!).join(","))
      // 30% toward white, each channel rounded either way.
      const bright = rgbOf(token(`${id}-bright`)!)
      rgbOf(brand!).forEach((c, i) => expect(Math.abs(bright[i]! - (c + (255 - c) * 0.3)), `--${id}-bright channel ${i}`).toBeLessThanOrEqual(0.5))
    }
  })

  test("a card's provider class points --brand at that provider's tokens", () => {
    for (const { id } of PROFILE_PROVIDERS) {
      expect(profileProvidersCss).toContain(
        `.provider-${id} { --brand: var(--${id}); --brand-bright: var(--${id}-bright); --brand-rgb: var(--${id}-rgb); }`,
      )
    }
  })

  for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
    test(`${name}: the active card's border and ring are its provider's brand`, () => {
      const rule = html.slice(html.indexOf("  .profile-card.active {"), html.indexOf("}", html.indexOf("  .profile-card.active {")))
      expect(rule).toContain("border-color: var(--brand, var(--accent))")
      expect(rule).toContain("box-shadow: 0 0 0 1px var(--brand, var(--accent))")
    })

    test(`${name}: embeds the provider module and its CSS exactly once`, () => {
      expect(html.split("var meridianProviders = (function () {").length - 1).toBe(1)
      expect(html.split(".provider-chips { display: flex;").length - 1).toBe(1)
    })
  }

  test("landing: hovering a switchable card lights it in the brighter brand", () => {
    expect(landingHtml).toContain(".profile-card.switchable:hover { border-color: var(--brand-bright, var(--accent));")
  })

  test("landing: a needs-login border is solid red, and an active card keeps its brand ring outside it", () => {
    // Beside the Claude brand the red differs in hue alone, which a protanope
    // cannot see; the active card's ring, which this rule leaves alone, is what
    // still says which account is active.
    const css = landingHtml.slice(0, landingHtml.indexOf("</style>"))
    expect(css).toContain(".profile-card.needs-login { border-color: var(--red); }")
    expect(css).not.toContain(".profile-card.active.needs-login")
    expect(css).not.toContain("dashed")
    // Declared after the active rule, so red wins the border and the ring stays.
    expect(css.indexOf(".profile-card.needs-login {")).toBeGreaterThan(css.indexOf(".profile-card.active {"))
  })

  test("landing: a spent active card dims its figures, never its name row", () => {
    // The Active pill and the spent badge live in that row, and they are what
    // say which account is serving and why the rest of the card is dimmed.
    const spare = ".profile-card.active.spend-fading > .profile-head, .profile-card.active.spend-spent > .profile-head { filter: none; opacity: 1; }"
    expect(landingHtml).toContain(spare)
    expect(landingHtml.indexOf(spare)).toBeGreaterThan(landingHtml.indexOf(".profile-card.spend-fading > *, .profile-card.spend-spent > * {"))
  })

  test("profiles: under the wide layout a provider heading spans the card grid and leaves spacing to its gap", () => {
    expect(profileProvidersCss).toContain("grid-column: 1 / -1;")
    expect(profilePageHtml).toContain('html[data-layout="wide"] #content > .provider-group-head { margin-bottom: 0; }')
  })

  test("profiles: the switch button is in the brand of the account it switches to", () => {
    expect(profilePageHtml).toContain(".switch-btn.switch-to { color: var(--brand-bright, var(--accent)); border-color: var(--brand, var(--accent)); }")
  })
})

// ---------------------------------------------------------------------------
// The pages themselves, run against a stub document.
// ---------------------------------------------------------------------------

type Stub = Record<string, unknown> & { innerHTML: string; hidden: boolean; attrs: Map<string, string> }

function stubElement(): Stub {
  const attrs = new Map<string, string>()
  let text = ""
  const el = {
    attrs, hidden: false, value: "", innerHTML: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute: (k: string, v: string) => { attrs.set(k, String(v)) },
    getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
    removeAttribute: (k: string) => { attrs.delete(k) },
    querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() {}, appendChild() {}, focus() {}, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, height: 0 }),
  }
  Object.defineProperty(el, "textContent", { get: () => text, set: (v: unknown) => { text = String(v) } })
  return el as unknown as Stub
}

interface Page {
  run<T>(expression: string): T
  element(id: string): Stub
  select(selector: string, elements: unknown[]): void
  /** Runs the page's window listeners for an event, as the browser would. */
  dispatch(type: string): void
  clickChip(rootId: string, provider: string): void
  at: Address
}

function loadPage(html: string, storage: MemoryStorage, href = "http://127.0.0.1:3459/"): Page {
  const at = address(href)
  const listeners = new Map<string, Array<() => void>>()
  const clicks = new Map<string, Array<(event: { target: unknown }) => void>>()
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1] ?? "").join("\n")
  const elements = new Map<string, Stub>()
  const selections = new Map<string, unknown[]>()
  const element = (id: string) => {
    if (!elements.has(id)) {
      const el = stubElement()
      el.addEventListener = (type: string, fn: (event: { target: unknown }) => void) => {
        if (type === "click") clicks.set(id, [...(clicks.get(id) ?? []), fn])
      }
      elements.set(id, el)
    }
    return elements.get(id)!
  }
  const document = {
    getElementById: element,
    querySelector: (s: string) => selections.get(s)?.[0] ?? null,
    querySelectorAll: (s: string) => selections.get(s) ?? [],
    addEventListener() {},
    activeElement: null,
    // What esc() relies on: textContent in, escaped markup out.
    createElement: () => {
      let text = ""
      return {
        set textContent(v: unknown) { text = String(v) },
        get textContent() { return text },
        get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") },
      }
    },
  }
  const sandbox: Record<string, unknown> = {
    document, localStorage: storage, URL, AbortController, console,
    location: at.location,
    history: at.history,
    navigator: { clipboard: { writeText() {} } },
    fetch: () => new Promise(() => {}),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener(type: string, fn: () => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    alert() {}, innerHeight: 800, scrollY: 0, scrollTo() {},
  }
  sandbox.window = sandbox
  // One context for the page's life: Bun's runInNewContext makes a new one
  // per call, and a later call would not see what the page's functions see.
  const context = createContext(sandbox)
  runInContext(script, context)
  return {
    run: <T>(expression: string) => runInContext(expression, context) as T,
    element,
    select: (selector, list) => { selections.set(selector, list) },
    dispatch: type => { for (const fn of listeners.get(type) ?? []) fn() },
    clickChip: (rootId, provider) => {
      const target = { closest: () => ({ getAttribute: () => provider }) }
      for (const fn of clicks.get(rootId) ?? []) fn({ target })
    },
    at,
  }
}

/** Opening tags of the cards, in drawing order: their classes and attributes. */
function cardsOf(html: string) {
  return [...html.matchAll(/<div class="profile-card ([^"]*)"([^>]*)>/g)].map(m => {
    const attr = (name: string) => m[2]!.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? null
    return { classes: m[1]!.split(" "), id: attr("data-id"), group: attr("data-group"), index: attr("data-index"), hidden: / hidden(\s|$)/.test(m[2]!) }
  })
}

const headingsOf = (html: string) => [...html.matchAll(/<div class="provider-group-head provider-(\w+)" data-group="\w+" role="heading" aria-level="3"( hidden)?>/g)].map(m => [m[1], !!m[2]])
const orderIndexes = (html: string) => [...html.matchAll(/<span class="order-index">(\d+)<\/span>/g)].map(m => Number(m[1]))

describe("the landing page draws one grid, grouped by provider", () => {
  const section = (storage: MemoryStorage, profiles: unknown[]) =>
    loadPage(landingHtml, storage).run<{ html: string }>(
      `profileSection(null, {}, ${JSON.stringify({ profiles, routing: "active" })}, { auth: { loggedIn: true } })`,
    ).html

  test("Claude first, then ChatGPT, each under its heading, in the saved order", () => {
    const html = section(new MemoryStorage(), mixed())
    expect(cardsOf(html).map(c => [c.id, c.group])).toEqual([["c1", "claude"], ["c2", "claude"], ["g1", "chatgpt"], ["g2", "chatgpt"]])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", false]])
    expect(html.indexOf('data-group="chatgpt" role="heading"')).toBeLessThan(html.indexOf('data-id="g1"'))
    expect(html.indexOf('data-id="c2"')).toBeLessThan(html.indexOf('data-group="chatgpt" role="heading"'))
  })

  test("one active card per provider, each carrying its provider's class, stripe and badge", () => {
    const cards = cardsOf(section(new MemoryStorage(), mixed()))
    expect(cards.filter(c => c.classes.includes("active")).map(c => [c.id, c.classes[0]])).toEqual([["c1", "provider-claude"], ["g2", "provider-chatgpt"]])
    for (const c of cards) expect(c.classes[0]).toBe(`provider-${c.group}`)
    const html = section(new MemoryStorage(), mixed())
    expect(html).toContain('<span class="provider-pill provider-badge">Claude</span>')
    expect(html).toContain('<span class="provider-pill provider-badge">ChatGPT</span>')
  })

  test("handles number each provider from 1, while indexes run across the page", () => {
    const html = section(new MemoryStorage(), mixed())
    expect(orderIndexes(html)).toEqual([1, 2, 1, 2])
    expect(cardsOf(html).map(c => c.index)).toEqual(["0", "1", "2", "3"])
    expect(html).toContain("a card moves only among its provider")
  })

  test("chips show both providers, and a hidden one's cards stay in the page, hidden", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const html = section(storage, mixed())
    expect(html).toContain('data-provider-chip="claude" aria-pressed="true"')
    expect(html).toContain('data-provider-chip="chatgpt" aria-pressed="false"')
    expect(cardsOf(html).map(c => [c.id, c.hidden])).toEqual([["c1", false], ["c2", false], ["g1", true], ["g2", true]])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", true]])
    expect(html).toContain('<div class="provider-none" hidden>')
  })

  test("with every provider hidden, the page says so and offers Show all", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["claude","chatgpt"]')
    const html = section(storage, mixed())
    expect(html).toContain(`<div class="provider-none">${PROVIDERS_NONE_SHOWN_HTML}</div>`)
  })

  test("a ChatGPT-only instance: no chips or headings, the brand still on every card", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const html = section(storage, [seat("a"), seat("b", { isActive: true }), seat("c")])
    expect(html).not.toContain("provider-chip")
    expect(headingsOf(html)).toEqual([])
    expect(cardsOf(html).map(c => [c.id, c.classes.includes("provider-chatgpt"), c.classes.includes("active"), c.hidden]))
      .toEqual([["a", true, false, false], ["b", true, true, false], ["c", true, false, false]])
  })

  test("a provider's only card gets no handle", () => {
    const html = section(new MemoryStorage(), [claude("c1", { isActive: true }), seat("g1"), seat("g2", { isActive: true })])
    expect(orderIndexes(html)).toEqual([1, 2])
    expect(html.indexOf('class="drag-handle"')).toBeGreaterThan(html.indexOf('data-id="g1"'))
  })
})

describe("the profiles page draws the same groups", () => {
  const rendered = (storage: MemoryStorage, profiles: unknown[]) => {
    const page = loadPage(profilePageHtml, storage)
    page.run(`lastProfiles = ${JSON.stringify({ profiles })}; render(lastProfiles, null)`)
    return { page, html: page.element("content").innerHTML, chips: page.element("profiles-provider-chips").innerHTML }
  }

  test("grouped cards, one active per provider, chips beside the search", () => {
    const { html, chips } = rendered(new MemoryStorage(), mixed())
    const cards = cardsOf(html)
    expect(cards.map(c => [c.id, c.group, c.index])).toEqual([["c1", "claude", "0"], ["c2", "claude", "1"], ["g1", "chatgpt", "2"], ["g2", "chatgpt", "3"]])
    expect(cards.filter(c => c.classes.includes("active")).map(c => [c.id, c.classes[0]])).toEqual([["c1", "provider-claude"], ["g2", "provider-chatgpt"]])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", false]])
    expect(orderIndexes(html)).toEqual([1, 2, 1, 2])
    expect(chips).toContain('data-provider-chip="claude" aria-pressed="true"')
    expect(chips).toContain('data-provider-chip="chatgpt" aria-pressed="true"')
  })

  test("the provider badge replaces a seat's type badge; a Claude account keeps its type", () => {
    const { html } = rendered(new MemoryStorage(), mixed())
    expect(html).toContain('<span class="profile-badge provider-badge">Claude</span><span class="profile-badge badge-type">claude-max</span>')
    expect(html).toContain('<span class="profile-badge provider-badge">ChatGPT</span>')
    expect(html).not.toContain('badge-type">chatgpt<')
    expect(html).toContain('class="switch-btn switch-to"')
  })

  test("a chip and the search compose; the count covers only the providers on screen", () => {
    const storage = new MemoryStorage()
    const { page } = rendered(storage, mixed())
    const card = (id: string, group: string) => {
      const el = stubElement()
      el.attrs.set("data-id", id)
      el.attrs.set("data-group", group)
      return el
    }
    const cards = [card("c1", "claude"), card("c2", "claude"), card("g1", "chatgpt"), card("g2", "chatgpt")]
    const head = (group: string) => { const el = stubElement(); el.attrs.set("data-group", group); return el }
    const heads = [head("claude"), head("chatgpt")]
    page.select("#content .profile-card[data-id]", cards)
    page.select("#content .provider-group-head", heads)
    const shown = () => cards.filter(c => !c.hidden).map(c => c.attrs.get("data-id"))

    page.run("meridianProviders.setHidden('chatgpt', true); applyProfileFilter()")
    expect(shown()).toEqual(["c1", "c2"])
    expect(heads.map(h => h.hidden)).toEqual([false, true])
    expect(page.element("profiles-provider-none").hidden).toBe(true)

    page.run("setProfileQuery('c2')")
    expect(shown()).toEqual(["c2"])
    expect(page.element("profiles-filter-count").textContent).toBe("1 of 2")

    page.run("setProfileQuery('g1')")
    expect(shown()).toEqual([])
    expect(heads.map(h => h.hidden)).toEqual([true, true])
    expect(page.element("profiles-no-match").hidden).toBe(false)

    page.run("setProfileQuery(''); meridianProviders.setHidden('claude', true); applyProfileFilter()")
    expect(shown()).toEqual([])
    expect(page.element("profiles-provider-none").hidden).toBe(false)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["chatgpt","claude"]')
  })

  test("a card updating after a sign-in stays visible during a search for its old email", () => {
    const storage = new MemoryStorage()
    const profiles = [claude("c1", { email: "old@example.com" }), claude("c2", { email: "other@example.com" })]
    // A seat on the page too, so turning the Claude chip off is not refused
    // as hiding the last provider.
    const { page } = rendered(storage, [...profiles, seat("g1")])
    const cards = ["c1", "c2"].map(id => {
      const el = stubElement()
      el.attrs.set("data-id", id)
      el.attrs.set("data-group", "claude")
      return el
    })
    page.select("#content .profile-card[data-id]", cards)
    const shown = () => cards.filter(c => !c.hidden).map(c => c.attrs.get("data-id"))
    page.run("setProfileQuery('old@example.com')")
    expect(shown()).toEqual(["c1"])

    // The re-login landed on another account: the email changed under the
    // search, and the card is still updating.
    const updating = [claude("c1", { email: "new@example.com", factsRefresh: { state: "updating", since: 1 } }), profiles[1]]
    page.run(`lastProfiles = ${JSON.stringify({ profiles: updating })}; applyProfileFilter()`)
    expect(shown()).toEqual(["c1"])
    expect(page.element("profiles-filter-count").textContent).toBe("1 of 2")

    // The page's own memory of the sign-in keeps it too, before the server says so.
    page.run(`lastProfiles = ${JSON.stringify({ profiles: [claude("c1", { email: "new@example.com" }), profiles[1]] })}; applyProfileFilter()`)
    expect(shown()).toEqual([])
    page.run("meridianCardStatus.beginUpdate('c1'); applyProfileFilter()")
    expect(shown()).toEqual(["c1"])

    // A hidden provider still hides it: the exemption is from the search only.
    page.run("meridianProviders.setHidden('claude', true); applyProfileFilter()")
    expect(shown()).toEqual([])
  })

  test("a link to an account of a hidden provider shows that provider again", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const page = loadPage(profilePageHtml, storage)
    page.run(`lastProfiles = ${JSON.stringify({ profiles: mixed() })}; render(lastProfiles, null)`)
    const target = stubElement()
    target.attrs.set("data-group", "chatgpt")
    page.element("profile-g1").getAttribute = target.getAttribute
    page.run("location.hash = '#g1'; jumpToProfileAnchor()")
    expect(page.run<boolean>("meridianProviders.isHidden('chatgpt')")).toBe(false)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe("[]")
  })
})

// ---------------------------------------------------------------------------
// ?provider= in the address (profileFilterUrl.ts).
// ---------------------------------------------------------------------------

/** Storage that also notices any write, so "left alone" means no write at all. */
class WatchedStorage extends MemoryStorage {
  writes = 0
  override setItem(key: string, value: string): void { this.writes++; super.setItem(key, value) }
}

const remembering = (hidden: string[]) => {
  const storage = new WatchedStorage()
  storage.setItem(HIDDEN_PROVIDERS_KEY, JSON.stringify(hidden))
  storage.writes = 0
  return storage
}

describe("?provider= names the chips that are on", () => {
  const shownBy = (search: string, storage = remembering(["claude"])) => {
    const p = loadProviders(storage, address(`http://127.0.0.1:3459/profiles${search}`))
    return PROFILE_PROVIDERS.map(x => x.id).filter(id => !p.isHidden(id))
  }

  test("one id, a list, and the order and spacing a hand-typed link may have", () => {
    expect(shownBy("?provider=chatgpt")).toEqual(["chatgpt"])
    expect(shownBy("?provider=claude")).toEqual(["claude"])
    expect(shownBy("?provider=chatgpt,claude")).toEqual(["claude", "chatgpt"])
    expect(shownBy("?provider=chatgpt%2C%20claude")).toEqual(["claude", "chatgpt"])
  })

  test("unknown ids are dropped; with none known left the remembered choice stands", () => {
    expect(shownBy("?provider=claude,antigravity,constructor")).toEqual(["claude"])
    expect(shownBy("?provider=antigravity")).toEqual(["chatgpt"])
    expect(shownBy("?provider=constructor,toString")).toEqual(["chatgpt"])
    expect(shownBy("?provider=%20")).toEqual(["chatgpt"])
    expect(shownBy("?provider=,")).toEqual(["chatgpt"])
    expect(shownBy("?q=work")).toEqual(["chatgpt"])
    expect(shownBy("")).toEqual(["chatgpt"])
  })

  test("an explicitly empty parameter selects no chips, even with a saved preference", () => {
    expect(shownBy("?provider=")).toEqual([])
    expect(shownBy("?provider")).toEqual([])
    expect(shownBy("?provider=", remembering([]))).toEqual([])
  })

  test("opening a link never writes the remembered choice", () => {
    const storage = remembering(["claude"])
    loadProviders(storage, address("http://127.0.0.1:3459/profiles?provider=claude"))
    expect(storage.writes).toBe(0)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["claude"]')
  })

  test("a click on a group the link named rewrites the address, not storage, and keeps the rest of it", () => {
    const storage = remembering(["claude"])
    const at = address("http://127.0.0.1:3459/profiles?q=work&provider=chatgpt#d-dh-c2")
    const p = loadProviders(storage, at)
    p.setHidden("claude", false)
    expect(at.location.href).toBe("http://127.0.0.1:3459/profiles?q=work&provider=claude,chatgpt#d-dh-c2")
    p.setHidden("chatgpt", true)
    expect(at.location.href).toBe("http://127.0.0.1:3459/profiles?q=work&provider=claude#d-dh-c2")
    p.showAll()
    expect(at.location.href).toBe("http://127.0.0.1:3459/profiles?q=work&provider=claude,chatgpt#d-dh-c2")
    expect(storage.writes).toBe(0)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["claude"]')
    // The rewritten address is a link of its own: a reload shows the same chips.
    expect(loadProviders(storage, address(at.location.href)).isHidden("claude")).toBe(false)
  })

  test("without the parameter a click saves as before and leaves the address alone", () => {
    const storage = remembering([])
    const at = address("http://127.0.0.1:3459/profiles#d-dh-c2")
    const p = loadProviders(storage, at)
    p.setHidden("chatgpt", true)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["chatgpt"]')
    expect(at.replaced).toEqual([])
  })

  test("fromLocation follows the address back and forth", () => {
    const storage = remembering(["claude"])
    const at = address("http://127.0.0.1:3459/profiles?provider=claude")
    const p = loadProviders(storage, at)
    at.location.href = "http://127.0.0.1:3459/profiles"
    p.fromLocation()
    expect(p.isHidden("claude")).toBe(true)
    at.location.href = "http://127.0.0.1:3459/profiles?provider=claude"
    p.fromLocation()
    expect(p.isHidden("claude")).toBe(false)
    expect(p.isHidden("chatgpt")).toBe(true)
    expect(storage.writes).toBe(0)
  })
})

describe("?provider= on the landing page", () => {
  const visibleOn = (search: string, storage: MemoryStorage) => {
    const html = loadPage(landingHtml, storage, `http://127.0.0.1:3459/${search}`).run<{ html: string }>(
      `profileSection(null, {}, ${JSON.stringify({ profiles: mixed(), routing: "active" })}, { auth: { loggedIn: true } })`,
    ).html
    return { html, ids: cardsOf(html).filter(c => !c.hidden).map(c => c.id) }
  }

  test("each link shows its provider's cards only, and the remembered choice is untouched", () => {
    const storage = remembering(["claude"])
    expect(visibleOn("?provider=claude", storage).ids).toEqual(["c1", "c2"])
    expect(visibleOn("?provider=chatgpt", storage).ids).toEqual(["g1", "g2"])
    const { html } = visibleOn("?provider=claude", storage)
    expect(html).toContain('data-provider-chip="claude" aria-pressed="true"')
    expect(html).toContain('data-provider-chip="chatgpt" aria-pressed="false"')
    expect(visibleOn("", storage).ids).toEqual(["g1", "g2"])
    expect(storage.writes).toBe(0)
  })
})

describe("?provider= on the profiles page", () => {
  const open = (href: string, storage: MemoryStorage) => {
    const page = loadPage(profilePageHtml, storage, href)
    page.run(`lastProfiles = ${JSON.stringify({ profiles: mixed() })}; render(lastProfiles, null)`)
    const cards = [["c1", "claude"], ["c2", "claude"], ["g1", "chatgpt"], ["g2", "chatgpt"]].map(([id, group]) => {
      const el = stubElement()
      el.attrs.set("data-id", id!)
      el.attrs.set("data-group", group!)
      return el
    })
    page.select("#content .profile-card[data-id]", cards)
    const shown = () => { page.run("applyProfileFilter()"); return cards.filter(c => !c.hidden).map(c => c.attrs.get("data-id")) }
    return { page, shown }
  }

  test("the link shows its provider only; the chips say so", () => {
    const storage = remembering([])
    const { page, shown } = open("http://127.0.0.1:3459/profiles?provider=chatgpt", storage)
    expect(shown()).toEqual(["g1", "g2"])
    expect(page.element("profiles-provider-chips").innerHTML).toContain('data-provider-chip="claude" aria-pressed="false"')
    expect(storage.writes).toBe(0)
  })

  test("a profile anchor rides along with the query; following it to a hidden provider rewrites the query, not storage", () => {
    const storage = remembering([])
    const { page, shown } = open("http://127.0.0.1:3459/profiles?provider=chatgpt#c1", storage)
    expect(shown()).toEqual(["g1", "g2"])
    const target = stubElement()
    target.attrs.set("data-group", "claude")
    page.element("profile-c1").getAttribute = target.getAttribute
    page.run("jumpToProfileAnchor()")
    expect(shown()).toEqual(["c1", "c2", "g1", "g2"])
    expect(page.at.location.href).toBe("http://127.0.0.1:3459/profiles?provider=claude,chatgpt#c1")
    expect(storage.writes).toBe(0)
  })

  test("back to an entry with another ?provider= redraws the chips from it", () => {
    const storage = remembering(["chatgpt"])
    const { page, shown } = open("http://127.0.0.1:3459/profiles?provider=chatgpt", storage)
    expect(shown()).toEqual(["g1", "g2"])
    page.at.location.href = "http://127.0.0.1:3459/profiles?provider=claude#c2"
    page.dispatch("popstate")
    expect(shown()).toEqual(["c1", "c2"])
    page.at.location.href = "http://127.0.0.1:3459/profiles"
    page.dispatch("popstate")
    expect(shown()).toEqual(["c1", "c2"])
    expect(page.run<boolean>("meridianProviders.isHidden('chatgpt')")).toBe(true)
    expect(storage.writes).toBe(0)
  })
})

for (const [name, html, path, rootId, selector, apply] of [
  ["landing", landingHtml, "/", "content", "[data-group]", "applyProviderFilter()"],
  ["profiles", profilePageHtml, "/profiles", "profiles-section", "#content .profile-card[data-id]", "applyProfileFilter()"],
] as const) {
  test(`${name}: last chip off survives reload, history and Show all without saving a preference`, () => {
    const storage = remembering(["claude"])
    const base = `http://127.0.0.1:3459${path}?fixture=roundtrip`
    const open = (href: string) => {
      const page = loadPage(html, storage, href)
      if (name === "profiles") page.run(`lastProfiles = ${JSON.stringify({ profiles: mixed() })}; render(lastProfiles, null)`)
      else page.run(`profileSection(null, {}, ${JSON.stringify({ profiles: mixed() })}, { auth: { loggedIn: true } })`)
      const cards = [["c1", "claude"], ["g1", "chatgpt"]].map(([id, group]) => {
        const el = stubElement()
        el.attrs.set("data-id", id!)
        el.attrs.set("data-group", group!)
        return el
      })
      if (name === "landing") page.element("content").querySelectorAll = (s: string) => s === selector ? cards : []
      else page.select(selector, cards)
      page.run(apply)
      return { page, shown: () => cards.filter(c => !c.hidden).map(c => c.attrs.get("data-id")) }
    }
    const first = open(`${base}&provider=chatgpt`)
    expect(first.shown()).toEqual(["g1"])
    first.page.clickChip(rootId, "chatgpt")
    expect(first.shown()).toEqual([])
    const emptyUrl = `${base}&provider=`
    expect(first.page.at.location.href).toBe(emptyUrl)

    const reloaded = open(emptyUrl)
    expect(reloaded.shown()).toEqual([])
    if (name === "profiles") expect(reloaded.page.element("profiles-provider-none").hidden).toBe(false)
    reloaded.page.clickChip(rootId, "*")
    expect(reloaded.shown()).toEqual(["c1", "g1"])
    expect(reloaded.page.at.location.href).toBe(`${base}&provider=claude,chatgpt`)

    // Back to an earlier all-hidden entry, then forward to a plain visit.
    // Dispatch only popstate: the page listener must apply the new filter.
    for (const [href, shown] of [[emptyUrl, []], [base, ["g1"]], [emptyUrl, []]] as const) {
      reloaded.page.at.location.href = href
      reloaded.page.dispatch("popstate")
      expect(reloaded.shown()).toEqual([...shown])
    }
    expect(storage.writes).toBe(0)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["claude"]')
    expect(open(base).shown()).toEqual(["g1"])
  })
}
