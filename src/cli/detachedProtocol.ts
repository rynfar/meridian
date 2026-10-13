import { timingSafeEqual } from "node:crypto"

/** Private supervisor protocol; never sent over the public Meridian HTTP API. */
export const DETACHED_PROTOCOL_VERSION = 1
export const DETACHED_FRAME_BYTES = 4096
const HEX_ID = /^[a-f0-9]{32}$/
const HEX_NONCE = /^[a-f0-9]{64}$/

export interface DetachedIdentity {
  instanceId: string
  nonce: string
}
export interface DetachedRequest extends DetachedIdentity {
  version: typeof DETACHED_PROTOCOL_VERSION
  action: "inspect" | "stop"
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseDetachedRequest(value: unknown): DetachedRequest | undefined {
  if (!record(value) || Object.keys(value).length !== 4) return undefined
  if (value.version !== DETACHED_PROTOCOL_VERSION
    || (value.action !== "inspect" && value.action !== "stop")
    || typeof value.instanceId !== "string" || value.instanceId.length !== 32 || !HEX_ID.test(value.instanceId)
    || typeof value.nonce !== "string" || value.nonce.length !== 64 || !HEX_NONCE.test(value.nonce)) return undefined
  return { version: DETACHED_PROTOCOL_VERSION, action: value.action, instanceId: value.instanceId, nonce: value.nonce }
}

export function authenticatesDetachedRequest(request: DetachedRequest, identity: DetachedIdentity): boolean {
  if (identity.instanceId.length !== 32 || identity.nonce.length !== 64 || !HEX_ID.test(identity.instanceId) || !HEX_NONCE.test(identity.nonce)) return false
  // Validate before allocating/comparing so malformed callers cannot throw or
  // trick Buffer's permissive hex decoder into authenticating a partial nonce.
  const parsed = parseDetachedRequest(request)
  if (!parsed) return false
  const sameId = timingSafeEqual(Buffer.from(parsed.instanceId, "hex"), Buffer.from(identity.instanceId, "hex"))
  const sameNonce = timingSafeEqual(Buffer.from(parsed.nonce, "hex"), Buffer.from(identity.nonce, "hex"))
  return sameId && sameNonce
}

/** One request per connection. Bound bytes before parsing or retaining input. */
export class DetachedRequestFrame {
  private bytes = Buffer.alloc(0)
  private finished = false

  push(chunk: Uint8Array): DetachedRequest | undefined {
    if (this.finished) throw new Error("Detached control frame is already complete")
    if (chunk.byteLength > DETACHED_FRAME_BYTES - this.bytes.byteLength) {
      this.finished = true
      this.bytes = Buffer.alloc(0)
      throw new Error("Detached control frame is too large")
    }
    this.bytes = Buffer.concat([this.bytes, chunk])
    const newline = this.bytes.indexOf(10)
    if (newline < 0) return undefined
    this.finished = true
    const bytes = this.bytes
    this.bytes = Buffer.alloc(0)
    if (newline !== bytes.byteLength - 1) throw new Error("Detached control accepts one frame")
    let value: unknown
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline))) }
    catch { throw new Error("Invalid detached control frame") }
    const request = parseDetachedRequest(value)
    if (!request) throw new Error("Invalid detached control request")
    return request
  }
}

export type DetachedPhase = "starting" | "ready" | "draining" | "exited"

/** Stop is admitted once: repeated requests must never become a second signal. */
export class DetachedLifecycle {
  private current: DetachedPhase = "starting"
  get phase(): DetachedPhase { return this.current }
  ready(): boolean {
    if (this.current !== "starting") return false
    this.current = "ready"
    return true
  }
  stop(): boolean {
    if (this.current === "draining" || this.current === "exited") return false
    this.current = "draining"
    return true
  }
  exited(): void { this.current = "exited" }
}
