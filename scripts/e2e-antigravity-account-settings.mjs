// Read-only official version/config commands. Retain only a whitelist of types.
// No model, auth/login, settings write, raw stdout/stderr or account identifiers.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const [executable, cwd, outputPath] = process.argv.slice(2)
if (!executable || !cwd || !outputPath) throw new Error('Expected executable, owned workdir, output path')
const env = { ...process.env }
env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
for (const key of Object.keys(env)) if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_.*|GOOGLE_GEMINI_BASE_URL|ANTHROPIC_.*|OPENAI_.*|OPENROUTER_.*|AZURE_OPENAI_.*|MERIDIAN_API_KEY)$/.test(key)) delete env[key]
const commands = []
async function binaryHash() {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(executable)) hash.update(chunk)
  return hash.digest('hex')
}
const initialBinaryHash = await binaryHash()
async function read(args) {
  const beforeHash = await binaryHash()
  if (beforeHash !== initialBinaryHash) {
    commands.push({ args, failure: 'binary-identity-changed-before-command', beforeHash })
    return null
  }
  const started = performance.now()
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdoutBytes = 0, stderrBytes = 0, failure, forced, finalDrain, done = false
  let stdoutClosed = false, stderrClosed = false, stdoutEof = false, stderrEof = false
  let closeObserved = false, resolveRead
  const chunks = []
  function stop(reason) {
    failure ??= reason
    if (done) return
    function signal(name) {
      if (!child.pid) return
      try { process.kill(-child.pid, name) }
      catch (error) { if (error.code !== 'ESRCH') failure = 'signal-error' }
    }
    signal('SIGTERM')
    forced ??= setTimeout(() => signal('SIGKILL'), 1000)
    finalDrain ??= setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy()
      child.unref()
      settle(child.exitCode, child.signalCode)
    }, 3000)
  }
  const timeout = setTimeout(() => stop('deadline'), 20000)
  child.on('error', () => { failure ??= 'spawn-error' })
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length
    if (stdoutBytes + stderrBytes > 1024 * 1024) stop('output-limit')
    else chunks.push(chunk)
  })
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length
    if (stdoutBytes + stderrBytes > 1024 * 1024) stop('output-limit')
  })
  child.stdout.on('error', () => stop('stdout-error'))
  child.stderr.on('error', () => stop('stderr-error'))
  child.stdout.on('close', () => { stdoutClosed = true })
  child.stderr.on('close', () => { stderrClosed = true })
  child.stdout.on('end', () => { stdoutEof = true })
  child.stderr.on('end', () => { stderrEof = true })
  function settle(code, signal) {
    if (done) return
    done = true
    clearTimeout(timeout); clearTimeout(forced); clearTimeout(finalDrain)
    commands.push({ args, pid: child.pid ?? null, code, signal, failure: failure ?? null,
      elapsedMs: Math.round(performance.now() - started), stdoutBytes, stderrBytes,
      childCloseObserved: closeObserved, stdoutClosed, stderrClosed, stdoutEof, stderrEof,
      cleanupIncomplete: !closeObserved || !stdoutEof || !stderrEof,
      descendantCensus: 'NOT_AUDITED' })
    resolveRead(!failure && closeObserved && code === 0 && stdoutEof && stderrEof ? Buffer.concat(chunks).toString('utf8') : null)
  }
  const output = await new Promise(resolve => {
    resolveRead = resolve
    child.once('close', (code, signal) => { closeObserved = true; settle(code, signal) })
  })
  const afterHash = await binaryHash()
  Object.assign(commands.at(-1), { beforeHash, afterHash })
  return beforeHash === afterHash ? output : null
}
const report = { platform: process.platform, arch: process.arch, node: process.version,
  initialBinaryHash, updateDisabled: 'AGY_CLI_DISABLE_AUTO_UPDATE=true',
  nativeVersion: null, commands, result: 'INCOMPLETE', fields: null, modelCommands: 0 }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
try {
  const version = await read(['--version'])
  if (version?.trim() !== '1.5.13') report.result = 'UNSUPPORTED_OR_UNREADABLE_VERSION'
  else {
    report.nativeVersion = '1.5.13'
    const raw = await read(['-p', '/config', '--output-format', 'json'])
    if (raw === null) report.result = 'CONFIG_COMMAND_FAILED'
    else {
      let parsed
      try { parsed = JSON.parse(raw) } catch { report.result = 'INVALID_JSON' }
      const envelope = object(parsed) && typeof parsed.status === 'string' && typeof parsed.response === 'string' ? parsed : null
      if (report.result !== 'INVALID_JSON' && !envelope) report.result = 'UNKNOWN_CONFIG_ENVELOPE'
      if (envelope) {
        if (envelope.status !== 'SUCCESS') report.result = 'CONFIG_STATUS_NOT_SUCCESS'
        else {
          // agy 1.5.5 and 1.5.13 print effective settings as a TSV block in `response`.
          const rows = new Map(envelope.response.split('\n').filter(line => line.includes('\t')).map(line => [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)]))
          report.fields = Object.fromEntries(['customModelsConfig', 'modelProvider', 'useG1Credits', 'gcp'].map(key => {
            const present = rows.has(key), value = rows.get(key)
            const field = { present, type: present ? 'string' : 'undefined' }
            if (key === 'useG1Credits') field.value = value
            else if (present) field.empty = value.trim().length === 0
            return [key, field]
          }))
          report.result = 'TSV_EFFECTIVE_SETTINGS_OBSERVED'
        }
      }
    }
  }
} finally {
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report))
}
if (report.result !== 'TSV_EFFECTIVE_SETTINGS_OBSERVED') process.exitCode = 1
