#!/usr/bin/env bun
// Exercise the built setup CLI with a real pinned OpenCode executable.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const client = process.env.E2E_OPENCODE_BIN
assert(client, 'Set E2E_OPENCODE_BIN')
const root = mkdtempSync(join(tmpdir(), 'meridian-package-integrity-'))
cpSync(join(repo, 'dist'), join(root, 'dist'), { recursive: true })
cpSync(join(repo, 'package.json'), join(root, 'package.json'))
symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
const env = { ...process.env, OPENCODE_CONFIG_DIR: join(root, 'config'), MERIDIAN_CONFIG_DIR: join(root, 'meridian'), OPENCODE_DISABLE_AUTOUPDATE: '1' }
mkdirSync(env.OPENCODE_CONFIG_DIR)
const configPath = join(env.OPENCODE_CONFIG_DIR, 'opencode.json')
const original = JSON.stringify({ plugins: [], providers: { fixture: { name: 'Preserve me' } } })
writeFileSync(configPath, original)
const missing = process.argv.includes('--manifest') ? 'package.json' : 'index.js'
rmSync(join(root, 'dist', 'meridian-v2', missing))
const child = Bun.spawn(['node', join(root, 'dist', 'cli.js'), 'setup', '--v2', '--opencode-bin', client], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
const timeout = setTimeout(() => child.kill(), 30_000)
try {
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  console.log(JSON.stringify({ repo, root, missing, stdout, stderr, exitCode }))
  assert.equal(exitCode, 1, 'Setup configured a package that the host cannot load')
  assert.match(stderr, /OpenCode V2 plugin bundle is missing/)
  assert.equal(readFileSync(configPath, 'utf8'), original, 'Failed setup changed the existing configuration')
  console.log(`PASS: missing ${missing} rejected without changing configuration`)
} finally { clearTimeout(timeout) }
