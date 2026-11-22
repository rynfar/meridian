/**
 * Shared pieces of the stopped-turn gate (E79, scripts/e2e-client-abort-resume.mjs):
 * a scripted Messages API upstream, the built Meridian server in its own Node
 * process, and a recording relay between a real client and that server.
 */
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { observeChildClosure, stopAndJoinChild } from "./e2eProcessCustody.mjs"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Text of a Messages API content value, tool results included. */
export function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((block) => block?.type === "text" ? block.text ?? ""
    : block?.type === "tool_result" ? contentText(block.content) : "").join("\n")
}

/**
 * A scripted upstream for the SDK child's Messages API calls. A request whose
 * last user message `slowWhen` selects streams `400` numbered lines slowly, so
 * a client can stop it mid-stream; everything else answers "ok" at once. Each
 * request is recorded as `{ slow, all }`, `all` being its whole message text.
 */
export function startScriptedUpstream({ port, slowWhen, lineDelayMs = 25 }) {
  const requests = []
  const server = Bun.serve({
    port, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method !== "POST" || path !== "/v1/messages") {
        return Response.json(path.endsWith("count_tokens") ? { input_tokens: 100 } : {})
      }
      const body = await request.json()
      const messages = body.messages ?? []
      const lastUser = [...messages].reverse().find((m) => m.role === "user")
      const slow = slowWhen(contentText(lastUser?.content))
      requests.push({ slow, all: messages.map((m) => `${m.role}: ${contentText(m.content)}`).join("\n") })
      const usage = { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      const id = `msg_fixture_${requests.length}`
      if (!body.stream) {
        return Response.json({ id, type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage })
      }
      const encoder = new TextEncoder()
      let cancelled = false
      return new Response(new ReadableStream({
        async start(controller) {
          const ev = (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`))
          ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [],
            stop_reason: null, stop_sequence: null, usage } })
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
          for (let n = 1; n <= (slow ? 400 : 1) && !cancelled; n++) {
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: slow ? `${n}\n` : "ok" } })
            if (slow) await sleep(lineDelayMs)
          }
          if (cancelled) return
          ev("content_block_stop", { index: 0 })
          ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })
          ev("message_stop", {})
          controller.close()
        },
        cancel() { cancelled = true },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  return { requests, stop: () => server.stop(true) }
}

/**
 * The built Meridian (`<root>/dist/cli.js`) under Node in its own process,
 * with its config, store, telemetry and workdir under `dir`. `env` adds or
 * overrides server variables (HOME and credentials are the caller's choice).
 */
export async function startMeridianServer({ root, node, port, dir, env }) {
  const paths = { workdir: join(dir, "workdir"), store: join(dir, "store"), config: join(dir, "config") }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  const serverEnv = {
    PATH: process.env.PATH, USER: process.env.USER, LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR,
    HOME: process.env.HOME,
    MERIDIAN_PORT: String(port), MERIDIAN_HOST: "127.0.0.1",
    MERIDIAN_CONFIG_DIR: paths.config, MERIDIAN_SESSION_DIR: paths.store, MERIDIAN_WORKDIR: paths.workdir,
    MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_TELEMETRY_DB: join(dir, "telemetry.db"),
    MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_UPDATE_CHECK_PATH: join(dir, "update-check.json"),
    MERIDIAN_DESIGN_TOKEN_PATH: join(dir, "design-token.json"),
    MERIDIAN_CREDENTIALS_READONLY: "1", OPENCODE_CLAUDE_PROVIDER_DEBUG: "1",
    ...env,
  }
  const log = []
  const child = spawn(node, [join(root, "dist/cli.js")], { cwd: paths.workdir, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] })
  const witness = observeChildClosure(child)
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf("\n")) >= 0) { log.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1) }
    })
  }
  const base = `http://127.0.0.1:${port}`
  const stop = async () => {
    writeFileSync(join(dir, "server.log"), log.join("\n"))
    return stopAndJoinChild(child, witness)
  }
  const deadline = Date.now() + 60_000
  let lastError = "no response"
  for (;;) {
    // A refused connection is expected until the server listens.
    const probe = await fetch(`${base}/health`).then((r) => r.ok ? r.json() : `HTTP ${r.status}`,
      (error) => (error instanceof Error ? error.message : String(error)))
    if (typeof probe === "object") {
      const build = probe.build ?? {}
      return { base, log, paths, stop, health: { version: probe.version, claudeExecutable: probe.claudeExecutable?.source,
        build: { sha: build.sha, sourceHash: build.sourceHash, certification: build.certification, dirty: build.dirty,
          displayVersion: build.displayVersion, source: build.source } } }
    }
    lastError = probe
    if (Date.now() > deadline || witness.state.exitSeen) {
      await stop()
      throw new Error(`server did not start (${lastError}): ${log.slice(-5).join(" | ")}`)
    }
    await sleep(500)
  }
}

/** Server variables that point the SDK child at the scripted upstream. */
export function scriptedUpstreamEnv({ upstreamPort, home }) {
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    MERIDIAN_PROFILES: JSON.stringify([{ id: "fixture", type: "api", apiKey: "fixture-no-live-credential",
      baseUrl: `http://127.0.0.1:${upstreamPort}` }]),
  }
}

/**
 * A relay between a real client and Meridian that records each request's
 * identity headers (signed values redacted) and Messages API role shape, and
 * forwards it, propagating the client's disconnect.
 */
export function startRecordingRelay({ port, target }) {
  const relayed = []
  const server = Bun.serve({
    port, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const raw = request.method === "POST" ? await request.text() : undefined
      let shape
      if (url.pathname.endsWith("/messages") && raw) {
        shape = (JSON.parse(raw).messages ?? []).map((m) =>
          `${m.role}[${typeof m.content === "string" ? "string" : (m.content ?? []).map((b) => b.type).join(",")}]`)
      }
      relayed.push({ at: Date.now(), method: request.method, path: url.pathname,
        headers: Object.fromEntries([...request.headers]
          .filter(([k]) => k.startsWith("x-meridian") || k.startsWith("x-opencode") || k === "x-session-affinity" || k === "user-agent")
          .map(([k, v]) => [k, k.includes("turn") ? "<signed>" : v])),
        ...(shape ? { shape } : {}) })
      const headers = new Headers(request.headers)
      headers.delete("host")
      return fetch(`${target}${url.pathname}${url.search}`, { method: request.method, headers, body: raw, signal: request.signal })
    },
  })
  return { relayed, stop: () => server.stop(true) }
}
