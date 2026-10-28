import { expect, test } from 'bun:test'
import { RendererRecovery } from '../../apps/desktop/src/rendererRecovery'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
test('the production clock can initialize without a test clock', () => {
  const recovery = new RendererRecovery({ available: () => true, reload: async () => undefined, probe: async () => true, log: () => {}, exhausted: () => {} })
  recovery.dispose()
})
function fixture() {
  let now = 0, alive = true, notifications = 0
  const jobs = new Map<() => void, number>()
  const reloads: boolean[] = [], logs: string[] = []
  let reload: () => Promise<unknown> = async () => undefined
  let probe: () => Promise<boolean> = async () => true
  const recovery = new RendererRecovery({
    available: () => alive,
    reload: terminate => { reloads.push(terminate); return reload() },
    probe: () => probe(), log: message => logs.push(message), exhausted: () => { notifications++ },
  }, {
    now: () => now,
    schedule(callback, milliseconds) { jobs.set(callback, now + milliseconds); return () => { jobs.delete(callback) } },
  })
  const advance = async (milliseconds: number) => {
    const end = now + milliseconds
    for (;;) {
      const next = [...jobs].sort((a, b) => a[1] - b[1])[0]
      if (!next || next[1] > end) break
      now = next[1]; jobs.delete(next[0]); next[0](); await flush()
    }
    now = end; await flush()
  }
  return { recovery, advance, reloads, logs, jobs, notifications: () => notifications, unavailable: () => { alive = false }, reload: (value: typeof reload) => { reload = value }, probe: (value: typeof probe) => { probe = value } }
}

test('crash recovery coalesces signals and keeps successful reloads within the crash-loop budget', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) {
    f.recovery.recover('crashed'); f.recovery.recover('GPU crashed'); f.recovery.check()
    await f.advance(1000)
  }
  expect(f.reloads).toEqual([false, false, false])
  f.recovery.recover('crashed'); f.recovery.recover('crashed')
  await f.advance(1000)
  expect(f.reloads).toHaveLength(3)
  expect(f.notifications()).toBe(1)
  f.recovery.recover('manual retry', true, true)
  await f.advance(250)
  expect(f.reloads).toEqual([false, false, false, true])
})

test('a later independent crash gets a fresh automatic budget', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) { f.recovery.recover('crashed'); await f.advance(1000) }
  await f.advance(60_000)
  f.recovery.recover('crashed'); await f.advance(250)
  expect(f.reloads).toHaveLength(4)
})

test('healthy wake/show probes do not reload or consume the budget', async () => {
  const f = fixture()
  for (let i = 0; i < 5; i++) { f.recovery.check(); await flush() }
  expect(f.reloads).toEqual([])
  expect(f.jobs.size).toBe(0)
})

test('a failed or hung probe terminates the renderer before loading the trusted entry', async () => {
  for (const probe of [async () => false, () => new Promise<boolean>(() => {})]) {
    const f = fixture(); f.probe(probe)
    f.recovery.check(); await flush()
    f.probe(async () => true)
    await f.advance(5250)
    expect(f.reloads).toEqual([true])
  }
})

test('rejected, timed-out and blank reloads stop after three attempts', async () => {
  for (const mode of ['reject', 'timeout', 'blank']) {
    const f = fixture()
    if (mode === 'reject') f.reload(async () => { throw new Error('load failed') })
    if (mode === 'timeout') f.reload(() => new Promise(() => {}))
    if (mode === 'blank') f.probe(async () => false)
    f.recovery.recover('crashed')
    await f.advance(60_000)
    expect(f.reloads).toEqual([false, true, true])
    expect(f.notifications()).toBe(1)
    expect(f.jobs.size).toBe(0)
  }
})

test('a late completion cannot finish a newer recovery', async () => {
  const f = fixture()
  let finish!: () => void
  f.reload(() => new Promise<void>(resolve => { finish = resolve }))
  f.recovery.recover('crashed'); await f.advance(15_250)
  f.reload(async () => undefined)
  await f.advance(500)
  const count = f.logs.length
  finish(); await flush()
  expect(f.logs).toHaveLength(count)
  expect(f.reloads).toEqual([false, true])
})

test('disposal or shutdown prevents queued recovery and late probe effects', async () => {
  const f = fixture()
  f.recovery.recover('crashed'); f.unavailable(); await f.advance(30_000)
  expect(f.reloads).toEqual([])
  const g = fixture()
  let finish!: (value: boolean) => void
  g.probe(() => new Promise(resolve => { finish = resolve }))
  g.recovery.check(); await flush(); g.recovery.dispose()
  finish(false); await g.advance(30_000)
  expect(g.reloads).toEqual([])
  expect(g.jobs.size).toBe(0)
})
