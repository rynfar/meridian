import Database from 'libsql'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VERIFIED_AGY_NATIVE_RECORD_VERSION = '1.2.7'
export function isVerifiedAgNativeRecordVersion(version: string): boolean {
  return version === VERIFIED_AGY_NATIVE_RECORD_VERSION
}

const MAX_STEP_BYTES = 4 * 1024 * 1024
const MAX_METADATA_BYTES = 128 * 1024
export function agNativeRecordUri(path: string): string { return pathToFileURL(path).href + '?mode=ro' }
type Field = { wire: number; value: bigint | Buffer }
type Message = Map<number, Field[]>

/** Limited protobuf reader for the verified agy 1.2.7 Step schema; never decodes reasoning fields. */
function fields(data: Buffer): Message {
  if (data.length > MAX_STEP_BYTES) throw new Error('native step exceeds recovery bound')
  let offset = 0
  const varint = (): bigint => {
    let value = 0n
    for (let count = 0; count < 10; count++) {
      if (offset >= data.length) throw new Error('truncated native varint')
      const byte = data[offset++]!
      if (count === 9 && byte > 1) throw new Error('native varint overflow')
      value |= BigInt(byte & 127) << BigInt(count * 7)
      if (byte < 128) return value
    }
    throw new Error('invalid native varint')
  }
  const out: Message = new Map()
  let count = 0
  while (offset < data.length) {
    if (++count > 4096) throw new Error('native field bound exceeded')
    const tag = varint(), number = Number(tag >> 3n), wire = Number(tag & 7n)
    if (number < 1 || number >= 2 ** 29) throw new Error('invalid native field')
    let value: bigint | Buffer
    if (wire === 0) value = varint()
    else {
      const size = wire === 2 ? varint() : wire === 1 ? 8n : wire === 5 ? 4n : -1n
      if (size < 0n || size > BigInt(data.length - offset)) throw new Error('invalid native field size')
      value = data.subarray(offset, offset + Number(size)); offset += Number(size)
    }
    const list = out.get(number) ?? []
    list.push({ wire, value }); out.set(number, list)
  }
  return out
}
function one(message: Message, number: number, wire: number): Field | undefined {
  const values = message.get(number)
  if (!values) return
  if (values.length !== 1 || values[0]!.wire !== wire) throw new Error('ambiguous native field')
  return values[0]
}
function bytes(message: Message, number: number): Buffer | undefined {
  const value = one(message, number, 2)?.value
  return Buffer.isBuffer(value) ? value : undefined
}
function integer(message: Message, number: number): number {
  const value = one(message, number, 0)?.value ?? 0n
  if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid native integer')
  return Number(value)
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
function text(message: Message, number: number): string { return utf8.decode(bytes(message, number) ?? Buffer.alloc(0)) }
function requiredBytes(message: Message, number: number): Buffer {
  const value = bytes(message, number)
  if (!value) throw new Error('missing native message')
  return value
}

export interface AgNativeAnchor {
  conversationId?: string
  inputAfter: number
  responseAfter: number
  prompt: string
  firstInput: boolean
  startedAt: number
}
export interface AgRecoveredNativeText {
  text: string
  inputStep: number
  responseStep: number
  executionId: string
}
interface Row {
  idx: number; step_type: number; status: number; step_format: number;
  metadata: Buffer; step_payload: Buffer; error_bytes: number | null
}

/** Reads exactly one verified 1.2.7 conversation. No directory scan, credential access or DB content writes. */
export class AgNativeRecords {
  constructor(private readonly home: string, private readonly getCliVersion: () => string = () => '') {}
  private supportedVersion(): boolean { return isVerifiedAgNativeRecordVersion(this.getCliVersion()) }
  supported(): boolean { return this.supportedVersion() }
  private withDb<T>(conversationId: string, read: (db: Database.Database) => T): T | undefined {
    if (!this.supportedVersion()) return
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) return
    const path = join(this.home, '.gemini', 'antigravity-cli', 'conversations', conversationId + '.db')
    let db: Database.Database | undefined
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) return
      // libsql 0.5.x ignores the compatibility readonly option; the SQLite URI enforces it.
      db = new Database(agNativeRecordUri(path))
      db.pragma('query_only = ON')
      db.pragma('busy_timeout = 50')
      db.exec('BEGIN')
      return read(db)
    // Missing DB, lock contention, or unsupported record schemas fail closed to retry/502.
    } catch { return undefined }
    finally {
      if (db) {
        try { if (db.inTransaction) db.exec('ROLLBACK') }
        finally { db.close() }
      }
    }
  }
  watermark(conversationId: string): number | undefined {
    if (!this.supportedVersion()) return
    return this.withDb(conversationId, db => {
      const value = db.prepare('SELECT max(idx) AS idx FROM steps').get() as { idx: number | null }
      return value.idx === null ? -1 : Number.isSafeInteger(value.idx) ? value.idx : undefined
    })
  }
  recover(conversationId: string, anchor: AgNativeAnchor): AgRecoveredNativeText | undefined {
    if (!this.supportedVersion()) return
    if (anchor.conversationId && anchor.conversationId !== conversationId) return
    return this.withDb(conversationId, db => {
      const trajectories = db.prepare('SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 2').all() as Array<{ trajectory_id: string; cascade_id: string }>
      if (trajectories.length !== 1 || trajectories[0]!.cascade_id !== conversationId) return
      const latest = db.prepare('SELECT idx, step_type FROM steps ORDER BY idx DESC LIMIT 1').get() as { idx: number; step_type: number } | undefined
      const input = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1').get() as { idx: number } | undefined
      if (!latest || latest.step_type !== 15 || !input || !Number.isSafeInteger(input.idx) || !Number.isSafeInteger(latest.idx) || input.idx <= anchor.inputAfter || latest.idx <= Math.max(input.idx, anchor.responseAfter)) return
      if (anchor.firstInput && (db.prepare('SELECT count(*) AS count FROM steps WHERE step_type = 14').get() as { count: number }).count !== 1) return
      const readStep = (idx: number, type: number) => {
        const row = db.prepare('SELECT idx, step_type, status, step_format, metadata, step_payload, length(error_details) AS error_bytes FROM steps WHERE idx = ? AND length(metadata) <= ? AND length(step_payload) <= ?').get(idx, MAX_METADATA_BYTES, MAX_STEP_BYTES) as Row | undefined
        if (!row || row.step_type !== type || row.status !== 3 || row.step_format !== 0 || row.error_bytes) throw new Error('native step is not a completed supported response')
        const step = fields(Buffer.from(row.step_payload)), metadataBlob = Buffer.from(row.metadata)
        if (integer(step, 1) !== type || integer(step, 4) !== 3 || !requiredBytes(step, 5).equals(metadataBlob)) throw new Error('native row/protobuf mismatch')
        const metadata = fields(metadataBlob), source = fields(requiredBytes(metadata, 20))
        if (text(source, 4) !== conversationId || text(source, 1) !== trajectories[0]!.trajectory_id || integer(source, 2) !== idx) throw new Error('native source mismatch')
        const stamp = fields(requiredBytes(metadata, 1))
        return { step, execution: text(metadata, 12), createdAt: integer(stamp, 1) * 1000 + integer(stamp, 2) / 1e6 }
      }
      const user = readStep(input.idx, 14), answer = readStep(latest.idx, 15)
      if (!user.execution || answer.execution !== user.execution || user.createdAt < anchor.startedAt - 5) return
      const supplied = fields(requiredBytes(user.step, 19))
      if (!text(supplied, 1).includes(anchor.prompt) && !text(supplied, 2).includes(anchor.prompt)) return
      const planner = fields(requiredBytes(answer.step, 20))
      if (planner.has(7)) return
      const modified = text(planner, 8), response = text(planner, 1)
      if (modified.trim() && response.trim() && modified !== response) return
      const value = modified.trim() ? modified : response
      if (!value.trim()) return
      return { text: value, inputStep: input.idx, responseStep: latest.idx, executionId: user.execution }
    })
  }
}
