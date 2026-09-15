import { app, BrowserWindow, ipcMain, Menu, safeStorage, nativeTheme, Tray, nativeImage, Notification, dialog, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Manager } from './manager'
import { loadNativeGlass, type NativeGlass } from './nativeGlass'
import { desktopWindowColors } from '../../../src/telemetry/profileBar'
import { object, text, version } from './core'
import { dispatch } from './actions'
import type { DesktopState } from './contracts'

app.setName('Meridian Desktop')
let window: BrowserWindow | undefined
let manager: Manager
let tray: Tray | undefined
let quitting = false
let canQuit = false
function show() { window?.show(); window?.focus() }
async function invoke(action: string, value?: unknown) {
  try { await dispatch(manager, action, value) }
  catch (error) { await dialog.showMessageBox({ type: 'error', message: 'Meridian could not complete that action', detail: String(error) }) }
}
const notifications = new Set<Notification>()
function showNotification(title: string, body: string) {
  if (!Notification.isSupported()) throw new Error('Native notifications are not supported on this system.')
  const notification = new Notification({ title, body })
  notifications.add(notification)
  notification.on('click', show)
  notification.once('show', () => { manager.state.notificationStatus = 'Delivered to macOS'; manager.publish() })
  notification.once('close', () => notifications.delete(notification))
  notification.once('failed', (_event, error) => {
    notifications.delete(notification)
    manager.state.notificationStatus = `Delivery failed: ${error}`; manager.publish()
  })
  manager.state.notificationStatus = 'Requested; waiting for the system'
  manager.publish(); notification.show()
}
function updateTray(state: DesktopState) {
  tray?.setToolTip(`Meridian · ${state.running ? state.owned ? 'Managed' : 'Connected' : 'Stopped'}`)
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Meridian', click: show },
    { label: state.running ? `Meridian ${state.running} · ${state.owned ? 'App managed' : 'External'}` : 'Meridian is not running', enabled: false },
    { type: 'separator' },
    { label: 'Start Meridian', enabled: state.preferences.mode === 'managed' && !state.owned && !state.busy && Boolean(state.preferences.selected), click: () => { void invoke('start') } },
    { label: 'Restart Meridian', enabled: state.owned && !state.busy, click: () => { void invoke('restart') } },
    { label: 'Stop Meridian', enabled: state.owned && !state.busy, click: () => { void invoke('stop') } },
    { type: 'separator' }, { label: 'Quit Meridian Desktop', click: () => app.quit() },
  ]))
}
let timer: ReturnType<typeof setInterval> | undefined
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  void app.whenReady().then(async () => {
    const entry = join(__dirname, 'index.html')
    const entryUrl = pathToFileURL(entry).href
    manager = new Manager({
      directory: join(app.getPath('userData'), 'preview'),
      node: join(__dirname, '../node_modules/node/bin/node'),
      npm: join(__dirname, '../node_modules/npm/bin/npm-cli.js'),
      runner: join(__dirname, 'runner.mjs'), desktopVersion: app.getVersion(),
      encrypt(value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      changed: state => { if (window && !window.isDestroyed()) window.webContents.send('meridian:state', state); updateTray(state) },
      notify: incident => { try { showNotification(incident.title, incident.detail) } catch (error) { manager.log(String(error)) } },
    })
    await manager.init()
    let glass: NativeGlass | undefined
    if (process.platform === 'darwin') {
      try { glass = await loadNativeGlass() }
      catch (error) { manager.log(`Native glass unavailable: ${String(error)}`) }
    }
    window = new BrowserWindow({
      width: 1180, height: 790, minWidth: 900, minHeight: 650, show: false,
      title: 'Meridian Desktop', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 20, y: 20 }, transparent: Boolean(glass),
      backgroundColor: glass ? desktopWindowColors.transparent : nativeTheme.shouldUseDarkColors ? desktopWindowColors.dark : desktopWindowColors.light,
      icon: join(__dirname, 'icon.png'),
      webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    })
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== entryUrl) throw new Error('Untrusted IPC sender')
    }
    ipcMain.handle('meridian:state', event => { trusted(event); return manager.snapshot() })
    ipcMain.handle('meridian:action', async (event, action: unknown, value: unknown) => {
      trusted(event)
      if (action === 'test-notification') {
        showNotification('Meridian notifications are ready', 'This is a test from Meridian Desktop. Your services were not changed.')
      } else if (action === 'login-at-startup') {
        if (process.platform !== 'darwin' || !app.isPackaged) throw new Error('Login startup is available in the packaged Mac app.')
        if (typeof value !== 'boolean') throw new Error('Invalid login preference.')
        app.setLoginItemSettings({ openAtLogin: value })
        manager.state.loginAtStartup = app.getLoginItemSettings().openAtLogin
        manager.publish()
      } else if (action === 'release-notes') {
        const release = version(value)
        await shell.openExternal(`https://github.com/rynfar/meridian/releases/tag/v${release}`)
      } else if (action === 'open-login') {
        const url = new URL(manager.state.login?.url || '')
        if (url.protocol !== 'https:' || !['claude.com', 'platform.claude.com'].includes(url.hostname)) throw new Error('No valid Claude login URL.')
        await shell.openExternal(url.href)
      } else if (action === 'export-diagnostics') {
        const result = await dialog.showSaveDialog({ defaultPath: 'meridian-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
        if (!result.canceled && result.filePath) {
          const { writeFile } = await import('node:fs/promises')
          // Export operational aggregates only. Raw requests/logs can include
          // prompts or credentials and are deliberately excluded from this file.
          const snapshot = manager.snapshot()
          const health = object(snapshot.health)
          const summary = object(snapshot.summary)
          await writeFile(result.filePath, JSON.stringify({ desktopVersion: snapshot.desktopVersion, platform: snapshot.platform, version: snapshot.running, owned: snapshot.owned, status: text(health.status), requests: summary.totalRequests, errors: summary.errorCount, tokenUsage: summary.tokenUsage, timing: summary.totalDuration }, null, 2), { mode: 0o600 })
        }
      } else await dispatch(manager, action, value)
      return manager.snapshot()
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Meridian Desktop', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
    ]))
    window.on('close', event => { if (!canQuit) { event.preventDefault(); window?.hide() } })
    tray = new Tray(nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 18, height: 18 }))
    tray.on('click', show)
    manager.state.loginAtStartup = process.platform === 'darwin' ? app.getLoginItemSettings().openAtLogin : false
    await window.loadFile(entry)
    if (glass) {
      try {
        const id = glass.addView(window.getNativeWindowHandle(), { cornerRadius: 16, opaque: false })
        if (id >= 0) manager.state.glass = 'Native Liquid Glass'
      } catch (error) { manager.log(`Glass initialization failed: ${String(error)}`) }
    }
    if (process.platform === 'darwin') window.setWindowButtonVisibility(true)
    manager.publish()
    window.show()
    window.focus()
    void manager.refresh().then(async () => { if (manager.preferences.mode === 'managed' && manager.preferences.autoStart && manager.preferences.selected) await invoke('start') })
    timer = setInterval(() => { if (!quitting && !manager.state.busy) void manager.refresh() }, 10000)
  }).catch(error => { console.error(error); app.quit() })
}
app.on('activate', show)
app.on('before-quit', event => {
  if (canQuit || !manager) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void manager.shutdown().then(() => {
    clearInterval(timer); tray?.destroy(); canQuit = true; app.quit()
  }).catch(async error => {
    quitting = false
    await dialog.showMessageBox({ type: 'warning', message: 'Meridian is still running', detail: String(error) })
  })
})
