// Controlled command failure against the actual compiled credential store.
// No security command or real Keychain item is used. Synthetic values only.
// bun build src/proxy/tokenRefresh.ts --target node --outdir <temporary-dir>
// E2E_CREDENTIAL_STORE_BUNDLE=<temporary-dir>/tokenRefresh.js node <this script>
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const sentinel = 'SYNTHETIC-CREDENTIAL-MUST-NOT-APPEAR'
const originalExec = childProcess.execFile
const originalPlatform = os.platform
const originalDebug = console.debug
const lines = []
process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = '1'
childProcess.execFile = (_file, args, _options, callback) => {
  const error = Object.assign(new Error(`Command failed: security add-generic-password -w ${args.at(-1)}`), { code: 42 })
  callback(error, '', '')
}
os.platform = () => 'darwin'
console.debug = (...args) => lines.push(args.join(' '))
syncBuiltinESMExports()
try {
  const { createPlatformCredentialStore } = await import(pathToFileURL(resolve(process.env.E2E_CREDENTIAL_STORE_BUNDLE)).href)
  const store = createPlatformCredentialStore({ claudeConfigDir: '/synthetic-isolated-credential-store' })
  const written = await store.write({ claudeAiOauth: { accessToken: sentinel, refreshToken: 'SYNTHETIC-REFRESH', expiresAt: Date.now() + 60000 } })
  assert.equal(written, false, 'The controlled failed command was reported successful')
  assert(lines.some(line => line.includes('token_refresh.keychain_write_failed')), 'Missing actionable failure event')
  const leaked = lines.some(line => line.includes(sentinel) || line.includes('SYNTHETIC-REFRESH'))
  originalDebug(JSON.stringify({ commandFailed: true, eventLogged: true, secretLeaked: leaked }))
  assert.equal(leaked, false, 'Credential command failure leaked the password argument')
  originalDebug(JSON.stringify({ result: 'PASS' }))
} finally {
  childProcess.execFile = originalExec
  os.platform = originalPlatform
  console.debug = originalDebug
  syncBuiltinESMExports()
}
