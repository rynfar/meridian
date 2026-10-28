---
id: design-language
type: architecture-design
title: Meridian design language (web UI, desktop, brand)
status: active
parent: architecture
---

# DESIGN.md — The Meridian Design Language

The single source of truth for how Meridian looks and feels — the web UI
(landing, telemetry, profiles, settings, plugins), the brand assets, and the
README visuals. If you are building or changing any user-facing surface,
follow this document. When this document and existing code disagree, this
document wins; fix the code.

**Implementation anchor:** all color tokens and shared chrome live in
[`src/telemetry/profileBar.ts`](src/telemetry/profileBar.ts) (`themeCss`,
`profileBarCss`, `profileBarHtml`, `profileBarJs`, `meridianLogoSvg`).
Every page prepends `themeCss` and embeds the shared header. There is no
build step for the UI — pages are self-contained template strings.

---

## 1. Brand

**The mark** is a wireframe globe whose prime meridian runs the brand
gradient from blue (north pole) to violet (south pole), with a solid node
pinned at each pole: blue on top, violet on bottom. A faded equator line
crosses the middle. One mark, every size — header, favicon, banner, README.

**The gradient** is the heart of the identity:

```
linearGradient (vertical): #58a6ff → #bc8cff
```

**Wordmark:** `MERIDIAN`, uppercase, weight 700, generous letter-spacing
(2px at header size, 10px at banner size), in `--text`.

**Tagline:** “Claude & Antigravity, in your tools.”

**Asset inventory** (change the mark → update ALL of these together):

| Asset | Use |
|---|---|
| `src/telemetry/profileBar.ts` → `meridianLogoSvg` | Site header (canonical copy of the mark) |
| `assets/logo.svg` | 512px standalone mark |
| `assets/icon.svg` | 64px app icon (mark on `--bg` rounded square with `--border` ring) |
| `assets/banner.svg` | README hero (backsplash + mark + wordmark + tagline) |
| `assets/how-it-works.svg` | README architecture diagram (same palette) |
| `assets/*-512.png` | PNG exports of the SVGs for external use — regenerate after any SVG change |

## 2. Color

Tokens are defined once in `themeCss` and referenced everywhere as CSS
variables. **Never hardcode hex colors in page CSS** — the only files
allowed to contain color literals are `profileBar.ts` (the token block +
logo) and the brand SVGs in `assets/`.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0d1117` | Page base (under the backsplash) |
| `--surface` | `#161b22` | Cards, panels, tables |
| `--surface2` | `#1c2128` | Nested surfaces: inputs, bars, pills, hover fills |
| `--border` | `#30363d` | Every hairline. One border color, everywhere |
| `--text` | `#e6edf3` | Primary text |
| `--muted` | `#8b949e` | Secondary text, labels, empty states |
| `--accent` | `#58a6ff` | **Blue — interactive & active** |
| `--accent2` | `#bc8cff` | **Violet — brand secondary & literal** |
| `--green` | `#3fb950` | Healthy, success, low utilization |
| `--yellow` | `#d29922` | Warning, medium utilization |
| `--red` | `#f85149` | Error, violation, high utilization |

Legacy aliases (same values, kept for the telemetry dashboard’s semantic
naming): `--violet`/`--purple` = `--accent2`, `--lavender #d2a8ff`,
`--blue` = `--accent`, plus waterfall phases `--queue` (yellow), `--ttfb`
(blue), `--upstream` (green). Prefer `--accent`/`--accent2` in new code.

### Blue vs. violet — the deciding rule

Meridian is deliberately **two-tone**: blue and violet appear together only
in the brand gradient. Everywhere else, each has a fixed job:

- **Blue (`--accent`)** = *you can click it, or it is the active thing.*
  Links, nav highlight, buttons, focus rings, active tab underline, section
  emphasis. The one exception is the active *account* card, whose border and
  pill are its provider's brand (see Provider brands below).
- **Violet (`--accent2`)** = *literal or meta, never interactive.*
  Inline code / command snippets, mono identifiers, and the telemetry
  dashboard’s session-lineage & meta annotations (e.g. the `undo` lineage
  badge, request-source tags, deferred-tool notes).

Never use violet for an interactive state, and never use blue for code.

### Tinted fills

Translucent fills are derived from the tokens’ RGB values — use exactly
these bases: blue `rgba(88,166,255,α)`, violet `rgba(188,140,255,α)`,
green `rgba(63,185,80,α)`, yellow `rgba(210,153,34,α)`, red
`rgba(248,81,73,α)`. Keep α ≤ 0.18 for backgrounds, ≤ 0.4 for borders.

### Utilization / status thresholds

Usage bars and percentage readouts color by value: `< 60%` green,
`≥ 60%` yellow, `≥ 85%` red. Health dot: healthy green (with soft glow),
degraded yellow, offline red. With the opt-in `showHostname` setting the pill
names the machine after its status (`Operational · nwkr-desktop`), first DNS
label only with the full name on hover; at phone width the name stays,
ellipsized, and keeps its separator only where the status text stays too.
When native Claude traffic from this instance reports definite connection failures,
the health pill becomes a red tinted pill ("Claude connection failed") and a
yellow one ("Rechecking Claude connection") while traffic is let back in.
Details identify this instance's configured Claude egress and are available
on hover across the trigger, gap and panel or native-button activation;
Escape or blur dismisses them. The button's accessible name always includes
the current status and any displayed opt-in hostname, including at phone width.
Both keep their text at phone width, where the plain status shows only its dot.
Draining and offline status retain precedence; combined instances name Claude
explicitly and do not imply Antigravity is unavailable. Existing hostname and
provenance composition remains shared across pages.

### Provider brands

Account cards on `/` and `/profiles` show which provider an account belongs
to, and which account is active for each provider, in that provider's brand.
Brand colours appear on account cards and their provider chips and headings,
nowhere else.

| Token | Value | Use |
|---|---|---|
| `--claude` | `#c15f3c` | Claude accounts |
| `--chatgpt` | `#74aa9c` | ChatGPT seats |

Each has `-bright` (the brand mixed 30% toward white: hover, badge and pill
text) and `-rgb` (tinted fills). A card's `.provider-<id>` class
(`profileProviders.ts`) points `--brand`, `--brand-bright` and `--brand-rgb`
at its provider, so card CSS never names one.

- **Every card:** a brand stripe on its left edge and a brand badge naming
  the provider.
- **Active:** brand border + 1px brand ring, brand dot and brand Active pill.
  There is one per provider.
- **Switchable on hover:** `-bright` border with a faint brand fill.
- **Spent or failing:** shown by dimming and the existing badges. The active
  border is never recoloured or faded, and the active card's name row, with
  its Active pill and spent badge, never dims. Only its figures do.
- **Needs a login:** a red border, the same for every provider, and a
  needs-login badge. An active card keeps its brand ring outside the red.
- **Controls stay blue:** buttons, links, focus rings, drag handles and drop
  targets.

ChatGPT's brand is its green-grey, not its violet `#ab68ff`. The violet shares
`--accent2`'s hue (ΔE2000 9), and its brighter tint is `--accent2` itself.
The web UI is dark-only. A light theme would need `#4a8a7a` for ChatGPT
(4.0:1 on white), because `#74aa9c` there is 2.6:1.

## 3. The backsplash

Every page body carries the banner’s gentle wash — defined once in
`themeCss`, so **pages must not set their own `body` background**:

```css
body {
  background:
    radial-gradient(1200px 800px at 12% -8%, rgba(88,166,255,0.07), transparent 60%),
    radial-gradient(1100px 800px at 92% 108%, rgba(188,140,255,0.06), transparent 60%),
    linear-gradient(135deg, #0d1117 0%, #10151d 55%, #161b22 100%);
  background-attachment: fixed;
}
```

Blue glow top-left, violet glow bottom-right — the same diagonal story as
the banner. Keep it subtle; if a screenshot makes the glow obvious, it’s
too strong.

## 4. Page skeleton & chrome

Every HTML page is assembled the same way:

1. `themeCss` (tokens + backsplash)
2. Page-specific CSS (tokens only, no literals)
3. `profileBarCss` + `profileBarHtml` — the **shared site header**
4. Page content in a `.container` (max-width 960px; the telemetry
   dashboard uses full-width padding instead)
5. `profileBarJs` appended to the page script

**Wide layout.** The `layout` setting (Settings → Layout) serves every page
with `data-layout="wide"` on `<html>`. The shared rule in `profileBarCss`
then lifts the `.container` max-width and pads it and the header with
`--page-gutter` (`clamp(16px, 3vw, 48px)`). A page that lays out cards or
label/value rows adds its own `html[data-layout="wide"]` rule so a value
never ends up a screen away from its label: the home page keeps its card size
and adds columns, `/profiles` shows larger cards side by side, Settings rows
add columns at a width that holds a long select beside its label (at least
560px, against about 400px in two contained columns), and Providers keeps
cards about as wide as when contained. The content wrapper must be
`.container` for any of this to reach it. A contained page carries no
attribute, so it renders as before.

**The header owns the brand.** It shows the mark + wordmark (links home),
the site nav (Home · Providers · Telemetry · Profiles · Settings · Plugins), the
active-profile chip, the live health pill, the running version to its right,
and — when the update check is on and a newer release exists — a blue
update badge after that. Consequences:

- Page `<h1>` is the *page name* (“Telemetry”, “Profiles”) — never
  “Meridian”, never a logo. Subtitle below it: 13–14px `--muted`.
- No “back to home” links, no footer nav duplicating the header.
- Status lives in the header pill; pages don’t render status banners.

**Profile switching** happens where the accounts are visible: click an
account card on the home page (or the Profiles page). The header chip only
*shows* the active profile. After any state mutation, call
`window.meridianHeaderRefresh()` so the chip updates immediately.

## 5. Typography & numbers

- **UI stack:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`
- **Mono stack:** `'SF Mono', SFMono-Regular, Consolas, monospace` — for
  code, commands, model ids, session ids, and any tabular figures
- Metrics always set `font-variant-numeric: tabular-nums`
- **Micro-labels** (section titles, card labels): 10–12px, uppercase,
  `letter-spacing: 0.5–1px`, `--muted`, weight 500–600
- Stat sizes: strip value 20px/700 · card cost 22px/700 · dashboard card 28px/600

## 6. Component vocabulary

- **Card:** `--surface`, 1px `--border`, radius 12px, padding 16–20px.
  Active account card: its provider's brand border + 1px brand ring.
  Clickable cards get `cursor: pointer` and a hover border (the brighter
  provider brand on an account card), plus a hover-revealed uppercase hint
  (e.g. “Click to activate”).
- **Stats strip:** one flex row of cells separated by 1px `--border`
  dividers inside a single card — label (micro-label), value (20px/700),
  optional muted detail line. Use instead of a grid of chunky cards.
- **Pills:** radius 10–20px, tinted fill + tinted border of the same hue
  (e.g. the update chip: blue text on `rgba(88,166,255,0.12)` with
  `rgba(88,166,255,0.35)` border; an account's Active pill does the same in
  its provider's brand). Status badges: green/muted/red variants.
- **Usage bar:** 6–8px track in `--surface2`, radius 3–4px, fill colored
  by the utilization thresholds; percentage readout matches the fill color.
- **Buttons:** `--surface2` fill, accent text + accent border; hover =
  blue tint fill. No solid-filled primary buttons.
- **Tabs:** muted text, active = accent text + 2px accent underline.
- **Tables:** inside a `--surface` card; uppercase micro-label headers on
  `--bg`; row hover = faint blue tint.
- **Inline code chip:** mono, `--surface`/`--bg` fill, 1px border, radius
  4–5px, **violet text** (`--accent2`).
- **Empty states:** calm centered `--muted` text in a card — never red.
- **Header build badge:** a current npm install shows nothing; an
  outdated one shows the blue update chip linking to releases. A local or
  dev build shows one violet metadata pill (release · build number or
  "source run" · branch · short commit · dirty) on a single line, with the
  branch ellipsized first and full values in the tooltip. Branch and commit
  are blue links only when the backend supplies a credential-free HTTPS URL;
  otherwise they stay violet text. Unknown fields are omitted. Drift is a
  separate chip: muted for current or unknown states, yellow only for real
  drift ("3 builds behind", "rolled back", "source changed"). A failed
  drift refresh shows "drift unknown" and never changes the health pill.

## 7. Principles

1. **Signal over filler.** Zero is boring — render it calmly (“no errors”)
   and reserve red/yellow for non-zero problems. Conditional cells
   (envelope violations, errors) appear only when there’s something to say.
2. **One purpose per page.** Home = orientation + accounts + at-a-glance
   totals. Deep diagnostics live on `/telemetry`. Management lives on its
   own pages. Don’t duplicate a page’s job elsewhere.
3. **The README teaches; the app shows.** Setup instructions, config
   snippets, and integration guides belong in the README — the app links
   to them instead of embedding them.
4. **Live, not stale.** Pages poll their JSON endpoints (~10s) and render
   client-side. Always `esc()` interpolated data.
5. **Consistency beats novelty.** Before styling something new, find the
   existing component that does the same job and reuse its pattern.

## 8. New-page checklist

- [ ] Prepends `themeCss`, embeds `profileBarCss/Html/Js`
- [ ] Content wrapper is `.container`; the route serves the page through `withSavedLayout`
- [ ] No `body` background, no hardcoded hex colors, tokens only
- [ ] `<h1>` = page name + muted subtitle; header handles brand/status
- [ ] Nav link added to `profileBarHtml` (and its active-state id)
- [ ] Blue = interactive/active · violet = code/meta · semantic colors earned
- [ ] Layout contract covered in `src/__tests__/site-header.test.ts`

## Native desktop preview

The optional `apps/desktop` shell uses native window controls and sidebar
navigation instead of the web `profileBar` header. Its palette is its own: a
neutral graphite set, light and dark designed separately, in `desktopThemeCss`
in `profileBar.ts`. This explicit native-shell exception changes neither the
web `themeCss` nor the shared header contract for web pages. The build extracts
the block into the desktop stylesheet and fails if any other stylesheet rule
carries a colour literal. Measured values, the type scale and the component
patterns live in `.interface-design/system.md`; this section states the rules.

**Palette.** Canvas, one raised surface and a darker inset *well* (tracks,
segmented controls, inputs); 0.5px `ring` / `ring-strong` edges and a `hover`
fill; four text levels t1–t4 (`--text`, `--t2`, `--muted`, `--t4`). Violet
`--accent2` means cache and nothing else (cache read; `--cache-write` is the
same violet at ~40%; `--fresh` is the neutral for uncached input). Blue
`--accent` means interactive or active. Green, yellow and red appear only as
marks — dots, glyphs, small text, usage fills — never as tinted backgrounds
behind text. Provider brands appear only as a quiet tint on account avatars.

**Depth.** One strategy: tonal surfaces plus a 0.5px ring, never a visible 1px
border on content. Content sits on the canvas, separated by space and
sentence-case section labels; there is no card per metric. A raised panel marks
only what the user acts on — on Today the account serving requests, on Accounts
each account, on Service each settings group — plus sheets, menus, popovers and
the request-detail side panel. Sidebar active rows are a raised fill with the
ring, not a blue wash.

**Type.** System font, set as an explicit family list (Chromium drops
`-apple-system` inside the `font` shorthand and falls back to a serif). Heroes
are 44/600 SF Pro Display with tight tracking and the unit at 22/500 t3; labels
are 12/500 sentence case, never uppercase, table headers included. Hierarchy
comes from weight and the four text levels before size. Every number is tabular.

**Components.** A hero is label → figure → data strip → caption, without a box.
Two signature components carry the product: the *prompt ribbon* splits a
prompt into cache read · cache write · fresh (Today hero and live rows, Traffic
rows and request detail, Cache totals and per-bucket chart), and the *limit bar
with a pace tick* marks how much of the window has elapsed (1 − time left ÷
window length; 5 hours, 7 days, 30 days) with "on pace / ahead of pace / under
pace" (±5 points) and the reset time beneath. A stale reading, unknown reset or
unknown window draws no tick; a stale reading keeps a warning colour, dimmed,
so a full account never reads as free, and turns grey rather than green. A
window whose reset passed is grey, captioned "awaiting a reading · reset at
10:00" (tooltip: "reset at 10:00, awaiting a new reading"), and never holds the
account. "Prompt from cache" is always the
token-weighted share, cache read ÷ (read + write + uncached input) from the
summary — the Today and Cache heroes, the sidebar Cache count and the
menu-bar tile agree; the per-request mean is labelled "mean per request".
Lists are native: 29px rows, no borders or zebra, a full-row hover fill,
sentence-case t3 headers with the sort arrow. Successful rows carry no status
badge; a failure replaces the ribbon with "HTTP 500 · api_error" in red. Long
context is a small t4 "1M" suffix, the active account a 6px blue dot, a held
account plain text ("until 10:59"). A quiet outlined pill remains only for a
discrete state that needs naming (a duplicate account, a pricing override, a
selected version). Attention items are a glyph list (warn triangle, bad
circle-x, ok check). Health is a status line — dot, state, context — never a
boxed chip. Settings follow macOS Settings: grouped inset panels, label left,
control right, help text t3 beneath, the section index beside them.
Shortcut hints use `kbd`; ⌘1–⌘6 open the six screens and ⌘R refreshes the
data (⇧⌘R reloads the window).

The window keeps its structure: a 216px glass sidebar with SF-style line icons,
counts in t4 (Cache in violet, a limited count as a warn dot and number) and a
footer naming the instance being viewed (supervisor, address, version); a
toolbar with the page title, the status line ("Working · personal · Max", or the
plain reason it is not), the time-window segmented control and refresh. Today
is the two heroes, the day strip (stacked prompt tokens per bucket, requests
beneath with failures in red, a dashed now line), the live list, the serving
panel and Needs attention. Hours without traffic leave a gap rather than a
bridged line. Dollars (API-equivalent at list prices, never an invoice) appear
on Traffic, Cache and Accounts, never in a hero. Failures are grouped by cause
with a count, a time span and whether they cleared. A screen that cannot read
its data shows the connection state, its fix and the matching action, never an
empty table; loading uses skeletons in the well tone. Motion stays under 200ms,
ease-out, opacity and transform only, and honours reduced motion.

The interface labels itself as a preview. Unsupported lifecycle controls are
not presented as working actions; external service ownership stays visible.

The menu-bar panel prioritizes cache reuse, connection health and account
limits in the same language: a status line, two raised tiles ("Prompt from
cache" with a mini ribbon; requests with the failed count), account rows with
5-hour and weekly mini tracks carrying pace ticks (no caption), the last
failure as a glyph item and plain text buttons in the footer. Claude and
ChatGPT accounts form one group; Antigravity accounts (a Google allowance) a
separate one beneath, with tracks but never a switch action. Each row ends in
one plain-text state: "serving", "until 10:59" for a held account, "sign in",
or *Use* for Claude and ChatGPT. Account switching and owned service controls
remain available without opening the dashboard. Escape or loss of focus
dismisses the panel; missing or stale quota data never looks like unused
capacity, and a window whose reset passed is grey and holds nothing. Reset
times are not printed in the rows: each limit keeps its full reset detail
("resets 14:59", or "reset at 10:00, awaiting a new reading") in the row's
tooltip and accessible name; the account list scrolls only when it exceeds the
available space, and service controls stay outside it.

The macOS menu-bar icon uses a transparent monochrome Meridian template, tinted
by the system. The Dock retains the full-color app icon unless the macOS **Hide Dock icon**
preference is enabled; the menu-bar icon and dashboard remain available. Committed 18-point
assets include 1x, 2x and 3x representations; regenerate them with
`swift scripts/render-tray-icon.swift`.


## 9. Provider navigation

`/providers` and Meridian Desktop share `telemetry/providerView.ts`. The primary
filter is All providers / Claude / Antigravity. A compact stats strip summarizes
observed hourly activity; provider cards own their accounts, model catalogues,
quota windows and management links. Never add subscription percentages across
providers or show an unavailable reading as zero. Old readings remain visible
with stale labels while background refresh runs.

Keep provider identity separate from model identity: Claude models reached
through Antigravity consume a Google allowance. Claude profile controls stay
inside the Claude account view. Shared totals must label partial data. Use the
existing blue active underline, neutral cards, violet endpoint/model literals,
and semantic quota thresholds. The provider brands (§2) stay on account cards.

`/` and `/profiles` list every account in one grid, grouped by provider
(Claude, then ChatGPT) under a heading for each. Chips above the grid show or
hide a provider. All chips start on, the browser remembers the choice for both
pages, and chips appear only while two or more providers have accounts. A
card moves only among its own provider's cards, because each provider's pool
is ranked on its own.

The desktop menu bar separates account quota groups and labels combined activity.
Provider selection belongs in managed-service settings, with tool permission as
a separate opt-in. An attached service remains controlled by its owner.
