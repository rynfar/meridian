import { useState } from 'react'
import { Download, ExternalLink, Play, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { useDesktop } from '../../lib/desktop'
import { Button } from '../../components/button'
import { Select, Switch } from '../../components/controls'
import { Pill } from '../../components/pill'
import { Empty } from '../../components/state'
import { fmtInt } from '../../model/format'
import { host } from '../../model/status'
import { Fact, Group, PanelHeader, SettingRow } from './parts'
import { number, object, rows, text } from '../../../core'
import type { DesktopState } from '../../../contracts'

export function Process({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const managed = state.preferences.mode === 'managed'
  const p = state.preferences
  const where = host(state.instance?.baseUrl)
  const toggle = (key: 'allowAntigravityTools' | 'persistAntigravityHistory' | 'allowAntigravityBrowser' | 'allowAntigravitySubagents', label: string, description: string) => (
    <SettingRow key={key} label={label} description={description} control={<Switch checked={Boolean(p[key])} disabled={busy || state.owned} onCheckedChange={value => { void run('save-preferences', { [key]: value }) }} aria-label={label} />} />
  )
  return (
    <>
      <PanelHeader title="Process" description={managed ? 'The app runs its own Meridian. Closing the window keeps it running; quitting finishes active requests first, then stops it.' : 'This Meridian is run by your own service manager. The app reads it and never stops or restarts it.'} />
      <Group>
        <SettingRow label={<span className="flex items-center gap-2">{state.owned ? 'Running' : managed ? 'Stopped' : state.running ? 'Connected' : 'Not reachable'}<Pill tone={state.owned || (!managed && state.running) ? 'green' : 'muted'}>{managed ? 'app-managed' : 'external'}</Pill></span>}
          description={<span className="font-mono text-xs text-accent2">{where}</span>}
          control={managed ? state.owned ? <><Button onClick={() => { void run('restart') }} disabled={busy}><RotateCcw />Restart</Button><Button variant="danger" onClick={() => { void run('stop') }} disabled={busy}><Square />Stop</Button></>
            : <Button onClick={() => { void run('start') }} disabled={busy || !p.selected}><Play />Start Meridian</Button> : null} />
        {managed ? <SettingRow label="Start with the app" description="Start the managed copy when the app opens, unless another Meridian already serves your clients." control={<Switch aria-label="Start with the app" checked={p.autoStart} disabled={busy} onCheckedChange={value => { void run('save-preferences', { autoStart: value }) }} />} /> : null}
        {managed && !p.selected ? <p className="hairline-t border-border px-4 py-2.5 text-sm text-muted">Install a version in Versions to run the managed copy.</p> : null}
        {managed ? <p className="hairline-t border-border px-4 py-2.5 text-xs text-muted">Crash recovery restarts the managed copy up to three times, then stops and raises an alert.</p> : null}
      </Group>

      {state.migration ? (
        <Group title="Service ownership">
          <SettingRow label={state.migration.label} description={state.migration.adopted ? 'Meridian Desktop manages this LaunchAgent. Its original supervisor is paused; returning restores it on the same port.' : 'A compatible macOS LaunchAgent. Taking ownership pauses it and starts Meridian on the same port; active requests finish first. You can return it at any time.'}
            control={state.migration.adopted ? <Button onClick={() => { void run('return-headless') }} disabled={busy}>Return to headless</Button>
              : <Button onClick={() => { void run('take-ownership', state.migration?.label) }} disabled={busy || !state.migration.canAdopt}>Manage this service</Button>} />
        </Group>
      ) : null}

      {managed ? (
        <Group title="Providers for the managed copy">
          <SettingRow label="Enabled providers" htmlFor="backend" description="Stop the service before changing this." control={
            <Select id="backend" value={p.backend ?? 'claude'} disabled={busy || state.owned} className="w-52" onChange={event => { void run('save-preferences', { backend: event.target.value }) }}>
              <option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="combined">Claude + Antigravity</option>
            </Select>} />
          {p.backend && p.backend !== 'claude' ? <>
            {toggle('allowAntigravityTools', 'Allow Antigravity client tools', 'Uses CLI auto-approval with Meridian’s restrictive hook; client-side approvals remain yours.')}
            {toggle('persistAntigravityHistory', 'Keep Antigravity history across restarts', 'Stores response content locally for up to 30 minutes and bounded request activity for up to 30 days.')}
            {toggle('allowAntigravityBrowser', 'Allow the native Antigravity browser', 'An isolated Chrome session; needs Chrome and chrome-devtools-mcp 1.9.0.')}
            {toggle('allowAntigravitySubagents', 'Allow native Antigravity subagents', 'Subagents can use the tools enabled for this service, without client approval dialogs.')}
          </> : null}
        </Group>
      ) : null}
    </>
  )
}

export function Versions({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const managed = state.preferences.mode === 'managed'
  const [choice, setChoice] = useState('')
  const selected = choice || state.latest || state.available[0] || ''
  return (
    <>
      <PanelHeader title="Versions" description={managed ? 'Versions the app can run. Each installs side by side; switching restarts the managed copy, and a failed switch rolls back.' : 'Installs a separate app-managed copy. Your own service keeps its version.'}
        actions={<Button onClick={() => { void run('check-updates') }} disabled={busy}><RefreshCw />Check for updates</Button>} />
      <Group>
        <Fact label="Running">{state.running ? `Meridian ${state.running}${managed ? '' : ' (your service)'}` : 'Not running'}</Fact>
        <Fact label="Selected for the app">{state.preferences.selected ?? 'None'}</Fact>
        <Fact label="Previous">{state.preferences.previous ?? 'None'}</Fact>
        <Fact label="Latest on npm">{state.latest ? <span className="flex items-center gap-2">{state.latest}{state.running && state.latest !== state.running ? <Pill tone="accent">update available</Pill> : null}</span> : 'Check for updates to see'}</Fact>
      </Group>
      {state.available.length ? (
        <Group title="Install">
          <SettingRow label="Version" htmlFor="install-version" control={<>
            <Select id="install-version" value={selected} onChange={event => setChoice(event.target.value)} className="w-56">
              {state.available.map(release => <option key={release} value={release}>{release}{release === state.latest ? ' · latest' : ''}{state.installed.includes(release) ? ' · installed' : ''}</option>)}
            </Select>
            <Button onClick={() => { void run('install', selected) }} disabled={busy || !selected}><Download />Install</Button>
          </>} />
        </Group>
      ) : null}
      <Group title="Installed">
        {state.installed.length ? state.installed.map(release => (
          <SettingRow key={release} label={<span className="flex items-center gap-2 font-mono text-sm">{release}{release === state.preferences.selected ? <Pill tone="accent">selected</Pill> : release === state.preferences.previous ? <Pill tone="muted">previous</Pill> : null}</span>}
            control={<>
              <Button variant="ghost" onClick={() => { void run('release-notes', release) }}><ExternalLink />Release notes</Button>
              {release !== state.preferences.selected ? <Button onClick={() => { void run('activate', release) }} disabled={busy || !managed}>{release === state.preferences.previous ? 'Roll back' : 'Use version'}</Button> : null}
            </>} />
        )) : <Empty title="No installed versions" detail="Check for updates, then install a release." />}
        {!managed && state.installed.length ? <p className="hairline-t border-border px-4 py-2.5 text-xs text-muted">Switch to the app's own copy in Connection to run these versions.</p> : null}
      </Group>
    </>
  )
}

export function Plugins({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const managed = state.preferences.mode === 'managed'
  const plugins = rows(object(state.plugins).plugins)
  return (
    <>
      <PanelHeader title="Plugins" description="Plugins loaded by this Meridian, and the curated plugins the app can install into its own copy."
        actions={<Button onClick={() => { void run('reload-plugins') }} disabled={busy || !state.running}><RefreshCw />Reload plugins</Button>} />
      <Group title={`Loaded · ${plugins.filter(plugin => plugin.status === 'active').length} active of ${plugins.length}`}>
        {plugins.length ? plugins.map(plugin => {
          const hooks = Object.entries(object(object(plugin.stats).hooks)).map(([hook, raw]) => { const stats = object(raw); return `${hook} ${fmtInt(stats.invocations)}×${number(stats.errors) ? ` · ${fmtInt(stats.errors)} errors` : ''}` })
          return (
            <SettingRow key={text(plugin.path) || text(plugin.name)} label={<span className="flex min-w-0 items-center gap-2"><span className="truncate">{text(plugin.name)}</span>{text(plugin.version) ? <span className="font-mono text-xs text-accent2">{text(plugin.version)}</span> : null}<Pill tone={plugin.status === 'active' ? 'green' : 'red'}>{text(plugin.status)}</Pill></span>}
              description={text(plugin.description) || undefined}
              status={[hooks.join(' · '), text(plugin.error) ? <span className="text-red">{text(plugin.error)}</span> : null]} />
          )
        }) : <Empty title="No plugins loaded" detail={managed ? 'Install one below.' : 'Install plugins in your service, then reload.'} />}
      </Group>
      <Group title="Catalog · published by rynfar">
        {(state.catalog ?? []).map(plugin => {
          const loaded = plugins.find(item => item.name === plugin.id)
          const upToDate = Boolean(plugin.latest && (plugin.installed === plugin.latest || (loaded?.version === plugin.latest && loaded?.status === 'active')))
          return (
            <SettingRow key={plugin.id} label={`${plugin.title} scrub`} description={<span className="font-mono text-xs text-accent2">{plugin.package}</span>}
              status={[[plugin.installed ? `Installed ${plugin.installed}${loaded?.status === 'active' ? ' · active' : ' · loads on next start'}` : loaded ? `Loaded ${text(loaded.version)}` : 'Not installed', plugin.latest ? `latest ${plugin.latest}` : ''].filter(Boolean).join(' · ')]}
              control={<Button onClick={() => { void run('install-plugin', plugin.id) }} disabled={busy || !managed || upToDate}>{upToDate ? 'Up to date' : loaded || plugin.installed ? 'Update' : 'Install'}</Button>} />
          )
        })}
        <div className="hairline-t flex items-center justify-between border-border px-4 py-2.5 text-xs text-muted">
          <span>{managed ? 'Shared with local headless installs that use the same plugin configuration.' : 'External services manage their own plugin files.'}</span>
          <Button variant="subtle" onClick={() => { void run('check-plugins') }} disabled={busy}>Check for updates</Button>
        </div>
      </Group>
    </>
  )
}
