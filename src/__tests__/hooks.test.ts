/**
 * Event hooks (proxy/hooks.ts): what a webhook and a command receive, how a
 * slow or broken target is bounded, and that nothing credential-bearing - a
 * webhook's path, a command's arguments - reaches the log.
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createHookDispatcher,
  hookProgramName,
  hookTargetLabel,
  parseHookSettings,
  resolveHookTargets,
  type HookTarget,
} from "../proxy/hooks"

const INSTANCE = { host: "test-host", pid: 4242, port: 3459, version: "1.0.0" }

function dispatcher(targets: HookTarget[], extra: Partial<Parameters<typeof createHookDispatcher>[0]> = {}) {
  const logged: string[] = []
  const hooks = createHookDispatcher({ targets: () => targets, instance: () => INSTANCE, log: line => { logged.push(line) }, ...extra })
  return { hooks, logged }
}

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "meridian-hooks-"))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("command hooks", () => {
  it("hand the event over on stdin, never in argv, and report the first line of output", async () => {
    const { dir, done } = scratch()
    try {
      const out = join(dir, "event.json")
      const args = join(dir, "args.txt")
      const command = `cat > ${out}; echo "$MERIDIAN_HOOK_EVENT $#" > ${args}; echo "relayed to laptop"; echo second line`
      const { hooks, logged } = dispatcher([{ kind: "command", value: command, source: "settings" }])
      const [delivery] = await hooks.emit("oauth.callback.listening", { callback: { id: "cb1" } })
      expect(delivery).toMatchObject({ ok: true, detail: "relayed to laptop", target: "command cat", source: "settings" })
      const event = JSON.parse(readFileSync(out, "utf8"))
      expect(event).toMatchObject({ version: 1, event: "oauth.callback.listening", instance: INSTANCE, callback: { id: "cb1" } })
      expect(typeof event.id).toBe("string")
      expect(Number.isNaN(Date.parse(event.at))).toBe(false)
      expect(readFileSync(args, "utf8").trim()).toBe("oauth.callback.listening 0")
      expect(logged.join("\n")).not.toContain(out)
    } finally {
      done()
    }
  })

  it("fail with the exit code and the last thing the command said on stderr", async () => {
    const { hooks } = dispatcher([{ kind: "command", value: "echo first >&2; echo 'port 1455 in use' >&2; exit 3", source: "env" }])
    const [delivery] = await hooks.emit("oauth.callback.closed", {})
    expect(delivery).toMatchObject({ ok: false, detail: "exit 3: port 1455 in use", source: "env" })
  })

  it("stop a command that outlives its timeout, together with what it started", async () => {
    // The background sleep inherits the command's stdout, and a delivery ends
    // only once every holder of it has exited, so answering long before the
    // sleep would is proof that the whole process group was stopped.
    const { hooks } = dispatcher([{ kind: "command", value: "sleep 30 & wait", source: "settings" }], { commandTimeoutMs: 200 })
    const started = Date.now()
    const [delivery] = await hooks.emit("hooks.test", {})
    expect(delivery).toMatchObject({ ok: false, detail: "no answer in 0.2s, stopped" })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it("does not count a command that never reads stdin as failed", async () => {
    const { hooks } = dispatcher([{ kind: "command", value: "true", source: "settings" }])
    const [delivery] = await hooks.emit("hooks.test", { padding: "x".repeat(256 * 1024) })
    expect(delivery).toMatchObject({ ok: true, detail: "exit 0" })
  })

  it("strips terminal escapes from what a command prints", async () => {
    const { hooks } = dispatcher([{ kind: "command", value: "printf '\\033[31mred\\033[0m\\tdone\\n'", source: "settings" }])
    const [delivery] = await hooks.emit("hooks.test", {})
    expect(delivery?.detail).toBe("red done")
  })
})

describe("webhooks", () => {
  it("POST the event as JSON and accept any 2xx", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const { hooks, logged } = dispatcher([{ kind: "webhook", value: "https://hooks.example/services/T0/SECRET-PATH", source: "settings" }], {
      fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response("accepted\n", { status: 202 }) },
    })
    const [delivery] = await hooks.emit("oauth.callback.listening", { callback: { id: "cb2" } })
    expect(delivery).toMatchObject({ ok: true, detail: "accepted", target: "webhook hooks.example" })
    expect(calls).toHaveLength(1)
    const headers = new Headers(calls[0]!.init.headers)
    expect(calls[0]!.init.method).toBe("POST")
    expect(calls[0]!.init.redirect).toBe("manual")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("x-meridian-event")).toBe("oauth.callback.listening")
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ event: "oauth.callback.listening", callback: { id: "cb2" } })
    expect(logged.join("\n")).not.toContain("SECRET-PATH")
  })

  it("report a refusal, a redirect and an unreachable target without the URL", async () => {
    const answers = [
      () => new Response("nope", { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      () => { throw Object.assign(new Error("connect to https://hooks.example/services/T0/SECRET-PATH failed"), { code: "ConnectionRefused" }) },
    ]
    const details: string[] = []
    for (const answer of answers) {
      const { hooks } = dispatcher([{ kind: "webhook", value: "https://hooks.example/services/T0/SECRET-PATH", source: "settings" }], {
        fetchImpl: async () => answer(),
      })
      const [delivery] = await hooks.emit("hooks.test", {})
      expect(delivery?.ok).toBe(false)
      details.push(delivery!.detail)
    }
    expect(details).toEqual(["HTTP 500: nope", "HTTP 302 (redirects are not followed)", "unreachable (ConnectionRefused)"])
  })

  it("give up on a webhook that does not answer in time", async () => {
    const { hooks } = dispatcher([{ kind: "webhook", value: "https://slow.example/hook", source: "settings" }], {
      webhookTimeoutMs: 100,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })))
      }),
    })
    const [delivery] = await hooks.emit("hooks.test", {})
    expect(delivery).toMatchObject({ ok: false, detail: "no answer in 0.1s" })
  })
})

describe("dispatch", () => {
  it("delivers only the events a target asked for", async () => {
    const seen: string[] = []
    const { hooks } = dispatcher([
      { kind: "webhook", value: "https://a.example/", events: ["oauth.callback.closed"], source: "settings" },
      { kind: "webhook", value: "https://b.example/", source: "settings" },
    ], { fetchImpl: async url => { seen.push(new URL(url).host); return new Response("") } })
    expect(await hooks.emit("oauth.callback.listening", {})).toHaveLength(1)
    expect(seen).toEqual(["b.example"])
  })

  it("answers by the deadline with the unfinished deliveries still running", async () => {
    let release = () => {}
    let settled = () => {}
    const finished = new Promise<void>(resolve => { settled = resolve })
    const { hooks } = dispatcher([{ kind: "webhook", value: "https://slow.example/", source: "settings" }], {
      fetchImpl: () => new Promise(resolve => { release = () => resolve(new Response("late")) }),
      log: line => { if (line.includes(": ok in ")) settled() },
    })
    const early = await hooks.emit("hooks.test", {}, { waitMs: 50 })
    expect(early).toEqual([expect.objectContaining({ ok: null, detail: "running" })])
    release()
    await finished
    expect(hooks.recent()[0]).toMatchObject({ ok: true, detail: "late" })
  })

  it("drops deliveries past the in-flight cap instead of queueing them", async () => {
    const pending: Array<() => void> = []
    const { hooks } = dispatcher([{ kind: "webhook", value: "https://slow.example/", source: "settings" }], {
      maxInFlight: 1,
      fetchImpl: () => new Promise(resolve => { pending.push(() => resolve(new Response(""))) }),
    })
    void hooks.emit("hooks.test", {})
    const [dropped] = await hooks.emit("hooks.test", {})
    expect(dropped).toMatchObject({ ok: false, detail: "dropped: 1 deliveries already running" })
    for (const finish of pending) finish()
  })

  it("keeps the most recent deliveries, newest first", async () => {
    const { hooks } = dispatcher([{ kind: "webhook", value: "https://a.example/", source: "settings" }], { fetchImpl: async () => new Response("") })
    for (let i = 0; i < 30; i++) await hooks.emit(i % 2 ? "oauth.callback.closed" : "oauth.callback.listening", {})
    const recent = hooks.recent()
    expect(recent).toHaveLength(25)
    expect(recent[0]?.event).toBe("oauth.callback.closed")
  })

  it("does nothing, and spawns nothing, without targets", async () => {
    const { hooks } = dispatcher([], { fetchImpl: () => { throw new Error("must not be called") } })
    expect(await hooks.emit("oauth.callback.listening", {})).toEqual([])
  })
})

describe("configuration", () => {
  it("names a command by its program, never its arguments or environment", () => {
    expect(hookProgramName("HOME=/home/x exec /opt/relay/bin/oauth-relay --socket relay")).toBe("oauth-relay")
    expect(hookProgramName("env -i TOKEN=abc '/usr/local/bin/notify me'")).toBe("notify")
    expect(hookTargetLabel({ kind: "webhook", value: "https://user:pw@hooks.example:8443/x/TOKEN?k=v" })).toBe("webhook hooks.example:8443")
  })

  it("validates a whole hooks form or rejects it", () => {
    expect(parseHookSettings({ webhooks: [{ url: " https://a.example/hook " }], commands: [{ command: "relay", events: ["oauth.callback.listening", "oauth.callback.listening"] }] }))
      .toEqual({ ok: true, value: { webhooks: [{ url: "https://a.example/hook" }], commands: [{ command: "relay", events: ["oauth.callback.listening"] }] } })
    expect(parseHookSettings({ webhooks: [{ url: "ftp://a.example/" }] })).toMatchObject({ ok: false })
    expect(parseHookSettings({ commands: [{ command: "  " }] })).toMatchObject({ ok: false })
    expect(parseHookSettings({ commands: [{ command: "x", events: ["oauth.everything"] }] })).toMatchObject({ ok: false })
    expect(parseHookSettings({ webhooks: Array.from({ length: 11 }, () => ({ url: "https://a.example/" })) })).toMatchObject({ ok: false })
  })

  it("adds the environment's targets after the saved ones and skips hand-edited garbage", () => {
    const targets = resolveHookTargets(
      { webhooks: [{ url: "https://a.example/" }, { url: "not a url" }], commands: [{ command: "relay", events: ["bogus", "oauth.callback.closed"] }] },
      { url: "https://env.example/", command: "env-relay" },
    )
    expect(targets).toEqual([
      { kind: "webhook", value: "https://a.example/", events: undefined, source: "settings" },
      { kind: "command", value: "relay", events: ["oauth.callback.closed"], source: "settings" },
      { kind: "webhook", value: "https://env.example/", source: "env" },
      { kind: "command", value: "env-relay", source: "env" },
    ])
  })
})
