/**
 * Which allowance did Anthropic just refuse?
 *
 * An account that has run out keeps reporting healthy percentages: measured on
 * the live fleet, `corp4` rendered `5h 67% / 7d 7%` on /profiles at the same
 * minute its requests were being refused. The cached numbers are a snapshot of
 * the last successful read; a refusal is news that arrives later and never
 * overwrites them. So the refusal has to be recorded and reported on its own
 * terms, next to the cached numbers rather than instead of them.
 *
 * This module answers only the "which bucket, and when does it reset" part.
 * It is a leaf module and every function here is pure - the stores that hold
 * the answers live in profileHealth.ts.
 *
 * Evidence ladder, best source first. The distinction that matters to a reader
 * of the UI is `reported` (Anthropic said so) versus inferred (we worked it
 * out from stale numbers), so every diagnosis carries it explicitly:
 *
 *   1. `sdk_event`     - the SDK's own `rate_limit_event` said `rejected` and
 *                        named `rateLimitType`. Unambiguous.
 *   2. `error_message` - the CLI's prose names the window. Measured live:
 *                        "You've hit your session limit · resets 12:30am
 *                        (America/Chicago)" - that is both the bucket (Claude
 *                        Code calls the 5-hour window a "session") and a real
 *                        reset clock, so it is worth parsing rather than
 *                        discarding.
 *   3. `cached_usage`  - nothing said which, so deduce from the last-read
 *                        windows: whichever is nearest its limit, or, when the
 *                        weekly windows are nowhere near theirs, the 5-hour one
 *                        by elimination.
 *   4. `unknown`       - say so rather than guessing a bucket.
 *
 * There are no `anthropic-ratelimit-*` response headers to read here: Meridian
 * reaches Anthropic through the Claude Agent SDK subprocess, never over HTTP it
 * can see, so `rate_limit_event` IS this proxy's structured form of those
 * headers and tier 1 above is the header check.
 */

/** How the bucket was determined. See the ladder in the module doc. */
export type LimitSource = "sdk_event" | "error_message" | "cached_usage" | "unknown"

export interface LimitDiagnosis {
  /** Anthropic's window key ("five_hour", "seven_day", "seven_day_opus", …),
   *  or null when nothing identified it. */
  bucket: string | null
  /** True when Anthropic named the bucket; false when we deduced it. Drives
   *  the "(guess)" marking in the UI. */
  reported: boolean
  source: LimitSource
  /** Epoch ms the window reopens, when known. */
  resetsAt: number | null
  /** One line explaining the verdict, rendered as the badge's tooltip. */
  rationale: string
}

/**
 * The CLI's qualifier words, mapped to Anthropic's window keys.
 *
 * "session" is the 5-hour window: Claude Code's UI calls it a session, and the
 * live message that prompted this work used exactly that word for a five-hour
 * exhaustion. The unqualified "You've hit your limit" and "usage limit reached"
 * wordings name nothing, so they deliberately have no entry and fall through to
 * inference.
 */
const QUALIFIER_BUCKETS: Record<string, string> = {
  session: "five_hour",
  weekly: "seven_day",
  week: "seven_day",
}

/** Model words that select a per-model weekly bucket when one is named. */
const MODEL_BUCKETS: Record<string, string> = {
  opus: "seven_day_opus",
  sonnet: "seven_day_sonnet",
  fable: "seven_day_fable",
}

/**
 * Up to two qualifier words, so a future "hit your weekly opus limit" is read
 * as the Opus weekly bucket rather than the general one. Deliberately separate
 * from `classifyError`'s own matcher: this one decides WHICH limit, and must be
 * free to change without moving the line between 429 and 500.
 */
const LIMIT_WORDING = /hit your ((?:[\w-]+ ){0,2})limit/i
const RESET_WORDING = /resets\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|midnight|noon)\s*(?:\(([^)]+)\))?/i

export interface ParsedLimitWording {
  bucket: string | null
  /** The qualifier as written, kept for the rationale so an unrecognized one
   *  ("daily", "monthly") still tells the reader what the CLI said. */
  qualifier: string | null
  clock: string | null
  zone: string | null
}

/**
 * Pull the bucket and reset clock out of an SDK error message. Returns nulls
 * for anything it cannot read - this never throws on unfamiliar prose, because
 * the CLI's wording has changed three times already (#764, #787).
 */
export function parseLimitWording(errMsg: string): ParsedLimitWording {
  const wording = LIMIT_WORDING.exec(errMsg)
  const words = (wording?.[1] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)

  let bucket: string | null = null
  const model = words.find(w => MODEL_BUCKETS[w])
  const qualifierWord = words.find(w => QUALIFIER_BUCKETS[w])
  if (model) bucket = MODEL_BUCKETS[model]!
  else if (qualifierWord) bucket = QUALIFIER_BUCKETS[qualifierWord]!

  const reset = RESET_WORDING.exec(errMsg)
  return {
    bucket,
    qualifier: words.length > 0 ? words.join(" ") : null,
    clock: reset?.[1]?.trim() ?? null,
    zone: reset?.[2]?.trim() ?? null,
  }
}

interface WallClock { hour: number; minute: number }

/** "12:30am", "6:40pm", "2pm", "midnight", "noon" - every form observed so far. */
function parseWallClock(raw: string): WallClock | null {
  const s = raw.trim().toLowerCase()
  if (s === "midnight") return { hour: 0, minute: 0 }
  if (s === "noon") return { hour: 12, minute: 0 }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null
  const meridiem = m[3]
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === "am") hour = hour === 12 ? 0 : hour
    else hour = hour === 12 ? 12 : hour + 12
  } else if (hour > 23) return null
  return { hour, minute }
}

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsInZone(ts: number, zone: string): ZoneParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts))
    const read = (type: string) => Number(parts.find(p => p.type === type)?.value)
    const out = {
      year: read("year"), month: read("month"), day: read("day"),
      // Intl emits hour 24 for midnight under hour12:false in some runtimes.
      hour: read("hour") % 24, minute: read("minute"), second: read("second"),
    }
    return Object.values(out).every(Number.isFinite) ? out : null
  } catch {
    // Unrecognized IANA zone. Nothing to resolve; callers fall back to the
    // conservative default rather than inventing a reset time.
    return null
  }
}

/** Offset (ms) to add to a UTC-interpreted wall clock to get the real instant. */
function zoneOffsetMs(ts: number, zone: string): number | null {
  const p = partsInZone(ts, zone)
  if (!p) return null
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000
}

/**
 * Resolve "resets 12:30am (America/Chicago)" to an instant: the next time that
 * wall clock occurs in that zone.
 *
 * The offset is read twice - once at `now`, then again at the candidate - so a
 * reset that lands on the far side of a DST boundary resolves to the right
 * instant rather than being an hour out.
 *
 * Returns null for an unparseable clock or unknown zone. Only ever looks one
 * day ahead, so the result is bounded to ~24h from `now`: the CLI prints a
 * clock time with no date, and a value further out than that would be a
 * misreading, not information.
 */
export function resolveResetClock(clock: string, zone: string | null | undefined, now: number): number | null {
  const wall = parseWallClock(clock)
  if (!wall) return null
  const tz = zone && zone.trim() ? zone.trim() : "UTC"
  const here = partsInZone(now, tz)
  if (!here) return null
  for (const dayAdd of [0, 1]) {
    const asUtc = Date.UTC(here.year, here.month - 1, here.day + dayAdd, wall.hour, wall.minute, 0)
    const firstGuessOffset = zoneOffsetMs(now, tz)
    if (firstGuessOffset === null) return null
    const corrected = zoneOffsetMs(asUtc - firstGuessOffset, tz)
    if (corrected === null) return null
    const instant = asUtc - corrected
    if (instant > now) return instant
  }
  return null
}

/** Utilization at or above which a cached window is treated as the culprit. */
const INFER_HOT = 0.9
/** Below this, a weekly window is "nowhere near its limit" and can be ruled out. */
const INFER_COLD = 0.8
/** A `rejected` SDK event older than this is stale evidence about a fresh refusal. */
const SDK_EVIDENCE_MAX_AGE_MS = 15 * 60_000

export interface SdkLimitEvidence {
  rateLimitType?: string
  status?: string
  utilization?: number | null
  resetsAt?: number | null
  observedAt: number
}

export interface CachedWindow {
  type: string
  utilization: number | null
  resetsAt: number | null
}

export interface DiagnoseLimitInput {
  /** Raw SDK error text, before `classifyError` replaces it with proxy prose. */
  message: string
  now: number
  /** This profile's SDK rate-limit entries (rateLimitStore.getAll). */
  sdkEntries?: readonly SdkLimitEvidence[]
  /** This profile's last-read OAuth usage windows. */
  windows?: readonly CachedWindow[]
}

function windowResetsAt(windows: readonly CachedWindow[] | undefined, bucket: string | null): number | null {
  if (!bucket) return null
  const hit = windows?.find(w => w.type === bucket)
  return hit?.resetsAt ?? null
}

/**
 * Decide which allowance was refused, and say how confident that is.
 *
 * Never throws and always returns a diagnosis - an "unknown" verdict is a
 * useful thing to render ("refusing, cause unknown") and far better than
 * silently attributing the refusal to whichever window happened to look busiest.
 */
export function diagnoseLimit(input: DiagnoseLimitInput): LimitDiagnosis {
  const { message, now, sdkEntries, windows } = input

  const rejected = sdkEntries
    ?.filter(e => e.rateLimitType
      && (e.status === "rejected" || (e.utilization ?? 0) >= 1)
      && now - e.observedAt <= SDK_EVIDENCE_MAX_AGE_MS)
    .sort((a, b) => b.observedAt - a.observedAt)[0]
  if (rejected?.rateLimitType) {
    return {
      bucket: rejected.rateLimitType,
      reported: true,
      source: "sdk_event",
      resetsAt: rejected.resetsAt ?? windowResetsAt(windows, rejected.rateLimitType),
      rationale: `the SDK reported this window rejected`,
    }
  }

  const wording = parseLimitWording(message)
  const clockReset = wording.clock ? resolveResetClock(wording.clock, wording.zone, now) : null
  if (wording.bucket) {
    return {
      bucket: wording.bucket,
      reported: true,
      source: "error_message",
      resetsAt: clockReset ?? windowResetsAt(windows, wording.bucket),
      rationale: `Anthropic named the ${wording.qualifier} limit`,
    }
  }

  const known = (windows ?? []).filter(w => typeof w.utilization === "number")
  if (known.length > 0) {
    const hottest = known.reduce((a, b) => ((b.utilization ?? 0) > (a.utilization ?? 0) ? b : a))
    if ((hottest.utilization ?? 0) >= INFER_HOT) {
      return {
        bucket: hottest.type,
        reported: false,
        source: "cached_usage",
        resetsAt: hottest.resetsAt ?? clockReset,
        rationale: `guessed: ${hottest.type} was at ${Math.round((hottest.utilization ?? 0) * 100)}% when last read`,
      }
    }
    const weeklies = known.filter(w => w.type.startsWith("seven_day"))
    const fiveHour = known.find(w => w.type === "five_hour")
    if (fiveHour && weeklies.length > 0 && weeklies.every(w => (w.utilization ?? 0) < INFER_COLD)) {
      return {
        bucket: "five_hour",
        reported: false,
        source: "cached_usage",
        resetsAt: fiveHour.resetsAt ?? clockReset,
        rationale: `guessed: no weekly window is near its limit, so the 5-hour one is what ran out`,
      }
    }
  }

  return {
    bucket: null,
    reported: false,
    source: "unknown",
    resetsAt: clockReset,
    rationale: wording.qualifier
      ? `Anthropic said "${wording.qualifier} limit", which is not a window we know`
      : `Anthropic refused without naming a window`,
  }
}
