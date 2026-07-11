import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { dirname, isAbsolute } from "node:path"

const DEFAULT_TTL_MS = 5 * 60_000
const MAX_TTL_MS = 60 * 60_000
const DEFAULT_MAX_ENTRIES = 1_024
const DEFAULT_MAX_FRAME_BYTES = 16 * 1_024
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000

export interface WorkspaceAuthorityLease {
  capability: string
  owner: string
  agentId: string
  cwd: string
  expiresAt: number
}

export interface WorkspaceAuthorityRegistryOptions {
  defaultTtlMs?: number
  maxTtlMs?: number
  maxEntries?: number
  now?: () => number
  mintCapability?: () => string
}

export interface IssueWorkspaceAuthorityLease {
  owner: string
  agentId: string
  cwd: string
  ttlMs?: number
}

function requireIdentifier(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 256) throw new Error(`${name} must be between 1 and 256 characters`)
  return trimmed
}

/**
 * In-memory authority leases. A capability is reusable while its owning
 * agent is live, but becomes permanently invalid after revoke or expiry.
 */
export class WorkspaceAuthorityRegistry {
  readonly #leases = new Map<string, WorkspaceAuthorityLease>()
  readonly #defaultTtlMs: number
  readonly #maxTtlMs: number
  readonly #maxEntries: number
  readonly #now: () => number
  readonly #mintCapability: () => string

  constructor(options: WorkspaceAuthorityRegistryOptions = {}) {
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    this.#maxTtlMs = options.maxTtlMs ?? MAX_TTL_MS
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.#now = options.now ?? Date.now
    this.#mintCapability = options.mintCapability ?? (() => randomBytes(32).toString("base64url"))
    if (this.#defaultTtlMs <= 0 || this.#maxTtlMs < this.#defaultTtlMs) {
      throw new Error("workspace authority TTL bounds are invalid")
    }
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new Error("workspace authority maxEntries must be a positive integer")
    }
  }

  issue(input: IssueWorkspaceAuthorityLease): WorkspaceAuthorityLease {
    this.pruneExpired()
    if (this.#leases.size >= this.#maxEntries) throw new Error("workspace authority registry is full")
    const owner = requireIdentifier(input.owner, "owner")
    const agentId = requireIdentifier(input.agentId, "agentId")
    if (!isAbsolute(input.cwd)) throw new Error("cwd must be absolute")
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs
    this.#validateTtl(ttlMs)

    let capability = ""
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = this.#mintCapability()
      if (candidate && !this.#leases.has(candidate)) {
        capability = candidate
        break
      }
    }
    if (!capability) throw new Error("failed to mint a unique workspace authority capability")

    const lease = Object.freeze({ capability, owner, agentId, cwd: input.cwd, expiresAt: this.#now() + ttlMs })
    this.#leases.set(capability, lease)
    return lease
  }

  resolve(capability: string): WorkspaceAuthorityLease | undefined {
    const lease = this.#leases.get(capability)
    if (!lease) return undefined
    if (lease.expiresAt <= this.#now()) {
      this.#leases.delete(capability)
      return undefined
    }
    return lease
  }

  renew(capability: string, owner: string, agentId: string, ttlMs?: number): WorkspaceAuthorityLease | undefined {
    const lease = this.resolve(capability)
    if (!lease || lease.owner !== owner || lease.agentId !== agentId) return undefined
    const effectiveTtl = ttlMs ?? this.#defaultTtlMs
    this.#validateTtl(effectiveTtl)
    const renewed = Object.freeze({ ...lease, expiresAt: this.#now() + effectiveTtl })
    this.#leases.set(capability, renewed)
    return renewed
  }

  revoke(capability: string, owner: string, agentId: string): boolean {
    const lease = this.resolve(capability)
    if (!lease || lease.owner !== owner || lease.agentId !== agentId) return false
    return this.#leases.delete(capability)
  }

  revokeAgent(owner: string, agentId: string): number {
    let revoked = 0
    for (const [capability, lease] of this.#leases) {
      if (lease.owner === owner && lease.agentId === agentId) {
        this.#leases.delete(capability)
        revoked++
      }
    }
    return revoked
  }

  pruneExpired(): number {
    const now = this.#now()
    let pruned = 0
    for (const [capability, lease] of this.#leases) {
      if (lease.expiresAt <= now) {
        this.#leases.delete(capability)
        pruned++
      }
    }
    return pruned
  }

  clear(): void {
    this.#leases.clear()
  }

  get size(): number {
    this.pruneExpired()
    return this.#leases.size
  }

  #validateTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.#maxTtlMs) {
      throw new Error(`ttlMs must be a positive integer no greater than ${this.#maxTtlMs}`)
    }
  }
}

export interface WorkspaceAuthorityServerConfig extends WorkspaceAuthorityRegistryOptions {
  socketPath: string
  credentialPath?: string
  maxFrameBytes?: number
  socketTimeoutMs?: number
}

export type WorkspaceAuthorityRequest =
  | { id: string; credential: string; operation: "issue"; owner: string; agentId: string; cwd: string; ttlMs?: number }
  | { id: string; credential: string; operation: "renew"; owner: string; agentId: string; capability: string; ttlMs?: number }
  | { id: string; credential: string; operation: "revoke"; owner: string; agentId: string; capability: string }
  | { id: string; credential: string; operation: "revoke-agent"; owner: string; agentId: string }

export type WorkspaceAuthorityResponse =
  | { id: string; ok: true; lease?: WorkspaceAuthorityLease; revoked?: number }
  | { id: string; ok: false; error: "unauthorized" | "invalid_request" | "not_found" | "registry_full" }

export interface WorkspaceAuthorityServer {
  registry: WorkspaceAuthorityRegistry
  socketPath: string
  credentialPath: string
  close(): Promise<void>
}

async function removeOwnedRuntimeEntry(path: string, expected: "socket" | "file"): Promise<void> {
  try {
    const stat = await lstat(path)
    const typeMatches = expected === "socket" ? stat.isSocket() : stat.isFile()
    if (!typeMatches || stat.uid !== process.getuid?.()) {
      throw new Error(`refusing to replace unsafe workspace authority ${expected}: ${path}`)
    }
    await unlink(path)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }
}

async function preparePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const pathStat = await lstat(path)
  if (pathStat.isSymbolicLink()) {
    throw new Error(`workspace authority runtime directory must not be a symlink: ${path}`)
  }
  const canonical = await realpath(path)
  const stat = await lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`workspace authority runtime directory must be owned by the current user and mode 0700: ${path}`)
  }
}

async function removeStaleSocketOrThrow(path: string): Promise<void> {
  let stat
  try {
    stat = await lstat(path)
  } catch (error: any) {
    if (error?.code === "ENOENT") return
    throw error
  }
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) {
    throw new Error(`refusing to replace unsafe workspace authority socket: ${path}`)
  }

  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out probing workspace authority socket: ${path}`))
    }, 1_000)
    socket.once("connect", () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false)
      else reject(error)
    })
  })
  if (live) throw new Error(`workspace authority socket is already active: ${path}`)
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

function sameCredential(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function requestId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : "unknown"
}

function handleRequest(
  registry: WorkspaceAuthorityRegistry,
  expectedCredential: string,
  raw: unknown,
): WorkspaceAuthorityResponse {
  const input = raw as Partial<WorkspaceAuthorityRequest> | null
  const id = requestId(input?.id)
  if (!input || !sameCredential(input.credential, expectedCredential)) return { id, ok: false, error: "unauthorized" }

  try {
    if (input.operation === "issue") {
      const lease = registry.issue({ owner: input.owner!, agentId: input.agentId!, cwd: input.cwd!, ttlMs: input.ttlMs })
      return { id, ok: true, lease }
    }
    if (input.operation === "renew") {
      const lease = registry.renew(input.capability!, input.owner!, input.agentId!, input.ttlMs)
      return lease ? { id, ok: true, lease } : { id, ok: false, error: "not_found" }
    }
    if (input.operation === "revoke") {
      const revoked = registry.revoke(input.capability!, input.owner!, input.agentId!)
      return revoked ? { id, ok: true, revoked: 1 } : { id, ok: false, error: "not_found" }
    }
    if (input.operation === "revoke-agent") {
      return { id, ok: true, revoked: registry.revokeAgent(input.owner!, input.agentId!) }
    }
    return { id, ok: false, error: "invalid_request" }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    return { id, ok: false, error: message.includes("registry is full") ? "registry_full" : "invalid_request" }
  }
}

/**
 * Start a private newline-delimited JSON control socket. This is never started
 * unless a socket path is explicitly configured by the embedding process.
 */
export async function startWorkspaceAuthorityServer(
  config: WorkspaceAuthorityServerConfig,
  registry = new WorkspaceAuthorityRegistry(config),
): Promise<WorkspaceAuthorityServer> {
  if (!isAbsolute(config.socketPath)) throw new Error("workspace authority socketPath must be absolute")
  const credentialPath = config.credentialPath ?? `${config.socketPath}.credential`
  if (!isAbsolute(credentialPath)) throw new Error("workspace authority credentialPath must be absolute")
  if (credentialPath === config.socketPath) throw new Error("workspace authority socket and credential paths must differ")
  if (dirname(credentialPath) !== dirname(config.socketPath)) {
    throw new Error("workspace authority socket and credential must share a runtime directory")
  }

  await preparePrivateRuntimeDirectory(dirname(config.socketPath))
  await removeStaleSocketOrThrow(config.socketPath)

  const credential = randomBytes(32).toString("base64url")
  const maxFrameBytes = config.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const timeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS
  const sockets = new Set<Socket>()
  let server: Server | undefined
  let bound = false
  try {
    server = createServer((socket) => {
      sockets.add(socket)
      socket.setEncoding("utf8")
      socket.setTimeout(timeoutMs, () => socket.destroy())
      socket.on("close", () => sockets.delete(socket))
      let buffered = ""
      socket.on("data", (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf("\n")
        while (newline >= 0) {
          const frame = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (Buffer.byteLength(frame) > maxFrameBytes) {
            socket.destroy()
            return
          }
          if (frame) {
            let response: WorkspaceAuthorityResponse
            try {
              response = handleRequest(registry, credential, JSON.parse(frame))
            } catch {
              response = { id: "unknown", ok: false, error: "invalid_request" }
            }
            socket.write(`${JSON.stringify(response)}\n`)
          }
          newline = buffered.indexOf("\n")
        }
        if (Buffer.byteLength(buffered) > maxFrameBytes) socket.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(config.socketPath, () => {
        bound = true
        server!.off("error", reject)
        resolve()
      })
    })
    await chmod(config.socketPath, 0o600)
    await removeOwnedRuntimeEntry(credentialPath, "file")
    await writeFile(credentialPath, `${credential}\n`, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true })
  } catch (error) {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (bound) {
      await Promise.allSettled([
        removeOwnedRuntimeEntry(config.socketPath, "socket"),
        removeOwnedRuntimeEntry(credentialPath, "file"),
      ])
    }
    throw error
  }

  let closePromise: Promise<void> | undefined
  return {
    registry,
    socketPath: config.socketPath,
    credentialPath,
    close() {
      closePromise ??= (async () => {
        registry.clear()
        for (const socket of sockets) socket.destroy()
        const results = await Promise.allSettled([
          new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())),
          removeOwnedRuntimeEntry(config.socketPath, "socket"),
          removeOwnedRuntimeEntry(credentialPath, "file"),
        ])
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason)
        if (errors.length > 0) throw new AggregateError(errors, "failed to close workspace authority resources")
      })()
      return closePromise
    },
  }
}

export async function readWorkspaceAuthorityCredential(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim()
}
