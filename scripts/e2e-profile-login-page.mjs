#!/usr/bin/env bun
// Actual page templates, synthetic profiles/authorization links. No real OAuth,
// account writes, private credentials or model calls. Before tree is optional.
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const html = (await import(pathToFileURL(join(process.env.E2E_PAGE_ROOT ?? root, 'src/telemetry/profilePage.ts')).href)).profilePageHtml
const ids = ['ordinary', '__proto__', 'constructor', 'work']
const requests = []
const roster = { profiles: ids.map(id => ({ id, type: 'claude-max', loggedIn: false,
  email: 'synthetic@example.invalid', planLabel: 'Max' })), activeProfile: ids[0], profileOrder: ids,
  routing: 'active', exhausted: [] }
const server = createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`
  const url = new URL(req.url, origin)
  res.setHeader('Cache-Control', 'no-store')
  if (url.pathname === '/profiles') { res.setHeader('Content-Type', 'text/html'); res.end(html); return }
  res.setHeader('Content-Type', 'application/json')
  if (url.pathname === '/fixture/assertions') { res.end(JSON.stringify({ requests })); return }
  if (url.pathname === '/profiles/login/start' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk
    const { profile } = JSON.parse(raw)
    requests.push(profile)
    res.end(JSON.stringify({ mode: 'paste', loginId: `fixture-${profile}`, expiresAt: Date.now() + 600000,
      pasteAuthorizeUrl: `${origin}/fixture/authorize?profile=${encodeURIComponent(profile)}` })); return
  }
  const data = url.pathname === '/profiles/list' ? roster
    : url.pathname === '/health' ? { status: 'healthy', backend: 'claude', auth: { loggedIn: true }, build: { source: 'npm', version: '1.79.0', latest: '1.79.0', updateAvailable: false } }
    : url.pathname === '/v1/usage/quota/all' ? { profiles: [] }
    : url.pathname === '/telemetry/summary' ? { requests: 0, costEstimate: { byProfile: {} } }
    : url.pathname === '/settings/api/routing' ? { routing: 'active', profileOrder: ids }
    : url.pathname === '/fixture/authorize' ? { fixture: true, note: 'Synthetic authorization only; no account sign-in.' } : null
  if (!data) res.statusCode = 404
  res.end(JSON.stringify(data))
})
server.listen(Number(process.env.E2E_PORT ?? 42211), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/profiles`, fixture: true })))
