// Native macOS renderer recovery, isolated preferences, no credentials/model calls.
// npm run build --prefix apps/desktop
// env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron scripts/e2e-desktop-renderer-recovery.cjs
// E2E_DESKTOP_MAIN selects an unchanged/released desktop main.cjs for the negative control.
const { app, BrowserWindow, powerMonitor, Menu } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const root = mkdtempSync(join(tmpdir(), 'meridian-renderer-recovery-'))
const entry = resolve(process.env.E2E_DESKTOP_MAIN || join(__dirname, '../apps/desktop/dist/main.cjs'))
const signals = process.env.E2E_RECOVERY_CASE === 'signals'
const report = { platform: process.platform, arch: process.arch, electron: process.versions.electron, entry, case: signals ? 'signals' : 'crash-and-hang', passed: [] }
app.on('will-quit', event => {
  if (report.result !== 'PASS') {
    report.result = 'FAIL'; report.error = 'Desktop quit before recovery assertions finished'
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.error(JSON.stringify({ root, ...report }, null, 2))
    event.preventDefault(); app.exit(1)
  }
})
app.setPath('userData', root)
mkdirSync(join(root, 'preview'))
writeFileSync(join(root, 'preview/desktop.json'), JSON.stringify({ mode: 'attached', endpoint: 'http://127.0.0.1:1', openWindowAtLaunch: false, autoStart: false }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, message, milliseconds = 10_000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) { if (await predicate()) return; await delay(100) }
  throw new Error(message)
}
function bounded(promise, milliseconds = 2000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer did not answer')), milliseconds) })]).finally(() => clearTimeout(timer))
}
async function healthy(window) {
  if (window.webContents.isCrashed() || window.webContents.isLoading()) return false
  try { return await bounded(window.webContents.executeJavaScript(`Boolean(document.querySelector('#content')?.childElementCount || document.querySelector('#panel header'))`)) }
  catch { return false }
}
async function screenshot(window, name) {
  try {
    writeFileSync(join(root, `${name}.png`), (await bounded(window.webContents.capturePage(undefined, { stayHidden: true }), 3000)).toPNG())
  } catch (error) {
    report.mediaErrors = [...(report.mediaErrors || []), `${name}: ${String(error)}`]
  }
}
async function main() {
  assert.equal(process.platform, 'darwin', 'Run on the affected macOS platform')
  require(entry)
  await until(() => BrowserWindow.getAllWindows().length === 2, 'Desktop windows were not created')
  await until(() => BrowserWindow.getAllWindows().every(window => window.webContents.getURL().endsWith('.html')), 'Local entries did not load')
  const dashboard = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))
  const panel = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/tray.html'))
  assert(dashboard && panel)
  await until(async () => await healthy(dashboard) && await healthy(panel), 'Initial UI did not load')
  const pid = process.pid, ids = [dashboard.id, panel.id]
  report.passed.push('both actual desktop renderers initialized with isolated preferences')
  await screenshot(panel, 'before')
  let loads = 0
  for (const window of [dashboard, panel]) window.webContents.on('did-finish-load', () => { loads++ })
  powerMonitor.emit('resume'); powerMonitor.emit('unlock-screen')
  await delay(2500)
  assert.equal(loads, 0, 'Healthy wake/unlock must not reload unsaved forms')
  report.passed.push('healthy wake/unlock does not reload')
  if (signals) {
    dashboard.emit('unresponsive'); dashboard.emit('responsive')
    app.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed' })
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit' })
    await delay(5500)
    assert.equal(loads, 0, 'Transient unresponsiveness and unrelated child exits must not reload')
    report.passed.push('transient unresponsiveness, Utility crashes and clean GPU exits do not reload')
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' })
    await until(async () => loads >= 2 && await healthy(dashboard) && await healthy(panel), 'GPU event did not reload both interfaces')
    report.passed.push('synthetic abnormal GPU-exit signal reloads both interfaces')
    const before = loads
    await panel.webContents.executeJavaScript("document.getElementById('panel').replaceChildren()")
    powerMonitor.emit('resume')
    await until(async () => loads > before && await healthy(panel), 'Blank DOM was not recovered on wake')
    report.passed.push('wake probe repairs an actually emptied quick-controls DOM')
    const reload = Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu.items.find(item => item.label === 'Reload interface')
    assert(reload)
    const previous = loads
    reload.click()
    await until(async () => loads >= previous + 2 && await healthy(dashboard) && await healthy(panel), 'Native Reload interface did not restore both windows')
    report.passed.push('native Reload interface works independently of renderer actions')
  } else {
    for (const [window, name] of [[panel, 'quick-controls'], [dashboard, 'dashboard']]) {
      const before = loads
      window.webContents.forcefullyCrashRenderer()
      await until(async () => loads > before && await healthy(window), `${name} stayed blank after renderer termination`)
      assert(!window.isVisible(), 'Recovering a background window must not open it')
      report.passed.push(`${name} recovers from actual renderer termination without opening a window`)
    }
    dashboard.show()
    const before = loads
    // An actual blocked renderer, not just a synthetic unresponsive event.
    void dashboard.webContents.executeJavaScript('while (true) {}').catch(() => undefined)
    await until(async () => loads > before && await healthy(dashboard), 'A hung renderer did not recover', 25_000)
    report.passed.push('persistent actual JavaScript hang recovers')
    assert(dashboard.isVisible(), 'Recovery preserves visibility')
  }
  assert.deepEqual([dashboard.id, panel.id], ids, 'Windows were retained')
  assert.equal(process.pid, pid, 'Main process was not restarted')
  const state = await bounded(dashboard.webContents.executeJavaScript('window.meridian.state()'), 5000)
  assert.equal(state.owned, false)
  assert.equal(state.preferences.endpoint, 'http://127.0.0.1:1')
  assert(state.serviceLog.some(line => line.includes('Interface recovered')), 'Main-process recovery diagnostic is available')
  report.recoveryLog = state.serviceLog.filter(line => /Dashboard:|Quick controls:/.test(line))
  report.passed.push('sandboxed state IPC and service preferences survive; no service was started')
  await screenshot(panel, 'after')
  report.result = 'PASS'
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ root, ...report }, null, 2))
  app.quit()
}
main().catch(error => {
  report.result = 'FAIL'; report.error = String(error)
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.error(JSON.stringify({ root, ...report }, null, 2))
  app.exit(1)
})
