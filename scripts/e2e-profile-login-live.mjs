#!/usr/bin/env bun
// Manual real-account browser gate. Isolated Meridian config, credentials and
// session directories; no startup refresh scheduler or host profile adoption.
// Complete Add a profile in the collaborative browser, then verify its account
// with a headless client. Keep OAuth links/codes and credentials private.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = realpathSync(process.env.E2E_EXISTING_ROOT ?? mkdtempSync(join(tmpdir(), 'meridian-profile-login-live-')))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0', CLAUDE_CONFIG_DIR: join(root, 'unlinked-default') })
for (const path of [process.env.MERIDIAN_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, join(root, 'verification')]) mkdirSync(path, { recursive: true, mode: 0o700 })
if (!process.env.E2E_EXISTING_ROOT) writeFileSync(join(process.env.MERIDIAN_CONFIG_DIR, 'profiles.json'), JSON.stringify([{ id: 'verification', claudeConfigDir: join(root, 'verification') }]), { mode: 0o600 })
const { enableDiskProfileDiscovery } = await import('../src/proxy/profiles.ts')
const { createProxyServer } = await import('../src/proxy/server.ts')
enableDiskProfileDiscovery()
// createProxyServer provides the real HTTP application without arming the
// default global credential refresh scheduler in startProxyServer.
const { app } = createProxyServer({ silent: true })
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 42212), fetch: app.fetch })
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}/profiles`, artifact: root, platform: process.platform, realOAuth: true, seededProfile: 'verification (empty, isolated)' }))
process.once('SIGINT', () => { server.stop(true); process.exit(0) })
process.once('SIGTERM', () => { server.stop(true); process.exit(0) })
