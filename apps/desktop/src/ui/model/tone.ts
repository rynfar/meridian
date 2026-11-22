/** Semantic tones. Colour comes from the DESIGN tokens; these names map onto them in CSS. */
export type Tone = 'green' | 'yellow' | 'red' | 'muted' | 'accent' | 'violet'

/** DESIGN.md utilization thresholds: < 60% green, ≥ 60% yellow, ≥ 85% red. */
export function utilTone(utilization: number | null | undefined): Tone {
  if (utilization === null || utilization === undefined || !Number.isFinite(utilization)) return 'muted'
  if (utilization >= 0.85) return 'red'
  if (utilization >= 0.6) return 'yellow'
  return 'green'
}

/** Bar width for a utilization, never fully invisible for a real reading. */
export function barWidth(utilization: number | null | undefined, minimum = 0.02): number {
  if (utilization === null || utilization === undefined || !Number.isFinite(utilization)) return 0
  return Math.max(minimum, Math.min(1, utilization))
}

/**
 * Fill for a usage track. A current reading takes its threshold colour. A
 * stale one keeps a warning colour, dimmed, so a full account never reads as
 * free, but loses green: old figures are not known free capacity. A window
 * whose reset passed is muted grey: its figure belongs to the previous window.
 */
export function trackTone(window: { utilization: number | null; stale: boolean; expired?: boolean } | undefined): { tone: Tone; dim: boolean } {
  if (!window || window.utilization === null) return { tone: 'muted', dim: false }
  if (window.expired) return { tone: 'muted', dim: true }
  const tone = utilTone(window.utilization)
  if (!window.stale) return { tone, dim: false }
  return { tone: tone === 'green' ? 'muted' : tone, dim: true }
}
