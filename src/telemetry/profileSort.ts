/**
 * View-only ordering for the home page's account cards.
 *
 * Distinct from the `profileOrder` setting, which is durable and decides
 * which account Priority routing drains first. This one answers "show me
 * the ones with capacity" while looking at the page, and is deliberately
 * not persisted anywhere.
 *
 * Mirrored by the inline browser script in landing.ts, the same house
 * pattern profileUsage.ts uses: the page is one template literal that runs
 * in the browser and cannot import at runtime, so this TS module is the
 * tested source of truth (profile-sort.test.ts).
 */

export type ProfileSortMode = "configured" | "spent-desc" | "spent-asc"

export const DEFAULT_PROFILE_SORT: ProfileSortMode = "configured"

/** Rendered as the control, in this order. `id` is what the comparator takes. */
export const PROFILE_SORT_MODES: ReadonlyArray<{ id: ProfileSortMode; label: string; title: string }> = [
  { id: "configured", label: "Order", title: "The order profiles are configured in" },
  { id: "spent-desc", label: "Most spent", title: "Closest to running out first" },
  { id: "spent-asc", label: "Least spent", title: "Most capacity left first" },
]

export function parseProfileSortMode(raw: string | null | undefined): ProfileSortMode {
  return PROFILE_SORT_MODES.some((m) => m.id === raw) ? (raw as ProfileSortMode) : DEFAULT_PROFILE_SORT
}

/**
 * Order `items` for display. `spentOf` returns 0..1 for a profile, or null
 * when nothing is known about it.
 *
 * A profile with no reading sorts last in BOTH directions. Null is absence
 * of evidence, not a low number — sorting it to the front of "least spent"
 * would recommend the one account we cannot vouch for.
 *
 * Ties and the "configured" mode keep the incoming order, which is the
 * order the profiles are configured in.
 */
export function sortProfilesForView<T>(
  items: readonly T[],
  mode: ProfileSortMode,
  spentOf: (item: T) => number | null,
): T[] {
  const list = items.slice()
  if (mode === "configured") return list
  const direction = mode === "spent-desc" ? -1 : 1
  return list
    .map((item, index) => ({ item, index, spent: spentOf(item) }))
    .sort((a, b) => {
      if (a.spent == null || b.spent == null) {
        if (a.spent == null && b.spent == null) return a.index - b.index
        return a.spent == null ? 1 : -1
      }
      if (a.spent !== b.spent) return (a.spent - b.spent) * direction
      return a.index - b.index
    })
    .map((entry) => entry.item)
}
