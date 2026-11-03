import { useState } from 'react'
import { Radar } from 'lucide-react'
import { useDesktop } from '../../lib/desktop'
import { Button } from '../../components/button'
import { Input, Select } from '../../components/controls'
import { Dot, Pill } from '../../components/pill'
import { Table, Td, Th, Tr } from '../../components/table'
import { when } from '../../model/format'
import { host } from '../../model/status'
import { Fact, Group, PanelHeader, SettingRow } from './parts'
import type { DesktopState } from '../../../contracts'

const connectionTone = { ok: 'green', starting: 'yellow', 'wrong-port': 'yellow', stopped: 'red', unauthorized: 'red', 'not-meridian': 'red' } as const

export function Connection({ state }: { state: DesktopState }) {
  const { run, busy, now } = useDesktop()
  const [endpoint, setEndpoint] = useState(state.preferences.endpoint)
  const [apiKey, setApiKey] = useState('')
  const [mode, setMode] = useState(state.preferences.mode)
  const [port, setPort] = useState(String(state.preferences.port))
  const instance = state.instance
  const locked = state.owned || Boolean(state.migration?.adopted)
  const detection = state.detection
  return (
    <>
      <PanelHeader title="Connection" description="Meridian Desktop shows the Meridian your clients actually use. It finds it from your launchd service, OpenCode and Pi configuration and port 3456, and runs its own copy only when none is running."
        actions={<Button onClick={() => { void run('redetect') }} disabled={busy}><Radar />Re-detect</Button>} />
      <Group>
        <Fact label="Status"><span className="flex items-baseline gap-2"><Dot tone={connectionTone[state.connection.kind]} className="self-center" /><span className="font-medium">{state.connection.kind === 'ok' ? 'Connected' : state.connection.kind}</span><span className="text-t3">{state.connection.message}</span></span></Fact>
        {state.connection.fix ? <Fact label="Fix">{state.connection.fix}</Fact> : null}
        <Fact label="Viewing" mono>{instance?.baseUrl ?? '—'}</Fact>
        <Fact label="Version">{instance?.version ? `Meridian ${instance.version}` : '—'}</Fact>
        <Fact label="Supervisor">{instance ? `${instance.supervisor.kind}${instance.supervisor.label ? ` · ${instance.supervisor.label}` : ''}` : '—'}</Fact>
        <Fact label="Found through">{instance?.detectedFrom ?? '—'}</Fact>
        <Fact label="Viewing since">{instance ? when(instance.attachedAt, now) : '—'}</Fact>
        <Fact label="How">{state.preferences.mode === 'managed' ? 'Managed: the app runs its own copy' : 'Attached: the app reads the service and never takes it over'}</Fact>
      </Group>

      {detection ? (
        <Group title={`Detection · ${when(detection.at, now)}`}>
          <p className="px-4 py-2.5 text-cap text-t2">{detection.note}</p>
          {detection.services.length ? (
            <Table inset>
              <thead><tr><Th>Address</Th><Th>Status</Th><Th>Version</Th><Th>Supervisor</Th><Th>Found in</Th></tr></thead>
              <tbody>{detection.services.map(service => (
                <Tr key={service.baseUrl}>
                  <Td className="font-mono text-xs text-t2">{host(service.baseUrl)}{service.own ? <Pill tone="accent" className="ml-1.5">app copy</Pill> : null}</Td>
                  <Td><Pill tone={service.status === 'meridian' ? 'green' : service.status === 'unreachable' ? 'muted' : 'red'}>{service.status}</Pill></Td>
                  <Td className="num">{service.version ?? '—'}</Td>
                  <Td>{service.supervisor.label ?? service.supervisor.kind}{service.pid ? <span className="text-t3"> · pid {service.pid}</span> : null}</Td>
                  <Td className="max-w-64 truncate text-t3" title={service.sources.join('\n')}>{service.sources.join(', ')}</Td>
                </Tr>
              ))}</tbody>
            </Table>
          ) : null}
          {detection.rejected.length ? <div className="px-4 py-2.5 text-xs text-t3">{detection.rejected.map((item, index) => <div key={index}>Skipped {item.source} ({item.detail}): <span className="font-mono text-t2">{item.url}</span> — {item.reason}</div>)}</div> : null}
        </Group>
      ) : null}

      <Group title="Address and API key">
        <form onSubmit={event => { event.preventDefault(); void run('save-preferences', { mode: 'attached', endpoint, ...(apiKey ? { apiKey } : {}) }).then(next => { if (next) setApiKey('') }) }}>
          <SettingRow label="Meridian address" htmlFor="endpoint" description="Only local addresses (127.0.0.1, localhost)." control={<Input id="endpoint" className="w-60 font-mono text-xs" value={endpoint} disabled={locked} onChange={event => setEndpoint(event.target.value)} />} />
          <SettingRow label={<>API key <span className="font-normal text-t3">{state.hasApiKey ? '· saved' : '· optional'}</span></>} htmlFor="api-key" description="Needed when the service sets MERIDIAN_API_KEY. Stored encrypted in the macOS keychain-backed store."
            control={<Input id="api-key" type="password" autoComplete="off" className="w-60" placeholder={state.hasApiKey ? 'Leave blank to keep the saved key' : 'API key'} value={apiKey} disabled={locked} onChange={event => setApiKey(event.target.value)} />} />
          <div className="flex items-center justify-end gap-2 px-4 py-2.5">
            {locked ? <span className="text-xs text-t3">Stop the managed service, or return it to headless, before changing the connection.</span> : null}
            <Button type="submit" disabled={busy || locked}>Connect</Button>
          </div>
        </form>
      </Group>

      <Group title="App-managed copy">
        <form onSubmit={event => { event.preventDefault(); void run('save-preferences', { mode, port: Number(port) }) }}>
          <SettingRow label="Run Meridian" htmlFor="mode" description="Attach is the default. Choose managed only when no other Meridian should serve your clients."
            control={<Select id="mode" value={mode} disabled={locked} onChange={event => setMode(event.target.value === 'managed' ? 'managed' : 'attached')} className="w-56"><option value="attached">Attach to an existing service</option><option value="managed">Run the app's own copy</option></Select>} />
          <SettingRow label="Managed port" htmlFor="port" control={<Input id="port" type="number" min={1024} max={65535} className="w-24" value={port} disabled={locked} onChange={event => setPort(event.target.value)} />} />
          <div className="flex justify-end px-4 py-2.5"><Button type="submit" disabled={busy || locked}>Save</Button></div>
        </form>
      </Group>
    </>
  )
}
