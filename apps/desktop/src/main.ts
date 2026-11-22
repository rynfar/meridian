import { clientSetupClipboardCommand } from './clientSetup'
import { app, BrowserWindow, ipcMain, Menu, safeStorage, nativeTheme, Tray, nativeImage, Notification, dialog, shell, screen, clipboard } from 'electron'
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
let panel: BrowserWindow | undefined
let manager: Manager
let tray: Tray | undefined
let lastHideDockIcon: boolean | undefined
let lastDockHide = 0
let dockTimer: ReturnType<typeof setTimeout> | undefined
function updateDock(hide: boolean) {
  if (process.platform !== 'darwin' || !tray || hide === lastHideDockIcon) return
  lastHideDockIcon = hide
  clearTimeout(dockTimer)
  if (hide) {
    const apply = () => { lastDockHide = Date.now(); app.dock?.hide() }
    // Electron/macOS ignores hide calls within one second of the last hide.
    const wait = Math.max(0, 1100 - (Date.now() - lastDockHide))
    if (wait) dockTimer = setTimeout(apply, wait)
    else apply()
  } else void app.dock?.show().then(() => {
    // A newer preference may have arrived while Dock activation was pending.
    if (lastHideDockIcon) { lastHideDockIcon = undefined; updateDock(true) }
  }).catch(error => { manager.log(`Could not show Dock icon: ${String(error)}`) })
}
let quitting = false
let canQuit = false
function show() { panel?.hide(); window?.show(); window?.focus() }
function togglePanel() {
  if (!panel || !tray) return
  if (panel.isVisible()) { panel.hide(); return }
  const bounds = tray.getBounds()
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
  const width = Math.min(420, area.width), height = Math.min(panel.getBounds().height, area.height)
  const x = Math.max(area.x, Math.min(bounds.x + bounds.width / 2 - width / 2, area.x + area.width - width))
  const y = bounds.y < area.y + area.height / 2 ? Math.max(area.y, bounds.y + bounds.height + 6) : Math.max(area.y, bounds.y - height - 6)
  panel.setBounds({ x: Math.round(x), y: Math.min(y, area.y + area.height - height), width, height })
  panel.show(); panel.focus(); void manager.refresh()
}
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
  notification.once('show', () => { manager.state.notificationStatus = 'Delivered to the system'; manager.publish() })
  notification.once('close', () => notifications.delete(notification))
  notification.once('failed', (_event, error) => {
    notifications.delete(notification)
    manager.state.notificationStatus = `Delivery failed: ${error}`; manager.publish()
  })
  manager.state.notificationStatus = 'Requested; waiting for the system'
  manager.publish(); notification.show()
}
function updateTray(state: DesktopState) {
  updateDock(state.preferences.hideDockIcon)
  const where = state.instance ? ` · ${new URL(state.instance.baseUrl).host}` : ''
  tray?.setToolTip(`Meridian · ${state.running ? state.owned ? 'Managed' : 'Connected' : state.connection.kind === 'starting' ? 'Starting' : 'Stopped'}${where}`)
}
function trayMenu() {
  const state = manager.snapshot()
  return Menu.buildFromTemplate([
    { label: 'Open Meridian', click: show },
    { label: state.running ? `Meridian ${state.running} · ${state.owned ? 'App managed' : 'External'}` : 'Meridian is not running', enabled: false },
    ...(state.instance ? [{ label: `${new URL(state.instance.baseUrl).host} · ${state.instance.supervisor.label ?? state.instance.supervisor.kind}`, enabled: false }] : []),
    { label: 'Re-detect Meridian', enabled: !state.busy, click: () => { void invoke('redetect') } },
    { type: 'separator' },
    { label: 'Start Meridian', enabled: state.preferences.mode === 'managed' && !state.owned && !state.busy && Boolean(state.preferences.selected), click: () => { void invoke('start') } },
    { label: 'Restart Meridian', enabled: state.owned && !state.busy, click: () => { void invoke('restart') } },
    { label: 'Stop Meridian', enabled: state.owned && !state.busy, click: () => { void invoke('stop') } },
    { type: 'separator' }, { label: 'Quit Meridian Desktop', click: () => app.quit() },
  ])
}
let timer: ReturnType<typeof setInterval> | undefined
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', show)
  void app.whenReady().then(async () => {
    const entry = join(__dirname, 'index.html')
    const entryUrl = pathToFileURL(entry).href
    const panelEntry = join(__dirname, 'tray.html')
    const panelUrl = pathToFileURL(panelEntry).href
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
      changed: state => { if (window && !window.isDestroyed()) window.webContents.send('meridian:state', state); if (panel && !panel.isDestroyed()) panel.webContents.send('meridian:state', state); updateTray(state) },
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
    panel = new BrowserWindow({ width: 420, height: 640, show: false, frame: false, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: Boolean(glass), backgroundColor: glass ? desktopWindowColors.transparent : nativeTheme.shouldUseDarkColors ? desktopWindowColors.dark : desktopWindowColors.light, webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    panel.on('blur', () => panel?.hide())
    panel.on('close', event => { if (!canQuit) { event.preventDefault(); panel?.hide() } })
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    panel.webContents.on('will-navigate', event => event.preventDefault())
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (![[window, entryUrl], [panel, panelUrl]].some(([candidate, url]) => candidate instanceof BrowserWindow && !candidate.isDestroyed() && event.sender === candidate.webContents && event.senderFrame === candidate.webContents.mainFrame && event.senderFrame?.url === url)) throw new Error('Untrusted IPC sender')
    }
    ipcMain.handle('meridian:state', event => { trusted(event); return manager.snapshot() })
    ipcMain.handle('meridian:action', async (event, action: unknown, value: unknown) => {
      trusted(event)
      if (action === 'open-desktop') show()
      else if (action === 'copy-profile-login') {
        const profile = text(value)
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Use an account name containing letters, numbers, dashes or underscores.')
        clipboard.writeText(`meridian profile login ${profile}`)
      }
      else if (action === 'copy-profile-remove') {
        const profile = text(value)
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Use an account name containing letters, numbers, dashes or underscores.')
        clipboard.writeText(`meridian profile remove ${profile}`)
      }
      else if (action === 'copy-client-setup') await clipboard.writeText(clientSetupClipboardCommand(manager.snapshot(), value))
      else if (action === 'close-panel') panel?.hide()
      else if (action === 'resize-panel') {
        if (!panel || event.sender !== panel.webContents || typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid panel size.')
        const bounds = panel.getBounds(), area = screen.getDisplayMatching(bounds).workArea
        const height = Math.min(area.height, Math.max(320, Math.min(640, Math.ceil(value))))
        panel.setBounds({ ...bounds, height, y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) })
      }
      else if (action === 'quit-app') app.quit()
      else if (action === 'toggle-snooze') await dispatch(manager, 'save-preferences', { quietUntil: manager.preferences.quietUntil > Date.now() ? 0 : Date.now() + 3_600_000 })
      else if (action === 'take-ownership') {
        const migration = manager.state.migration
        if (!window || !migration?.canAdopt || value !== migration.label) throw new Error('Refresh the service before taking ownership.')
        const answer = await dialog.showMessageBox(window, { type: 'question', message: 'Manage this service with Meridian Desktop?', detail: `The app will pause ${migration.label} and start Meridian on the same port. Active requests finish first. You can restore the original supervisor from Service.`, buttons: ['Cancel', 'Manage service'], defaultId: 0, cancelId: 0 })
        if (answer.response === 1) await dispatch(manager, action, value)
      } else if (action === 'test-notification') {
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
        // Only the URL the active sign-in produced, and only Claude/ChatGPT sign-in hosts.
        if (url.protocol !== 'https:' || !['claude.com', 'platform.claude.com', 'claude.ai', 'auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new Error('No valid sign-in URL.')
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
          await writeFile(result.filePath, JSON.stringify({ desktopVersion: snapshot.desktopVersion, platform: snapshot.platform, version: snapshot.running, owned: snapshot.owned, status: text(health.status), connection: snapshot.connection.kind, supervisor: snapshot.instance?.supervisor.kind, window: snapshot.window.kind, requests: summary.totalRequests, errors: summary.errorCount, tokenUsage: summary.tokenUsage, timing: summary.totalDuration }, null, 2), { mode: 0o600 })
        }
      } else await dispatch(manager, action, value)
      return manager.snapshot()
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Meridian Desktop', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { label: 'View', submenu: [{ label: 'Quick controls', accelerator: 'CommandOrControl+Shift+M', click: togglePanel }, { type: 'separator' }, { label: 'Refresh data', accelerator: 'CommandOrControl+R', click: () => { if (!manager.state.busy) void invoke('refresh') } }, { label: 'Reload window', role: 'reload', accelerator: 'CommandOrControl+Shift+R' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
    ]))
    window.on('close', event => { if (!canQuit) { event.preventDefault(); window?.hide() } })
    // Template artwork has a transparent background; macOS supplies its tint.
    // Preserve the bundled Retina representations instead of resizing the mask.
    const trayIcon = process.platform === 'darwin'
      ? nativeImage.createFromPath(join(__dirname, 'trayTemplate.png'))
      : nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 18, height: 18 })
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true)
    tray = new Tray(trayIcon)
    tray.on('click', togglePanel)
    tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
    manager.state.loginAtStartup = process.platform === 'darwin' ? app.getLoginItemSettings().openAtLogin : false
    await window.loadFile(entry)
    await panel.loadFile(panelEntry)
    if (glass) {
      try {
        const id = glass.addView(window.getNativeWindowHandle(), { cornerRadius: 16, opaque: false })
        if (id >= 0) manager.state.glass = 'Native Liquid Glass'
        glass.addView(panel.getNativeWindowHandle(), { cornerRadius: 18, opaque: false })
      } catch (error) { manager.log(`Glass initialization failed: ${String(error)}`) }
    }
    if (process.platform === 'darwin') window.setWindowButtonVisibility(true)
    manager.publish()
    if (manager.preferences.openWindowAtLaunch) show()
    // init() detected the service: the managed copy starts only when no other Meridian serves the clients.
    void manager.refresh().then(async () => { if (manager.shouldStartManaged()) await invoke('start') })
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
    clearInterval(timer); clearTimeout(dockTimer); tray?.destroy(); canQuit = true; app.quit()
  }).catch(async error => {
    quitting = false
    await dialog.showMessageBox({ type: 'warning', message: 'Meridian is still running', detail: String(error) })
  })
})
