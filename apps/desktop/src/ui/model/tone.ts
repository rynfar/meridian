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
