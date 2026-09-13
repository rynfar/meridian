#!/usr/bin/env bun
// Live, in Docker: is the derived hostId stable across a restart and unique
// across containers, and does MERIDIAN_HOST_ID fix both?
//
// `linuxLocalBootIdentity` builds hostId from the machine-id AND the
// pid-namespace inode. Inside a container that is wrong twice over (#905):
//
//   - NOT STABLE. The inode changes on every `docker restart` while the session
//     store survives in the writable layer, so a proxy SIGKILLed holding a
//     store lock returns with a different hostId. The old lock then probes as
//     `indeterminate` rather than `dead`, is never retired, and every request
//     fails with `timed out waiting for lock` until the container is recreated.
//   - NOT UNIQUE. Every container from an image tag shares a baked
//     `/etc/machine-id`, so hostId reduces to that inode, which is allocated
//     from a fixed base at boot. Two freshly-booted hosts sharing a session
//     directory can each read the other's LIVE lock as `dead`.
//
// Needs real containers because both properties are about namespaces and image
// layers; nothing observable from a single process reproduces them.
//
// Requires Docker. Costs no tokens — never reaches a model.
//
//   bun scripts/e2e-host-id.mjs
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
  say('SKIP: Docker is not available; both properties are about namespaces and')
  say('      image layers and cannot be reproduced without it — see E2E.md E52.')
  process.exit(0)
}

const stage = mkdtempSync('/tmp/meridian-hostid-')
const repo = process.env.E2E_MERIDIAN_ROOT ?? '.'
for (const e of ['src', 'package.json', 'bun.lock', 'tsconfig.json']) {
  const from = join(repo, e)
  if (existsSync(from)) cpSync(from, join(stage, e), { recursive: true })
}
writeFileSync(join(stage, 'probe.mjs'), `
import { captureProcessIncarnation } from "/app/src/proxy/session/processIncarnation.ts"
import { readFileSync, readlinkSync } from "node:fs"
const inc = captureProcessIncarnation()
console.log(JSON.stringify({
  machineId: readFileSync("/etc/machine-id", "utf8").trim().slice(0, 12),
  pidNs: readlinkSync("/proc/self/ns/pid"),
  hostId: inc?.hostId?.slice(0, 16),
}))
`)

const NAMES = ['meridian-hostid-a', 'meridian-hostid-b']
const rmAll = () => spawnSync('docker', ['rm', '-f', ...NAMES], { stdio: 'ignore' })
// A shared, byte-identical machine-id: exactly what an image layer gives.
const BAKED = 'deadbeefdeadbeefdeadbeefdeadbeef'
const probe = (name, pin) => {
  const args = ['exec']
  if (pin) args.push('-e', `MERIDIAN_HOST_ID=${pin}`)
  args.push(name, 'bun', 'probe.mjs')
  const out = spawnSync('docker', args, { encoding: 'utf8', timeout: 300000 })
  try { return JSON.parse((out.stdout ?? '').trim().split('\n').pop()) } catch { return {} }
}

try {
  rmAll()
  say(`\n=== host identity, image=${IMAGE} ===`)
  for (const n of NAMES) {
    spawnSync('docker', ['run', '-d', '--name', n, '-v', `${stage}:/app`, '-w', '/app', IMAGE, 'sleep', '900'], { stdio: 'ignore' })
    spawnSync('docker', ['exec', n, 'sh', '-c',
      `printf "%s" "${BAKED}" > /etc/machine-id; bun install --silent >/dev/null 2>&1`], { stdio: 'ignore', timeout: 600000 })
  }

  // 1. The reported instability.
  const before = probe(NAMES[0])
  spawnSync('docker', ['restart', NAMES[0]], { stdio: 'ignore', timeout: 120000 })
  spawnSync('sleep', ['2'])
  const after = probe(NAMES[0])
  say(`  derived  before: pidNs=${before.pidNs} hostId=${before.hostId}`)
  say(`  derived  after : pidNs=${after.pidNs} hostId=${after.hostId}`)
  const inodeMoved = before.pidNs !== after.pidNs
  check(before.machineId === after.machineId, 'machine-id survives the restart, isolating the variable',
    `${before.machineId} == ${after.machineId}`)
  if (inodeMoved) {
    check(before.hostId !== after.hostId,
      'the DERIVED hostId moves with the pid-namespace inode (the reported bug)',
      `${before.hostId} -> ${after.hostId}`)
  } else {
    // Docker reused the inode this run. The bug is still real; it just did not
    // manifest here, and asserting it would make the gate flaky.
    say('  note  the pid-namespace inode did not change on this restart, so the')
    say('        instability could not be observed; the pinned checks below still hold')
  }

  // 2. THE FIX. The pin is the only input, so a moved inode cannot move the id.
  const pinnedA = probe(NAMES[0], 'shared-pin')
  const pinnedB = probe(NAMES[1], 'shared-pin')
  say(`  pinned   A: pidNs=${pinnedA.pidNs} hostId=${pinnedA.hostId}`)
  say(`  pinned   B: pidNs=${pinnedB.pidNs} hostId=${pinnedB.hostId}`)
  check(pinnedA.pidNs !== pinnedB.pidNs, 'the two containers really do differ in pid namespace',
    `${pinnedA.pidNs} vs ${pinnedB.pidNs}`)
  check(Boolean(pinnedA.hostId) && pinnedA.hostId === pinnedB.hostId,
    'the same pin yields the same hostId across different pid namespaces',
    `${pinnedA.hostId} == ${pinnedB.hostId}`)

  // 3. And distinct pins keep hosts apart, so B cannot retire A's live lock.
  const hostA = probe(NAMES[0], 'host-A')
  const hostB = probe(NAMES[1], 'host-B')
  say(`  host-A: hostId=${hostA.hostId}`)
  say(`  host-B: hostId=${hostB.hostId}`)
  check(Boolean(hostA.hostId) && hostA.hostId !== hostB.hostId,
    'distinct pins yield distinct hostIds despite a shared machine-id',
    `${hostA.hostId} != ${hostB.hostId}`)

  say(`\n=== verdict ===`)
  if (failures.length) {
    say(`  FAIL: ${failures.length} check(s)`)
    for (const f of failures) say(`    - ${f}`)
  } else {
    say('  PASS: pinning makes hostId stable across restarts and unique across hosts')
  }
} finally {
  rmAll()
  rmSync(stage, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)
