import { mock } from 'bun:test'
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [source, root, mode] = process.argv.slice(2)
const sql = !mode.startsWith('json-')
const delayed = mode.endsWith('-slow')
const embedded = mode.startsWith('embedded-')
const idle = mode.endsWith('-idle')
const withChatGpt = mode.includes('chatgpt')
if (!root || (process.platform !== 'win32' && (statSync(root).mode & 0o777) !== 0o700)) throw new Error('expected owned private disposable root')
const sessions = join(root, 'sessions')
for (const name of ['sessions', 'config', 'claude', 'plugins', 'xdg', 'work']) mkdirSync(join(root, name), { mode: 0o700 })
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_') || key.startsWith('ANTHROPIC_') || key === 'CLAUDE_CODE_OAUTH_TOKEN') delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: sessions,
  MERIDIAN_WORKDIR: join(root, 'work'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
  XDG_CONFIG_HOME: join(root, 'xdg'), MERIDIAN_BOOKKEEPING: sql ? 'sqlite' : 'json',
  MERIDIAN_ROUTING: 'manual', MERIDIAN_PASSTHROUGH: '0',
  MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1',
  MERIDIAN_SESSION_GC_GRACE_MS: '3600000', MERIDIAN_SESSION_GC_INTERVAL_MS: '3600000',
  MERIDIAN_SHUTDOWN_GRACE_MS: '50', MERIDIAN_SHUTDOWN_CLEANUP_DEADLINE_MS: '2000', MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE: '1',
  MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_BACKEND: 'claude',
})

const events = []
const beginning = performance.now()
const note = (name, fields = {}) => events.push({ name, elapsedMs: Number((performance.now() - beginning).toFixed(3)), ...fields })
const counters = { sdkQueries: 0, gcRuns: 0, syntheticAuthChecks: 0, syntheticExecutableResolutions: 0, syntheticCredentialReads: 0, outboundFetchRefusals: 0, realCredentialReads: 0, spawnedSdkChildren: 0 }
const realFetch = globalThis.fetch
Reflect.set(globalThis, 'fetch', async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    counters.outboundFetchRefusals++
    throw new Error('P4 probe forbids non-loopback network')
  }
  return realFetch(input, init)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function bounded(promise, name, ms = process.platform === 'win32' ? 30000 : 6000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}
const queryStarted = deferred()
const cleanupStarted = deferred()
const releaseCleanup = deferred()
const cleanupFinished = deferred()
let heldFinalizer = false

// Keep the real pure model logic. Replace only executable/auth boundaries.
const modelPath = join(source, 'src/proxy/models.ts')
const models = await import(modelPath)
mock.module(modelPath, () => ({ ...models,
  resolveClaudeExecutableAsync: async () => { counters.syntheticExecutableResolutions++; return '/__p4_mock_cli_never_spawned__' },
  resolveClaudeExecutableSync: () => ({ path: '/__p4_mock_cli_never_spawned__', source: 'configured' }),
  getResolvedClaudeExecutableInfo: () => ({ path: '/__p4_mock_cli_never_spawned__', source: 'configured' }),
  getClaudeAuthStatusAsync: async () => { counters.syntheticAuthChecks++; return { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' } },
}))
const tokenPath = join(source, 'src/proxy/tokenRefresh.ts')
const tokens = await import(tokenPath)
const syntheticStore = { read: async () => { counters.syntheticCredentialReads++; return null }, write: async () => { throw new Error('P4 probe forbids credential writes') } }
mock.module(tokenPath, () => ({ ...tokens,
  createPlatformCredentialStore: () => syntheticStore,
  ensureFreshToken: async () => false, refreshOAuthToken: async () => false,
  startBackgroundRefresh: () => {}, stopBackgroundRefresh: () => {},
  readStoredCredentialPresence: async () => 'unknown', getStoredPlanFields: async () => ({}),
  getAuthRenewalStatus: async () => ({ refreshTokenExpiresAt: null, daysUntilRenewal: null, renewalRequiredSoon: false }),
}))
mock.module(join(source, 'src/logger.ts'), () => ({
  claudeLog: (name) => { if (name.startsWith('passthrough.client_abort') || name.includes('cleanup') || name.includes('bookkeeping')) note('productionLog', { event: name }) },
  withClaudeLogContext: (_context, callback) => callback(),
}))
mock.module(join(source, 'src/proxy/mcpTools.ts'), () => ({ createOpencodeMcpServer: () => ({ type: 'sdk', name: 'opencode', instance: {} }) }))

const { setSdkMock } = await import(join(source, 'src/__tests__/sdkMock.ts'))
const helpers = await import(join(source, 'src/__tests__/helpers.ts'))
setSdkMock(() => ({
  query(params) {
    counters.sdkQueries++
    return (async function* () {
      const sessionId = helpers.resolveMockSdkSessionId(params.options, 'p4-synthetic-sdk-session')
      note('mockSdkStarted')
      queryStarted.resolve()
      yield { ...helpers.messageStart(), session_id: sessionId }
      yield { ...helpers.textBlockStart(0), session_id: sessionId }
      const signal = params.options.abortController.signal
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      note('mockSdkObservedAbort')
      throw Object.assign(new Error('synthetic SDK abort'), { name: 'AbortError' })
    })()
  },
  createSdkMcpServer: () => ({ type: 'sdk', name: 'test', instance: {} }),
  tool: () => ({}),
}), 'isolated P4 shutdown probe')

// Explicit fault injection: pause the ACTUAL production request's finalizer.
// The real SQL transcript-lease release still runs after the pause.
const lifecyclePath = join(source, 'src/proxy/sessionLifecycle.ts')
const lifecycle = await import(lifecyclePath)
const realReleaseJoinedTranscriptLease = lifecycle.releaseJoinedTranscriptLease
const realRunGc = lifecycle.runGc
if (typeof realRunGc !== 'function') throw new Error('expected the real lifecycle GC entrypoint')
mock.module(lifecyclePath, () => ({ ...lifecycle,
  async runGc(...args) {
    counters.gcRuns++
    return realRunGc(...args)
  },
  async releaseJoinedTranscriptLease(...args) {
    if (delayed && !heldFinalizer) {
      heldFinalizer = true
      note('actualRequestFinalizerPaused')
      cleanupStarted.resolve()
      await releaseCleanup.promise
      note('actualRequestFinalizerReleased')
    }
    await realReleaseJoinedTranscriptLease(...args)
    note('actualSqlTranscriptLeaseReleased')
    cleanupFinished.resolve()
  },
}))

const { retainedBookkeepingRuntimeDirectory } = await import(join(source, 'src/proxy/session/bookkeeping/runtimeIdentity.ts'))
const { acquireMaintenanceGuard } = await import(join(source, 'src/proxy/session/bookkeeping/guard.ts'))
const { connectionFor } = await import(join(source, 'src/proxy/session/bookkeeping/connection.ts'))
const { activeStoreBackend } = await import(join(source, 'src/proxy/session/bookkeeping/storeBackend.ts'))
const { acquireWriterLease, WriterLeaseUnavailableError } = await import(join(source, 'src/proxy/chatgpt/lease.ts'))

// The optional ChatGPT case owns a REAL lease over an EMPTY disposable store.
// No token, sign-in, renewal or operator credential store is involved.
const chatGptStore = join(root, 'config', 'owned-empty-chatgpt.json')
if (withChatGpt) {
  const { createOwnedCredentialSource } = await import(join(source, 'src/proxy/chatgpt/owned.ts'))
  const owned = createOwnedCredentialSource({ storePath: chatGptStore, allowEmpty: true, readOnly: false })
  mock.module(join(source, 'src/proxy/chatgpt/config.ts'), () => ({ resolveChatGptSource: () => owned }))
  // Version discovery is outside this ownership regression; keep it offline.
  const versionPath = join(source, 'src/proxy/chatgpt/clientVersion.ts')
  const versions = await import(versionPath)
  mock.module(versionPath, () => ({ ...versions,
    createCodexClientVersion: options => versions.fixedCodexClientVersion(options.pinned),
  }))
}
async function chatGptLeaseAvailable() {
  if (!withChatGpt) return undefined
  try {
    const lease = await acquireWriterLease({ lockPath: `${chatGptStore}.lock`, waitMs: 0 })
    lease.release()
    return true
  } catch (error) {
    if (!(error instanceof WriterLeaseUnavailableError)) throw error
    return false
  }
}
const { startProxyServer, createProxyServer, initializeProxyBookkeeping } = await import(join(source, 'src/proxy/server.ts'))

function ownershipSnapshot(label) {
  let guardReleased = false
  let guardError
  try { const guard = acquireMaintenanceGuard(sessions); guardReleased = true; guard.close() }
  catch (error) { guardError = { name: error.name, message: error.message } }
  let connection
  try { const actual = connectionFor(sessions); connection = { refs: actual.refs, pending: actual.pending, phase: actual.phase, databaseOpen: Boolean(actual.db) } }
  catch (error) { connection = { unavailable: true, error: error.message } }
  const result = { label, guardReleased, guardError, runtimeIdentityRetained: retainedBookkeepingRuntimeDirectory() === realpathSync.native(sessions), sqliteBackendInstalled: Boolean(activeStoreBackend()), connection }
  note('ownershipSnapshot', result)
  return result
}


let instance, backend, outerOwner, closePromise, readResult
let outcome = 'pending', closeError
const watchdog = setTimeout(() => { console.error('shutdown fixture watchdog expired'); process.exit(70) }, process.platform === 'win32' ? 60000 : 12000)
try {
  const config = { port: 0, host: '127.0.0.1', silent: true, backend: 'claude',
    profiles: [{ id:'owned-api-fixture', type:'api', apiKey:'owned-not-a-provider-key', baseUrl:'http://127.0.0.1:1' }],
    defaultProfile:'owned-api-fixture', pluginDir: join(root, 'plugins'), pluginConfigPath: join(root, 'config/plugins.json') }
  let request
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session': 'shutdown-own-session' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, max_tokens: 128,
      messages: [{ role: 'user', content: 'synthetic request; never sent upstream' }] }) }
  if (embedded) {
    outerOwner = await initializeProxyBookkeeping()
    backend = createProxyServer(config)
    if (!idle) request = backend.app.fetch(new Request('http://127.0.0.1/v1/messages', init))
  } else {
    instance = await startProxyServer(config)
    const address = instance.server.address()
    if (!address || typeof address === 'string') throw new Error('expected live TCP listener')
    request = fetch(`http://127.0.0.1:${address.port}/v1/messages`, init)
  }
  if (!idle) {
    await bounded(queryStarted.promise, 'SDK request started')
    const response = await bounded(request, 'streaming response')
    if (response.status !== 200) throw new Error(`request refused: ${response.status}`)
    readResult = response.text().then(body => ({ bodyBytes: body.length }), error => ({ error: error.name }))
  }
  if (embedded) { backend.beginDrain(); backend.forceAbortInFlight() }
  const close = () => embedded ? backend.closeBackend() : instance.close()
  closePromise = close()
  const identicalPromise = close() === closePromise
  const settled = closePromise.then(() => { outcome='fulfilled' }, error => { outcome='rejected';closeError=error.message })
  if (delayed) await bounded(cleanupStarted.promise, 'paused actual request finalizer')
  if (embedded) await Bun.sleep(100)
  else await bounded(settled, 'bounded close outcome', 5000)
  const beforeRelease = ownershipSnapshot('before paused finalizer release')
  const beforeReleaseChatGptLeaseAvailable = await chatGptLeaseAvailable()
  const outcomeBeforeRelease = outcome
  releaseCleanup.resolve()
  if (!idle) {
    await bounded(cleanupFinished.promise, 'actual SQL transcript lease released')
    await bounded(readResult, 'response consumer settled')
  }
  if (embedded) await bounded(settled, 'embedded backend joined')
  const deadline = Date.now()+2000
  while (Date.now()<deadline && (embedded ? activeStoreBackend() && connectionFor(sessions).refs > 1 : activeStoreBackend())) await Bun.sleep(5)
  const afterBackend = ownershipSnapshot('request and backend cleanup joined')
  if (outerOwner) await outerOwner.close()
  const afterOuterOwner = ownershipSnapshot('all owned cleanup joined')
  const afterCloseChatGptLeaseAvailable = await chatGptLeaseAvailable()
  const report = { mode, sql, delayed, embedded, idle, identicalPromise, outcomeBeforeRelease, outcome, closeError,
    beforeRelease, afterBackend, afterOuterOwner, listenerClosed: !instance || !instance.server.listening,
    withChatGpt, beforeReleaseChatGptLeaseAvailable, afterCloseChatGptLeaseAvailable,
    counters, events, platform: process.platform, arch: process.arch, bun: process.versions.bun }
  writeFileSync(join(root,'result.json'), JSON.stringify(report,null,2)+'\n')
  console.log('SHUTDOWN_REPORT '+JSON.stringify(report))
} catch (error) {
  releaseCleanup.resolve()
  if (closePromise) await Promise.race([closePromise.catch(() => undefined), Bun.sleep(1000)])
  console.error(error.stack)
  process.exitCode=1
} finally {
  releaseCleanup.resolve()
  clearTimeout(watchdog)
}
// The parent joins this ORIGINAL process and both pipes. Successful-path guard
// assertions are made above before exit; an old implementation may leak ownership.
process.exit(process.exitCode ?? 0)
