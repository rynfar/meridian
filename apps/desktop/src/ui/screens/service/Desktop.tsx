import { useEffect, useMemo, useState } from 'react'
import { BellRing, Copy, FileDown } from 'lucide-react'
import { useDesktop } from '../../lib/desktop'
import { Button } from '../../components/button'
import { Input, Select, Switch, Textarea } from '../../components/controls'
import { Empty } from '../../components/state'
import { when } from '../../model/format'
import { Fact, Group, PanelHeader, SettingRow } from './parts'
import { providerSetupCommand } from '../../../../../../src/telemetry/providerSetup'
import type { DesktopState } from '../../../contracts'

const ALERTS = [
  ['notificationCritical', 'Service recovery failed', 'The app-managed copy could not be restarted.'],
  ['notificationRequests', 'Repeated request failures', 'Several requests failed within two minutes.'],
  ['notificationCache', 'Repeated cache misses', 'Three continuations in a row reused almost nothing.'],
  ['notificationQuota', 'Usage reaches 95%', 'An account is about to hit a usage window.'],
] as const

export function DesktopPreferences({ state }: { state: DesktopState }) {
  const { run, busy, now } = useDesktop()
  const p = state.preferences
  const save = (patch: Record<string, unknown>) => { void run('save-preferences', patch) }
  const paused = p.quietUntil > now
  return (
    <>
      <PanelHeader title="Desktop" description="How Meridian Desktop itself behaves on this Mac. Alerts are always recorded in Logs; notifications are optional and rate-limited." />
      <Group title="Notifications">
        <SettingRow label="Desktop notifications" status={[state.notificationStatus ? `Last test: ${state.notificationStatus}` : null]}
          control={<><Button variant="subtle" onClick={() => { void run('test-notification') }} disabled={busy || !p.notifications}><BellRing />Send test</Button><Switch aria-label="Desktop notifications" checked={p.notifications} disabled={busy} onCheckedChange={value => save({ notifications: value })} /></>} />
        {ALERTS.map(([key, label, description]) => (
          <SettingRow key={key} label={label} description={description} className="pl-8" control={<Switch aria-label={label} checked={p[key]} disabled={busy || !p.notifications} onCheckedChange={value => save({ [key]: value })} />} />
        ))}
        <SettingRow label="Quiet hour" description="Pause notifications for an hour; alerts still appear in Logs." status={[paused ? `Paused until ${when(p.quietUntil, now)}` : null]}
          control={<Button variant="subtle" onClick={() => { void run('toggle-snooze') }} disabled={busy || !p.notifications}>{paused ? 'Resume now' : 'Pause for 1 hour'}</Button>} />
        <p className="px-4 py-2.5 text-xs text-t3">Critical alerts notify at most every 15 minutes; others once per category every 30 minutes.</p>
      </Group>
      <Group title="App">
        <SettingRow label="Open at login" description={state.platform === 'darwin' ? 'Available in the packaged Mac app.' : 'Available on macOS.'} control={<Switch aria-label="Open at login" checked={state.loginAtStartup === true} disabled={busy || state.platform !== 'darwin'} onCheckedChange={value => { void run('login-at-startup', value) }} />} />
        <SettingRow label="Open the window at launch" control={<Switch aria-label="Open the window at launch" checked={p.openWindowAtLaunch} disabled={busy} onCheckedChange={value => save({ openWindowAtLaunch: value })} />} />
        {state.platform === 'darwin' ? <SettingRow label="Hide Dock icon" description="Keep Meridian in the menu bar only. Click its icon to open the window." control={<Switch aria-label="Hide Dock icon" checked={p.hideDockIcon} disabled={busy} onCheckedChange={value => save({ hideDockIcon: value })} />} /> : null}
      </Group>
    </>
  )
}

export function Clients({ state }: { state: DesktopState }) {
  const { run, busy, say } = useDesktop()
  const antigravity = state.providers?.providers.find(provider => provider.id === 'antigravity' && provider.enabled)
  const models = useMemo(() => (antigravity?.models ?? []).filter(model => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)), [antigravity?.models])
  const [client, setClient] = useState('pi')
  const [model, setModel] = useState('')
  const [keyEnv, setKeyEnv] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  useEffect(() => { if (!models.includes(model)) setModel(models.find(item => /^gemini-.*-low$/.test(item)) ?? models[0] ?? '') }, [models, model])
  const endpoint = state.instance?.baseUrl ?? state.preferences.endpoint
  let command = '', problem = ''
  try { command = antigravity && model ? providerSetupCommand(endpoint, antigravity.endpoint, client, model, keyEnv.trim(), makeDefault) : '' }
  catch (error) { problem = error instanceof Error ? error.message : String(error) }
  return (
    <>
      <PanelHeader title="Clients & diagnostics" description="Connect a client to this Meridian, and export a diagnostic summary for a bug report." />
      <Group title="Connect Pi or OpenCode to Antigravity">
        {!antigravity ? <Empty title="Antigravity is not enabled on this service" detail="Enable it in Process → Providers for the managed copy, or on your own service." />
          : !models.length ? <Empty title="Waiting for account models" detail="Client setup is available once Antigravity reports its models." /> : <>
            <SettingRow label="Client" htmlFor="setup-client" control={<Select id="setup-client" className="w-40" value={client} onChange={event => setClient(event.target.value)}><option value="pi">Pi</option><option value="opencode">OpenCode V1</option></Select>} />
            <SettingRow label="Account model" htmlFor="setup-model" control={<Select id="setup-model" className="w-64" value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item} value={item}>{item}</option>)}</Select>} />
            <SettingRow label="API-key variable" htmlFor="setup-key" description="Only if this service requires a key: the environment variable your client reads it from." control={<Input id="setup-key" className="w-56 font-mono text-xs" placeholder="MERIDIAN_CLIENT_KEY" value={keyEnv} onChange={event => setKeyEnv(event.target.value)} />} />
            <SettingRow label="Make this the client’s default" control={<Switch aria-label="Make this the client’s default" checked={makeDefault} onCheckedChange={setMakeDefault} />} />
            <div className="px-4 py-3">
              <Textarea readOnly rows={3} aria-label="Setup command" value={command} />
              <div className="mt-2 flex items-center gap-3">
                <Button disabled={!command || busy} onClick={() => { void run('copy-client-setup', { client, model, keyEnv, setDefault: makeDefault }).then(next => { if (next) say('Setup command copied', 'success') }) }}><Copy />Copy command</Button>
                <span className="text-xs text-t3">{problem || 'Run it in a terminal with Meridian installed, then restart the client.'}</span>
              </div>
            </div>
          </>}
      </Group>
      <Group title="Diagnostics">
        <SettingRow label="Export diagnostic summary" description="Counts, timings, versions and the connection state. Excludes prompts, requests and logs." control={<Button onClick={() => { void run('export-diagnostics') }} disabled={busy}><FileDown />Export…</Button>} />
      </Group>
      <Group title="About">
        <Fact label="Meridian Desktop">{state.desktopVersion} · preview</Fact>
        <Fact label="Appearance">{state.glass}</Fact>
        <Fact label="Platform">{state.platform === 'darwin' ? 'macOS' : state.platform}</Fact>
      </Group>
    </>
  )
}
