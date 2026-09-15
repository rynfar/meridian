/** The renderer can request named operations, never arbitrary URLs or commands. */
import { object, text } from './core'
import type { Manager } from './manager'
export async function dispatch(manager: Manager, action: unknown, value: unknown): Promise<void> {
  if (action === 'login-code') { manager.loginCode(value); return }
  const labels: Record<string, string> = { refresh: 'Refreshing', 'check-updates': 'Checking releases', install: 'Installing Meridian', activate: 'Switching versions', start: 'Starting Meridian', stop: 'Draining Meridian', restart: 'Restarting Meridian', 'save-preferences': 'Saving settings', 'switch-profile': 'Switching account', 'reload-plugins': 'Reloading plugins', 'set-features': 'Saving features', 'add-profile': 'Adding profile', 'login-profile': 'Signing in', acknowledge: 'Clearing alerts' }
  const name = text(action)
  if (!Object.hasOwn(labels, name)) throw new Error('Unknown desktop action.')
  await manager.mutate(labels[name] ?? 'Working', async () => {
    switch (name) {
      case 'refresh': await manager.refresh(); break
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
      case 'switch-profile': {
        const profile = text(value)
        if (!/^[\w-]{1,64}$/.test(profile)) throw new Error('Invalid profile name.')
        await manager.api('/profiles/active', 'POST', { profile }); await manager.refresh(); break
      }
      case 'reload-plugins': await manager.api('/plugins/reload', 'POST'); await manager.refresh(); break
      case 'set-features': {
        const input = object(value)
        const adapter = text(input.adapter)
        if (!/^[\w-]{1,64}$/.test(adapter)) throw new Error('Invalid adapter.')
        await manager.api('/settings/api/features/' + encodeURIComponent(adapter), 'PATCH', object(input.features)); await manager.refresh(); break
      }
    }
  })
}
