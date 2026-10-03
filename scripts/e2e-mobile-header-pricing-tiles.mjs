#!/usr/bin/env bun
// Real page templates, synthetic data, no credentials or model calls.
// E2E_BASELINE_ROOT=<unchanged checkout> bun scripts/e2e-mobile-header-pricing-tiles.mjs
// Serves /after/ (home) and /after/settings from this tree and /before/* from
// the baseline, then evaluate scripts/e2e-mobile-header-pricing-tiles-browser.js
// in each page at each width. ?branch=1 adds a branch to the build identity.
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const trees = { after: root, before: process.env.E2E_BASELINE_ROOT ?? root }
const pages = {}
for (const [label, tree] of Object.entries(trees)) {
  const load = async (file) => import(pathToFileURL(join(tree, 'src/telemetry', file)).href)
  pages[label] = { home: (await load('landing.ts')).landingHtml, settings: (await load('settingsPage.ts')).settingsPageHtml }
}
const sha = '3255c914604df1880885d3edd08d5e9cffc1c3bc'
const build = { source: 'local', kind: 'source', version: '1.77.1', releaseVersion: '1.77.1', sha, dirty: false,
  commitUrl: `https://github.com/rynfar/meridian/commit/${sha}` }
const ids = ['personal@example.invalid', 'work-account@example.invalid']
const profiles = ids.map((id, i) => ({ id, type: 'claude-max', isActive: i === 0, loggedIn: true,
  email: id, allowance: '20x', planLabel: 'Max', authMethod: 'claude.ai', subscriptionType: 'max' }))
const roster = { profiles, activeProfile: ids[0], routing: 'active+priority', profileOrder: ids }
const quota = { profiles: ids.map((id) => ({ id, windows: [
  { type: 'five_hour', utilization: 0.67, resetsAt: Date.now() + 3600000 },
  { type: 'seven_day', utilization: 0.42, resetsAt: Date.now() + 86400000 }] })) }
const summary = { totalRequests: 10, requests: 10, errors: 0,
  costEstimate: { byProfile: Object.fromEntries(ids.map((id) => [id, { requests: 10, estimatedUsd: 123.45 }])) } }
const rates = (input, output, cacheRead, cacheWrite) => ({ inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: cacheRead, cacheWritePerMTok: cacheWrite })
const pricing = { builtin: {
  'claude-3-5-haiku-20241022': rates(0.8, 4, 0.08, 1),
  'claude-3-haiku-20240307': rates(0.25, 1.25, 0.03, 0.3),
  'claude-3-opus-20240229': rates(15, 75, 1.5, 18.75),
  'claude-sonnet-4-5-20250929': rates(3, 15, 0.3, 3.75),
}, overrides: { 'claude-opus-4-1-20250805': rates(123.45, 75, 1.5, 18.75) } }
const { iconResponse } = await import('../src/telemetry/icon.ts')
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid')
  const match = url.pathname.match(/^\/(after|before)(\/settings)?\/?$/)
  if (match) { res.setHeader('Content-Type', 'text/html'); res.end(pages[match[1]][match[2] ? 'settings' : 'home']); return }
  if (url.pathname === '/telemetry/icon.svg') {
    const icon = iconResponse(); res.statusCode = icon?.status ?? 404
    if (icon) { res.setHeader('Content-Type', icon.headers.get('content-type')); res.end(await icon.text()) } else res.end()
    return
  }
  const branched = (req.headers.referer ?? '').includes('branch=1')
  const health = { status: 'healthy', backend: 'claude', auth: { loggedIn: true },
    build: branched ? { ...build, branch: 'fix/mobile-header-pricing-tiles' } : build }
  const data = url.pathname === '/health' ? health : url.pathname === '/profiles/list' ? roster
    : url.pathname === '/build-status' ? { state: 'current', runtime: build, latest: build }
    : url.pathname === '/v1/usage/quota/all' ? quota : url.pathname === '/telemetry/summary' ? summary
    : url.pathname === '/settings/api/pricing' ? pricing
    : url.pathname === '/settings/api/routing' ? { routing: 'active+priority', profileOrder: ids } : null
  res.statusCode = data ? 200 : 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data))
})
server.listen(Number(process.env.E2E_PORT ?? 42099), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/after/`, baseline: resolve(trees.before), fixture: 'synthetic only' })))
