/**
 * The in-place patch both live pages refresh through.
 *
 * Bun has no DOM, so this runs the shipped browser source against a small
 * node tree implementing exactly the DOM members it touches. What is asserted
 * is node IDENTITY: a find-in-page highlight, a selection or focus lives on a
 * node, and survives a refresh only if that node is the one still on the page.
 */
import { describe, expect, test } from "bun:test"
import { domPatchJs } from "../telemetry/domPatch"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

class FakeNode {
  parentNode: FakeElement | null = null
  constructor(public nodeType: number, public nodeName: string, public nodeValue: string | null = null) {}
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
}

class FakeElement extends FakeNode {
  childNodes: FakeNode[] = []
  private attrs = new Map<string, string>()
  attributeWrites = 0
  constructor(tag: string, attrs: Record<string, string> = {}, children: FakeNode[] = []) {
    super(1, tag.toUpperCase())
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
    for (const child of children) this.appendChild(child)
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })) }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null }
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  hasAttribute(name: string) { return this.attrs.has(name) }
  setAttribute(name: string, value: string) { this.attributeWrites++; this.attrs.set(name, value) }
  removeAttribute(name: string) { this.attributeWrites++; this.attrs.delete(name) }
  appendChild(node: FakeNode) { return this.insertBefore(node, null) }
  removeChild(node: FakeNode) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1)
    node.parentNode = null
    return node
  }
  insertBefore(node: FakeNode, ref: FakeNode | null) {
    if (node.parentNode) node.parentNode.removeChild(node)
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node)
    node.parentNode = this
    return node
  }
}

const el = (tag: string, attrs: Record<string, string> = {}, ...children: FakeNode[]) => new FakeElement(tag, attrs, children)
const text = (value: string) => new FakeNode(3, "#text", value)

const patch = new Function(domPatchJs + "\nreturn meridianPatch;")() as {
  morphChildren: (target: FakeElement, source: FakeElement) => void
}

function card(id: string, body: string, extra: Record<string, string> = {}) {
  return el("div", { class: "profile-card", id: `profile-${id}`, ...extra },
    el("span", { class: "profile-name" }, text(id)),
    el("div", { class: "detail" }, text(body)),
  )
}

const textOf = (node: FakeNode): string =>
  node instanceof FakeElement ? node.childNodes.map(textOf).join("") : node.nodeValue ?? ""

describe("meridianPatch.morphChildren", () => {
  test("an unchanged refresh keeps every node and writes nothing", () => {
    const page = el("div", {}, card("work", "Acme"), card("side", "Globex"))
    const nodes = [page.childNodes[0], (page.childNodes[0] as FakeElement).childNodes[1], (page.childNodes[1] as FakeElement).childNodes[0]]
    patch.morphChildren(page, el("div", {}, card("work", "Acme"), card("side", "Globex")))
    expect([page.childNodes[0], (page.childNodes[0] as FakeElement).childNodes[1], (page.childNodes[1] as FakeElement).childNodes[0]]).toEqual(nodes)
    expect((page.childNodes[0] as FakeElement).attributeWrites).toBe(0)
  })

  test("a changed fact is patched into the SAME text node", () => {
    const page = el("div", {}, card("work", "50%"))
    const detail = ((page.childNodes[0] as FakeElement).childNodes[1] as FakeElement)
    const value = detail.childNodes[0]!
    patch.morphChildren(page, el("div", {}, card("work", "62%")))
    expect(detail.childNodes[0]).toBe(value)
    expect(value.nodeValue).toBe("62%")
  })

  test("a reorder moves the cards themselves, keyed by id", () => {
    const page = el("div", {}, card("a", "1"), card("b", "2"), card("c", "3"))
    const [a, b, c] = page.childNodes as [FakeNode, FakeNode, FakeNode]
    patch.morphChildren(page, el("div", {}, card("c", "3"), card("a", "1"), card("b", "2")))
    expect(page.childNodes).toEqual([c, a, b])
  })

  test("only a card that appeared is new, and only one that went away is removed", () => {
    const page = el("div", {}, card("a", "1"), card("b", "2"))
    const a = page.childNodes[0]
    patch.morphChildren(page, el("div", {}, card("a", "1"), card("new", "3")))
    expect(page.childNodes[0]).toBe(a)
    expect(page.childNodes.map(n => (n as FakeElement).getAttribute("id"))).toEqual(["profile-a", "profile-new"])
  })

  test("a removed keyed card does not cost its unkeyed siblings their identity", () => {
    const heading = el("h3", {}, text("Claude"))
    const page = el("div", {}, card("gone", "x"), heading, card("a", "1"))
    patch.morphChildren(page, el("div", {}, el("h3", {}, text("Claude")), card("a", "1")))
    expect(page.childNodes[0]).toBe(heading)
  })

  test("attributes follow the rendering: changed, added and dropped", () => {
    const page = el("div", {}, card("a", "1", { class: "profile-card active", "data-login-state": "ok" }))
    const node = page.childNodes[0] as FakeElement
    patch.morphChildren(page, el("div", {}, card("a", "1", { class: "profile-card", title: "t" })))
    expect(page.childNodes[0]).toBe(node)
    expect(node.getAttribute("class")).toBe("profile-card")
    expect(node.getAttribute("title")).toBe("t")
    expect(node.hasAttribute("data-login-state")).toBe(false)
  })

  test("a data-patch-own node keeps what the page's script put in it", () => {
    const panel = el("div", { class: "login-panel" }, text("paste your code"))
    const page = el("div", {}, el("div", { id: "login-slot-a", "data-patch-own": "" }, panel))
    patch.morphChildren(page, el("div", {}, el("div", { id: "login-slot-a", "data-patch-own": "" })))
    expect((page.childNodes[0] as FakeElement).childNodes).toEqual([panel])
  })

  test("a node whose tag changed is replaced rather than patched into the wrong shape", () => {
    const page = el("div", {}, el("span", {}, text("old")))
    patch.morphChildren(page, el("div", {}, el("strong", {}, text("new"))))
    expect(page.childNodes.map(n => n.nodeName)).toEqual(["STRONG"])
    expect(textOf(page)).toBe("new")
  })
})

describe("the pages that refresh themselves", () => {
  for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
    test(`${name} ships the shared patcher and refreshes #content through it`, () => {
      expect(html).toContain("var meridianPatch=(function(){")
      expect(html).toMatch(/meridianPatch\.html\(document\.getElementById\('content'\),/)
    })
  }

  test("/profiles keeps an open sign-in panel through a refresh", () => {
    expect(profilePageHtml).toContain('data-patch-own')
  })
})
