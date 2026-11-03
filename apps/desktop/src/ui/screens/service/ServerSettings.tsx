import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Search } from 'lucide-react'
import { useDesktop } from '../../lib/desktop'
import { Button } from '../../components/button'
import { Code, Input, Segmented, Select, Switch } from '../../components/controls'
import { Pill } from '../../components/pill'
import { Table, Td, Th, Tr } from '../../components/table'
import { Empty } from '../../components/state'
import { bytes, fmtInt } from '../../model/format'
import { moveInOrder } from '../../model/accounts'
import { envNote, Group, PanelHeader, readSection, SettingRow } from './parts'
import { envOverrideText } from '../../../../../../src/telemetry/settingRow'
import { number, object, text } from '../../../core'
import type { DesktopState, WritableSettingsSection } from '../../../contracts'

function useSave() {
  const { run } = useDesktop()
  return (section: WritableSettingsSection, body: Record<string, unknown>) => run('update-settings', { section, body })
}
const envFor = (section: Record<string, unknown>, key: string, inUse: string | null, saved: string | null) =>
  envOverrideText(object(section.envSources)[key], inUse, saved) ?? envNote(object(section.envOverride)[key])

/** A text or number field that saves on Enter or when it loses focus, not per keystroke. */
function CommitField({ value, onCommit, type = 'text', className, placeholder, min, max, id, disabled, label }: { value: string; onCommit(value: string): void; type?: 'text' | 'number'; className?: string; placeholder?: string; min?: number; max?: number; id?: string; disabled?: boolean; label?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft !== value) onCommit(draft) }
  return <Input id={id} aria-label={label} type={type} min={min} max={max} placeholder={placeholder} disabled={disabled} className={className} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit() }} />
}

export function Routing({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const save = useSave()
  const { value, problem } = readSection(state, 'routing')
  const description = 'How requests choose an account. Active sends everything to the selected account. Sticky keeps a conversation on its account. Priority drains the pool top to bottom and returns after a reset. Active+priority stays on your account but fails over to the pool when it is refused. An x-meridian-profile header always wins.'
  if (!value) return <><PanelHeader title="Routing" description={description} /><Group>{problem}</Group></>
  const modes = Array.isArray(value.modes) ? value.modes.map(text) : ['active', 'sticky', 'priority']
  const order = Array.isArray(value.profileOrder) ? value.profileOrder.map(text) : []
  const pool = text(value.routing).includes('priority')
  return (
    <>
      <PanelHeader title="Routing" description={description} />
      <Group>
        <SettingRow label="Mode" htmlFor="routing-mode" env={envFor(value, 'routing', text(value.routing), null)} control={
          <Select id="routing-mode" className="w-44" value={text(value.routing)} disabled={busy} onChange={event => { void save('routing', { routing: event.target.value }) }}>{modes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</Select>} />
        <div className="px-4 py-3">
          <div className="text-base font-medium">Pool order</div>
          <p className="mt-0.5 text-sm text-t3">{pool ? text(value.routing) === 'active+priority' ? 'Fallback order when the active account runs out. The active account always goes first.' : 'Highest priority first; drained top to bottom.' : 'Used by priority modes. Kept for when you switch.'}</p>
          <ol className="mt-2 flex flex-col gap-1">
            {order.map((id, index) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <span className="num w-5 text-right text-t3">{index + 1}</span>
                <span className="flex-1 font-mono text-xs">{id}</span>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${id} up`} disabled={busy || index === 0} onClick={() => { void run('reorder-profiles', moveInOrder(order, id, -1)) }}><ArrowUp /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${id} down`} disabled={busy || index === order.length - 1} onClick={() => { void run('reorder-profiles', moveInOrder(order, id, 1)) }}><ArrowDown /></Button>
              </li>
            ))}
          </ol>
        </div>
      </Group>
    </>
  )
}

type Feature = { key: string; label: string; desc: string; type: 'toggle' | 'select' | 'number' | 'text'; options?: string[] }
const FEATURES: Feature[] = [
  { key: 'codeSystemPrompt', label: 'Claude Code prompt', desc: 'Include the built-in Claude Code system prompt (tool rules, safety, coding practices).', type: 'toggle' },
  { key: 'clientSystemPrompt', label: 'Client prompt', desc: 'Include the system prompt the connecting agent sends.', type: 'toggle' },
  { key: 'claudeMd', label: 'CLAUDE.md', desc: 'Host instruction files for SDK-owned tool execution. Off: none · Project: ./CLAUDE.md · Full: user + project. Passthrough uses client context.', type: 'select', options: ['off', 'project', 'full'] },
  { key: 'memory', label: 'Memory', desc: 'Persistent memory across sessions.', type: 'toggle' },
  { key: 'dreaming', label: 'Auto-Dream', desc: 'Background memory consolidation.', type: 'toggle' },
  { key: 'thinking', label: 'Thinking', desc: 'Extended thinking mode.', type: 'select', options: ['disabled', 'adaptive', 'enabled'] },
  { key: 'thinkingPassthrough', label: 'Thinking passthrough', desc: 'Forward thinking blocks to the client.', type: 'toggle' },
  { key: 'sharedMemory', label: 'Shared memory', desc: 'Share memory with Claude Code (~/.claude) instead of isolated storage.', type: 'toggle' },
  { key: 'webFetchPreflight', label: 'WebFetch preflight', desc: 'Check each WebFetch hostname against the Anthropic blocklist before fetching. Only affects Cherry Studio.', type: 'toggle' },
  { key: 'claudeAiConnectors', label: 'claude.ai connectors', desc: 'Load the MCP connectors attached to your claude.ai account. Always off in passthrough.', type: 'toggle' },
  { key: 'maxBudgetUsd', label: 'Max budget (USD)', desc: 'Per-request cost cap; the query aborts when exceeded (0 = off).', type: 'number' },
  { key: 'fallbackModel', label: 'Fallback model', desc: 'Model to fall back to if the primary fails.', type: 'select', options: ['', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]'] },
  { key: 'sdkDebug', label: 'SDK debug logging', desc: 'Verbose SDK debug output to the service’s stderr.', type: 'toggle' },
  { key: 'additionalDirectories', label: 'Additional directories', desc: 'Comma-separated extra paths Claude can access.', type: 'text' },
]
const ADAPTERS: Record<string, string> = { opencode: 'OpenCode', openai: 'OpenAI', crush: 'Crush', forgecode: 'ForgeCode', pi: 'Pi', droid: 'Droid', passthrough: 'Passthrough', codex: 'Codex', cherry: 'Cherry Studio', 'claude-code': 'Claude Code' }

export function Agents({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const config = object(state.features)
  const adapters = Object.keys(config)
  const [adapter, setAdapter] = useState(adapters[0] ?? '')
  const current = adapters.includes(adapter) ? adapter : adapters[0] ?? ''
  const features = object(config[current])
  const set = (key: string, value: unknown) => { void run('set-features', { adapter: current, features: { [key]: value } }) }
  return (
    <>
      <PanelHeader title="Agent features" description="SDK features for each connected agent. In passthrough, tools and project instructions come from the client. Both system prompts should usually stay on: Claude Code’s base instructions come first, then the agent’s. Changes apply to the next request."
        actions={current ? <Button variant="subtle" onClick={() => { void run('reset-features', current) }} disabled={busy}><RotateCcw />Reset {ADAPTERS[current] ?? current}</Button> : null} />
      {!adapters.length ? <Group><Empty title="No agent settings" detail={state.connection.kind === 'ok' ? 'This Meridian reports no adapters.' : 'Connect to Meridian to edit agent features.'} /></Group> : <>
        <div className="mb-3 flex flex-wrap gap-1">{adapters.map(id => <Button key={id} variant={id === current ? 'subtle' : 'ghost'} size="sm" onClick={() => setAdapter(id)}>{ADAPTERS[id] ?? id}</Button>)}</div>
        <Group>
          {FEATURES.filter(feature => feature.key in features).map(feature => {
            const value = features[feature.key]
            const id = `feature-${feature.key}`
            const control = feature.type === 'toggle' ? <Switch id={id} checked={value === true} disabled={busy} onCheckedChange={next => set(feature.key, next)} />
              : feature.type === 'select' ? <Select id={id} className="w-40" value={String(value ?? '')} disabled={busy} onChange={event => set(feature.key, event.target.value)}>{[...new Set([...(feature.options ?? []), String(value ?? '')])].map(option => <option key={option} value={option}>{option === '' ? '(none)' : option}</option>)}</Select>
              : feature.type === 'number' ? <CommitField id={id} type="number" min={0} className="w-24 text-right" value={String(number(value) ?? 0)} onCommit={next => set(feature.key, Number.parseFloat(next) || 0)} disabled={busy} />
              : <CommitField id={id} className="w-64" value={text(value)} onCommit={next => set(feature.key, next)} disabled={busy} />
            return <SettingRow key={feature.key} label={feature.label} htmlFor={id} description={feature.desc} control={control} />
          })}
        </Group>
      </>}
    </>
  )
}

const CREDITS = [['never', 'Never use credits'], ['reserve', 'Only when no seat has plan usage left'], ['immediately', 'As soon as the seat’s plan usage is drained']] as const
const SUMMARY = [['client', 'As the client asks'], ['auto', 'Auto'], ['concise', 'Concise'], ['detailed', 'Detailed']] as const
const FREE_SEAT = [['before-credits', 'Before any seat spends credits'], ['after-credits', 'Only once no seat can use credits']] as const

export function ChatGpt({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const save = useSave()
  const { value, problem } = readSection(state, 'chatgpt')
  const header = <PanelHeader title="ChatGPT" description="GPT models are served from your ChatGPT subscription as a pass-through: Meridian adds no prompt, and agent features do not apply. These settings act on the response and on retries."
    actions={value?.enabled ? <Button variant="subtle" onClick={() => { void run('reset-settings', { section: 'chatgpt' }) }} disabled={busy}><RotateCcw />Reset</Button> : null} />
  if (!value) return <>{header}<Group>{problem}</Group></>
  if (value.enabled !== true) return <>{header}<Group><Empty title="ChatGPT is not served here" detail="Set MERIDIAN_CHATGPT_CREDENTIALS on the service to enable ChatGPT." /></Group></>
  const f = object(value.features)
  const models = Array.isArray(value.models) ? value.models.map(text) : []
  const seats = Array.isArray(value.seats) ? value.seats.map(object) : []
  const patch = (key: string, next: unknown) => { void save('chatgpt', { [key]: next }) }
  const options = (list: readonly (readonly [string, string])[]) => list.map(([id, label]) => <option key={id} value={id}>{label}</option>)
  return (
    <>
      {header}
      <Group>
        <SettingRow label="Thinking passthrough" description="Forward ChatGPT’s short reasoning summaries to the client. The encrypted reasoning the client must send back is always kept." control={<Switch checked={f.thinkingPassthrough === true} disabled={busy} onCheckedChange={next => patch('thinkingPassthrough', next)} />} />
        <SettingRow label="Reasoning summary" description="How much reasoning summary ChatGPT is asked for on every request." control={<Select className="w-52" value={text(f.reasoningSummary)} disabled={busy} onChange={event => patch('reasoningSummary', event.target.value)}>{options(SUMMARY)}</Select>} />
        <SettingRow label="Max budget (USD)" description="Per-request cost cap from OpenAI pricing (0 = off)." control={<CommitField type="number" min={0} className="w-24 text-right" value={String(number(f.maxBudgetUsd) ?? 0)} onCommit={next => patch('maxBudgetUsd', Number.parseFloat(next) || 0)} disabled={busy} />} />
        <SettingRow label="Fallback model" description="Retry once on this model when the requested one fails before any output." control={<Select className="w-52" value={text(f.fallbackModel)} disabled={busy} onChange={event => patch('fallbackModel', event.target.value)}><option value="">(none)</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</Select>} />
        <SettingRow label="Codex credits" description="When a seat whose plan usage is used up may keep serving on purchased credits. Credits may be real money." control={<Select className="w-72" value={text(f.creditsPolicy)} disabled={busy} onChange={event => patch('creditsPolicy', event.target.value)}>{options(CREDITS)}</Select>} />
        <SettingRow label="Free-plan seats" description="Where a free seat ranks for unpinned work. It always comes after paid seats with plan usage left." control={<Select className="w-64" value={text(f.freeSeatOrder)} disabled={busy} onChange={event => patch('freeSeatOrder', event.target.value)}>{options(FREE_SEAT)}</Select>} />
        {seats.map(seat => (
          <SettingRow key={text(seat.id)} label={`Credits: ${text(seat.id)}`} description={`${text(seat.label)} — overrides the Codex credits policy for this seat only.`}
            control={<Select className="w-72" value={text(seat.creditsPolicy) || 'inherit'} disabled={busy} onChange={event => patch('seatCreditsPolicy', { [text(seat.id)]: event.target.value })}><option value="inherit">Same as above ({text(f.creditsPolicy)})</option>{options(CREDITS)}</Select>} />
        ))}
      </Group>
    </>
  )
}

const RATE_KEYS = ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] as const
export function Pricing({ state }: { state: DesktopState }) {
  const { run, busy } = useDesktop()
  const { value, problem } = readSection(state, 'pricing')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState({ model: '', input: '', output: '', read: '', write: '' })
  const builtin = object(value?.builtin), overrides = object(value?.overrides)
  const models = useMemo(() => [...new Set([...Object.keys(builtin), ...Object.keys(overrides)])].sort(), [value])
  const header = <PanelHeader title="Model pricing" description="USD per million tokens, used for the API-equivalent estimates on Traffic and Cache. Edit a rate to override the built-in one, or add a model the table does not know. Cache rates default to 0.1× and 1.25× of input." />
  if (!value) return <>{header}<Group>{problem}</Group></>
  const shown = models.filter(model => model.toLowerCase().includes(query.trim().toLowerCase()))
  const commit = (model: string, key: typeof RATE_KEYS[number], raw: string) => {
    const effective = object(overrides[model] ?? builtin[model])
    const pricing = Object.fromEntries(RATE_KEYS.map(k => [k, k === key ? Number.parseFloat(raw) : number(effective[k]) ?? 0]))
    if (Object.values(pricing).some(rate => !Number.isFinite(rate) || rate < 0)) return
    void run('set-pricing', { model, pricing })
  }
  const add = () => {
    const pricing: Record<string, number> = { inputPerMTok: Number.parseFloat(draft.input), outputPerMTok: Number.parseFloat(draft.output) }
    if (draft.read) pricing.cacheReadPerMTok = Number.parseFloat(draft.read)
    if (draft.write) pricing.cacheWritePerMTok = Number.parseFloat(draft.write)
    void run('set-pricing', { model: draft.model.trim(), pricing }).then(next => { if (next) setDraft({ model: '', input: '', output: '', read: '', write: '' }) })
  }
  const addValid = /^[\w.:@/-]{1,128}$/.test(draft.model.trim()) && Number.isFinite(Number.parseFloat(draft.input)) && Number.isFinite(Number.parseFloat(draft.output))
  return (
    <>
      {header}
      <div className="mb-2 flex items-center gap-2"><div className="relative w-64"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-t3" /><Input className="pl-7" type="search" aria-label="Search models" placeholder="Search models" value={query} onChange={event => setQuery(event.target.value)} /></div><span className="num text-xs text-t3">{shown.length} models · {Object.keys(overrides).length} overrides</span></div>
      <Group>
        <div className="max-h-[360px] overflow-auto ">
          <Table inset>
            <thead><tr><Th>Model</Th><Th className="text-right">Input</Th><Th className="text-right">Output</Th><Th className="text-right">Cache read</Th><Th className="text-right">Cache write</Th><Th>Source</Th><Th /></tr></thead>
            <tbody>{shown.map(model => {
              const override = overrides[model] !== undefined
              const effective = object(overrides[model] ?? builtin[model])
              return (
                <Tr key={model}>
                  <Td className="font-mono text-xs text-t2">{model}</Td>
                  {RATE_KEYS.map(key => <Td key={key} className="text-right"><CommitField label={`${model} ${key}`} type="number" min={0} className="h-6 w-20 text-right" value={String(Math.round((number(effective[key]) ?? 0) * 10000) / 10000)} onCommit={raw => commit(model, key, raw)} disabled={busy} /></Td>)}
                  <Td><Pill tone={override ? 'accent' : 'muted'}>{override ? 'override' : 'built-in'}</Pill></Td>
                  <Td>{override ? <Button variant="ghost" size="xs" onClick={() => { void run('delete-pricing', model) }} disabled={busy}>{builtin[model] ? 'Reset' : 'Remove'}</Button> : null}</Td>
                </Tr>
              )
            })}</tbody>
          </Table>
        </div>
        <form className="flex items-center gap-2 px-4 py-2.5" onSubmit={event => { event.preventDefault(); if (addValid) add() }}>
          <Input aria-label="Model id" placeholder="model id (e.g. claude-opus-9)" className="flex-1 font-mono text-xs" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} />
          {(['input', 'output', 'read', 'write'] as const).map(key => <Input key={key} aria-label={key} type="number" min={0} step={0.01} placeholder={key === 'read' ? 'cache read' : key === 'write' ? 'cache write' : key} className="w-24" value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} />)}
          <Button type="submit" disabled={busy || !addValid}><Plus />Add</Button>
        </form>
      </Group>
    </>
  )
}

export function Storage({ state }: { state: DesktopState }) {
  const save = useSave()
  const { busy } = useDesktop()
  const telemetry = readSection(state, 'telemetry')
  const transcripts = readSection(state, 'transcripts')
  const t = telemetry.value
  return (
    <>
      <PanelHeader title="Telemetry storage" description="What Meridian remembers about requests, and for how long. In memory it is a fixed ring, lost on restart; persisted to SQLite it survives restarts and is deleted by age. These apply on the next start of the service." />
      <Group>
        {!t ? telemetry.problem : (() => {
          const saved = object(t.saved), wanted = object(t.wanted), live = object(t.effective), limits = object(t.limits)
          const persisting = text(live.kind) === 'sqlite'
          const numberRow = (key: string, label: string, unit: string, now: string) => {
            const limit = object(limits[key])
            return <SettingRow key={key} label={label} htmlFor={`tel-${key}`} status={[`now: ${now}`]} env={envFor(t, key, null, number(saved[key]) === undefined ? null : `${saved[key]} ${unit}`)}
              control={<><CommitField id={`tel-${key}`} type="number" min={number(limit.min)} max={number(limit.max)} placeholder="default" className="w-28 text-right" value={number(saved[key]) === undefined ? '' : String(saved[key])} disabled={busy} onCommit={raw => { void save('telemetry', { [key]: raw.trim() === '' ? null : Number(raw) }) }} /><span className="w-12 text-xs text-t3">{unit}</span></>} />
          }
          const pending = Array.isArray(t.pendingRestart) ? t.pendingRestart.map(text) : []
          return <>
            <SettingRow label="Persist to SQLite" status={[`now: ${persisting ? 'SQLite' : 'memory'}`]} env={envFor(t, 'telemetryPersist', wanted.persist === true ? 'SQLite' : 'memory', saved.telemetryPersist === null || saved.telemetryPersist === undefined ? null : saved.telemetryPersist ? 'SQLite' : 'memory')}
              control={<Switch aria-label="Persist to SQLite" checked={wanted.persist === true} disabled={busy} onCheckedChange={value => { void save('telemetry', { telemetryPersist: value }) }} />} />
            {numberRow('telemetryRetentionDays', 'Retention', 'days', persisting ? `${fmtInt(live.retentionDays)} days` : 'n/a while in memory')}
            {numberRow('telemetrySize', 'Request ring size', 'rows', persisting ? 'n/a while persisting' : fmtInt(live.capacity))}
            {numberRow('diagnosticLogSize', 'Diagnostic log size', 'entries', persisting ? 'n/a while persisting' : fmtInt(live.diagnosticLogCapacity))}
            <p className="px-4 py-2.5 text-xs text-t3">Holding {fmtInt(live.held)} requests {persisting ? <>in <span className="font-mono text-t2">{text(live.dbPath)}</span> ({bytes(live.dbBytes)})</> : 'in memory — lost on restart'}. The database path is set with <Code>MERIDIAN_TELEMETRY_DB</Code>.</p>
            {pending.length ? <p className="px-4 py-2.5 text-xs text-yellow">Saved, not yet in effect: {pending.join(', ')}. {text(object(t.supervision).restartCommand) ? <>Restart with <Code>{text(object(t.supervision).restartCommand)}</Code>.</> : 'Restart Meridian to apply.'}</p> : null}
          </>
        })()}
      </Group>
      <Group title="Transcript retention">
        {!transcripts.value ? transcripts.problem : (() => {
          const value = transcripts.value
          const effective = object(value.effective), limits = object(value.limits)
          const days = number(effective.days) ?? 0
          return <SettingRow label="Delete after" htmlFor="tr-days" description={<>Off by default. When on, Claude Code deletes <b className="text-yellow">all</b> of its files older than this in each profile directory, not only transcripts. A profile whose own settings set cleanupPeriodDays keeps it.</>}
            status={[`now: ${days > 0 ? `Claude Code deletes files older than ${days} days` : 'off, nothing is deleted'}`]} env={envFor(value, 'transcriptRetentionDays', days > 0 ? `${days} days` : 'off', number(value.saved) ? `${value.saved} days` : null)}
            control={<><CommitField id="tr-days" type="number" min={number(limits.min) ?? 1} max={number(limits.max) ?? 3650} placeholder="off" className="w-28 text-right" value={number(value.saved) === undefined ? '' : String(value.saved)} disabled={busy} onCommit={raw => { void save('transcripts', { transcriptRetentionDays: raw.trim() === '' ? null : Number(raw) }) }} /><span className="w-12 text-xs text-t3">days</span></>} />
        })()}
      </Group>
    </>
  )
}

export function Updates({ state }: { state: DesktopState }) {
  const save = useSave()
  const { busy } = useDesktop()
  const { value, problem } = readSection(state, 'updates')
  const header = <PanelHeader title="Service updates" description="Asks the npm registry once a day whether a newer Meridian is published, and checks loaded plugins installed from npm. Off until you turn it on. Installing versions for the app’s own copy lives in Versions." />
  if (!value) return <>{header}<Group>{problem}</Group></>
  const build = object(value.build)
  const plugins = Array.isArray(value.plugins) ? value.plugins.map(object) : []
  const status = value.envOptOut ? 'forced off' : !value.checkForUpdates ? 'not checking' : !text(build.latest) ? 'checking…' : build.updateAvailable ? `${text(build.latest)} available` : 'up to date'
  return (
    <>
      {header}
      <Group>
        <SettingRow label="Check for updates" status={[`now: ${status}`, `Running ${text(build.version) || 'unknown'}${text(build.source) && text(build.source) !== 'npm' ? ` from a ${text(build.source)} build` : ''}`]}
          env={value.envOptOut ? 'MERIDIAN_NO_UPDATE_CHECK is set on the service; update checks stay off.' : null}
          control={<Switch aria-label="Check for updates" checked={value.checkForUpdates === true} disabled={busy || value.envOptOut === true} onCheckedChange={next => { void save('updates', { checkForUpdates: next }) }} />} />
        {plugins.map(plugin => (
          <SettingRow key={text(plugin.name)} label={<span className="flex items-center gap-2">{text(plugin.name)}{text(plugin.package) ? <span className="font-mono text-xs text-t2">{text(plugin.package)}</span> : null}</span>}
            status={[!plugin.checkable ? `not checkable: ${text(plugin.reason) || 'no npm package'}` : plugin.updateAvailable ? `${text(plugin.installed)} → ${text(plugin.latest)} available` : `${text(plugin.installed)}${text(plugin.latest) ? ', up to date' : ''}`, text(plugin.error) ? `last check failed: ${text(plugin.error)}` : null]} />
        ))}
      </Group>
    </>
  )
}

export function ClaudeCode({ state }: { state: DesktopState }) {
  const save = useSave()
  const { busy } = useDesktop()
  const { value, problem } = readSection(state, 'claude-executable')
  const [path, setPath] = useState('')
  useEffect(() => setPath(text(value?.customPath)), [value?.customPath])
  const header = <PanelHeader title="Claude Code executable" description="Which Claude Code runs each request. System uses the claude on your PATH; Bundled uses the copy Meridian ships with; Custom runs a path you choose. Applies to the next request; MERIDIAN_CLAUDE_PATH overrides it." />
  if (!value) return <>{header}<Group>{problem}</Group></>
  const candidates = object(value.candidates)
  const describe = (raw: unknown) => { const c = object(raw); return text(c.path) ? `${text(c.path)} ${text(c.version) || text(c.detail) || ''}`.trim() : text(c.detail) || 'not available' }
  const active = object(value.active)
  const modes = Array.isArray(value.modes) ? value.modes.map(text) : ['system', 'bundled', 'custom']
  const envOverride = object(value.envOverride)
  return (
    <>
      {header}
      <Group>
        <SettingRow label="Executable" htmlFor="claude-exe-mode" status={[`now: ${text(active.path) ? `${text(active.path)} ${text(active.version)} (${text(active.source)})` : text(value.activeError) || 'none resolved'}`, `System: ${describe(candidates.system)}`, `Bundled: ${describe(candidates.bundled)}`]}
          env={text(envOverride.detail) ? `MERIDIAN_CLAUDE_PATH is set but not used: ${text(envOverride.detail)}` : text(active.source) === 'env' ? 'In use from MERIDIAN_CLAUDE_PATH (env); the choice here is ignored.' : null}
          control={<Select id="claude-exe-mode" className="w-36" value={text(value.mode)} disabled={busy} onChange={event => { void save('claude-executable', event.target.value === 'custom' ? { mode: 'custom', ...(path.trim() ? { path: path.trim() } : {}) } : { mode: event.target.value }) }}>{modes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</Select>} />
        <SettingRow label="Custom path" htmlFor="claude-exe-path" status={text(value.customPath) ? [`Custom: ${describe(candidates.custom)}`] : []}
          control={<><Input id="claude-exe-path" className="w-72 font-mono text-xs" placeholder="/absolute/path/to/claude" value={path} onChange={event => setPath(event.target.value)} /><Button onClick={() => { void save('claude-executable', { mode: 'custom', path: path.trim() || undefined }) }} disabled={busy || !path.trim()}>Use this path</Button></>} />
      </Group>
    </>
  )
}

export function WebUi({ state }: { state: DesktopState }) {
  const save = useSave()
  const { busy } = useDesktop()
  const header = readSection(state, 'header')
  const layout = readSection(state, 'layout')
  return (
    <>
      <PanelHeader title="Web pages" description="How this Meridian’s own web pages look for anyone who opens them in a browser. The desktop app is not affected." />
      <Group title="Site header">
        {!header.value ? header.problem : <SettingRow label="Show hostname" description="Names the machine beside the status in the header. The hostname is then also reported by /health, which answers without the API key."
          status={[`now: ${header.value.showHostname ? 'shown' : 'hidden'}`, `This machine: ${text(header.value.hostname) || 'unknown'}`]}
          control={<Switch aria-label="Show hostname" checked={header.value.showHostname === true} disabled={busy} onCheckedChange={next => { void save('header', { showHostname: next }) }} />} />}
      </Group>
      <Group title="Layout">
        {!layout.value ? layout.problem : <SettingRow label="Page width" description="Contained keeps pages in a centred column; wide uses the whole browser window." control={
          <Segmented label="Layout" value={text(layout.value.layout) || 'contained'} disabled={busy} onChange={next => { void save('layout', { layout: next }) }} options={(Array.isArray(layout.value.layouts) ? layout.value.layouts.map(text) : ['contained', 'wide']).map(id => ({ value: id, label: id.charAt(0).toUpperCase() + id.slice(1) }))} />} />}
      </Group>
    </>
  )
}
