/** Match stops across CLI chunks without exposing a partial stop prefix. */
export class AgTextStops {
  private pending = ""
  matched?: string
  constructor(private readonly stops: string[]) {}
  push(text: string): string {
    if (this.matched) return ""
    this.pending += text
    let first = -1
    for (const stop of this.stops) {
      const index = this.pending.indexOf(stop)
      if (index >= 0 && (first < 0 || index < first)) { first = index; this.matched = stop }
    }
    if (first >= 0) { const output = this.pending.slice(0, first); this.pending = ""; return output }
    let held = 0
    for (const stop of this.stops) {
      for (let size = Math.min(stop.length - 1, this.pending.length); size > held; size--) {
        if (this.pending.endsWith(stop.slice(0, size))) { held = size; break }
      }
    }
    const output = this.pending.slice(0, this.pending.length - held)
    this.pending = this.pending.slice(this.pending.length - held)
    return output
  }
  flush(): string { const output = this.pending; this.pending = ""; return output }
}
