import { afterEach, describe, expect, it } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  WorkspaceAuthorityRegistry,
  startWorkspaceAuthorityServer,
  type WorkspaceAuthorityRequest,
  type WorkspaceAuthorityResponse,
  type WorkspaceAuthorityServer,
} from "../proxy/workspaceAuthority"
import { createProxyServer, startProxyServer } from "../proxy/server"

const tempPaths: string[] = []
const servers: WorkspaceAuthorityServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})))
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function privateRuntimeDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "meridian-authority-"))
  tempPaths.push(path)
  await chmod(path, 0o700)
  return path
}

async function startTestServer(options: Record<string, unknown> = {}) {
  const runtimeDir = await privateRuntimeDir()
  const server = await startWorkspaceAuthorityServer({
    socketPath: join(runtimeDir, "control.sock"),
    ...options,
  })
  servers.push(server)
  const credential = (await readFile(server.credentialPath, "utf8")).trim()
  return { server, credential, runtimeDir }
}

async function exchange(socketPath: string, requests: WorkspaceAuthorityRequest[]): Promise<WorkspaceAuthorityResponse[]> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const responses: WorkspaceAuthorityResponse[] = []
    let buffered = ""
    socket.setEncoding("utf8")
    socket.once("error", reject)
    socket.on("data", (chunk) => {
      buffered += chunk
      let newline = buffered.indexOf("\n")
      while (newline >= 0) {
        responses.push(JSON.parse(buffered.slice(0, newline)))
        buffered = buffered.slice(newline + 1)
        if (responses.length === requests.length) {
          socket.end()
          resolve(responses)
          return
        }
        newline = buffered.indexOf("\n")
      }
    })
    socket.once("connect", () => {
      socket.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n")
    })
  })
}

describe("WorkspaceAuthorityRegistry", () => {
  it("binds opaque capabilities to owner, agent, cwd, and expiry", () => {
    let now = 1_000
    const registry = new WorkspaceAuthorityRegistry({ now: () => now, defaultTtlMs: 100, maxTtlMs: 1_000 })
    const lease = registry.issue({ owner: "paseo", agentId: "agent-1", cwd: "/srv/worktree" })

    expect(lease.capability).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(registry.resolve(lease.capability)).toEqual(lease)
    expect(lease).toMatchObject({ owner: "paseo", agentId: "agent-1", cwd: "/srv/worktree", expiresAt: 1_100 })

    now = 1_100
    expect(registry.resolve(lease.capability)).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it("fails closed for mismatched ownership and post-revoke replay", () => {
    const registry = new WorkspaceAuthorityRegistry()
    const lease = registry.issue({ owner: "paseo", agentId: "agent-1", cwd: "/srv/a" })

    expect(registry.renew(lease.capability, "paseo", "agent-2")).toBeUndefined()
    expect(registry.revoke(lease.capability, "other", "agent-1")).toBe(false)
    expect(registry.revoke(lease.capability, "paseo", "agent-1")).toBe(true)
    expect(registry.resolve(lease.capability)).toBeUndefined()
    expect(registry.renew(lease.capability, "paseo", "agent-1")).toBeUndefined()
  })

  it("renews live leases without changing capability identity", () => {
    let now = 10
    const registry = new WorkspaceAuthorityRegistry({ now: () => now, defaultTtlMs: 20, maxTtlMs: 100 })
    const lease = registry.issue({ owner: "paseo", agentId: "agent-1", cwd: "/srv/a" })
    now = 15
    const renewed = registry.renew(lease.capability, "paseo", "agent-1", 50)

    expect(renewed).toMatchObject({ capability: lease.capability, expiresAt: 65 })
  })

  it("bounds live storage but prunes expired entries before rejecting", () => {
    let now = 0
    let sequence = 0
    const registry = new WorkspaceAuthorityRegistry({
      now: () => now,
      defaultTtlMs: 10,
      maxTtlMs: 10,
      maxEntries: 2,
      mintCapability: () => `capability-${++sequence}`,
    })
    registry.issue({ owner: "paseo", agentId: "a", cwd: "/srv/a" })
    registry.issue({ owner: "paseo", agentId: "b", cwd: "/srv/b" })
    expect(() => registry.issue({ owner: "paseo", agentId: "c", cwd: "/srv/c" })).toThrow("registry is full")

    now = 10
    expect(registry.issue({ owner: "paseo", agentId: "c", cwd: "/srv/c" })).toBeDefined()
    expect(registry.size).toBe(1)
  })

  it("revokes every lease for a terminated agent without touching peers", () => {
    const registry = new WorkspaceAuthorityRegistry()
    const first = registry.issue({ owner: "paseo", agentId: "a", cwd: "/srv/a" })
    registry.issue({ owner: "paseo", agentId: "a", cwd: "/srv/a" })
    const peer = registry.issue({ owner: "paseo", agentId: "b", cwd: "/srv/b" })

    expect(registry.revokeAgent("paseo", "a")).toBe(2)
    expect(registry.resolve(first.capability)).toBeUndefined()
    expect(registry.resolve(peer.capability)).toEqual(peer)
  })

  it("rejects malformed identity, cwd, and TTL inputs", () => {
    const registry = new WorkspaceAuthorityRegistry()
    expect(() => registry.issue({ owner: "", agentId: "a", cwd: "/srv/a" })).toThrow()
    expect(() => registry.issue({ owner: "paseo", agentId: "a", cwd: "relative" })).toThrow()
    expect(() => registry.issue({ owner: "paseo", agentId: "a", cwd: "/srv/a", ttlMs: 0 })).toThrow()
  })
})

describe("workspace authority Unix control server", () => {
  it("is absent unless explicitly configured", () => {
    expect(createProxyServer().workspaceAuthorityRegistry).toBeUndefined()
  })

  it("is owned by the proxy lifecycle when explicitly configured", async () => {
    const runtimeDir = await privateRuntimeDir()
    const socketPath = join(runtimeDir, "control.sock")
    const proxy = await startProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      workspaceAuthority: { socketPath },
    })
    expect((await lstat(socketPath)).isSocket()).toBe(true)
    expect((await lstat(`${socketPath}.credential`)).isFile()).toBe(true)

    await proxy.close()
    expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(lstat(`${socketPath}.credential`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("releases the HTTP listener even when authority artifact cleanup fails", async () => {
    const runtimeDir = await privateRuntimeDir()
    const socketPath = join(runtimeDir, "control.sock")
    const proxy = await startProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      workspaceAuthority: { socketPath },
    })
    const port = (proxy.server.address() as { port: number }).port
    await unlink(`${socketPath}.credential`)
    await mkdir(`${socketPath}.credential`)

    await expect(proxy.close()).rejects.toThrow("failed to close all Meridian resources")
    const verifier = createHttpServer()
    await new Promise<void>((resolve, reject) => {
      verifier.once("error", reject)
      verifier.listen(port, "127.0.0.1", resolve)
    })
    await new Promise<void>((resolve) => verifier.close(() => resolve()))
  })

  it("rolls back the HTTP server when control startup fails", async () => {
    const runtimeDir = await privateRuntimeDir()
    const socketPath = join(runtimeDir, "control.sock")
    await chmod(runtimeDir, 0o755)
    const portProbe = createHttpServer()
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve))
    const port = (portProbe.address() as { port: number }).port
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))
    await expect(startProxyServer({
      port,
      host: "127.0.0.1",
      silent: true,
      workspaceAuthority: { socketPath },
    })).rejects.toThrow("mode 0700")

    expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(lstat(`${socketPath}.credential`)).rejects.toMatchObject({ code: "ENOENT" })
    const verifier = createHttpServer()
    await new Promise<void>((resolve, reject) => {
      verifier.once("error", reject)
      verifier.listen(port, "127.0.0.1", resolve)
    })
    await new Promise<void>((resolve) => verifier.close(() => resolve()))
  })

  it("does not start control authority when the HTTP listener cannot bind", async () => {
    const runtimeDir = await privateRuntimeDir()
    const socketPath = join(runtimeDir, "control.sock")
    const holder = createHttpServer()
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve))
    const port = (holder.address() as { port: number }).port
    try {
      await expect(startProxyServer({
        port,
        host: "127.0.0.1",
        silent: true,
        workspaceAuthority: { socketPath },
      })).rejects.toMatchObject({ code: "EADDRINUSE" })
      expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" })
      expect(lstat(`${socketPath}.credential`)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
  })

  it("creates private runtime artifacts and removes them with all leases on close", async () => {
    const { server } = await startTestServer()
    const socketStat = await lstat(server.socketPath)
    const credentialStat = await lstat(server.credentialPath)
    expect(socketStat.mode & 0o777).toBe(0o600)
    expect(credentialStat.mode & 0o777).toBe(0o600)

    server.registry.issue({ owner: "paseo", agentId: "a", cwd: "/srv/a" })
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    expect(server.registry.size).toBe(0)
    expect(lstat(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(lstat(server.credentialPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("handles independently framed operations on one connection", async () => {
    const { server, credential } = await startTestServer()
    const responses = await exchange(server.socketPath, [
      { id: "one", credential, operation: "issue", owner: "paseo", agentId: "a", cwd: "/srv/a" },
      { id: "two", credential, operation: "issue", owner: "paseo", agentId: "b", cwd: "/srv/b" },
    ])

    expect(responses.map((response) => response.id)).toEqual(["one", "two"])
    expect(responses.every((response) => response.ok)).toBe(true)
    expect(server.registry.size).toBe(2)
  })

  it("refuses a duplicate start without disrupting the live server", async () => {
    const { server, credential } = await startTestServer()
    await expect(startWorkspaceAuthorityServer({ socketPath: server.socketPath }))
      .rejects.toThrow("already active")

    const [response] = await exchange(server.socketPath, [{
      id: "still-live",
      credential,
      operation: "issue",
      owner: "paseo",
      agentId: "agent",
      cwd: "/srv/a",
    }])
    expect(response?.ok).toBe(true)
    expect((await readFile(server.credentialPath, "utf8")).trim()).toBe(credential)
  })

  it("accepts a batch larger than the per-frame limit when each frame is valid", async () => {
    const { server, credential } = await startTestServer({ maxFrameBytes: 256 })
    const requests = Array.from({ length: 8 }, (_, index): WorkspaceAuthorityRequest => ({
      id: `batch-${index}`,
      credential,
      operation: "issue",
      owner: "paseo",
      agentId: `agent-${index}`,
      cwd: `/srv/${index}`,
    }))
    expect(Buffer.byteLength(requests.map((request) => JSON.stringify(request)).join("\n"))).toBeGreaterThan(256)
    const responses = await exchange(server.socketPath, requests)
    expect(responses).toHaveLength(8)
    expect(responses.every((response) => response.ok)).toBe(true)
  })

  it("isolates concurrent clients and preserves request ids", async () => {
    const { server, credential } = await startTestServer({ maxEntries: 64 })
    const responses = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
      return (await exchange(server.socketPath, [{
        id: `request-${index}`,
        credential,
        operation: "issue",
        owner: "paseo",
        agentId: `agent-${index}`,
        cwd: `/srv/${index}`,
      }]))[0]
    }))

    expect(new Set(responses.map((response) => response?.id)).size).toBe(32)
    expect(responses.every((response) => response?.ok)).toBe(true)
    expect(server.registry.size).toBe(32)
  })

  it("rejects invalid credentials without revealing registry state", async () => {
    const { server } = await startTestServer()
    const [response] = await exchange(server.socketPath, [{
      id: "bad-auth",
      credential: "not-the-credential",
      operation: "issue",
      owner: "paseo",
      agentId: "agent",
      cwd: "/srv/a",
    }])
    expect(response).toEqual({ id: "bad-auth", ok: false, error: "unauthorized" })
    expect(server.registry.size).toBe(0)
  })

  it("supports owner-bound renew and cleanup operations", async () => {
    const { server, credential } = await startTestServer()
    const [issued] = await exchange(server.socketPath, [{
      id: "issue",
      credential,
      operation: "issue",
      owner: "paseo",
      agentId: "agent",
      cwd: "/srv/a",
    }])
    if (!issued?.ok || !issued.lease) throw new Error("expected issued lease")

    const responses = await exchange(server.socketPath, [
      { id: "wrong", credential, operation: "renew", owner: "paseo", agentId: "other", capability: issued.lease.capability },
      { id: "cleanup", credential, operation: "revoke-agent", owner: "paseo", agentId: "agent" },
      { id: "replay", credential, operation: "renew", owner: "paseo", agentId: "agent", capability: issued.lease.capability },
    ])
    expect(responses).toEqual([
      { id: "wrong", ok: false, error: "not_found" },
      { id: "cleanup", ok: true, revoked: 1 },
      { id: "replay", ok: false, error: "not_found" },
    ])
  })

  it("fails before binding when the configured runtime directory is not private", async () => {
    const runtimeDir = await privateRuntimeDir()
    await chmod(runtimeDir, 0o755)
    await expect(startWorkspaceAuthorityServer({ socketPath: join(runtimeDir, "control.sock") }))
      .rejects.toThrow("mode 0700")
  })

  it("requires owner permissions to be exactly mode 0700", async () => {
    const runtimeDir = await privateRuntimeDir()
    await chmod(runtimeDir, 0o500)
    try {
      await expect(startWorkspaceAuthorityServer({ socketPath: join(runtimeDir, "control.sock") }))
        .rejects.toThrow("mode 0700")
    } finally {
      await chmod(runtimeDir, 0o700)
    }
  })

  it("drops oversized frames", async () => {
    const { server } = await startTestServer({ maxFrameBytes: 64 })
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(server.socketPath)
      socket.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve()
        else reject(error)
      })
      socket.once("close", () => resolve())
      socket.once("connect", () => socket.write("x".repeat(65)))
    })
    expect(server.registry.size).toBe(0)
  })

  it("can restart cleanly after an orderly shutdown", async () => {
    const runtimeDir = await privateRuntimeDir()
    const socketPath = join(runtimeDir, "control.sock")
    const first = await startWorkspaceAuthorityServer({ socketPath })
    await first.close()
    await mkdir(runtimeDir, { recursive: true })

    const second = await startWorkspaceAuthorityServer({ socketPath })
    servers.push(second)
    expect(second.socketPath).toBe(socketPath)
  })
})
