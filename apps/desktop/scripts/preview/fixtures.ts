/**
 * Builds static preview pages for the desktop renderers from a snapshot of a
 * real Meridian's HTTP responses, so every screen can be screenshotted in a
 * browser without Electron, the main process or a running service.
 *
 *   bun scripts/preview/fixtures.ts <snapshot-dir> <out-dir>
 *
 * <snapshot-dir> holds the GET bodies the main process reads (health.json,
 * quota.json, requests.json, summary.json, logs.json, profiles.json,
 * plugins.json, features.json, routes.json, retention.json, providers.json,
 * settings-<section>.json). Snapshots contain account details: keep them and
 * the output outside the repository. Run `npm run build` first; the pages load
 * dist/window.js, dist/tray.js, theme.css and ui.css under the production CSP.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseProviderSnapshot } from '../../../../src/telemetry/providerView'
import type { DesktopState, SettingsSection } from '../../src/contracts'
import { defaults } from '../../src/core'
import { bucketRequests, windowRange } from '../../src/uiData'

const [snapshotArg, outArg] = process.argv.slice(2)
if (!snapshotArg || !outArg) throw new Error('usage: bun scripts/preview/fixtures.ts <snapshot-dir> <out-dir>')
const snapshot = resolve(snapshotArg), out = resolve(outArg)
const dist = resolve(import.meta.dir, '../../dist')

async function read(name: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(snapshot, `${name}.json`), 'utf8')) } catch { return null }
}

const sections: SettingsSection[] = ['routing', 'telemetry', 'transcripts', 'updates', 'header', 'layout', 'claude-executable', 'pricing', 'chatgpt']
const requests = await read('requests')
const rows = Array.isArray(requests) ? requests as { timestamp?: number }[] : []
// The page clock is pinned to the newest request, so "today" and relative times match the data.
const now = Math.max(...rows.map(row => Number(row.timestamp) || 0), 0) + 30_000
const health = await read('health') as { version?: string } | null
const providers = await read('providers')
const settingsValues: Partial<Record<SettingsSection, unknown>> = {}
for (const section of sections) settingsValues[section] = await read(`settings-${section}`)
const series = bucketRequests(requests, windowRange('today', now))
delete series.estimated

const base: DesktopState = {
  desktopVersion: '0.1.0', platform: 'darwin', glass: 'Standard appearance',
  preferences: { ...defaults, mode: 'attached', endpoint: 'http://127.0.0.1:3456', window: 'today', selected: '1.86.0' },
  hasApiKey: false, installed: ['1.86.0'], available: ['1.87.0', '1.86.0', '1.85.0'], latest: '1.87.0', running: health?.version, owned: false,
  health, quota: await read('quota'), requests, summary: await read('summary'), logs: await read('logs'), profiles: await read('profiles'),
  plugins: await read('plugins'), features: await read('features'), routesSummary: await read('routes'), retention: await read('retention'),
  providers: providers ? parseProviderSnapshot(providers) : undefined,
  connection: { kind: 'ok', message: 'Meridian on 127.0.0.1:3456 is answering.', fix: '' },
  instance: { baseUrl: 'http://127.0.0.1:3456', port: 3456, version: health?.version ?? null, supervisor: { kind: 'launchd', label: 'com.rynfar.meridian' }, attachedAt: now - 3_600_000, detectedFrom: 'launchd: com.rynfar.meridian' },
  detection: {
    at: now - 60_000, note: 'Viewing the Meridian your clients use at 127.0.0.1:3456 (launchd: com.rynfar.meridian). The app-managed copy is not started.',
    services: [{ baseUrl: 'http://127.0.0.1:3456', port: 3456, sources: ['launchd: com.rynfar.meridian', 'opencode: opencode.json provider anthropic', 'default: 127.0.0.1:3456'], status: 'meridian', version: health?.version, supervisor: { kind: 'launchd', label: 'com.rynfar.meridian' }, own: false }],
    rejected: [],
  },
  window: { kind: 'today' }, timeseries: series,
  settings: { fetchedAt: now, values: settingsValues, unavailable: [], errors: [] },
  dataErrors: [], incidents: [], serviceLog: ['[meridian-desktop] Attached to http://127.0.0.1:3456'], lastChecked: now,
}

const failed = (kind: DesktopState['connection']['kind'], message: string, fix: string): DesktopState => ({
  ...base, connection: { kind, message, fix }, health: null, quota: null, requests: null, summary: null, logs: null, profiles: null, plugins: null,
  features: null, routesSummary: null, retention: null, providers: undefined, timeseries: null, timeseriesNote: undefined,
  settings: { values: {}, unavailable: [], errors: [] },
})
const fixtures: Record<string, DesktopState> = {
  ok: base,
  fallback: { ...base, timeseries: null, timeseriesNote: `Meridian ${health?.version ?? ''} has no /telemetry/timeseries; charts are estimated from the latest 500 requests.` },
  stopped: failed('stopped', 'Nothing is answering on 127.0.0.1:3456.', 'Start your Meridian service, or choose Re-detect if it moved.'),
  unauthorized: failed('unauthorized', 'Meridian on 127.0.0.1:3456 rejected the API key (401).', 'Enter the key in Service → Connection.'),
  loading: { ...failed('starting', 'Connecting…', ''), instance: null, lastChecked: undefined },
  // The service answers but two reads fail: each says so instead of an endless skeleton.
  partial: { ...base, summary: null, requests: null, routesSummary: null, dataErrors: ['Error: /telemetry/summary?window=58665250: HTTP 500 database is locked', 'Error: /telemetry/requests?limit=500: timed out'] },
}

await mkdir(out, { recursive: true })
for (const file of ['window.js', 'tray.js', 'theme.css', 'ui.css', 'icon.png']) await copyFile(join(dist, file), join(out, file))
// The stub stands in for preload.ts: the same three calls, answered from the fixture.
await writeFile(join(out, 'stub.js'), `(() => {
  let state = window.__FIXTURE
  const listeners = new Set()
  const actions = window.__ACTIONS = []
  window.meridian = {
    state: async () => state,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    async action(name, value) {
      actions.push([name, value])
      if (name === 'set-window') state = { ...state, window: { kind: value }, preferences: { ...state.preferences, window: value } }
      for (const listener of listeners) listener(state)
      return state
    },
  }
})()\n`)
const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`
for (const [name, state] of Object.entries(fixtures)) {
  await writeFile(join(out, `fixture-${name}.js`), `window.__FIXTURE = ${JSON.stringify(state)};\n`)
  for (const [surface, body] of [['window', ''], ['tray', ' class="tray"']] as const) {
    await writeFile(join(out, `${surface}-${name}.html`), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${surface} ${name}</title><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="ui.css"></head>
<body${body}><div id="root"></div><script src="fixture-${name}.js"></script><script src="stub.js"></script><script src="${surface}.js"></script></body></html>\n`)
  }
}
await writeFile(join(out, 'clock.json'), JSON.stringify({ now }))
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${out} (clock ${new Date(now).toISOString()})`)
