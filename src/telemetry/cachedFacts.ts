/**
 * Provenance for values a page shows from a remembered reading.
 *
 * Lives outside the inline-HTML template for the same reason profileUsage.ts
 * does: profilePage.ts is one big template literal that runs in the browser, so
 * these can't be imported at runtime. The page mirrors them in its inline
 * script and these TS versions guard the behavior via tests.
 *
 * Three states rather than two, because "no value" is two different facts and a
 * reader has to be able to tell them apart:
 *
 *   live   — read by the check that just ran.
 *   cached — read earlier; the check that just ran could not confirm it. Still
 *            the best answer available, so it is shown, and marked so nobody
 *            reads a remembered figure as a current one.
 *   never  — never successfully read for this profile. Rendering this as
 *            `cached` would claim a reading that was never taken; rendering it
 *            as nothing at all drops the row entirely, so an account whose plan
 *            size became unreadable looks identical to one that never had it.
 */

/** Which of the three readings produced the value on screen. */
export type FactProvenance = "live" | "cached" | "never"

/** Shown in place of a value that has never been read successfully. */
export const NEVER_READ_TEXT = "never read"

/** The marker's wording. Nowaker's own: short enough to sit after a value
 *  without wrapping the row. */
export const CACHED_TEXT = "(cached)"

/**
 * Classify a value by how it was obtained.
 *
 * `stale` means the check that just ran failed and `value` is what an earlier
 * one left behind. An empty string counts as absent: the auth status and usage
 * routes both normalize "not present" to null, but a blank plan string reaching
 * the page would otherwise render as a live reading of nothing.
 */
export function factProvenance(value: string | null | undefined, stale: boolean): FactProvenance {
  if (value == null || value === "") return "never"
  return stale ? "cached" : "live"
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Mirrors the `esc` helpers in the page templates. Values reaching here are
 *  account emails and plan names from a credential file, so they are escaped
 *  rather than trusted. */
function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/**
 * The marker that sits to the right of one cached value, or '' for a value read
 * by the check that just ran.
 *
 * Per value rather than per card: a profile card routinely mixes the two — a
 * live status beside a remembered email — so a single banner over the card
 * would mislabel whichever half it doesn't apply to.
 */
export function cachedTag(provenance: FactProvenance): string {
  return provenance === "cached" ? '<span class="cached-tag">' + CACHED_TEXT + "</span>" : ""
}

/**
 * Render one `.detail-value` cell for a profile fact.
 *
 * `extraClass` carries the caller's own status colouring (the Status row is
 * green or red); it is joined onto `.detail-value` rather than replacing it.
 * Returns null when the row should be omitted — a fact that is absent from a
 * check that SUCCEEDED is genuinely not applicable to this account (an API-key
 * profile has no plan), which is neither a stale reading nor a failure to read.
 */
export function renderFactValue(
  value: string | null | undefined,
  stale: boolean,
  extraClass = "",
): string | null {
  const provenance = factProvenance(value, stale)
  if (provenance === "never" && !stale) return null

  const classes = "detail-value" + (extraClass ? " " + extraClass : "")
  if (provenance === "never") {
    return '<span class="' + classes + ' detail-unknown">' + NEVER_READ_TEXT + "</span>"
  }
  return '<span class="' + classes + '">' + esc(String(value)) + cachedTag(provenance) + "</span>"
}
