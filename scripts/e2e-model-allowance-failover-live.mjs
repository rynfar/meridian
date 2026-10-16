#!/usr/bin/env bun
// Live: an account that has spent its allowance for one model, in a pool with
// an account that has some left. Does a request for that model reach the
// second account, and does everything else stay on the first?
//
// It needs the real thing: two Claude Max profiles of the installed proxy,
// one whose weekly allowance for MODEL is spent (`/v1/usage/quota/all` shows
// that model's window at 100% while the account-wide windows have room) and
// one with allowance left. Nothing else makes Anthropic answer with the
// refusal this is about, so it cannot run in CI.
//
//   SPENT=<spent-profile> ROOM=<profile-with-room> bun scripts/e2e-model-allowance-failover-live.mjs
//
// The proxy is this checkout's, in this process, with a config directory, a
// session store and a working directory of its own: a proxy already running
// on the machine is not touched, and neither is its active profile. The two
// profiles' credentials are the installed ones, read where they are.
//
// MODEL is the model whose allowance is spent (default claude-fable-5-1) and
// OTHER_MODEL one the first account still serves (default claude-haiku-4-5).
// ALSO_SPENT, when set, is a second profile that refuses MODEL: with it the
// gate also asks a pool in which every account refuses.
// Costs four one-word replies: three of MODEL on ROOM, one of OTHER_MODEL on
// SPENT. The refusals themselves cost nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setSessionStoreDir } from "../src/proxy/sessionStore.ts"

const say = console.log.bind(console)
const { SPENT, ROOM } = process.env
const MODEL = process.env.MODEL ?? "claude-fable-5-1"
const OTHER_MODEL = process.env.OTHER_MODEL ?? "claude-haiku-4-5"
const installed = join(process.env.MERIDIAN_CONFIG_DIR ?? join(homedir(), ".config", "meridian"), "profiles.json")
if (!SPENT || !ROOM || !existsSync(installed)) {
  say("SKIP: set SPENT and ROOM to two profiles of the installed proxy (see the header)")
  process.exit(1)
}
const ALSO_SPENT = process.env.ALSO_SPENT
const profiles = JSON.parse(readFileSync(installed, "utf8"))
const named = [ROOM, SPENT, ...(ALSO_SPENT ? [ALSO_SPENT] : [])]
const found = named.map(id => profiles.find(profile => profile.id === id))
if (found.some(profile => !profile)) {
  say(`SKIP: ${installed} has no profile named ${named.filter((_, index) => !found[index]).join(" or ")}`)
  process.exit(1)
}
const pool = found.slice(0, 2)

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), "mallowance-")))
const CONFIG = join(WORKDIR, "config")
mkdirSync(CONFIG)
// The spent account is the active one, as it was when this was found: the
// account every request goes to first.
writeFileSync(join(CONFIG, "settings.json"), JSON.stringify({ routing: "active+priority", activeProfile: SPENT }))
// An operator's own pins must not decide what this gate measures.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: CONFIG,
  MERIDIAN_WORKDIR: WORKDIR,
  MERIDIAN_TELEMETRY_PERSIST: "0",
  MERIDIAN_CLAUDE_PATH: process.env.E2E_CLAUDE_PATH ? resolve(process.env.E2E_CLAUDE_PATH) : resolve(import.meta.dir, "../node_modules/.bin/claude"),
})
setSessionStoreDir(join(WORKDIR, "store"))
const { startProxyServer } = await import("../src/proxy/server.ts")
// What an account is out for is kept by the proxy that learned it, so each
// part below starts a proxy that has learned nothing. Started the way the
// installed one is, and asked over HTTP: a proxy that is only constructed
// leaves the CLI unresolved until its first request that is not streamed, and
// the SDK then answers a streamed one with the older CLI it carries, which
// words this refusal as a model that does not exist.
const proxies = []
async function proxy(accounts) {
  const started = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles: accounts, defaultProfile: SPENT })
  proxies.push(started)
  return `http://127.0.0.1:${started.server.address().port}`
}

const failures = []
function check(ok, label, detail = "") {
  say(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`)
  if (!ok) failures.push(label)
}
const get = async (app, path) => (await fetch(app + path)).json()

/** One request, what came back, and the accounts it was tried on, in order. */
async function ask(app, model, session, stream = false) {
  const started = Date.now()
  const res = await fetch(`${app}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-opencode-session": session },
    body: JSON.stringify({ model, max_tokens: 16, stream, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
  })
  const raw = await res.text()
  // A stream is its frames: the text they carry, and the error frame if one came.
  const frames = stream
    ? raw.split("\n\n").map(frame => ({
        event: /^event: (.+)$/m.exec(frame)?.[1],
        data: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "null"),
      }))
    : []
  const body = stream ? frames.find(frame => frame.event === "error")?.data ?? {} : JSON.parse(raw)
  const text = stream
    ? frames.map(frame => frame.data?.delta?.text ?? "").join("")
    : body.content?.map(block => block.text).join("") ?? ""
  const hops = (await get(app, "/telemetry/requests?limit=20&hops=1"))
    .filter(row => row.timestamp >= started)
    .sort((a, b) => (a.routeAttempt ?? 0) - (b.routeAttempt ?? 0))
  return {
    status: res.status,
    text: text || JSON.stringify(body.error ?? body).slice(0, 200),
    error: body.error,
    retryAfter: res.headers.get("retry-after"),
    tried: hops.map(row => `${row.profileId}:${row.status}`),
    said: `HTTP ${res.status} "${(text || JSON.stringify(body.error ?? body)).slice(0, 160)}" tried ${hops.map(row => `${row.profileId}:${row.status}`).join(" -> ") || "nothing"}`,
  }
}

say(`${MODEL} with ${SPENT} active (allowance spent) and ${ROOM} behind it`)
say("\nstreamed, as the Claude Code client asks")
const streamed = await ask(await proxy(pool), MODEL, "allowance-stream", true)
check(streamed.status === 200 && streamed.error === undefined && streamed.tried.join(" ") === `${SPENT}:429 ${ROOM}:200`,
  "the stream is the next account's answer, with nothing of the refusal in it", streamed.said)

say("\nnot streamed")
const app = await proxy(pool)
const first = await ask(app, MODEL, "allowance-1")
check(first.status === 200 && first.tried.join(" ") === `${SPENT}:429 ${ROOM}:200`,
  "the request is refused by the active account and served by the next one", first.said)

const health = await get(app, "/profiles/health")
const benched = (health.exhaustedModels ?? []).find(entry => entry.id === SPENT)
check(benched !== undefined && !health.exhausted.some(entry => entry.id === SPENT),
  "the account is out for that model and not out altogether",
  `exhaustedModels=${JSON.stringify(health.exhaustedModels)} exhausted=${JSON.stringify(health.exhausted)}`)
const refusal = health.spent.find(entry => entry.profileId === SPENT)?.diagnosis
check(refusal?.reported === true, "the window that was refused is one Anthropic named",
  `window=${refusal?.bucket} source=${refusal?.source}`)
check(benched !== undefined && benched.until > Date.now() + 15 * 60_000,
  "the model stays off the account until the reset Anthropic gave, not the ten-minute default",
  benched ? `until ${new Date(benched.until).toISOString()}` : "no mark")

const other = await ask(app, OTHER_MODEL, "allowance-other")
check(other.status === 200 && other.tried.join(" ") === `${SPENT}:200`,
  `a request for ${OTHER_MODEL} is still served by the active account`, other.said)

const second = await ask(app, MODEL, "allowance-2")
check(second.status === 200 && second.tried.join(" ") === `${ROOM}:200`,
  "the next request for the model goes straight to the account with allowance left", second.said)

if (ALSO_SPENT) {
  say(`\n${SPENT} with ${ALSO_SPENT} behind it, so every account refuses`)
  const spent = await proxy([found[2], found[1]])
  const refusedStream = await ask(spent, MODEL, "allowance-spent-stream", true)
  const wait = refusedStream.error?.retry_after
  check(refusedStream.error?.type === "rate_limit_error" && wait > 15 * 60,
    "a streamed request ends in a rate limit whose frame says how long until an account has the model back",
    `${refusedStream.said} retry_after=${wait}`)
  const refused = await ask(spent, MODEL, "allowance-spent")
  check(refused.status === 429 && Number(refused.retryAfter) > 15 * 60 && refused.error?.retry_after === Number(refused.retryAfter),
    "a request that is not streamed is a 429 with that wait in its header and its body",
    `${refused.said} Retry-After=${refused.retryAfter} retry_after=${refused.error?.retry_after}`)
}

say(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${failures.length === 0 ? "the allowance of one model moved one model" : failures.join("; ")}`)
for (const started of proxies) await started.close()
// The SDK keeps a transcript per working directory inside each profile.
const slug = WORKDIR.replace(/[^A-Za-z0-9]/g, "-")
for (const profile of found) rmSync(join(profile.claudeConfigDir, "projects", slug), { recursive: true, force: true })
// A failed run keeps the proxy's session store.
if (failures.length === 0) rmSync(WORKDIR, { recursive: true, force: true })
else say(`  kept: ${WORKDIR}`)
process.exit(failures.length === 0 ? 0 : 1)
