#!/usr/bin/env node
// Canonical npm tarball → independent install → packaged SQLite.
// Usage: node scripts/e2e-libsql-package.mjs [existing-tarball.tgz]
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'meridian-libsql-package-'))
const install = join(root, 'installed')
const home = join(root, 'home')
mkdirSync(install)
mkdirSync(home)
// No real configuration, credentials or conversations enter the smoke package.
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, SystemRoot: process.env.SystemRoot }
function run(command, args, cwd, childEnv = env) {
  const result = spawnSync(command, args, { cwd, env: childEnv, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
function javascript(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? javascript(path) : entry.name.endsWith('.js') ? [path] : []
  })
}

try {
  let tarball = process.argv[2] && resolve(process.argv[2])
  if (!tarball) {
    run('npm', ['run', 'build'], repo, { ...process.env, LIBSQL_JS_DEV: '' })
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repo))
    assert.equal(packed.length, 1)
    tarball = join(root, packed[0].filename)
  }
  writeFileSync(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], install)
  const pkg = join(install, 'node_modules', '@rynfar', 'meridian')
  assert.notEqual(realpathSync(pkg), realpathSync(repo))
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies.libsql, 'libsql must remain a runtime dependency')
  for (const entry of [manifest.main, manifest.types, ...Object.values(manifest.bin)]) {
    assert.ok(existsSync(join(pkg, entry)), `Missing packaged entry: ${entry}`)
  }
  const sources = javascript(join(pkg, 'dist')).map(path => readFileSync(path, 'utf8'))
  const bundledLoader = sources.some(source => source.includes('LIBSQL_JS_DEV') || source.includes('// node_modules/libsql/index.js'))
  const buildPathLeak = sources.some(source => source.includes(join(repo, 'node_modules', 'libsql'))
    || /\b__dirname\s*=\s*["'][^"']*[/\\]node_modules[/\\]libsql["']/.test(source))

  // Execute the PUBLIC packaged server entry, not a source-only libsql probe.
  // Persistence falls back silently on loader failure, so require the DB schema.
  const probe = join(install, 'probe.mjs')
  writeFileSync(probe, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
await import('@rynfar/meridian');
const require = createRequire(import.meta.resolve('@rynfar/meridian'));
const loader = realpathSync(require.resolve('libsql'));
assert.ok(loader.startsWith(${JSON.stringify(realpathSync(install) + sep)}), 'libsql resolved outside fresh install');
assert.ok(existsSync(process.env.MERIDIAN_TELEMETRY_DB), 'packaged server fell back to memory');
const Database = require('libsql');
const db = new Database(process.env.MERIDIAN_TELEMETRY_DB);
for (const name of ['metrics', 'diagnostic_logs']) {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name), 'missing telemetry schema: ' + name);
}
db.prepare('INSERT INTO diagnostic_logs (timestamp, level, category, message) VALUES (?, ?, ?, ?)').run(Date.now(), 'info', 'package-smoke', 'synthetic portability fixture');
db.close();
const reopened = new Database(process.env.MERIDIAN_TELEMETRY_DB);
assert.equal(reopened.prepare("SELECT message FROM diagnostic_logs WHERE category='package-smoke'").get().message, 'synthetic portability fixture');
reopened.close();
console.log(JSON.stringify({ libsql: JSON.parse(readFileSync(join(dirname(loader), 'package.json'), 'utf8')).version }));
process.exit(0);
`)
  const probeEnv = { ...env, MERIDIAN_CONFIG_DIR: home, MERIDIAN_TELEMETRY_PERSIST: '1', MERIDIAN_TELEMETRY_DB: join(root, 'telemetry.db'), MERIDIAN_QUIET: '1' }
  const native = JSON.parse(run(process.execPath, [probe], install, probeEnv).trim())
  run(process.execPath, [join(pkg, manifest.bin.meridian), '--help'], install, probeEnv)
  if (manifest.bin['meridian-bookkeeping']) {
    run(process.execPath, [join(pkg, manifest.bin['meridian-bookkeeping']), '--help'], install, probeEnv)
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, version: manifest.version, sqlite: 'opened, written and reopened', native, bundledLoader, buildPathLeak }))
  assert.equal(bundledLoader, false, 'libsql loader is bundled; dormant LIBSQL_JS_DEV can retain the build-host path')
  assert.equal(buildPathLeak, false, 'packaged JS contains build-host libsql path')
  console.log('PASS: relocated npm installation opens packaged SQLite without bundling the native loader')
} finally {
  rmSync(root, { recursive: true, force: true })
}
