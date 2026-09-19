import { createHash } from 'node:crypto'
import { AntigravityError } from './antigravityProtocol'

/** Local Responses compatibility state, separate from native CLI conversation ownership. */
export class AgResponseStore {
  private readonly entries = new Map<string, { scope: string; json: string; bytes: number; expires: number }>()
  private bytes = 0
  constructor(private readonly limits = { entries: 256, bytes: 64 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, ttlMs: 30 * 60_000 }, private readonly now = Date.now) {}

  private remove(id: string) {
    const entry = this.entries.get(id)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(id) }
  }
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id)
  }
  put(id: string, scope: string, input: unknown[], response: Record<string, unknown>) {
    const json = JSON.stringify({ input, response })
    const bytes = Buffer.byteLength(json)
    if (bytes > this.limits.entryBytes || bytes > this.limits.bytes) throw new AntigravityError('Stored response exceeds the local storage budget; retry with store: false and full history', 413)
    this.prune()
    this.remove(id)
    while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.bytes) this.remove(this.entries.keys().next().value!)
    this.entries.set(id, { scope, json, bytes, expires: this.now() + this.limits.ttlMs })
    this.bytes += bytes
  }
  get(id: string, scope: string): { input: unknown[]; response: Record<string, unknown> } {
    this.prune()
    const entry = this.entries.get(id)
    if (!entry || entry.scope !== scope) throw new AntigravityError('Response not found: it may be unstored, deleted, expired, evicted or from another server instance', 404, 'not_found_error')
    // Serialization isolates forks and prevents callers from mutating saved history.
    return JSON.parse(entry.json) as { input: unknown[]; response: Record<string, unknown> }
  }
  delete(id: string, scope: string) {
    this.get(id, scope)
    this.remove(id)
    return { id, object: 'response', deleted: true }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}

/** Match auth header precedence; never retain raw credentials in the response store. */
export function agResponseScope(headers: Headers): string {
  const bearer = headers.get('authorization')
  const key = headers.get('x-api-key') || (bearer?.startsWith('Bearer ') ? bearer.slice(7) : '')
  return createHash('sha256').update(key || '').digest('hex')
}
