#!/usr/bin/env bun
// Actual OS credential store with synthetic OAuth transport. This is native
// persistence/CLI-format evidence, not a real-account OAuth or model E2E claim.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-native-profile-store-')))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENAI_)/.test(key)) delete process.env[key]
process.env.MERIDIAN_CONFIG_DIR = root
const { startProfileAdd, completeProfileAdd } = await import('../src/proxy/profileAdd.ts')
const { createPlatformCredentialStore, configDirToKeychainService } = await import('../src/proxy/tokenRefresh.ts')
let result
try {
  const started = startProfileAdd({ profiles: [], profileId: 'native-fixture' })
  assert(started.ok, 'Native fixture did not start')
  const state = new URL(started.authorizeUrl).searchParams.get('state')
  const fetchFn = async (input, init) => {
    if (String(input).endsWith('/oauth/token')) {
      const body = JSON.parse(init.body)
      assert.equal(body.state, state)
      assert.equal(body.grant_type, 'authorization_code')
      assert(body.code_verifier)
      return Response.json({ access_token: 'fixture-access-no-real-auth', refresh_token: 'fixture-refresh-no-real-auth', expires_in: 3600 })
    }
    return Response.json({ account: { subscription_type: 'max' }, organization: { rate_limit_tier: 'default_claude_max_20x' } })
  }
  result = await completeProfileAdd({ addId: started.addId, input: `fixture-code#${state}`, fetchFn })
  assert(result.ok, 'Native fixture credential write failed')
  const profiles = JSON.parse(readFileSync(join(root, 'profiles.json'), 'utf8'))
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].id, 'native-fixture')
  assert.equal(profiles[0].claudeConfigDir, result.claudeConfigDir)
  const store = createPlatformCredentialStore({ claudeConfigDir: result.claudeConfigDir })
  const saved = await store.read()
  assert.equal(saved?.claudeAiOauth?.accessToken, 'fixture-access-no-real-auth')
  assert.equal(saved?.claudeAiOauth?.refreshToken, 'fixture-refresh-no-real-auth')
  if (process.platform === 'darwin') assert.equal(existsSync(join(result.claudeConfigDir, '.credentials.json')), false)
  console.log(JSON.stringify({ result: 'PASS', platform: process.platform, nativeStore: process.platform === 'darwin' ? 'Keychain' : 'file', profilePublished: true, tokensRoundTrip: true, transport: 'synthetic', realAccount: false }))
} finally {
  if (result?.ok && process.platform === 'darwin') {
    const service = configDirToKeychainService(result.claudeConfigDir)
    assert(service !== 'Claude Code-credentials')
    const deleted = spawnSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', userInfo().username], { encoding: 'utf8' })
    assert.equal(deleted.status, 0, 'Could not remove the fixture-only Keychain item')
  }
  rmSync(root, { recursive: true, force: true })
}
