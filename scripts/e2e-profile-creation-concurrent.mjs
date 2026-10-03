// Actual compiled profileCli functions in two independent Node processes.
// No OAuth, credentials, model calls or user configuration are used.
// Build: bun build src/proxy/profileCli.ts --target node --outdir <temporary-dir>
// E2E_PROFILE_CLI_BUNDLE=<temporary-dir>/profileCli.js node <this script>
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
const bundle = resolve(process.env.E2E_PROFILE_CLI_BUNDLE)
const mode = process.env.E2E_PROFILE_RACE_MODE ?? 'distinct'
assert(['distinct', 'same'].includes(mode))
const root = mkdtempSync(join(tmpdir(), 'meridian-profile-creation-'))
writeFileSync(join(root, 'profiles.json'), JSON.stringify([{ id: 'untouched', claudeConfigDir: join(root, 'existing') }]), { mode: 0o600 })
const worker = join(root, 'worker.mjs')
writeFileSync(worker, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [bundle, id, credentialDir] = process.argv.slice(2);
const originalRead = fs.readFileSync;
let held = false;
const pause = new Int32Array(new SharedArrayBuffer(4));
fs.readFileSync = function(file, ...args) {
  const bytes = originalRead.call(this, file, ...args);
  if (!held && String(file) === join(process.env.MERIDIAN_CONFIG_DIR, 'profiles.json')) {
    held = true;
    process.send({ kind: 'read' });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(join(process.env.MERIDIAN_CONFIG_DIR, 'release'))) {
      if (Date.now() > deadline) throw new Error('fixture barrier timed out');
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  return bytes;
};
syncBuiltinESMExports();
const { createProfileSlot } = await import(pathToFileURL(bundle).href);
process.send({ kind: 'ready' });
await once(process, 'message');
const result = createProfileSlot(id, { claudeConfigDir: credentialDir });
process.send({ kind: 'result', result });
process.disconnect();
`, { mode: 0o600 })
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete env[key]
env.MERIDIAN_CONFIG_DIR = root
let reads = 0
let releaseTimer
const results = []
const workers = ['first', mode === 'same' ? 'first' : 'second'].map((id, index) => {
  const child = spawn(process.execPath, [worker, bundle, id, join(root, `credentials-${index}`)], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const ready = new Promise(resolve => child.on('message', message => {
    if (message.kind === 'ready') resolve()
    if (message.kind === 'read') {
      reads++
      // Both workers are imported/ready before either may start. Hold the
      // first snapshot long enough for an unguarded peer to read that same
      // snapshot. A serialized peer waits until publication instead.
      releaseTimer ??= setTimeout(() => writeFileSync(join(root, 'release'), ''), 500)
    }
    if (message.kind === 'result') results[index] = message.result
  }))
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}: ${stderr}`)))
  })
  return { child, ready, done }
})
const timeout = setTimeout(() => workers.forEach(w => w.child.kill('SIGTERM')), 10000)
try {
  await Promise.all(workers.map(w => w.ready))
  workers.forEach(w => w.child.send({ go: true }))
  await Promise.all(workers.map(w => w.done))
  const profiles = JSON.parse(readFileSync(join(root, 'profiles.json'), 'utf8'))
  const summary = { mode, artifact: root, reads, successfulCreators: results.filter(r => r.ok).length,
    refused: results.filter(r => !r.ok).map(r => r.reason), profileIds: profiles.map(p => p.id) }
  console.log(JSON.stringify(summary))
  assert(profiles.some(p => p.id === 'untouched'), 'Existing account vanished')
  if (mode === 'distinct') {
    assert.equal(summary.successfulCreators, 2)
    assert(profiles.some(p => p.id === 'first') && profiles.some(p => p.id === 'second'), 'A successful account creation was lost')
  } else {
    assert.equal(summary.successfulCreators, 1, 'Both processes reported creating the same account')
    assert.deepEqual(summary.refused, ['already_exists'])
    assert.equal(profiles.find(p => p.id === 'first')?.claudeConfigDir, results.find(r => r.ok)?.profile.claudeConfigDir)
  }
  console.log(JSON.stringify({ result: 'PASS', mode }))
} finally { clearTimeout(timeout); if (releaseTimer) clearTimeout(releaseTimer) }
