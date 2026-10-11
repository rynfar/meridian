/**
 * Opt-in error reporting (src/errorReporting): what leaves the process, when,
 * and that the process lives or dies exactly as it would without it.
 *
 * The process-level behaviour is exercised in real child processes
 * (fixtures/error-reporter-child.ts) against a stub collector, because the
 * thing under test is how a runtime treats an uncaught exception and an
 * unhandled rejection, which an in-process test cannot provoke safely.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authHeader, buildEnvelope, buildEvent, parseDsn, parseStack, scrubSecrets } from "../errorReporting/event"
import {
  DETACHED_FLUSH_JOB_ENV,
  detachedFlushSource,
  flushSpool,
  installErrorReporter,
  REPORTER_CLIENT,
  resolveErrorReportingDsn,
} from "../errorReporting"
import { setSetting } from "../settings"

const CHILD = join(import.meta.dir, "fixtures", "error-reporter-child.ts")
const LEAK_MARKERS = [
  "bearermarkerbearermarker",
  "OATMARKEROATMARKER",
  "eyJhbGciOiJIUzI1NiJ9",
  "hunter2",
  "QUERYMARKER",
  "REFRESHMARKER",
]

interface Received {
  readonly path: string
  readonly auth: string | null
  readonly body: string
}

let collector: ReturnType<typeof Bun.serve>
const received: Received[] = []
let collectorStatuses: number[] = []
let dirs: string[] = []

beforeAll(() => {
  collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({ path: new URL(request.url).pathname, auth: request.headers.get("x-sentry-auth"), body: await request.text() })
      return new Response("{}", { status: collectorStatuses.shift() ?? 200 })
    },
  })
})

afterAll(() => {
  collector.stop(true)
})

afterEach(() => {
  received.length = 0
  collectorStatuses = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "meridian-error-reporting-"))
  dirs.push(dir)
  return dir
}

function liveDsn(): string {
  return `http://publickey@127.0.0.1:${collector.port}/42`
}

/** A DSN nothing listens on: bind a port, then release it. */
function deadDsn(): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  return `http://publickey@127.0.0.1:${port}/42`
}

async function runChild(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, CHILD], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MERIDIAN_CONFIG_DIR: process.env.MERIDIAN_CONFIG_DIR ?? "", ...env },
    stdout: "ignore",
    stderr: "pipe",
  })
  const stderr = await new Response(child.stderr).text()
  return { code: await child.exited, stderr }
}

function spooled(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25)
}

function eventOf(envelope: string): { level: string; release?: string; exception: { values: Array<{ value: string; mechanism: { type: string; handled: boolean } }> } } {
  const lines = envelope.trimEnd().split("\n")
  return JSON.parse(lines[2]!)
}

describe("scrubSecrets", () => {
  it("removes every token shape Meridian's errors can carry and keeps the context", () => {
    const scrubbed = scrubSecrets(
      "401 from https://user:pw@api.example.com/v1/x?key=abc&sig=def with Authorization: Bearer abc.def-ghi "
      + "token sk-ant-ort01-AAAAAAAAAAAAAAAA and eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig-nature "
      + "google ya29.a0AfH6SMBxxxxxxxxxxx refresh 1//0gAAAAAAAAAAAAAAAAAAAAAA "
      + "{\"access_token\":\"abc123\",\"client_secret\":\"xyz\"} opaque 0123456789abcdefABCDEF0123456789abcdef",
    )
    for (const secret of ["user:pw", "key=abc", "sig=def", "abc.def-ghi", "sk-ant-ort01", "eyJhbGci", "ya29.", "1//0gAAA", "abc123", "\"xyz\"", "0123456789abcdefABCDEF"]) {
      expect(scrubbed).not.toContain(secret)
    }
    expect(scrubbed).toContain("401 from https://<redacted>@api.example.com/v1/x?<redacted>")
    expect(scrubbed).toContain("Bearer <redacted>")
    expect(scrubbed).toContain("\"access_token\":\"<redacted>")
  })

  it("leaves ordinary diagnostics alone", () => {
    const message = "ENOENT: no such file or directory, open '/home/u/.config/meridian/profiles.json' (max_tokens: 4096)"
    expect(scrubSecrets(message)).toBe(message)
  })
})

describe("event and envelope", () => {
  it("parses a DSN into the envelope endpoint and key", () => {
    expect(parseDsn("https://k3y@glitchtip.example.com/7")).toEqual({ envelopeUrl: "https://glitchtip.example.com/api/7/envelope/", publicKey: "k3y" })
    expect(parseDsn("http://k@host:8000/sub/path/12")).toEqual({ envelopeUrl: "http://host:8000/sub/path/api/12/envelope/", publicKey: "k" })
    expect(parseDsn("https://host/7")).toBeNull()
    expect(parseDsn("https://k@host/notanumber")).toBeNull()
    expect(parseDsn("not a url")).toBeNull()
    expect(authHeader("k", "c/1")).toBe("Sentry sentry_version=7, sentry_client=c/1, sentry_key=k")
  })

  it("marks package frames in-app with package-relative names, outermost first", () => {
    const frames = parseStack([
      "Error: x",
      "    at inner (/opt/meridian/src/proxy/server.ts:10:5)",
      "    at dep (/opt/meridian/node_modules/hono/dist/index.js:1:1)",
      "    at async outer (file:///elsewhere/app.js:3:4)",
    ].join("\n"), "/opt/meridian")
    expect(frames.map((frame) => [frame.filename, frame.in_app])).toEqual([
      ["/elsewhere/app.js", false],
      ["node_modules/hono/dist/index.js", false],
      ["src/proxy/server.ts", true],
    ])
  })

  it("sends only the exception, release and runtime, scrubbed, including the cause chain", () => {
    const thrown = new Error("outer Bearer secretvalue123", { cause: new Error("inner sk-proj-ABCDEFGHIJKL") })
    const event = buildEvent({
      eventId: "0".repeat(32), timestampMs: 1_000, thrown, mechanism: "onuncaughtexception", handled: true,
      packageRoot: "/nowhere", runtime: { name: "bun", version: "1" }, release: "meridian@1.0.0",
    })
    expect(Object.keys(event).sort()).toEqual(["contexts", "environment", "event_id", "exception", "level", "logger", "platform", "release", "tags", "timestamp"])
    expect(event.exception.values.map((value) => value.value)).toEqual(["inner <redacted>", "outer Bearer <redacted>"])
    const envelope = buildEnvelope(event).split("\n")
    expect(JSON.parse(envelope[0]!)).toEqual({ event_id: "0".repeat(32) })
    expect(JSON.parse(envelope[1]!)).toEqual({ type: "event", content_type: "application/json", length: Buffer.byteLength(envelope[2]!) })
  })
})

describe("delivery", () => {
  function spoolFiles(dir: string, count: number): void {
    mkdirSync(dir, { recursive: true })
    for (let index = 0; index < count; index++) writeFileSync(join(dir, `00000000${index}-event.json`), `envelope-${index}\n`)
  }

  it("drops what the collector refuses for good, and stops at the first retryable answer", async () => {
    const dir = join(tempDir(), "spool")
    spoolFiles(dir, 5)
    collectorStatuses = [200, 400, 413, 429]
    expect(await flushSpool(dir, liveDsn())).toEqual({ delivered: 1, rejected: 2, retained: 2 })
    expect(received.map((request) => request.body)).toEqual(["envelope-0\n", "envelope-1\n", "envelope-2\n", "envelope-3\n"])
    expect(spooled(dir)).toHaveLength(2)

    collectorStatuses = [503]
    expect(await flushSpool(dir, liveDsn())).toEqual({ delivered: 0, rejected: 0, retained: 2 })
    expect(await flushSpool(dir, liveDsn())).toEqual({ delivered: 2, rejected: 0, retained: 0 })
    expect(spooled(dir)).toEqual([])
  })

  it("keeps everything when nothing answers", async () => {
    const dir = join(tempDir(), "spool")
    spoolFiles(dir, 2)
    expect(await flushSpool(dir, deadDsn())).toEqual({ delivered: 0, rejected: 0, retained: 2 })
    expect(spooled(dir)).toHaveLength(2)
  })

  // The dying process hands delivery to `node -e` / `bun -e` with the function's
  // own source; running that program under Node proves it is self-contained.
  it.skipIf(Bun.which("node") === null)("the detached delivery program runs under Node", async () => {
    const dir = join(tempDir(), "spool")
    spoolFiles(dir, 1)
    const parsed = parseDsn(liveDsn())!
    const job = { dir, envelopeUrl: parsed.envelopeUrl, auth: authHeader(parsed.publicKey, REPORTER_CLIENT) }
    const child = Bun.spawn([Bun.which("node")!, "-e", detachedFlushSource()], {
      env: { PATH: process.env.PATH ?? "", [DETACHED_FLUSH_JOB_ENV]: JSON.stringify(job) },
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" })
    expect(received.map((request) => [request.path, request.body])).toEqual([["/api/42/envelope/", "envelope-0\n"]])
    expect(spooled(dir)).toEqual([])
  })
})

describe("configuration", () => {
  afterEach(() => {
    delete process.env.MERIDIAN_ERROR_REPORTING_DSN
    setSetting("errorReportingDsn", undefined)
  })

  it("is off by default: no listener attached", () => {
    const before = [process.listenerCount("uncaughtExceptionMonitor"), process.listenerCount("unhandledRejection")]
    expect(resolveErrorReportingDsn()).toBeUndefined()
    expect(installErrorReporter({ spoolDir: tempDir() })).toBe(false)
    expect([process.listenerCount("uncaughtExceptionMonitor"), process.listenerCount("unhandledRejection")]).toEqual(before)
  })

  it("reads settings.json, and the environment wins", () => {
    setSetting("errorReportingDsn", "https://a@settings.example/1")
    expect(resolveErrorReportingDsn()).toBe("https://a@settings.example/1")
    process.env.MERIDIAN_ERROR_REPORTING_DSN = "https://b@env.example/2"
    expect(resolveErrorReportingDsn()).toBe("https://b@env.example/2")
  })

  it("stays off, without echoing the value, when the DSN is malformed", () => {
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
    try {
      expect(installErrorReporter({ dsn: "https://no-project-id-secretvalue@host/", spoolDir: tempDir() })).toBe(false)
    } finally {
      console.error = original
    }
    expect(errors.join("\n")).not.toContain("secretvalue")
  })
})

describe("in a real process", () => {
  it("off: nothing spooled and nothing sent, and the crash is unchanged", async () => {
    const spool = join(tempDir(), "spool")
    const result = await runChild({ REPORTER_SPOOL: spool, REPORTER_FAIL: "throw" })
    expect(result.code).not.toBe(0)
    expect(existsSync(spool)).toBe(false)
    expect(received).toEqual([])
  })

  it("on: an uncaught exception and an unhandled rejection reach the collector scrubbed, and the process survives as the CLI makes it", async () => {
    const spool = join(tempDir(), "spool")
    const result = await runChild({
      REPORTER_DSN: liveDsn(), REPORTER_SPOOL: spool, REPORTER_RECOVER: "1", REPORTER_FAIL: "throw,reject", REPORTER_LINGER_MS: "1500",
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("Uncaught exception (recovered)")
    await waitFor(() => received.length >= 2)
    expect(received).toHaveLength(2)
    for (const request of received) {
      expect(request.path).toBe("/api/42/envelope/")
      expect(request.auth).toContain("sentry_key=publickey")
      for (const secret of LEAK_MARKERS) expect(request.body).not.toContain(secret)
    }
    const mechanisms = received.map((request) => eventOf(request.body).exception.values[0]!.mechanism).sort((a, b) => a.type.localeCompare(b.type))
    expect(mechanisms).toEqual([{ type: "onuncaughtexception", handled: true }, { type: "onunhandledrejection", handled: true }])
    expect(eventOf(received[0]!.body).release).toBe("meridian@0.0.0-test")
    expect(spooled(spool)).toEqual([])
  })

  it("a crash still crashes, exactly as without the reporter, and the fatal event is delivered after the process is gone", async () => {
    const spool = join(tempDir(), "spool")
    let releaseResponse: (() => void) | undefined
    const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve })
    const heldCollector = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        received.push({ path: new URL(request.url).pathname, auth: request.headers.get("x-sentry-auth"), body: await request.text() })
        await responseReady
        return new Response("{}", { status: 200 })
      },
    })
    const entries = () => existsSync(spool) ? readdirSync(spool) : []
    try {
      const baseline = await runChild({ REPORTER_SPOOL: join(tempDir(), "unused"), REPORTER_FAIL: "throw" })
      const crashed = await runChild({ REPORTER_DSN: `http://publickey@127.0.0.1:${heldCollector.port}/42`, REPORTER_SPOOL: spool, REPORTER_FAIL: "throw" })
      expect(baseline.code).not.toBe(0)
      expect(crashed.code).toBe(baseline.code)
      expect(crashed.stderr).toContain("thrown")
      await waitFor(() => received.length === 1)
      expect(received).toHaveLength(1)
      // Receiving the envelope precedes the response and claim removal.
      // An empty .json-only view cannot establish detached delivery completion.
      expect(spooled(spool)).toEqual([])
      expect(entries()).toHaveLength(1)
      expect(entries()[0]).toMatch(/\.json\.sending-\d+$/)
      const event = eventOf(received[0]!.body)
      expect(event.level).toBe("fatal")
      expect(event.exception.values[0]!.mechanism).toEqual({ type: "onuncaughtexception", handled: false })
      for (const secret of LEAK_MARKERS) expect(received[0]!.body).not.toContain(secret)
      releaseResponse?.()
      await waitFor(() => received.length === 1 && entries().length === 0)
      expect(received).toHaveLength(1)
      expect(entries()).toEqual([])
    } finally {
      releaseResponse?.()
      await waitFor(() => entries().length === 0)
      heldCollector.stop(true)
    }
  })

  it("an unhandled rejection with no other listener still exits as it would without the reporter, recorded once", async () => {
    for (const failure of ["reject", "reject-undefined"]) {
      const spool = join(tempDir(), "spool")
      const posted: string[] = []
      let releaseResponse: (() => void) | undefined
      const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve })
      const unavailable = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          posted.push(await request.text())
          await responseReady
          return new Response("unavailable", { status: 503 })
        },
      })
      try {
        const baseline = await runChild({ REPORTER_SPOOL: join(tempDir(), "unused"), REPORTER_FAIL: failure })
        const withReporter = await runChild({
          REPORTER_DSN: `http://publickey@127.0.0.1:${unavailable.port}/42`, REPORTER_SPOOL: spool, REPORTER_FAIL: failure,
        })
        expect(baseline.code).not.toBe(0)
        expect(withReporter.code).toBe(baseline.code)
        await waitFor(() => posted.length > 0)
        expect(posted).toHaveLength(1)

        // A dying process does not join its detached delivery child. Before
        // that child claims the file, an initial JSON snapshot is not settled.
        // Hold the response to witness the claim, then require retry restoration.
        const claimed = readdirSync(spool)
        expect(claimed).toHaveLength(1)
        expect(claimed[0]).toMatch(/\.json\.sending-\d+$/)
        releaseResponse?.()
        await waitFor(() => {
          const files = readdirSync(spool)
          return files.length === 1 && files[0]!.endsWith(".json")
        })
        const settled = readdirSync(spool)
        expect(settled).toHaveLength(1)
        expect(settled[0]).toMatch(/\.json$/)
        expect(posted).toHaveLength(1)
        expect(readFileSync(join(spool, settled[0]!), "utf8")).toBe(posted[0]!)
        expect(eventOf(posted[0]!).exception.values[0]!.mechanism).toEqual({ type: "onunhandledrejection", handled: false })
      } finally {
        releaseResponse?.()
        unavailable.stop(true)
      }
    }
  })

  it("collector down: nothing throws, the process lives, the events wait and the next start delivers them", async () => {
    const spool = join(tempDir(), "spool")
    const result = await runChild({
      REPORTER_DSN: deadDsn(), REPORTER_SPOOL: spool, REPORTER_RECOVER: "1", REPORTER_FAIL: "throw,reject", REPORTER_LINGER_MS: "1500",
    })
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain("error-report")
    expect(spooled(spool)).toHaveLength(2)

    const restarted = await runChild({ REPORTER_DSN: liveDsn(), REPORTER_SPOOL: spool, REPORTER_LINGER_MS: "1500" })
    expect(restarted.code).toBe(0)
    expect(received).toHaveLength(2)
    expect(spooled(spool)).toEqual([])
  })
})
