#!/usr/bin/env bun
// Auth-only actual-native gate. Preparation does not execute this payload.
// Use the same file for baseline/fixed source and an independently installed core.
// No model/client/catalog claim and no whole-OS containment claim.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'

const SELF = fileURLToPath(import.meta.url)
const DELAY = 8000
const NATIVE_LIMIT = 90000
const NATIVE_SHA256 = '50a14c2f50f56668380fdda490167f1d3630d5cc18fb8aed3073c2c7ea7314fe'
const CASES = ['cold', 'stale', 'sibling', 'last-owner', 'direct', 'logged-out']
const options = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => {
  const at = x.indexOf('='); return [x.slice(2, at), x.slice(at + 1)]
}))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function check(value, code) { if (!value) throw Object.assign(new Error(code), { gateCode: code }) }
function within(root, path) { return realpathSync(path).startsWith(realpathSync(root) + sep) }
function deadline(promise, ms, code) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { gateCode: code })), ms) })]).finally(() => clearTimeout(timer))
}
function quietEnv(work) {
  // Keep real HOME/CODEX_HOME untouched. Do not inherit host credentials/settings.
  return {
    PATH: '/usr/bin:/bin', TMPDIR: join(work, 'tmp'),
    USER: `meridian_auth_gate_${work.split(sep).at(-1).replace(/[^a-zA-Z0-9]/g, '').slice(-20)}`,
    XDG_CONFIG_HOME: join(work, 'xdg-config'), OPENCODE_CONFIG_DIR: join(work, 'opencode-config'),
    ANTHROPIC_CONFIG_DIR: join(work, 'anthropic-config'),
    CLAUDE_CONFIG_DIR: join(work, 'native-config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    MERIDIAN_CONFIG_DIR: join(work, 'config'), MERIDIAN_SESSION_DIR: join(work, 'sessions'),
    MERIDIAN_WORKDIR: join(work, 'work'), MERIDIAN_TELEMETRY_PERSIST: '0',
    MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_CREDENTIALS_READONLY: '1',
    MERIDIAN_SESSION_GC_INTERVAL_MS: '0', MERIDIAN_ROUTING: 'active',
    MERIDIAN_BACKEND: 'claude', MERIDIAN_ANNOUNCE: '0', MERIDIAN_ADVERTISE: '0',
  }
}
function prepareDirs(work) {
  for (const name of ['tmp', 'native-config', 'config', 'config/profiles', 'sessions', 'work', 'plugins', 'xdg-config', 'opencode-config', 'anthropic-config']) mkdirSync(join(work, name), { recursive: true, mode: 0o700 })
  writeFileSync(join(work, 'config/profiles.json'), '[]\n', { mode: 0o600 })
  writeFileSync(join(work, 'config/plugins.json'), '[]\n', { mode: 0o600 })
}

// Wrapper: exact child handles, unchanged private stdout, bounded own-child stop.
// SIGSTOP/SIGCONT delays the real auth process, so pending-close has a native child.
async function wrapper() {
  const args = process.argv.slice(process.argv.indexOf('--') + 1)
  const auth = args.length === 2 && args[0] === 'auth' && args[1] === 'status'
  check(auth || (args.length === 1 && args[0] === '--version'), 'WRAPPER_ARGUMENTS_REFUSED')
  const id = randomUUID(), started = Date.now()
  const record = (event, fields = {}) => { if (auth) appendFileSync(options.events, JSON.stringify({ id, event, elapsedMs: Date.now() - started, ...fields }) + '\n', { mode: 0o600 }) }
  let child, exited = false, closed = false, stdoutClosed = false, stderrClosed = false
  let exitCode = null, exitSignal = null, writes = 0, stdoutBytes = 0, stderrBytes = 0
  let nativeJson = '', firstStdoutMs = null, stopped = false, stopStarted = false
  let resumeTimer, processTimer, resolveJoined
  const joined = new Promise(r => { resolveJoined = r })
  const witness = () => { if (exited && closed && stdoutClosed && stderrClosed && writes === 0) resolveJoined() }
  const signal = value => { if (child && !exited && !closed) child.kill(value) }
  const stop = async reason => {
    if (stopStarted) return joined
    stopStarted = true; clearTimeout(resumeTimer); clearTimeout(processTimer)
    record('stop_requested', { reason })
    // TERM may stay pending while stopped. Resume this exact child first.
    if (stopped) { signal('SIGCONT'); stopped = false }
    signal('SIGTERM')
    const force = setTimeout(() => signal('SIGKILL'), 500)
    try { await deadline(joined, 1800, 'NATIVE_JOIN_UNCONFIRMED') }
    finally { clearTimeout(force) }
  }
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { void stop(s).catch(() => { record('join_unconfirmed'); process.exit(74) }) })
  child = spawn(options.native, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  record('native_spawn', { pid: child.pid ?? null })
  child.once('error', () => { record('spawn_error'); process.exit(73) })
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length
    firstStdoutMs ??= Date.now() - started
    if (stdoutBytes > 256 * 1024) { void stop('stdout_limit').catch(() => { record('join_unconfirmed'); process.exit(74) }); return }
    if (auth) nativeJson += chunk.toString('utf8')
    // This is the original native Buffer, not serialized/replaced auth JSON.
    writes++
    process.stdout.write(chunk, () => { writes--; witness() })
  })
  process.stdout.once('error', () => { void stop('stdout_forward_error').catch(() => { record('join_unconfirmed'); process.exit(74) }) })
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length
    // Diagnostics stay private and are discarded; never echo native stderr.
    if (stderrBytes > 256 * 1024) void stop('stderr_limit').catch(() => { record('join_unconfirmed'); process.exit(74) })
  })
  child.stdout.once('close', () => { stdoutClosed = true; witness() })
  child.stderr.once('close', () => { stderrClosed = true; witness() })
  child.once('exit', (code, s) => { exited = true; exitCode = code; exitSignal = s; record('native_exit', { code, signal: s }); witness() })
  child.once('close', () => { closed = true; witness() })
  if (auth) {
    if (!child.kill('SIGSTOP')) { await stop('pause_failed'); check(false, 'NATIVE_PAUSE_FAILED') }
    stopped = true
    record('paused')
    resumeTimer = setTimeout(() => { if (!exited && !closed && !stopStarted) { signal('SIGCONT'); stopped = false; record('resumed') } }, DELAY)
    processTimer = setTimeout(() => { void stop('native_deadline').catch(() => { record('join_unconfirmed'); process.exit(74) }) }, NATIVE_LIMIT)
  }
  await deadline(joined, NATIVE_LIMIT + 2200, 'NATIVE_JOIN_UNCONFIRMED')
  clearTimeout(resumeTimer); clearTimeout(processTimer)
  let loggedIn = null, authMethod = null, configMatches = null
  if (auth) {
    try {
      const parsed = JSON.parse(nativeJson)
      loggedIn = typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null
      authMethod = ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(parsed.authMethod) ? parsed.authMethod : null
      configMatches = typeof parsed.configDirectory === 'string' && resolve(parsed.configDirectory) === resolve(process.env.CLAUDE_CONFIG_DIR)
    } catch { loggedIn = null }
    record('native_joined', { exitSeen: exited, closeSeen: closed, stdoutClosed, stderrClosed, writesFlushed: writes === 0, code: exitCode, signal: exitSignal, stdoutBytes, stderrBytes, firstStdoutMs, loggedIn, authMethod, configMatches })
  }
  process.exit(exitSignal === null && Number.isInteger(exitCode) ? exitCode : 75)
}

async function worker() {
  const work = options.work, eventsPath = join(work, 'native-events.jsonl')
  const result = { result: 'FAIL', case: options.case, context: options.context, platform: `${process.platform}/${process.arch}`, bun: process.versions.bun ?? null, nodeCompatibility: process.versions.node, entryPath: options.entry, nativePath: options.native, nativeVersion: '2.1.284 (Claude Code)', entrySha256: sha(options.entry), harnessSha256: sha(SELF), nativeSha256: sha(options.native), queryCount: 0, http: [], native: [], wrapper: [], warnings: { total: 0, loggedOutExit: 0 }, controls: {} }
  const privateConsole = () => { result.warnings.total++ }
  console.log = privateConsole; console.error = privateConsole; console.debug = privateConsole
  console.warn = (...args) => { result.warnings.total++; if (args.some(x => typeof x === 'string' && /exited with code 1 reporting loggedIn: false/.test(x))) result.warnings.loggedOutExit++ }
  let token = null, tokenInput = null
  if (options['token-file']) {
    tokenInput = readFileSync(options['token-file'])
    token = tokenInput.toString('utf8').trim()
    check(token.length > 0 && token.length < 8192 && !/[\r\n{}]/.test(token), 'TOKEN_INPUT_NOT_ACCESS_ONLY_LINE')
  }
  check(options.case === 'logged-out' ? token === null : token !== null, 'TOKEN_CONTEXT_MISMATCH')
  let backends = [], transports = [], observed = [], wrapperChildren = [], sourceModels, querySpy, processSpy, firstFailure = null, shuttingDown = false, rejectStop
  const stopped = new Promise((_, reject) => { rejectStop = reject })
  const requestStop = () => { shuttingDown = true; rejectStop(Object.assign(new Error('WORKER_CANCELLED'), { gateCode: 'WORKER_CANCELLED' })) }
  process.once('SIGTERM', requestStop); process.once('SIGINT', requestStop)
  const events = () => existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : []
  const authStarted = () => events().filter(x => x.event === 'native_spawn').length
  const authJoined = () => events().filter(x => x.event === 'native_joined')
  const until = async (predicate, ms, code) => {
    const stopAt = Date.now() + ms
    while (!predicate()) { check(!shuttingDown, 'WORKER_CANCELLED'); check(Date.now() < stopAt, code); await sleep(25) }
    check(!shuttingDown, 'WORKER_CANCELLED')
  }
  try {
    const exercise = async () => {
      check(process.platform === 'darwin' && process.arch === 'arm64', 'TUPLE_NOT_MAC_ARM64')
      check(result.nativeSha256 === NATIVE_SHA256, 'NATIVE_NOT_REVIEWED_2_1_284')
      const { spyOn } = await import('bun:test')
      const require = createRequire(pathToFileURL(options.entry))
      const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk')
      const sdk = await import(pathToFileURL(sdkPath).href)
      result.sdkEntrySha256 = sha(sdkPath)
      result.sdkVersion = JSON.parse(readFileSync(join(dirname(sdkPath), 'package.json'), 'utf8')).version
      querySpy = spyOn(sdk, 'query').mockImplementation(() => { result.queryCount++; throw Object.assign(new Error('SDK_QUERY_REFUSED'), { gateCode: 'SDK_QUERY_REFUSED' }) })
      const cp = await import('node:child_process'), originalExec = cp.execFile
      const observeExec = (file, args, ...rest) => {
        if (file !== process.env.MERIDIAN_CLAUDE_PATH || args?.join(' ') !== 'auth status') return originalExec(file, args, ...rest)
        const record = { callback: false, exit: false, close: false, stdoutClose: false, stderrClose: false, code: null, signal: null }
        const callback = rest.at(-1)
        check(typeof callback === 'function', 'EXECFILE_CALLBACK_MISSING')
        rest[rest.length - 1] = (...values) => { record.callback = true; callback(...values) }
        const child = originalExec(file, args, ...rest)
        record.pid = child.pid ?? null; observed.push(record)
        wrapperChildren.push({ child, record })
        child.once('exit', (code, signal) => { record.exit = true; record.code = code; record.signal = signal })
        child.once('close', () => { record.close = true })
        child.stdout?.once('close', () => { record.stdoutClose = true })
        child.stderr?.once('close', () => { record.stderrClose = true })
        return child
      }
      processSpy = spyOn(cp, 'execFile').mockImplementation(observeExec)
      // Node's original promisify.custom closes over the original execFile and
      // would evade observation. Preserve its {stdout,stderr}/error.stdout shape,
      // callback semantics and .child through this observer for the old baseline.
      const { promisify } = await import('node:util')
      Object.defineProperty(cp.execFile, promisify.custom, { configurable: true, value: (...args) => {
        let child
        const promise = new Promise((resolve, reject) => {
          child = observeExec(...args, (error, stdout, stderr) => {
            if (error) { error.stdout = stdout; error.stderr = stderr; reject(error) }
            else resolve({ stdout, stderr })
          })
        })
        promise.child = child
        return promise
      } })
      const module = await import(pathToFileURL(options.entry).href)
      check(typeof module.createProxyServer === 'function', 'ENTRY_CREATE_PROXY_MISSING')
      if (options.models) sourceModels = await import(pathToFileURL(options.models).href)
      if (options.case === 'direct') check(typeof sourceModels?.getClaudeAuthStatusAsync === 'function', 'DIRECT_CONTROL_SOURCE_ONLY')
      const profileId = options.context === 'default' ? 'default' : 'focused'
      const profile = { id: profileId, type: 'oauth-token', ...(token ? { oauthToken: token } : {}) }
      if (token) mkdirSync(join(work, 'config/profiles', profileId), { recursive: true, mode: 0o700 })
      const create = async () => {
        check(!shuttingDown, 'WORKER_CANCELLED')
        const backend = module.createProxyServer({ backend: 'claude', profiles: [profile], defaultProfile: profileId, silent: true, debug: false, pluginDir: join(work, 'plugins'), pluginConfigPath: join(work, 'config/plugins.json'), installProcessErrorHandlers: false })
        backends.push(backend)
        // GET-only loopback transport avoids relying on a consumer devDependency.
        // The public core's real Hono routes and real auth owner remain in use.
        const server = createServer((request, response) => {
          void (async () => {
            if (request.method !== 'GET' || !['/health', '/profiles/list', '/livez'].includes(request.url)) {
              response.writeHead(405); response.end(); return
            }
            const nativeResponse = await backend.app.fetch(new Request('http://127.0.0.1' + request.url, { method: 'GET' }))
            response.writeHead(nativeResponse.status, Object.fromEntries(nativeResponse.headers))
            response.end(await nativeResponse.text())
          })().catch(() => { if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"HTTP_PRIVATE_FAILURE"}') })
        })
        transports.push(server)
        await deadline(new Promise((r, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', r) }), 2000, 'HTTP_BIND_TIMEOUT')
        const addr = server.address(); check(addr && typeof addr === 'object', 'HTTP_ADDRESS_MISSING')
        return { backend, server, url: `http://127.0.0.1:${addr.port}` }
      }
      const get = async (instance, path, label, bound = 6500) => {
        check(!shuttingDown, 'WORKER_CANCELLED')
        const start = performance.now()
        const response = await fetch(instance.url + path, { signal: AbortSignal.timeout(bound + 1000) })
        const body = await response.json(), ms = Math.round(performance.now() - start)
        check(!shuttingDown, 'WORKER_CANCELLED')
        const list = Array.isArray(body) ? body : body.profiles
        const p = list?.find(x => x.id === profileId)
        const fact = path === '/profiles/list' ? { label, path, status: response.status, ms, loggedIn: p?.loggedIn ?? null, provenance: p?.authProvenance ?? null, lastSuccessObserved: Boolean(p?.lastSuccessAt) } : { label, path, status: response.status, ms, health: body.status ?? null, loggedIn: body.auth?.loggedIn ?? null }
        result.http.push(fact); check(ms < bound, 'HTTP_PATIENCE_EXCEEDED'); return fact
      }
      const first = await create()
      if (options.case === 'cold' || options.case === 'stale' || options.case === 'logged-out') {
        const requests = [get(first, '/health', 'cold-health-1'), get(first, '/health', 'cold-health-2'), get(first, '/profiles/list', 'cold-list')]
        await until(() => authStarted() === 1, 3000, 'AUTH_NOT_STARTED')
        const liveStart = performance.now(), live = await fetch(first.url + '/livez', { signal: AbortSignal.timeout(1000) })
        await deadline(live.text(), 1000, 'LIVEZ_BODY_NOT_DRAINED')
        check(live.status === 200 && performance.now() - liveStart < 1000, 'EVENT_LOOP_NOT_RESPONSIVE')
        const pending = await Promise.all(requests)
        check(pending[0].health === 'degraded' && pending[1].health === 'degraded', 'COLD_NOT_DEGRADED')
        check(pending[2].provenance === 'never' && pending[2].loggedIn === false && !pending[2].lastSuccessObserved, 'PENDING_NOT_NEVER')
        check(authStarted() === 1, 'CONCURRENT_DUPLICATE_NATIVE')
        await until(() => authJoined().length === 1, NATIVE_LIMIT + 2500, 'LATE_NATIVE_NOT_JOINED')
        const joined = authJoined()[0]
        const late = await get(first, '/health', 'late-health', 1500)
        const list = await get(first, '/profiles/list', 'late-list', 1500)
        if (options.case === 'logged-out') {
          check(joined.loggedIn === false && joined.code === 1 && joined.authMethod === 'none', 'NATIVE_NOT_LOGGED_OUT')
          check(late.status === 503 && late.health === 'unhealthy' && late.loggedIn === false
            && list.provenance === 'live' && list.loggedIn === false && !list.lastSuccessObserved,
          'EXPLICIT_LOGOUT_NOT_RECORDED')
          check(result.warnings.loggedOutExit >= 1, 'LOGOUT_NUMERIC_DIAGNOSTIC_MISSING')
          result.controls.loggedOut = 'actual-native-false-exit-1-maps-to-observed-logout-without-login-success'
        } else {
          check(late.health === 'healthy' && late.loggedIn === true && list.loggedIn === true && list.provenance === 'live', 'LATE_NOT_HEALTHY')
          check(joined.code === 0 && joined.loggedIn === true && joined.authMethod === 'oauth_token' && joined.configMatches, 'NATIVE_LOGIN_OR_CONFIG_MISMATCH')
          check(joined.firstStdoutMs >= DELAY, 'NATIVE_DELAY_NOT_OBSERVED')
          check(authStarted() === 1, 'WARM_CACHE_DUPLICATE_NATIVE')
          result.controls.warm = 'prompt-cached-health-and-profile-list'
          if (options.case === 'stale') {
            // Public package has no cache-expiry helper. Observe the real 60s TTL.
            await sleep(61000)
            const stale = await Promise.all([get(first, '/health', 'stale-health', 1500), get(first, '/profiles/list', 'stale-list', 1500)])
            check(stale[0].health === 'healthy' && stale[1].loggedIn === true, 'STALE_NOT_PROMPT_USABLE')
            await until(() => authStarted() === 2, 3000, 'STALE_REFRESH_NOT_STARTED')
            check(authStarted() === 2, 'STALE_DUPLICATE_NATIVE')
            await until(() => authJoined().length === 2, NATIVE_LIMIT + 2500, 'STALE_NATIVE_NOT_JOINED')
            check((await get(first, '/health', 'refreshed-health', 1500)).health === 'healthy', 'STALE_REFRESH_NOT_HEALTHY')
            result.controls.stale = 'real-ttl-one-refresh-prompt-last-good'
          }
        }
      } else {
        const a = get(first, '/health', 'owner-a-pending')
        await until(() => authStarted() === 1, 3000, 'AUTH_NOT_STARTED')
        let survivor, direct
        if (options.case === 'sibling') {
          survivor = await create()
          const b = get(survivor, '/health', 'owner-b-pending')
          await sleep(200)
          await deadline(first.backend.closeBackend(), 3500, 'SIBLING_OWNER_CLOSE_TIMEOUT')
          await Promise.all([a, b])
        } else if (options.case === 'direct') {
          const env = { CLAUDE_CONFIG_DIR: join(work, 'config/profiles', profileId), CLAUDE_CODE_OAUTH_TOKEN: token }
          direct = sourceModels.getClaudeAuthStatusAsync(profileId === 'default' ? undefined : profileId, env)
          await sleep(200)
          await deadline(first.backend.closeBackend(), 3500, 'DIRECT_OWNER_CLOSE_TIMEOUT')
          await Promise.all([a, direct])
        } else {
          const closing = performance.now()
          await deadline(first.backend.closeBackend(), 3500, 'LAST_OWNER_CLOSE_TIMEOUT')
          result.controls.lastOwnerCloseMs = Math.round(performance.now() - closing)
          await a
        }
        if (options.case === 'last-owner') {
          await until(() => authJoined().length === 1, 3000, 'CANCELLED_NATIVE_NOT_JOINED')
          check(authJoined()[0].signal !== null && authJoined()[0].loggedIn === null, 'CANCELLED_NATIVE_GAVE_AUTH')
          survivor = await create()
          const pending = get(survivor, '/health', 'replacement-pending')
          await until(() => authStarted() === 2, 3000, 'CANCELLED_SLOT_NOT_RELEASED')
          await pending
        }
        const expected = options.case === 'last-owner' ? 2 : 1
        await until(() => authJoined().length === expected, NATIVE_LIMIT + 2500, 'SURVIVING_NATIVE_NOT_JOINED')
        check(authStarted() === expected, 'OWNERSHIP_DUPLICATE_NATIVE')
        if (options.case === 'direct') {
          const answer = await sourceModels.getClaudeAuthStatusAsync(profileId === 'default' ? undefined : profileId, { CLAUDE_CONFIG_DIR: join(work, 'config/profiles', profileId), CLAUDE_CODE_OAUTH_TOKEN: token })
          check(answer?.loggedIn === true, 'DIRECT_USER_LOST_SHARED_CHECK')
          result.controls.direct = 'source-only-independent-cache-user-survives-instance-close'
        } else {
          check((await get(survivor, '/health', 'surviving-healthy', 1500)).health === 'healthy', 'SURVIVING_OWNER_NOT_HEALTHY')
          result.controls[options.case] = 'actual-native-joined-and-remaining-owner-usable'
        }
      }
    }
    await Promise.race([exercise(), stopped])
  } catch (error) {
    firstFailure = error?.gateCode ?? 'UNCLASSIFIED_PRIVATE_WORKER_FAILURE'
  } finally {
    shuttingDown = true
    const clean = await Promise.allSettled(backends.map(x => deadline(x.closeBackend?.() ?? Promise.resolve(), 3500, 'FINAL_BACKEND_JOIN_TIMEOUT')))
    if (clean.some(x => x.status === 'rejected')) firstFailure ??= 'FINAL_BACKEND_JOIN_TIMEOUT'
    // An independent direct caller is deliberately outside instance ownership.
    // On harness failure, stop only handles witnessed by this execFile observer.
    for (const { child, record } of wrapperChildren) if (!record.exit && !record.close) child.kill('SIGTERM')
    try {
      await deadline((async () => { while (observed.some(x => !(x.callback && x.exit && x.close && x.stdoutClose && x.stderrClose))) await sleep(25) })(), 3500, 'WRAPPER_JOIN_UNCONFIRMED')
    } catch { firstFailure ??= 'WRAPPER_JOIN_UNCONFIRMED' }
    for (const server of transports) {
      const closing = new Promise((r, reject) => server.close(error => error ? reject(error) : r()))
      server.closeAllConnections?.()
      try { await deadline(closing, 2000, 'HTTP_CLOSE_TIMEOUT') }
      catch { firstFailure ??= 'HTTP_CLOSE_TIMEOUT' }
    }
    result.native = authJoined(); result.wrapper = observed
    if (result.native.length !== authStarted() || observed.length !== authStarted()) firstFailure ??= 'OWNED_CHILD_CENSUS_MISMATCH'
    if (observed.some(x => !(x.callback && x.exit && x.close && x.stdoutClose && x.stderrClose))) firstFailure ??= 'WRAPPER_JOIN_UNCONFIRMED'
    if (result.queryCount !== 0) firstFailure ??= 'SDK_QUERY_OCCURRED'
    result.firstFailure = firstFailure
    result.result = firstFailure ? 'FAIL' : 'PASS'
    result.entryUnchanged = sha(options.entry) === result.entrySha256
    if (!result.entryUnchanged) { result.firstFailure ??= 'ENTRY_CHANGED'; result.result = 'FAIL' }
    result.harnessUnchanged = sha(SELF) === result.harnessSha256
    result.nativeUnchanged = sha(options.native) === result.nativeSha256
    if (!result.harnessUnchanged || !result.nativeUnchanged) { result.firstFailure ??= 'HARNESS_OR_NATIVE_CHANGED'; result.result = 'FAIL' }
    result.tokenInputUnchanged = tokenInput === null ? null : tokenInput.equals(readFileSync(options['token-file']))
    if (result.tokenInputUnchanged === false) { result.firstFailure ??= 'TASK_TOKEN_INPUT_CHANGED'; result.result = 'FAIL' }
    result.taskCredentialFilesAbsent = !existsSync(join(work, 'native-config/.credentials.json')) && !existsSync(join(work, 'config/profiles', options.context === 'default' ? 'default' : 'focused', '.credentials.json'))
    if (!result.taskCredentialFilesAbsent) { result.firstFailure ??= 'NATIVE_CREATED_TASK_STORED_CREDENTIAL'; result.result = 'FAIL' }
    writeFileSync(join(work, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    querySpy?.mockRestore(); processSpy?.mockRestore()
  }
  process.exit(result.result === 'PASS' ? 0 : 1)
}

async function coordinator() {
  const taskRoot = resolve(options['task-root'] ?? dirname(SELF))
  check(CASES.includes(options.case), 'CASE_REQUIRED')
  check(['default', 'profile'].includes(options.context), 'CONTEXT_REQUIRED')
  for (const key of ['entry', 'native', 'output']) check(options[key] && options[key].startsWith('/'), 'ABSOLUTE_PATH_REQUIRED')
  if (options['token-file']) check(options['input-dir'] && within(options['input-dir'], options['token-file']), 'TOKEN_NOT_IN_TASK_INPUT_DIR')
  if (options['input-dir']) check(within(taskRoot, options['input-dir']), 'INPUT_DIR_NOT_IN_TASK_NAMESPACE')
  check(options.case === 'logged-out' ? !options['token-file'] : Boolean(options['token-file']), 'TOKEN_CONTEXT_MISMATCH')
  check(process.platform === 'darwin' && process.arch === 'arm64', 'TUPLE_NOT_MAC_ARM64')
  const work = resolve(options.output)
  check(dirname(work) === taskRoot, 'OUTPUT_NOT_IN_TASK_NAMESPACE')
  if (options.models) check(dirname(resolve(options.models)) === dirname(resolve(options.entry)) && options.entry.endsWith('/server.ts'), 'SOURCE_MODELS_NOT_SAME_ENTRY_GRAPH')
  check(sha(options.native) === NATIVE_SHA256, 'NATIVE_NOT_REVIEWED_2_1_284')
  check(!existsSync(work), 'OUTPUT_MUST_BE_NEW')
  mkdirSync(work, { recursive: false, mode: 0o700 }); prepareDirs(work)
  const env = quietEnv(work), wrapperPath = join(work, 'claude-auth-wrapper')
  // createProxyServer does not start refresh timers. This absent-token control
  // disables only the readonly mtime inspection, which otherwise stats the
  // owner's default credential file when the profile supplies no env overrides.
  if (options.case === 'logged-out') env.MERIDIAN_CREDENTIALS_READONLY = '0'
  // Shell quotes are exact; the tiny launcher owns no extra process after exec.
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
  writeFileSync(wrapperPath, '#!/bin/sh\nexec ' + [process.execPath, SELF, '--role=wrapper', '--native=' + options.native, '--events=' + join(work, 'native-events.jsonl'), '--'].map(quote).join(' ') + ' "$@"\n', { mode: 0o700 })
  chmodSync(wrapperPath, 0o700); env.MERIDIAN_CLAUDE_PATH = wrapperPath
  const forwarded = Object.entries(options).filter(([k]) => !['role', 'output'].includes(k)).map(([k, v]) => `--${k}=${v}`)
  const child = spawn(process.execPath, [SELF, '--role=worker', '--work=' + work, ...forwarded], { cwd: join(work, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let exit = false, close = false, outClose = false, errClose = false, spawnFailed = false, code = null, signal = null, resolveJoin
  const joined = new Promise(r => { resolveJoin = r })
  const witness = () => { if ((exit || spawnFailed) && close && outClose && errClose) resolveJoin() }
  child.once('error', () => { spawnFailed = !child.pid; witness() })
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => { if (!exit && !close) child.kill('SIGTERM') })
  let outBytes = 0, errBytes = 0
  child.stdout.on('data', b => { outBytes += b.length; if (outBytes > 1024 * 1024 && !exit && !close) child.kill('SIGTERM') })
  child.stderr.on('data', b => { errBytes += b.length; if (errBytes > 1024 * 1024 && !exit && !close) child.kill('SIGTERM') })
  child.stdout.once('close', () => { outClose = true; witness() })
  child.stderr.once('close', () => { errClose = true; witness() })
  child.once('exit', (c, s) => { exit = true; code = c; signal = s; witness() })
  child.once('close', () => { close = true; witness() })
  const limit = options.case === 'stale' ? 270000 : options.case === 'last-owner' ? 200000 : 110000
  const timeout = setTimeout(() => { if (!exit && !close) child.kill('SIGTERM') }, limit)
  const force = setTimeout(() => { if (!exit && !close) child.kill('SIGKILL') }, limit + 15000)
  let joinFailure = false
  try { await deadline(joined, limit + 18000, 'WORKER_JOIN_UNCONFIRMED') }
  catch { joinFailure = true }
  clearTimeout(timeout); clearTimeout(force)
  const receipt = { case: options.case, context: options.context, workerExit: code, workerSignal: signal, spawnFailed, exitSeen: exit, closeSeen: close, stdoutClosed: outClose, stderrClosed: errClose, discardedPrivateStdoutBytes: outBytes, discardedPrivateStderrBytes: errBytes, joinFailure, resultFile: join(work, 'result.json'), payloadScope: 'actual-native-auth-only; SDK/model query count asserted zero; no whole-OS claim' }
  writeFileSync(join(work, 'coordinator.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  // Only generated public facts leave the worker; no raw product/native output.
  process.stdout.write(JSON.stringify(receipt) + '\n')
  process.exit(!joinFailure && code === 0 && signal === null ? 0 : 1)
}

const role = options.role ?? 'coordinator'
try {
  if (role === 'wrapper') await wrapper()
  else if (role === 'worker') await worker()
  else { check(role === 'coordinator', 'ROLE_REFUSED'); await coordinator() }
} catch (error) {
  const safeFailure = { result: 'FAIL', firstFailure: error?.gateCode ?? 'UNCLASSIFIED_PRIVATE_FAILURE', role,
    errorClass: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(error?.name) ? error.name : 'OTHER',
    errorCode: ['ENOENT', 'EACCES', 'EPERM', 'ERR_MODULE_NOT_FOUND', 'ENOTDIR'].includes(error?.code) ? error.code : null }
  if (role === 'worker' && options.work && options.work.startsWith('/')) {
    writeFileSync(join(options.work, 'startup-failure.json'), JSON.stringify(safeFailure, null, 2) + '\n', { mode: 0o600 })
  }
  process.stderr.write(JSON.stringify(safeFailure) + '\n')
  process.exit(1)
}
