#!/usr/bin/env bun
// Live, in Docker: does a host without a boot identity refuse to serve, and
// does /health say so?
//
// Every session-store write takes a lock stamped with a process incarnation,
// and `captureProcessIncarnation` returns undefined without a boot identity —
// so `acquireLock` throws and every request that touches a session returns a
// 500. `/health` never probed it, so a container missing `/etc/machine-id`
// reported `healthy` to Docker's HEALTHCHECK and to any orchestrator while
// serving nothing. The original occurrence took three days to find for exactly
// that reason (#906, split from #903).
//
// Why this needs a container and not a unit test: the failure is a property of
// the HOST, and on a developer machine (or normal CI) boot identity is always
// available. `oven/bun:1-slim` ships with no `/etc/machine-id`, which is the
// reported environment verbatim — the same shape as distroless, scratch,
// chroot and gVisor images.
//
// Three claims, and the third is the one that keeps this safe to ship:
//
//   1. Without a boot identity `startProxyServer` REFUSES to start, and the
//      error names the missing file rather than saying "cannot capture lock
//      owner process incarnation", which names nothing actionable.
//   2. With the escape hatch set it starts, and `/health` returns 503
//      `unhealthy` carrying the cause — so an orchestrator finally sees it.
//   3. WITH a valid machine-id the same image starts normally and `/health`
//      does not report a boot-identity problem. Fail-fast that false-positives
//      on ordinary deployments would be worse than the bug.
//
// Requires Docker. Costs no tokens — it never reaches a model.
//
//   bun scripts/e2e-boot-identity.mjs
import { mkdtempSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const IMAGE = process.env.PROBE_IMAGE ?? 'oven/bun:1-slim'
const say = console.log.bind(console)
const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  say('SKIP: Docker is not available. This gate asserts a property of the HOST,')
  say('      which cannot be reproduced without one — see E2E.md E51.')
  process.exit(0)
}

// A copy, never a bind mount of the checkout: `bun install` inside the
// container would otherwise overwrite the host's platform-specific
// node_modules (the mounted macOS build cannot even load libsql on Linux).
const stage = mkdtempSync('/tmp/meridian-bootid-')
const repo = process.env.E2E_MERIDIAN_ROOT ?? '.'
for (const entry of ['src', 'package.json', 'bun.lock', 'tsconfig.json']) {
  const from = join(repo, entry)
  if (existsSync(from)) cpSync(from, join(stage, entry), { recursive: true })
}

writeFileSync(join(stage, 'probe.mjs'), `
const { startProxyServer } = await import("/app/src/proxy/server.ts")
let refused = false, namesCause = false
try {
  const inst = await startProxyServer({ port: 3999, host: "127.0.0.1" })
  await inst.close()
} catch (e) {
  refused = true
  namesCause = String(e.message).includes("/etc/machine-id")
}
console.log("FAILFAST refused=" + refused + " namesCause=" + namesCause)
process.env.MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY = "1"
const inst = await startProxyServer({ port: 3998, host: "127.0.0.1" })
try {
  const res = await fetch("http://127.0.0.1:3998/health")
  const body = await res.json()
  console.log("HEALTH http=" + res.status + " status=" + body.status +
    " available=" + JSON.stringify(body.bootIdentity?.available) +
    " namesCause=" + String(body.bootIdentity?.hint ?? "").includes("/etc/machine-id"))
} finally { await inst.close() }
`)

function run(withMachineId) {
  const seed = withMachineId
    ? 'printf "%s" "$(cat /proc/sys/kernel/random/uuid | tr -d -)" > /etc/machine-id;'
    : 'rm -f /etc/machine-id /var/lib/dbus/machine-id;'
  const out = spawnSync('docker', [
    'run', '--rm', '-v', `${stage}:/app`, '-w', '/app',
    '-e', 'MERIDIAN_SESSION_STORE_DIR=/tmp/s', '-e', 'MERIDIAN_WORKDIR=/tmp/w',
    IMAGE, 'sh', '-c',
    `${seed} bun install --silent >/dev/null 2>&1; bun probe.mjs 2>&1 | grep -E "FAILFAST|HEALTH"`,
  ], { encoding: 'utf8', timeout: 600000 })
  return out.stdout ?? ''
}

try {
  say(`\n=== boot identity, image=${IMAGE} ===`)

  say('  --- no /etc/machine-id (the reported environment) ---')
  const absent = run(false)
  for (const l of absent.trim().split('\n')) say(`  ${l}`)
  check(/FAILFAST refused=true/.test(absent),
    'startProxyServer refuses to bind a port it cannot serve from')
  check(/FAILFAST[^\n]*namesCause=true/.test(absent),
    'the refusal names the missing file, not just the symptom')
  check(/HEALTH http=503/.test(absent) && /status=unhealthy/.test(absent),
    '/health reports 503 unhealthy under the escape hatch')
  check(/HEALTH[^\n]*available=false/.test(absent),
    '/health carries the boot-identity verdict an orchestrator can read')
  check(/HEALTH[^\n]*namesCause=true/.test(absent),
    '/health carries the actionable cause')

  say('  --- with a valid machine-id (an ordinary deployment) ---')
  const present = run(true)
  for (const l of present.trim().split('\n')) say(`  ${l}`)
  // THE REGRESSION GUARD. Fail-fast that fires on a normal host would be worse
  // than the bug it fixes.
  check(/FAILFAST refused=false/.test(present),
    'an ordinary container still starts')
  check(/HEALTH http=200/.test(present),
    '/health does not report a boot-identity problem when there is none')
  check(!/HEALTH[^\n]*available=false/.test(present),
    'the boot-identity verdict is absent when identity is available')

  say(`\n=== verdict ===`)
  if (failures.length) {
    say(`  FAIL: ${failures.length} check(s)`)
    for (const f of failures) say(`    - ${f}`)
  } else {
    say('  PASS: refuses without identity, says so on /health, unaffected with it')
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)
