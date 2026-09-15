import { contextBridge, ipcRenderer } from 'electron'
import type { Action, DesktopApi, DesktopState } from './contracts'
const api: DesktopApi = {
  state: () => ipcRenderer.invoke('meridian:state'),
  action: (action: Action, value?: unknown) => ipcRenderer.invoke('meridian:action', action, value),
  subscribe(callback) { const handler = (_event: unknown, state: DesktopState) => callback(state); ipcRenderer.on('meridian:state', handler); return () => ipcRenderer.removeListener('meridian:state', handler) },
}
contextBridge.exposeInMainWorld('meridian', api)
