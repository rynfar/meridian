import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"

export interface AdmissionHeartbeat {
  budgetMs: number
  elapsedMs: number
  ticks: number[]
  maxGapMs: number
}

/** Include both edges: a completely starved timer cannot hide behind an empty sample array. */
export async function measureAdmissionHeartbeat(budgetMs: number, wait: () => Promise<void>): Promise<AdmissionHeartbeat> {
  const start = performance.now(), ticks: number[] = []
  const timer = setInterval(() => ticks.push(performance.now() - start), 5)
  try {
    await wait()
    const elapsedMs = performance.now() - start
    const edges = [0, ...ticks, elapsedMs]
    return { budgetMs, elapsedMs, ticks,
      maxGapMs: Math.max(...edges.slice(1).map((value, i) => value - edges[i]!)) }
  } finally { clearInterval(timer) }
}

export function assertAdmissionDeadline(sample: Pick<AdmissionHeartbeat, "elapsedMs" | "budgetMs">): void {
  assert(sample.elapsedMs >= sample.budgetMs, `early expiry: ${sample.elapsedMs} < ${sample.budgetMs}`)
  assert(sample.elapsedMs < sample.budgetMs + 50, `late expiry: ${sample.elapsedMs}`)
}

export function assertAdmissionHeartbeat(sample: AdmissionHeartbeat): void {
  assertAdmissionDeadline(sample)
  assert(sample.ticks.length >= Math.floor(sample.budgetMs / 5) - 3, `timer starved: ${sample.ticks.length} ticks`)
  assert(sample.maxGapMs <= 25, `timer gap ${sample.maxGapMs} > 25 ms`)
}
