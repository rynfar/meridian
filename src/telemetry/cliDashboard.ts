/**
 * The landing page (`GET /`), rendered for a terminal.
 *
 * `meridian status` prints this, and so does `meridian` when the port it
 * wanted is already serving Meridian — asking what is running is not an
 * error, so the answer is the dashboard rather than a diagnostic.
 *
 * It is the *same page*: the same values, under the same conditions, with
 * the same colour meanings as `src/telemetry/landing.ts`. When editing,
 * read that file first — every value here exists there, and nothing here
 * exists that does not. Two consequences worth stating, because both look
 * like omissions:
 *
 *  - Browser-only affordances are dropped, not translated. The "Click to
 *    activate" hint and the nav links are chrome, not facts; the pace
 *    `title=` tooltip is shown on hover, which a terminal has no analogue
 *    for. The visible facts they decorate are all still here.
 *  - `/v1/usage/quota/all` reports `error: "no_token"` for a profile whose
 *    credentials are missing, and the page does not read that field — such
 *    a profile has no windows, so it renders "no usage data yet". This
 *    prints the same thing rather than inventing an error line.
 *
 * Pure by construction: it takes the four payloads the page fetches and
 * returns a string. Colour is a caller-supplied flag, so piped output can
 * be checked for the absence of escape bytes, and there is no `process`
 * access to make it environment-dependent.
 *
 * Not printing credentials falls out of the same rule. Profile records
 * carry `email`, and profiles.json can carry `apiKey`; the page renders
 * neither for a configured profile, so neither is read here.
 */

import {
  WINDOW_LABELS,
  classifyUtilization,
  computeWeeklyPace,
  formatResetCountdown,
  type WeeklyPace,
} from "./profileUsage"

// --- palette ---------------------------------------------------------------

/**
 * The page's colours, mapped once.
 *
 * Keys name the CSS custom properties in `themeCss`
 * (src/telemetry/profileBar.ts) and the comment carries the hex those
 * properties hold, so a theme change is a one-line update here rather
 * than a hunt through the renderer. Values are xterm-256 indices — the
 * nearest cube (or greyscale) entry to the hex. 256 rather than truecolor
 * because every colour terminal renders it, and at these sizes the
 * difference is invisible.
 */
const PALETTE = {
  green: 71, //  --green   #3fb950
  yellow: 178, // --yellow  #d29922
  red: 203, //   --red     #f85149
  muted: 246, //  --muted   #8b949e
  accent: 75, //  --accent  #58a6ff
} as const

export type PaletteColor = keyof typeof PALETTE

type Paint = (text: string, color: PaletteColor) => string

const colorPaint: Paint = (text, color) => `\x1b[38;5;${PALETTE[color]}m${text}\x1b[0m`
const plainPaint: Paint = (text) => text

// --- payloads --------------------------------------------------------------
//
// Every field is optional: these describe what the page *reads*, not what a
// current server guarantees. An older instance, or one that answered only
// some of the four requests, is a normal outcome — see `unavailable`.

export interface HealthPayload {
  status?: string
  auth?: { loggedIn?: boolean; email?: string | null; subscriptionType?: string | null }
  mode?: string
}

export interface UsageWindow {
  type?: string
  utilization?: number | null
  resetsAt?: number | null
}

export interface QuotaPayload {
  profiles?: {
    id?: string
    profile?: string
    windows?: UsageWindow[]
    /**
     * `"no_token"` / `"not_oauth"`. Declared, and deliberately not read:
     * the page ignores it, and such a profile arrives with no windows, so
     * it renders "no usage data yet" like any other account with nothing
     * to report. Reading it here would put a state on the terminal that
     * the browser never shows.
     */
    error?: string | null
  }[]
}

export interface ProfileListPayload {
  profiles?: { id?: string; type?: string; isActive?: boolean }[]
  routing?: string
  profileOrder?: string[]
  exhausted?: { id?: string; until?: number }[]
}

export interface SummaryPayload {
  totalRequests?: number
  errorCount?: number
  envelopeViolationCount?: number
  totalDuration?: { p50?: number; p95?: number }
  tokenUsage?: {
    totalInputTokens?: number
    totalOutputTokens?: number
    avgCacheHitRate?: number | null
  }
  costEstimate?: {
    totalUsd?: number
    byProfile?: Record<string, { requests?: number; estimatedUsd?: number }>
  }
}

/** The four payloads, plus why any of them is missing. */
export interface DashboardSnapshot {
  health: HealthPayload | null
  profileList: ProfileListPayload | null
  quota: QuotaPayload | null
  summary: SummaryPayload | null
  /**
   * Reason a source could not be read, keyed by the section it feeds.
   * Rendered as an explicit note, so an unreadable endpoint never reads
   * as a fleet with no accounts or a day with no traffic.
   */
  unavailable?: Partial<Record<"accounts" | "traffic", string>>
}

export interface CliDashboardInput extends DashboardSnapshot {
  host: string
  port: number
  /** Injectable for tests; production callers omit it. */
  now?: number
}

export interface CliDashboardOptions {
  /** Emit ANSI colour. Callers pass `process.stdout.isTTY === true`. */
  color?: boolean
}

// --- formatting (mirrors landing.ts) ---------------------------------------

/** What the page prints when it has no value: `usd(null)`, `ms(0)`, `tokens(null)`. */
const UNKNOWN = "—"

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/** `usd()` in landing.ts. Locale pinned so the output does not move with $LANG. */
function usd(v: number | null | undefined): string {
  if (!isNum(v)) return UNKNOWN
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`
  if (v < 100) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

/** `tokens()` in landing.ts. */
function tokens(v: number | null | undefined): string {
  if (!isNum(v)) return UNKNOWN
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(v)
}

/** `ms()` in landing.ts — 0 is "no data", not "instant". */
function millis(v: number | null | undefined): string {
  if (!isNum(v) || v === 0) return UNKNOWN
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`
}

/**
 * `winLabel()` in landing.ts. The known map is shared with the profile page;
 * the fallback is the page's, which shortens an unnamed `seven_day_*` to
 * "7d *" — profileUsage.ts's `labelForWindow` spells out "Seven Day" instead,
 * and the point here is to match what the browser shows.
 */
function windowLabel(type: string): string {
  const known = WINDOW_LABELS[type]
  if (known) return known
  return type
    .replace(/^seven_day_/, "7d ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** `utilColor()` in landing.ts, via the tested three-tier classifier. */
function utilizationColor(utilization: number): PaletteColor {
  const status = classifyUtilization(utilization)
  return status === "high" ? "red" : status === "warn" ? "yellow" : "green"
}

type PaceStatus = WeeklyPace["status"] | "over"

/**
 * landing.ts promotes any pace whose projection reaches the cap to "over":
 * "on track to run out" outranks merely being ahead of an even pace.
 * `computeWeeklyPace` deliberately stops short of that judgement, so the
 * promotion lives with the presentation, here and in the page.
 */
function paceStatus(pace: WeeklyPace): PaceStatus {
  return pace.projectedPct != null && pace.projectedPct >= 100 ? "over" : pace.status
}

function paceColor(status: PaceStatus): PaletteColor {
  return status === "over" ? "red" : status === "ahead" ? "yellow" : "green"
}

// --- bars ------------------------------------------------------------------

const BAR_WIDTH = 28
const BAR_FILL = "█"
const BAR_TRACK = "░"
/** The pace row's tick: where even consumption would have reached by now. */
const BAR_MARKER = "┃"

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct))
}

/**
 * One usage bar. `markerPct`, when given, overlays a tick at that position
 * — the `.pace-marker` element on the page. Cells are grouped into runs
 * before painting so a coloured bar costs two escape sequences, not 28.
 */
function renderBar(pct: number, color: PaletteColor, paint: Paint, markerPct?: number): string {
  const filled = Math.round((clampPct(pct) / 100) * BAR_WIDTH)
  const marker =
    markerPct == null ? -1 : Math.min(Math.round((clampPct(markerPct) / 100) * BAR_WIDTH), BAR_WIDTH - 1)

  type Role = "fill" | "track" | "marker"
  const cells: { ch: string; role: Role }[] = []
  for (let i = 0; i < BAR_WIDTH; i++) {
    if (i === marker) cells.push({ ch: BAR_MARKER, role: "marker" })
    else if (i < filled) cells.push({ ch: BAR_FILL, role: "fill" })
    else cells.push({ ch: BAR_TRACK, role: "track" })
  }

  let out = ""
  let i = 0
  while (i < cells.length) {
    const role = cells[i]!.role
    let run = ""
    while (i < cells.length && cells[i]!.role === role) {
      run += cells[i]!.ch
      i++
    }
    // The marker is the page's neutral tick (--text at reduced opacity):
    // left unpainted so it reads against both the fill and the track.
    out += role === "fill" ? paint(run, color) : role === "track" ? paint(run, "muted") : run
  }
  return out
}

// --- the model the renderer lays out ---------------------------------------

interface UsageRow {
  label: string
  /** Bar fill, 0..n (clamped when drawn — utilization can exceed 100%). */
  pct: number
  /** Right-aligned figure: "38%" for a window, "+12%" for pace. */
  figure: string
  color: PaletteColor
  /** Reset countdown, or the pace projection. */
  note: string
  markerPct?: number
}

interface Badge {
  text: string
  color?: PaletteColor
}

interface AccountBlock {
  label: string
  isActive: boolean
  badges: Badge[]
  cost: string
  sub: string
  rows: UsageRow[]
}

/**
 * Which accounts to show, and what each one says — `profileSection()` in
 * landing.ts, with its two modes preserved: configured profiles render
 * exactly as configured, and a single-account install falls back to the
 * quota/cost keys labelled with the logged-in email.
 */
function buildAccounts(input: CliDashboardInput, now: number): AccountBlock[] {
  const byProfile = input.summary?.costEstimate?.byProfile ?? {}

  const quotaByProfile: Record<string, UsageWindow[]> = {}
  for (const entry of input.quota?.profiles ?? []) {
    quotaByProfile[entry.id || entry.profile || "default"] = entry.windows ?? []
  }

  const configured = input.profileList?.profiles ?? []

  interface Candidate {
    id: string
    label: string
    isActive: boolean
    configured: boolean
  }
  const candidates: Candidate[] = []

  if (configured.length > 0) {
    // Real profiles exist: show exactly those. Traffic that predates
    // per-profile attribution (the synthetic "default" bucket) still counts
    // in the totals below but does not render as an account that isn't there.
    for (const p of configured) {
      const id = p.id ?? "default"
      candidates.push({ id, label: id, isActive: p.isActive === true, configured: true })
    }
  } else {
    const auth = input.health?.auth
    const email = (auth?.loggedIn && auth.email) || ""
    const seen = new Set<string>()
    for (const key of [...Object.keys(quotaByProfile), ...Object.keys(byProfile)]) {
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        id: key,
        label: key === "default" ? email || "account" : key,
        isActive: false,
        configured: false,
      })
    }
  }

  const isPriority = input.profileList?.routing === "priority"
  const blocks: AccountBlock[] = []

  for (const candidate of candidates) {
    const cost = byProfile[candidate.id]
    const windows = (quotaByProfile[candidate.id] ?? []).filter((w) => w.utilization != null)
    if (!candidate.configured && windows.length === 0 && !cost) continue

    const rows: UsageRow[] = []
    for (const w of windows) {
      const utilization = w.utilization
      if (!isNum(utilization)) continue
      rows.push({
        label: windowLabel(w.type ?? ""),
        pct: Math.round(utilization * 100),
        figure: `${Math.round(utilization * 100)}%`,
        color: utilizationColor(utilization),
        note: formatResetCountdown(w.resetsAt, now),
      })
    }

    // The pace row reads the 7-day window; landing.ts takes the last match.
    let weekly: UsageWindow | undefined
    for (const w of windows) if (w.type === "seven_day") weekly = w
    const pace = weekly ? computeWeeklyPace(weekly.utilization, weekly.resetsAt, now) : null
    if (pace) {
      const status = paceStatus(pace)
      const projected = pace.projectedPct
      const figure =
        status === "over"
          ? projected != null
            ? `${projected}%`
            : "100%"
          : `${pace.deltaPct >= 0 ? "+" : "-"}${Math.abs(pace.deltaPct)}%`
      rows.push({
        label: "pace",
        pct: pace.actualPct,
        markerPct: pace.expectedPct,
        figure,
        color: paceColor(status),
        note:
          status === "over"
            ? "runs out before reset"
            : projected != null
              ? `~${projected}% by reset`
              : "",
      })
    }

    const badges: Badge[] = []
    if (isPriority) {
      const order = input.profileList?.profileOrder ?? []
      const idx = order.indexOf(candidate.id)
      if (idx >= 0) badges.push({ text: `#${idx + 1} in pool`, color: "muted" })
      const exhausted = (input.profileList?.exhausted ?? []).find((e) => e.id === candidate.id)
      if (exhausted) {
        badges.push({
          text: `exhausted · resets ${formatResetCountdown(exhausted.until, now)}`,
          color: "red",
        })
      }
    } else if (candidate.isActive) {
      // `.active-pill` — the one badge the page shows in the default mode.
      // Its sibling, the "Click to activate" hover hint, is a browser
      // affordance and has no terminal equivalent, so it is dropped.
      badges.push({ text: "ACTIVE", color: "accent" })
    }

    const requests = cost?.requests
    blocks.push({
      label: candidate.label,
      isActive: candidate.isActive,
      badges,
      cost: usd(cost ? cost.estimatedUsd : 0),
      sub: isNum(requests)
        ? `${requests} request${requests === 1 ? "" : "s"} · est. API value · 24h`
        : "no traffic · 24h",
      rows,
    })
  }

  return blocks
}

// --- the 24h strip ---------------------------------------------------------

interface StripItem {
  label: string
  value: string
  valueColor?: PaletteColor
  detail: string
  detailColor?: PaletteColor
}

/** `render()`'s `items` array in landing.ts, in the same order. */
function buildStrip(summary: SummaryPayload): StripItem[] {
  const tu = summary.tokenUsage ?? {}
  const hitRate = tu.avgCacheHitRate
  const errors = summary.errorCount

  const items: StripItem[] = [
    {
      // The big number is the TOTAL and is never error-coloured; the error
      // signal lives on the detail line, exactly as on the page.
      label: "Requests",
      value: isNum(summary.totalRequests) ? String(summary.totalRequests) : UNKNOWN,
      detail: !isNum(errors) ? UNKNOWN : errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "no errors",
      detailColor: isNum(errors) && errors > 0 ? "red" : undefined,
    },
    {
      label: "Tokens Out",
      value: tokens(tu.totalOutputTokens),
      detail: `${tokens(tu.totalInputTokens)} in`,
    },
    {
      label: "Cache Hit",
      value: isNum(hitRate) ? `${Math.round(hitRate * 100)}%` : UNKNOWN,
      valueColor: isNum(hitRate) && hitRate >= 0.5 ? "green" : undefined,
      detail: "prompt cache",
    },
    {
      label: "Est. API Value",
      value: usd(summary.costEstimate?.totalUsd),
      detail: "list prices",
    },
    {
      label: "Median Response",
      value: millis(summary.totalDuration?.p50),
      detail: `p95 ${millis(summary.totalDuration?.p95)}`,
    },
  ]

  const violations = summary.envelopeViolationCount
  if (isNum(violations) && violations > 0) {
    items.push({
      label: "Envelope",
      value: String(violations),
      valueColor: "red",
      detail: "wire-contract violations",
      detailColor: "red",
    })
  }

  return items
}

// --- header ----------------------------------------------------------------

/** The header's status pill: `loadHeader()` in profileBar.ts. */
function healthPill(health: HealthPayload | null): { label: string; color: PaletteColor } {
  const status = health?.status
  if (status === "healthy") return { label: "Operational", color: "green" }
  if (status === "degraded") return { label: "Degraded", color: "yellow" }
  return { label: "Offline", color: "red" }
}

/** The header's profile chip: the active profile's id and type, or nothing. */
function activeProfileChip(profileList: ProfileListPayload | null): string | null {
  const active = (profileList?.profiles ?? []).find((p) => p.isActive === true)
  if (!active?.id) return null
  return active.type ? `${active.id} ${active.type}` : active.id
}

// --- renderer --------------------------------------------------------------

const INDENT = "  "

/**
 * Render the dashboard.
 *
 * Returns a newline-terminated block. With `color: false` the result
 * contains no escape bytes at all, which is what piped output gets.
 */
export function renderCliDashboard(input: CliDashboardInput, options: CliDashboardOptions = {}): string {
  const paint = options.color ? colorPaint : plainPaint
  const bold = options.color ? (t: string) => `\x1b[1m${t}\x1b[22m` : (t: string) => t
  const now = input.now ?? Date.now()
  const out: string[] = []

  // Header — brand, health pill, active profile.
  const pill = healthPill(input.health)
  const chip = activeProfileChip(input.profileList)
  out.push(
    `${bold("MERIDIAN")}  ${paint("●", pill.color)} ${pill.label}` +
      (chip ? `  ${paint("·", "muted")}  ${chip}` : ""),
  )
  out.push("")

  // Intro — the endpoint agents point at, then the page's meta line.
  out.push(`${INDENT}ANTHROPIC_BASE_URL=http://${input.host}:${input.port}`)
  const meta: string[] = []
  const auth = input.health?.auth
  if (auth?.loggedIn) {
    meta.push(`${auth.email ?? ""}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ""}`)
  }
  meta.push(input.health?.mode ?? "internal")
  meta.push(`port ${input.port}`)
  out.push(`${INDENT}${paint(meta.join(" · "), "muted")}`)
  out.push("")

  // Accounts.
  const accounts = buildAccounts(input, now)
  const accountsNote = input.unavailable?.accounts
  if (accounts.length > 0 || accountsNote) {
    out.push(paint(accounts.length === 1 ? "ACCOUNT" : "ACCOUNTS", "muted"))
    out.push("")
    if (accountsNote) {
      out.push(`${INDENT}${paint(accountsNote, "yellow")}`)
      out.push("")
    }

    // Column widths are computed across the whole fleet, not per account, so
    // the percentages line up down the page and can be compared by eye.
    const allRows = accounts.flatMap((a) => a.rows)
    const labelWidth = Math.max(0, ...allRows.map((r) => r.label.length))
    const figureWidth = Math.max(0, ...allRows.map((r) => r.figure.length))
    // Where the cost sits: the right edge of the figure column.
    const costColumn = INDENT.length + 2 + labelWidth + 2 + BAR_WIDTH + 2 + figureWidth

    for (const account of accounts) {
      const dot = paint("●", account.isActive ? "accent" : "muted")
      const badges = account.badges.map((b) => (b.color ? paint(b.text, b.color) : b.text)).join("  ")
      const headLeft = `${account.label}${badges ? `  ${badges}` : ""}`
      // Pad on the plain text; the painted string carries invisible bytes.
      const headLeftPlain =
        account.label + (account.badges.length > 0 ? `  ${account.badges.map((b) => b.text).join("  ")}` : "")
      const gap = Math.max(1, costColumn - INDENT.length - 2 - headLeftPlain.length - account.cost.length)
      out.push(`${INDENT}${dot} ${headLeft}${" ".repeat(gap)}${bold(account.cost)}`)
      out.push(`${INDENT}  ${paint(account.sub, "muted")}`)

      if (account.rows.length === 0) {
        out.push(`${INDENT}  ${paint("no usage data yet", "muted")}`)
      }
      for (const row of account.rows) {
        const label = row.label.padEnd(labelWidth)
        const bar = renderBar(row.pct, row.color, paint, row.markerPct)
        const figure = row.figure.padStart(figureWidth)
        const note = row.note ? `  ${paint(row.note, "muted")}` : ""
        out.push(`${INDENT}  ${paint(label, "muted")}  ${bar}  ${paint(figure, row.color)}${note}`)
      }
      out.push("")
    }
  }

  // Last 24 hours.
  const trafficNote = input.unavailable?.traffic
  out.push(paint("LAST 24 HOURS", "muted"))
  out.push("")
  if (trafficNote) {
    out.push(`${INDENT}${paint(trafficNote, "yellow")}`)
  } else {
    const items = buildStrip(input.summary ?? {})
    const labelWidth = Math.max(...items.map((i) => i.label.length))
    const valueWidth = Math.max(...items.map((i) => i.value.length))
    for (const item of items) {
      const label = paint(item.label.padEnd(labelWidth), "muted")
      const valuePlain = item.value.padStart(valueWidth)
      const value = item.valueColor ? paint(valuePlain, item.valueColor) : valuePlain
      const detail = item.detailColor ? paint(item.detail, item.detailColor) : paint(item.detail, "muted")
      out.push(`${INDENT}${label}  ${value}  ${detail}`)
    }
  }

  return `${out.join("\n")}\n`
}
