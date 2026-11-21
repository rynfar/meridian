import { describe, expect, test } from "bun:test"
import { profileTableJs } from "../telemetry/profileTable"

type Page = "home" | "profiles"
type Cell = { readonly value: number | string | null; readonly html?: string }
type Row = {
  readonly id: string
  readonly anchorId?: string
  readonly hidden?: boolean
  readonly cells: Readonly<Record<string, Cell>>
  readonly actionsHtml: string
  readonly detailHtml?: string
}

class Button {
  constructor(readonly key: string, readonly disabled: boolean, readonly document: { activeElement: Button | null }) {}
  getAttribute(name: string) {
    return name === "data-profile-table-control" ? this.key : null
  }
  closest(selector: string) {
    return selector === "button[data-profile-table-control]" ? this : null
  }
  focus() { this.document.activeElement = this }
}

type TestEvent = {
  readonly target: { readonly closest: (selector: string) => unknown }
  readonly shiftKey?: boolean
  readonly preventDefault?: () => void
  readonly dataTransfer?: { effectAllowed: string; setData: (type: string, value: string) => void }
}
type Table = {
  readonly toolbarHtml: () => string
  readonly isTable: () => boolean
  readonly tableHtml: (rows: readonly Row[]) => string
  readonly init: (root: unknown, redraw: () => void) => void
  readonly dragging: () => boolean
}

function browser(page: Page, rows: readonly Row[] = [], saved = new Map<string, string>()) {
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) }
  const table: Table = new Function("localStorage", profileTableJs(page) + "\nreturn meridianProfileTable;")(storage)
  const ownerDocument: { activeElement: Button | null } = { activeElement: null }
  let rendered = ""
  const listeners = new Map<string, (event: TestEvent) => void>()
  function findButton(key: string) {
    const attrs = Array.from(rendered.matchAll(/<button\b([^>]*)>/g), match => match[1])
      .find(attrs => attrs?.includes(`data-profile-table-control="${key}"`))
    return attrs ? new Button(key, /\sdisabled(?:\s|$)/.test(attrs), ownerDocument) : null
  }
  table.init({
    ownerDocument,
    addEventListener: (type: string, listener: (event: TestEvent) => void) => listeners.set(type, listener),
    querySelector: (selector: string) => findButton(selector.match(/data-profile-table-control="([^"]+)"/)?.[1] ?? ""),
  }, redraw)
  function redraw() {
    ownerDocument.activeElement = null
    rendered = table.toolbarHtml() + (table.isTable() ? table.tableHtml(rows) : "")
  }
  redraw()
  function dispatch(type: string, event: TestEvent) {
    const listener = listeners.get(type)
    if (!listener) throw new Error(`No delegated ${type} listener`)
    listener(event)
  }
  return {
    table,
    dispatch,
    click(key: string, shiftKey = false) {
      const target = findButton(key)
      if (!target || target.disabled) throw new Error(`No enabled table control ${key}`)
      target.focus()
      dispatch("click", { target, shiftKey })
    },
    focused: () => ownerDocument.activeElement?.key,
    html: () => rendered,
  }
}

function account(id: string, cells: Row["cells"]): Row {
  return { id, cells: { name: { value: id }, ...cells }, actionsHtml: "" }
}

function rowOrder(markup: string) {
  return Array.from(markup.matchAll(/<tr[^>]* data-profile-row="([^"]*)"/g), (match) => match[1])
}

function columnOrder(markup: string) {
  return Array.from(markup.matchAll(/<th\b[^>]*data-column-id="([^"]+)"/g), (match) => match[1])
}

describe("browser profile table", () => {
  test("sorts numbers by their raw value with nulls and missing values last in both directions", () => {
    const rows = [
      account("unknown", { weekly: { value: null } }),
      account("ten", { weekly: { value: 10, html: "<strong>10%</strong>" } }),
      account("missing", {}),
      account("two", { weekly: { value: 2, html: "<strong>2%</strong>" } }),
    ] as const
    const home = browser("home", rows)
    home.click("table")

    home.click("sort:weekly")
    expect(rowOrder(home.html())).toEqual(["two", "ten", "unknown", "missing"])
    home.click("sort:weekly")
    expect(rowOrder(home.html())).toEqual(["ten", "two", "unknown", "missing"])
    expect(rows.map((row) => row.id)).toEqual(["unknown", "ten", "missing", "two"])
  })

  test("keeps the first sort primary when Shift adds a tiebreaker and restores both on reload", () => {
    const saved = new Map<string, string>()
    const rows = [
      account("b-one", { provider: { value: "B" }, weekly: { value: 1 } }),
      account("a-ten", { provider: { value: "A" }, weekly: { value: 10 } }),
      account("a-two", { provider: { value: "A" }, weekly: { value: 2 } }),
    ]
    const home = browser("home", rows, saved)
    home.click("table")
    home.click("sort:provider")
    home.click("sort:weekly", true)

    const reloaded = browser("home", rows, saved)
    expect(rowOrder(reloaded.html())).toEqual(["a-two", "a-ten", "b-one"])
  })

  test("restores the chosen layout and columns independently per page", () => {
    const saved = new Map<string, string>()
    const home = browser("home", [], saved)
    home.click("table")
    home.click("columns")
    home.click("hide:name")
    home.click("up:weekly")

    const reloaded = browser("home", [], saved)
    expect(columnOrder(reloaded.html())).toEqual(["provider", "active", "login", "weekly", "fiveHour", "actions"])
    const profiles = browser("profiles", [], saved)
    expect(profiles.table.isTable()).toBe(false)
    profiles.click("table")
    expect(columnOrder(profiles.html())).toContain("routing")
    expect(columnOrder(profiles.html())[0]).toBe("name")
  })

  test("offers the cost column only on Home, even if Profiles saved it before", () => {
    const previous = new Map([["meridian.profileTable.profiles", JSON.stringify({
      view: "table", order: ["cost", "name"], hidden: [], sort: [{ id: "cost", direction: "asc" }],
    })]])
    const profiles = browser("profiles", [], previous)
    profiles.click("columns")
    expect(columnOrder(profiles.html())).not.toContain("cost")
    expect(profiles.html()).not.toContain('data-profile-table-option="cost"')
    expect(profiles.html()).not.toContain('data-profile-table-control="clear-sort"')

    const home = browser("home")
    home.click("table")
    home.click("columns")
    home.click("hide:cost")
    expect(columnOrder(home.html())).toContain("cost")
  })

  test("reorders sort priority in the Columns editor without changing sort directions", () => {
    const rows = [
      account("b-one", { provider: { value: "B" }, weekly: { value: 1 } }),
      account("b-ten", { provider: { value: "B" }, weekly: { value: 10 } }),
      account("a-one", { provider: { value: "A" }, weekly: { value: 1 } }),
    ]
    const saved = new Map<string, string>()
    const home = browser("home", rows, saved)
    home.click("table")
    home.click("sort:provider")
    home.click("sort:weekly", true)
    home.click("columns")
    home.click("sort-direction:weekly")

    home.click("sort-earlier:weekly")
    expect(rowOrder(browser("home", rows, saved).html())).toEqual(["b-ten", "a-one", "b-one"])
    expect(home.focused()).toBe("sort-later:weekly")
    home.click("sort-later:weekly")
    expect(rowOrder(home.html())).toEqual(["a-one", "b-ten", "b-one"])
  })

  test("removes only the chosen sort key and saves the remaining key on reload", () => {
    const saved = new Map<string, string>()
    const rows = [
      account("b-one", { provider: { value: "B" }, weekly: { value: 1 } }),
      account("a-ten", { provider: { value: "A" }, weekly: { value: 10 } }),
      account("b-two", { provider: { value: "B" }, weekly: { value: 2 } }),
    ]
    const home = browser("home", rows, saved)
    home.click("table")
    home.click("sort:provider")
    home.click("sort:weekly", true)
    home.click("columns")

    home.click("sort-remove:provider")

    expect(rowOrder(browser("home", rows, saved).html())).toEqual(["b-one", "b-two", "a-ten"])
    expect(home.focused()).toBe("sort-remove:weekly")
  })

  test("resets the current page to its own column preset and stable input order", () => {
    const profiles = browser("profiles", [account("z", {}), account("a", {})])
    profiles.click("table")
    expect(columnOrder(profiles.html())).toContain("extra")
    profiles.click("columns")
    profiles.click("hide:extra")
    profiles.click("sort:name")

    profiles.click("reset")

    expect(columnOrder(profiles.html())).toContain("extra")
    expect(rowOrder(profiles.html())).toEqual(["z", "a"])
  })

  test("can opt in to ChatGPT credits and reset counts without expanding the default profile preset", async () => {
    const profiles = browser("profiles", [account("seat", { credits: { value: "42 credits" }, chatgptReset: { value: 3 } })])
    profiles.click("table")
    expect(columnOrder(profiles.html())).not.toContain("credits")
    expect(columnOrder(profiles.html())).not.toContain("chatgptReset")
    profiles.click("columns")

    profiles.click("hide:credits")
    profiles.click("hide:chatgptReset")

    const values: Record<string, string> = {}
    for (const key of ["credits", "chatgptReset"]) {
      await new HTMLRewriter().on(`td[data-key=${key}]`, {
        text(chunk) { values[key] = (values[key] ?? "") + chunk.text },
      }).transform(new Response(profiles.html())).text()
    }
    expect(values).toEqual({ credits: "42 credits", chatgptReset: "3" })
  })

  test("reports a native column drag until drop and persists the new slot", () => {
    const saved = new Map<string, string>()
    const home = browser("home", [], saved)
    home.click("table")
    home.click("columns")
    const transfer = new Map<string, string>()
    const dataTransfer = { effectAllowed: "", setData: (type: string, value: string) => transfer.set(type, value) }
    const grip = { getAttribute: () => "name" }
    const option = { getAttribute: () => "active" }
    let dropped = false

    home.dispatch("dragstart", { target: { closest: () => grip }, dataTransfer })
    expect(home.table.dragging()).toBe(true)
    home.dispatch("drop", { target: { closest: () => option }, preventDefault() { dropped = true } })

    expect(dropped).toBe(true)
    expect(home.table.dragging()).toBe(false)
    expect(columnOrder(browser("home", [], saved).html()).slice(0, 3)).toEqual(["provider", "active", "name"])
  })

  test("keeps the config and header controls focused through delegated redraws", () => {
    const home = browser("home")
    home.click("table")
    home.click("columns")
    home.click("up:weekly")
    expect(home.focused()).toBe("up:weekly")

    home.click("sort:weekly")
    expect(home.focused()).toBe("sort:weekly")
  })

  test("retains filtered rows and action/detail markup while escaping plain cell and anchor text", async () => {
    const fixture = {
      id: "filtered",
      anchorId: 'profile-"&',
      hidden: true,
      cells: { name: { value: "<Work & home>" }, login: { value: 0, html: "<strong>Signed in</strong>" } },
      actionsHtml: '<button type="button" aria-label="Rename Work &amp; home">Rename</button>',
      detailHtml: '<input id="rename-work" value="Work &amp; home">',
    } satisfies Row

    const { table } = browser("home")
    const html = table.tableHtml([fixture])
    const seen: Record<string, string | null> = {}
    await new HTMLRewriter()
      .on("tr[data-profile-row]", { element(el) {
        seen.anchor = el.getAttribute("id")
        seen.key = el.getAttribute("data-key")
        seen.hidden = el.getAttribute("hidden")
      } })
      .on("td[data-key=actions] button", { element(el) { seen.action = el.getAttribute("aria-label") } })
      .on("td[data-key=actions] input", { element(el) { seen.detail = el.getAttribute("id") } })
      .transform(new Response(html)).text()
    expect(seen).toEqual({ anchor: "profile-&quot;&amp;", key: "filtered", hidden: "", action: "Rename Work &amp; home", detail: "rename-work" })
    expect(html).toContain("&lt;Work &amp; home&gt;")
    expect(html).toContain("<strong>Signed in</strong>")
  })
})
