type Cancel = () => void
interface RecoveryHost {
  available(): boolean
  reload(terminate: boolean): Promise<unknown>
  probe(): Promise<boolean>
  log(message: string): void
  exhausted(): void
}
interface RecoveryClock {
  now(): number
  schedule(callback: () => void, milliseconds: number): Cancel
}
const systemClock: RecoveryClock = {
  now: Date.now,
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

export class RendererRecovery {
  private attempts: number[] = []
  private scheduled?: Cancel
  private deadline?: Cancel
  private generation = 0
  private busy = false
  private checking = false
  private disposed = false
  private notified = false

  constructor(private host: RecoveryHost, private clock: RecoveryClock = systemClock) {}

  private available() { return !this.disposed && this.host.available() }

  recover(reason: string, terminate = false, manual = false) {
    if (!this.available() || this.busy || this.scheduled) return
    this.generation++
    this.deadline?.(); this.deadline = undefined; this.checking = false
    if (manual) { this.attempts = []; this.notified = false }
    this.attempts = this.attempts.filter(time => this.clock.now() - time < 60_000)
    if (!this.attempts.length) this.notified = false
    if (this.attempts.length >= 3) {
      if (!this.notified) {
        this.notified = true
        this.host.log('Automatic interface recovery stopped after 3 attempts in one minute.')
        this.host.exhausted()
      }
      return
    }
    this.host.log(`Recovering interface: ${reason}.`)
    this.scheduled = this.clock.schedule(() => {
      this.scheduled = undefined
      if (!this.available()) return
      this.busy = true
      this.attempts.push(this.clock.now())
      const generation = ++this.generation
      const finish = (healthy: boolean) => {
        if (generation !== this.generation) return
        this.deadline?.(); this.deadline = undefined; this.busy = false
        if (!this.available()) return
        if (healthy) this.host.log('Interface recovered; service was not restarted.')
        else this.recover('reload did not restore the interface', true)
      }
      this.deadline = this.clock.schedule(() => finish(false), 15_000)
      void Promise.resolve().then(() => this.host.reload(terminate)).then(() => {
        if (generation !== this.generation || !this.available()) return false
        return this.host.probe()
      }).then(finish, () => finish(false))
    }, 250 * 2 ** this.attempts.length)
  }

  check() {
    if (!this.available() || this.busy || this.scheduled || this.checking) return
    this.checking = true
    const generation = ++this.generation
    const finish = (healthy: boolean) => {
      if (generation !== this.generation) return
      this.deadline?.(); this.deadline = undefined; this.checking = false
      if (!this.available()) return
      if (!healthy) this.recover('interface health check failed', true)
    }
    this.deadline = this.clock.schedule(() => finish(false), 5_000)
    void Promise.resolve().then(() => this.host.probe()).then(finish, () => finish(false))
  }

  dispose() {
    this.disposed = true; this.generation++
    this.scheduled?.(); this.deadline?.()
    this.scheduled = undefined; this.deadline = undefined
  }
}
