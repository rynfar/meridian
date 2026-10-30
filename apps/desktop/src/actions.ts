/** The renderer can request named operations, never arbitrary URLs or commands. */
import { object, text } from './core'
import type { Manager } from './manager'
export async function dispatch(manager: Manager, action: unknown, value: unknown): Promise<void> {
  if (action === 'login-code') { await manager.loginCode(value); return }
  // Not a lifecycle operation: never blocked by a busy service, and pushed at once.
  if (action === 'set-window') { await manager.setWindow(value); return }
  const labels: Record<string, string> = { 'take-ownership': 'Taking ownership', 'return-headless': 'Restoring headless service', refresh: 'Refreshing', redetect: 'Detecting Meridian', 'check-plugins': 'Checking plugins', 'install-plugin': 'Installing plugin', 'check-updates': 'Checking releases', install: 'Installing Meridian', activate: 'Switching versions', start: 'Starting Meridian', stop: 'Draining Meridian', restart: 'Restarting Meridian', 'save-preferences': 'Saving settings', 'switch-profile': 'Switching account', 'rename-profile': 'Renaming account', 'remove-profile': 'Removing account', 'reorder-profiles': 'Reordering accounts', 'reload-plugins': 'Reloading plugins', 'set-features': 'Saving features', 'reset-features': 'Resetting features', 'add-profile': 'Adding profile', 'login-profile': 'Signing in', 'chatgpt-connect': 'Connecting ChatGPT', 'chatgpt-refresh': 'Renewing ChatGPT seat', 'refresh-settings': 'Reading settings', 'update-settings': 'Saving server settings', 'reset-settings': 'Resetting server settings', 'set-pricing': 'Saving pricing', 'delete-pricing': 'Removing pricing override', acknowledge: 'Clearing alerts' }
  const name = text(action)
  if (!Object.hasOwn(labels, name)) throw new Error('Unknown desktop action.')
  await manager.mutate(labels[name] ?? 'Working', async () => {
    switch (name) {
      case 'take-ownership': { const label = text(value); if (!label) throw new Error('Review the supervisor before taking ownership.'); await manager.takeOwnership(label); break }
      case 'return-headless': await manager.returnHeadless(); break
      case 'redetect': await manager.redetect(); break
      case 'check-plugins': await manager.checkPlugins(); break
      case 'install-plugin': await manager.installPlugin(value); break
      // An explicit refresh re-reads everything, including window data within its TTL.
      case 'refresh': await manager.refresh(true); break
      case 'check-updates': await manager.checkUpdates(); break
      case 'install': await manager.install(value); break
      case 'activate': await manager.activate(value); break
      case 'start': await manager.start(); break
      case 'stop': await manager.stop(); await manager.refresh(); break
      case 'restart': await manager.restart(); break
      case 'save-preferences': await manager.configure(value); break
      case 'acknowledge': await manager.acknowledge(); break
      case 'add-profile': await manager.profileLogin(value, true); break
      case 'login-profile': await manager.profileLogin(value, false); break
      case 'switch-profile': await manager.switchProfile(value); break
      case 'rename-profile': await manager.renameProfile(value); break
      case 'remove-profile': await manager.removeProfile(value); break
      case 'reorder-profiles': await manager.reorderProfiles(value); break
      case 'chatgpt-connect': await manager.chatGptConnect(value); break
      case 'chatgpt-refresh': await manager.chatGptRefresh(value); break
      case 'reload-plugins': await manager.api('/plugins/reload', 'POST'); await manager.refresh(true); break
      case 'set-features': {
        const input = object(value)
        const adapter = text(input.adapter)
        if (!/^[\w-]{1,64}$/.test(adapter)) throw new Error('Invalid adapter.')
        await manager.api('/settings/api/features/' + encodeURIComponent(adapter), 'PATCH', object(input.features)); await manager.refresh(true); break
      }
      case 'reset-features': await manager.resetSettings({ section: 'features', adapter: typeof value === 'string' ? value : object(value).adapter }); break
      case 'refresh-settings': await manager.readSettings(true); manager.publish(); break
      case 'update-settings': await manager.updateSettings(value); break
      case 'reset-settings': await manager.resetSettings(value); break
      case 'set-pricing': await manager.setPricing(value); break
      case 'delete-pricing': await manager.deletePricing(value); break
    }
  })
}
