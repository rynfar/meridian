/**
 * Page layout: how much of the window Meridian's web pages may use.
 *
 * "contained" keeps every page in a centered column, which is how the pages
 * have always looked and stays the default. "wide" drops that column so the
 * pages span the window: the home page fits more account cards per row at the
 * same size, and /profiles lays its cards out side by side instead of in one
 * stack. It exists for people with a wide monitor and many accounts, for whom
 * the column leaves most of the screen empty while the cards scroll.
 *
 * The choice is a server setting (settings.json `layout`), not a per-browser
 * one, and it is applied while the page is served: the root element carries
 * `data-layout="wide"` and the page CSS keys off that attribute. Applying it
 * in the browser after load would first paint the contained page and then
 * jump. A contained page carries no attribute, so none of the wide rules
 * apply to it.
 */

import { getSetting } from "../settings"

export const PAGE_LAYOUTS = ["contained", "wide"] as const
export type PageLayout = (typeof PAGE_LAYOUTS)[number]

export function isPageLayout(value: unknown): value is PageLayout {
  return typeof value === "string" && (PAGE_LAYOUTS as readonly string[]).includes(value)
}

/** The layout a stored value means. Anything unknown, including unset, is contained. */
export function resolvePageLayout(value: unknown): PageLayout {
  return isPageLayout(value) ? value : "contained"
}

/** Mark a page's root element with its layout. Contained pages are returned unchanged. */
export function withPageLayout(html: string, layout: PageLayout): string {
  if (layout === "contained") return html
  return html.replace(/<html(?=[\s>])/i, `<html data-layout="${layout}"`)
}

/** A page as it should be served right now, per the saved setting. */
export function withSavedLayout(html: string): string {
  return withPageLayout(html, resolvePageLayout(getSetting("layout")))
}
