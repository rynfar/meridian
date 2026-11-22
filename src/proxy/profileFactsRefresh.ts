/**
 * What a profile's card should say between a finished sign-in and the facts
 * that sign-in changed.
 *
 * A login writes a credential in milliseconds, but who it signed in as (email,
 * organization, account), its plan and its usage are separate reads that land
 * seconds later. Until they do, the card holds the PREVIOUS login's facts in
 * the exact shape of current ones - after a sign-in into the wrong account it
 * goes on naming the right one - and nothing on it says the numbers are about
 * to change. This is the state that lets it say so: `updating` from the
 * moment the login is saved until those reads finish, then gone; `failed`
 * with the reason when they did not, kept a few minutes so the page sees it.
 *
 * Leaf module - no imports from server.ts.
 */

export type ProfileFactsRefreshView =
  | { state: "updating"; since: number }
  | { state: "failed"; since: number; at: number; error: string }

/** How long a failed refresh stays readable; the page polls every few seconds. */
export const FACTS_REFRESH_FAILURE_TTL_MS = 5 * 60_000

interface Entry {
  run: number
  view: ProfileFactsRefreshView
}

export class ProfileFactsRefresh {
  private readonly entries = new Map<string, Entry>()
  private runs = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly failureTtlMs: number = FACTS_REFRESH_FAILURE_TTL_MS,
  ) {}

  /**
   * Mark the profile `updating` NOW, synchronously, then run the reads. The
   * mark lands before the caller answers the sign-in, so a page that learns of
   * the login can never read the profile before it says it is updating. A
   * second login while one is running supersedes it: the older run's outcome
   * is dropped.
   */
  run(profileId: string, work: () => Promise<void>): Promise<void> {
    const run = ++this.runs
    const since = this.now()
    this.entries.set(profileId, { run, view: { state: "updating", since } })
    return (async () => {
      try {
        await work()
        if (this.entries.get(profileId)?.run === run) this.entries.delete(profileId)
      } catch (err) {
        if (this.entries.get(profileId)?.run !== run) return
        const error = err instanceof Error ? err.message : String(err)
        this.entries.set(profileId, { run, view: { state: "failed", since, at: this.now(), error } })
      }
    })()
  }

  view(profileId: string): ProfileFactsRefreshView | null {
    const entry = this.entries.get(profileId)
    if (!entry) return null
    if (entry.view.state === "failed" && this.now() - entry.view.at >= this.failureTtlMs) {
      this.entries.delete(profileId)
      return null
    }
    return entry.view
  }

  forget(profileId: string): void {
    this.entries.delete(profileId)
  }
}
