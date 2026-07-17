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

**Tagline:** “Harness Claude, your way.”

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
  Links, nav highlight, buttons, focus rings, active tab underline, the
  active account card border + pill, section emphasis.
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
degraded yellow, offline red.

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

**The header owns the brand.** It shows the mark + wordmark (links home),
the site nav (Home · Telemetry · Profiles · Settings · Plugins), the
active-profile chip, and the live health pill. Consequences:

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
  Active card: `--accent` border + 1px accent ring. Clickable cards get
  `cursor: pointer` and an accent border on hover, plus a hover-revealed
  uppercase hint (e.g. “Click to activate”).
- **Stats strip:** one flex row of cells separated by 1px `--border`
  dividers inside a single card — label (micro-label), value (20px/700),
  optional muted detail line. Use instead of a grid of chunky cards.
- **Pills:** radius 10–20px, tinted fill + tinted border of the same hue
  (e.g. Active pill: blue text on `rgba(88,166,255,0.12)` with
  `rgba(88,166,255,0.35)` border). Status badges: green/muted/red variants.
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
- [ ] No `body` background, no hardcoded hex colors, tokens only
- [ ] `<h1>` = page name + muted subtitle; header handles brand/status
- [ ] Nav link added to `profileBarHtml` (and its active-state id)
- [ ] Blue = interactive/active · violet = code/meta · semantic colors earned
- [ ] Layout contract covered in `src/__tests__/site-header.test.ts`
