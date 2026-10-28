# Meridian Desktop — interface system

Scope: `apps/desktop` (window and menu-bar panel). The web pages keep
DESIGN.md §2's tokens. DESIGN.md → *Native desktop preview* states the rules;
this file records the measured values and component patterns. Approved by the
owner 2026-10-28 from the Today specimen
(`mockups/desktop-2026-10-28/spec/today-v2.html`, outside the repo).

## Direction

- **Who:** a developer glancing between agent turns — is it working, is the
  cache holding, which account is burning.
- **Feel:** a precise instrument. Graphite, calm, dense; one signal colour.
- **References:** Linear (tonal surfaces, four text levels, hairline rings),
  Apple's own apps / Activity Monitor (native list, tabular numbers, segmented
  control), the `macos-design` skill (0.5px edge ring, independent light and
  dark palettes, shortcut hints).
- **Rejected defaults:** a card per metric → content on the canvas separated
  by space; dot + label + giant number + sparkline boxes → hero with a data
  ribbon; badges for every state → plain text, glyphs and colour only on
  exceptions; GitHub Primer palette → neutral graphite.

## Tokens (all colours live in `desktopThemeCss`, `src/telemetry/profileBar.ts`)

| Role | Light | Dark |
|---|---|---|
| canvas (`--bg`) | `#f5f5f6` | `#161618` |
| raised panel (`--surface`) | `#ffffff` | `#1d1d20` |
| raised-2 / selected (`--surface2`) | `#f0f0f2` | `#242428` |
| well (tracks, segmented, inputs) | `#ebebed` | `#111113` |
| ring | `rgba(0,0,0,.075)` | `rgba(255,255,255,.07)` |
| ring-strong | `rgba(0,0,0,.12)` | `rgba(255,255,255,.12)` |
| hover | `rgba(0,0,0,.035)` | `rgba(255,255,255,.035)` |
| text t1 / t2 / t3 / t4 | `#1b1b1e` `#46464c` `#7a7a82` `#a6a6ad` | `#ececee` `#b6b6bc` `#86868e` `#5c5c64` |
| cache (= brand violet `--accent2`) | `#8250b5` | `#bc8cff` |
| cache-write | cache at 42% | cache at 38% |
| fresh | `#c9c9ce` | `#3b3b41` |
| accent (interactive) | `#1f6fd6` | `#5aa3ff` |
| ok / warn / bad | `#2c8a52` `#a96d00` `#cf3f3a` | `#4cc283` `#e0a83e` `#f2645e` |

Colour rules: violet means cache, blue means interactive or active; ok/warn/bad
appear only as marks (dots, glyphs, small text, bar fills of usage), never as
tinted backgrounds behind text.

## Depth

One strategy: **tonal surfaces + 0.5px ring.** Canvas → raised panel
(`box-shadow: 0 0 0 .5px ring, 0 1px 2px rgba(0,0,0,.05)` light; ring + inset
highlight dark). No visible 1px borders on content. Exactly one raised panel
per screen region that the user acts on (Today: the serving account).

## Type (system font; SF Pro Display for heroes)

| Use | Size / weight / colour | Notes |
|---|---|---|
| Hero figure | 44 / 600 / t1 | tracking −0.035em, unit at 22 / 500 / t3 |
| Screen title | 15 / 600 / t1 | tracking −0.01em |
| Section label | 12 / 500 / t3 (t2 for list headers) | sentence case, never uppercase |
| Body / rows | 13 / 400–500 | names 500 t1, metadata t3, times t4 |
| Caption | 12.5 / 400 / t3 | key value inside at t2 / 500 |
| Micro | 11–11.5 / 400 / t4 | resets, pace, legends |

All numbers `tabular-nums`. Hierarchy from weight and the four text levels
before size.

## Spacing and shape

4px base. Content padding 22–26px; section gap 24–26px; list rows 29px; panel
padding 14×16px. Radii: panel 10, row/hover 6, segmented 7/5, tracks 2, ribbons 3.

## Components

- **Hero** — label (with 8px square swatch when it names a series) → figure →
  data strip (prompt ribbon for cache; latency split for requests) → caption.
  No box.
- **Prompt ribbon (signature)** — one horizontal bar split cache read
  (violet) · cache write (violet 40%) · fresh (fresh); 1px gaps, radius 3,
  6px tall in heroes, 4px in rows with the prompt size beside it. Used in the
  Today hero and live rows, Traffic rows and request detail, Cache screen.
- **Day strip** — 24 hourly columns of stacked prompt tokens (ribbon colours),
  a 22px request-count strip beneath with failures in red, a dashed now line;
  future hours are a 2px well tick, empty past hours a 2px well bar.
- **Limit bar with pace tick (signature)** — 4px well track, usage fill by
  threshold (<60% ok, ≥60% warn, ≥85% bad), a 1.5×10px t2 tick at the share of
  the window already elapsed; beneath: "on pace / ahead of pace (warn) /
  under pace" left, reset time right, both micro.
- **Native list** — grid rows 29px, no borders or zebra; header underlined by
  the ring; hover/selection = full-row `hover` fill radius 6; times t4,
  names 500, metadata t3, numbers right-aligned tabular. Failures replace the
  ribbon with "HTTP 500 · api_error" in bad.
- **Status line** — dot (7px) + text t2 + context t3; never a boxed chip.
- **Segmented control** — well track with ring, 2px padding; selected segment
  raised with ring-strong + 1px shadow, t1; others t3.
- **Attention item** — 14px stroke glyph (warn triangle, bad circle-x, ok
  check) + title 500 + detail t3 + outcome in ok/warn text.
- **Account row** — name 500 + plan t4 (11px) + 54px mini track + action text
  ("Use" accent, "until 10:59" warn). Active = blue 6px dot after the name.
- **Shortcut hint** — `kbd`: 10.5/500 t3, ring-strong inset, radius 4.
- **Sidebar nav** — 28px rows, 15px stroke icons (1.6), active = raised fill
  + ring, t1; counts t4 tabular; limited = warn dot + count.

## Motion

≤ 200ms, ease-out `cubic-bezier(0.23, 1, 0.32, 1)`; animate opacity and
transform only; respect `prefers-reduced-motion`. Live rows fade in, no slide.
