/**
 * Finishing a text selection on a card of `/` must not switch accounts.
 *
 * Every switchable card there is a switch button, and releasing a drag-select
 * over its text dispatches a click on it. The page's own script runs here
 * against a stub document, and its click listener on #content is fed the
 * click the browser would send.
 */
import { describe, expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { textSelectionJs } from "../telemetry/textSelection"

interface Selection { isCollapsed: boolean; text: string; anchorNode: unknown }

const inContent = { inContent: true }
const inHeader = { inContent: false }
const content = { contains: (node: { inContent?: boolean } | null) => !!node?.inContent }

function selectionContext(selection: Selection | null) {
  const sandbox: Record<string, unknown> = {
    getSelection: () => selection && { ...selection, toString: () => selection.text },
    document: { getElementById: (id: string) => (id === "content" ? content : null) },
  }
  sandbox.window = sandbox
  return createContext(sandbox)
}

function live(selection: Selection | null): boolean {
  const context = selectionContext(selection)
  runInContext(textSelectionJs, context)
  return runInContext("meridianSelection.live()", context) as boolean
}

describe("meridianSelection.live", () => {
  test("text selected inside #content is live", () => {
    expect(live({ isCollapsed: false, text: "work@example.com", anchorNode: inContent })).toBe(true)
  })

  test("no selection, a collapsed one or an empty one is not", () => {
    expect(live(null)).toBe(false)
    expect(live({ isCollapsed: true, text: "", anchorNode: inContent })).toBe(false)
    expect(live({ isCollapsed: false, text: "", anchorNode: inContent })).toBe(false)
  })

  test("a selection outside #content is not: no card can be under it", () => {
    expect(live({ isCollapsed: false, text: "Meridian", anchorNode: inHeader })).toBe(false)
  })
})

function landingPage() {
  const clicks: Array<(event: { target: unknown }) => void> = []
  const switches: string[] = []
  let selection: Selection | null = null
  const element = (id: string) => ({
    id, hidden: false, innerHTML: "", style: {}, dataset: {}, textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener: (type: string, fn: (event: { target: unknown }) => void) => {
      if (id === "content" && type === "click") clicks.push(fn)
    },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() {}, appendChild() {}, focus() {}, closest: () => null,
    contains: (node: { inContent?: boolean } | null) => id === "content" && !!node?.inContent,
    getBoundingClientRect: () => ({ top: 0, height: 0 }),
  })
  const elements = new Map<string, ReturnType<typeof element>>()
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, element(id))
        return elements.get(id)
      },
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      activeElement: null, visibilityState: "visible",
      createElement: () => ({ textContent: "", innerHTML: "" }),
    },
    getSelection: () => selection && { ...selection, toString: () => selection!.text },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URL, console,
    location: { href: "http://127.0.0.1:3456/", hash: "", search: "", pathname: "/" },
    history: { state: null, replaceState() {}, pushState() {} },
    navigator: { clipboard: { writeText() {} } },
    fetch: (url: string, init?: { body?: string }) => {
      if (url === "/profiles/active") switches.push(JSON.parse(init?.body ?? "{}").profile)
      return new Promise(() => {})
    },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener() {}, alert() {}, innerHeight: 800, scrollY: 0, scrollTo() {},
  }
  sandbox.window = sandbox
  const script = [...landingHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1] ?? "").join("\n")
  runInContext(script, createContext(sandbox))
  const card = { dataset: { profile: "work" } }
  // A click on a card's text: the only ancestor it has is the switchable card.
  const onCardText = { closest: (selector: string) => (selector === ".profile-card.switchable" ? card : null) }
  return {
    switches,
    select: (next: Selection | null) => { selection = next },
    clickCard: () => { for (const fn of clicks) fn({ target: onCardText }) },
  }
}

describe("a click on a switchable card of /", () => {
  test("a plain click switches to that account", () => {
    const page = landingPage()
    page.clickCard()
    expect(page.switches).toEqual(["work"])
  })

  test("the click that ends a drag-select over the card's text does not", () => {
    const page = landingPage()
    page.select({ isCollapsed: false, text: "work@example.com", anchorNode: inContent })
    page.clickCard()
    expect(page.switches).toEqual([])
  })

  test("text selected outside #content does not stop a switch", () => {
    const page = landingPage()
    page.select({ isCollapsed: false, text: "Meridian", anchorNode: inHeader })
    page.clickCard()
    expect(page.switches).toEqual(["work"])
  })
})
