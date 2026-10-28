import { useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Ellipsis, LogIn, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Card } from '../components/card'
import { Button } from '../components/button'
import { Pill, toneText } from '../components/pill'
import { Meter } from '../components/meter'
import { Input, Segmented, Tip } from '../components/controls'
import { Menu, MenuItem, MenuSeparator, Sheet } from '../components/overlay'
import { Avatar } from '../components/brand'
import { ConnectionProblem, Empty, Skeleton } from '../components/state'
import { fmtInt, pct, relative, usd, when } from '../model/format'
import { utilTone } from '../model/tone'
import { limitPill, moveInOrder, type AccountProvider, type AccountView, type LimitWindow } from '../model/accounts'
import { object } from '../../core'
import type { Navigate } from '../shell/nav'

const providerName: Record<AccountProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', antigravity: 'Antigravity' }
const providerNote: Record<AccountProvider, string> = { claude: 'Anthropic subscription', chatgpt: 'OpenAI subscription', antigravity: 'Google subscription · signed in through the Antigravity CLI' }
type Dialog = { kind: 'add'; provider: 'claude' | 'chatgpt' } | { kind: 'rename'; account: AccountView } | { kind: 'remove'; account: AccountView } | null
const NAME = /^[a-zA-Z0-9_-]{1,64}$/

export function Accounts({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data, accounts } = useModels()
  const [filter, setFilter] = useState<'all' | AccountProvider>('all')
  const [dialog, setDialog] = useState<Dialog>(null)

  if (data.kind === 'failed' && state) return <div className="p-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <div className="grid grid-cols-2 gap-3.5 p-5">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-48" />)}</div>

  const providers = (['claude', 'chatgpt', 'antigravity'] as const).filter(id => accounts.accounts.some(account => account.provider === id))
  const chatgptServed = Boolean(object(object(state.profiles).chatgpt).owner) || object(state.settings.values.chatgpt).enabled === true
  const health = object(state.health)
  const claudeServed = health.backend !== 'antigravity'
  const visible = (filter === 'all' ? providers : providers.filter(id => id === filter))
  const switchable = state.connection.kind === 'ok' && !accounts.follow

  return (
    <div className="scroll-y h-full px-5 pb-5 pt-[18px]">
      <div className="mb-3.5 flex items-center gap-2">
        {providers.length > 1 ? <Segmented<'all' | AccountProvider> label="Provider" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, ...providers.map(id => ({ value: id, label: providerName[id] }))]} /> : null}
        {accounts.routing ? <Tip content="How requests choose an account. Change it in Service → Routing."><button type="button" onClick={() => navigate('service', { section: 'routing' })} className="hairline rounded-md border-control-border bg-control px-2 py-[3px] text-sm text-muted hover:text-accent">Routing · <span className="text-text">{accounts.routing}</span></button></Tip> : null}
        <span className="flex-1" />
        {claudeServed ? <Button onClick={() => setDialog({ kind: 'add', provider: 'claude' })} disabled={busy || Boolean(state.login)}><Plus />Add Claude account</Button> : null}
        {chatgptServed ? <Button onClick={() => setDialog({ kind: 'add', provider: 'chatgpt' })} disabled={busy || Boolean(state.login)}><Plus />Add ChatGPT seat</Button> : null}
      </div>
      {accounts.follow ? <div className="mb-3.5 rounded-lg bg-accent/10 px-3 py-2 text-sm">Following the active account from <span className="font-mono text-xs text-accent2">{accounts.follow.url}</span>{accounts.follow.stale ? ' (stale)' : ''}. Switching is controlled there.</div> : null}

      {!accounts.accounts.length ? <Card><Empty title="No accounts on this service" detail="Add a Claude account to start serving requests.">{claudeServed ? <Button onClick={() => setDialog({ kind: 'add', provider: 'claude' })}><Plus />Add Claude account</Button> : null}</Empty></Card> : null}

      {visible.map(provider => {
        const list = accounts.accounts.filter(account => account.provider === provider)
        const ids = list.map(account => account.id)
        return (
          <section key={provider} className="mb-5">
            <div className="mb-2 flex items-baseline gap-2"><span className={`brand-${provider} brand-fill size-2 self-center rounded-full`} /><h2 className="text-md font-semibold">{providerName[provider]}</h2><span className="text-xs text-muted">{providerNote[provider]} · {list.length} {list.length === 1 ? 'account' : 'accounts'}</span></div>
            <div className="grid grid-cols-2 gap-3.5">
              {list.map((account, index) => (
                <AccountCard key={account.id} account={account} now={now} busy={busy} switchable={switchable && provider !== 'antigravity'} follow={Boolean(accounts.follow)}
                  first={index === 0} last={index === list.length - 1}
                  onUse={() => { void run('switch-profile', account.id) }}
                  onLogin={() => { void run(provider === 'chatgpt' ? 'chatgpt-connect' : 'login-profile', provider === 'chatgpt' ? { profile: account.id } : account.id) }}
                  onRenew={() => { void run('chatgpt-refresh', account.id) }}
                  onRename={() => setDialog({ kind: 'rename', account })}
                  onRemove={() => setDialog({ kind: 'remove', account })}
                  onMove={direction => { void run('reorder-profiles', moveInOrder(accounts.order.length ? accounts.order : ids, account.id, direction, other => ids.includes(other))) }}
                  canReorder={provider !== 'antigravity' && list.length > 1} />
              ))}
            </div>
          </section>
        )
      })}

      <AddSheet dialog={dialog?.kind === 'add' ? dialog : null} onClose={() => setDialog(null)} />
      <RenameSheet account={dialog?.kind === 'rename' ? dialog.account : null} onClose={() => setDialog(null)} />
      <RemoveSheet account={dialog?.kind === 'remove' ? dialog.account : null} onClose={() => setDialog(null)} />
    </div>
  )
}

function WindowBar({ window, now }: { window: LimitWindow; now: number }) {
  const tone = window.stale ? 'muted' : utilTone(window.utilization)
  return (
    <div>
      <div className="flex justify-between text-xs"><span className="text-muted">{window.label}</span><b className={cn('num font-semibold', toneText[tone])}>{pct(window.utilization)}</b></div>
      <Meter value={window.utilization} stale={window.stale} className="mt-1" label={`${window.label} usage`} />
      <div className="num mt-0.5 text-2xs text-muted">{window.resetsAt ? window.stale ? `last reading · reset was ${when(window.resetsAt, now)}` : `resets ${relative(window.resetsAt, now)} · ${when(window.resetsAt, now)}` : 'reset time unavailable'}</div>
    </div>
  )
}

function AccountCard({ account, now, busy, switchable, follow, first, last, canReorder, onUse, onLogin, onRenew, onRename, onRemove, onMove }: {
  account: AccountView; now: number; busy: boolean; switchable: boolean; follow: boolean; first: boolean; last: boolean; canReorder: boolean;
  onUse(): void; onLogin(): void; onRenew(): void; onRename(): void; onRemove(): void; onMove(direction: -1 | 1): void
}) {
  const primary = account.windows.filter(window => window.primary)
  const extra = account.windows.filter(window => !window.primary)
  const manageable = account.provider !== 'antigravity'
  return (
    <Card className={cn(`brand-${account.provider} flex flex-col gap-2.5`, account.active ? 'brand-ring' : 'brand-stripe', account.needsLogin && 'border-red')}>
      <div className="flex items-start gap-2.5">
        <Avatar id={account.id} provider={account.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-md font-semibold">{account.label}</span>
            {account.active ? <Pill tone="accent">{follow ? 'Following' : 'Active'}</Pill> : null}
            {account.needsLogin ? <Pill tone="red">needs login</Pill> : null}
            {account.limited ? <Tip content={account.limited.rationale ?? (account.limited.stale ? 'From the last reading; awaiting a fresh one.' : undefined)}><Pill tone="red">{limitPill(account.limited)}</Pill></Tip> : null}
            {account.duplicateOf.length ? <Tip content={account.duplicateTitle}><Pill tone="yellow">duplicate of {account.duplicateOf.join(', ')}</Pill></Tip> : null}
            {account.aliases.length ? <span className="text-2xs text-muted">aka {account.aliases.join(', ')}</span> : null}
          </div>
          <div className="truncate text-sm text-muted">{[account.email, account.organization && account.organization !== `${account.email}'s Organization` ? account.organization : '', [account.plan, account.planDetail].filter(Boolean).join(' · ')].filter(Boolean).join(' · ')}</div>
        </div>
        {manageable ? (
          <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${account.id}`}><Ellipsis /></Button>}>
            {!account.active ? <MenuItem disabled={!switchable || busy} onSelect={onUse}><LogIn />Use this account</MenuItem> : null}
            <MenuItem disabled={busy} onSelect={onLogin}><RefreshCw />Sign in again</MenuItem>
            {account.provider === 'chatgpt' ? <MenuItem disabled={busy} onSelect={onRenew}><RefreshCw />Renew seat</MenuItem> : null}
            <MenuItem disabled={busy} onSelect={onRename}><Pencil />Rename…</MenuItem>
            {canReorder ? <><MenuSeparator /><MenuItem disabled={busy || first} onSelect={() => onMove(-1)}><ArrowUp />Move earlier in the pool</MenuItem><MenuItem disabled={busy || last} onSelect={() => onMove(1)}><ArrowDown />Move later in the pool</MenuItem></> : null}
            <MenuSeparator />
            <MenuItem danger disabled={busy} onSelect={onRemove}><Trash2 />Remove…</MenuItem>
          </Menu>
        ) : null}
      </div>

      {account.usageNote ? <div className={cn('text-xs', account.needsLogin ? 'text-red' : 'text-yellow')}>{account.usageNote}{account.fetchedAt && !account.needsLogin ? ` · read ${when(account.fetchedAt, now)}` : ''}</div> : null}
      {primary.length ? <div className="grid grid-cols-2 gap-3">{primary.map(window => <WindowBar key={window.type} window={window} now={now} />)}</div> : !account.needsLogin ? <div className="text-sm text-muted">No usage windows reported.</div> : null}
      {extra.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {extra.map(window => <span key={window.type} className="text-muted" title={window.resetsAt ? `resets ${when(window.resetsAt, now)}` : undefined}>{window.label} <b className={cn('num font-semibold', window.stale ? 'text-muted' : toneText[utilTone(window.utilization)])}>{pct(window.utilization)}</b></span>)}
        </div>
      ) : null}
      {account.extraUsage ? <div className="text-xs text-muted">{account.extraUsage.text}</div> : null}
      {account.renewal.soon ? <div className="text-xs text-yellow">Sign in again {account.renewal.days === null ? 'soon' : account.renewal.days <= 0 ? 'today' : `within ${account.renewal.days} ${account.renewal.days === 1 ? 'day' : 'days'}`} — its sign-in expires.</div> : null}

      <div className="hairline-t mt-auto flex items-center gap-2 border-border pt-2 text-xs text-muted">
        {account.served !== undefined || account.refused ? <span className="num">{fmtInt(account.served ?? 0)} served{account.refused ? <> · <span className="text-red">{fmtInt(account.refused)} refused</span></> : null}</span> : <span>No requests in this window</span>}
        {account.costUsd !== undefined ? <span className="num">· {usd(account.costUsd)} API-equivalent</span> : null}
        <span className="flex-1" />
        {account.needsLogin && manageable ? <Button size="xs" onClick={onLogin} disabled={busy}>Sign in</Button>
          : !account.active && switchable ? <Button size="xs" onClick={onUse} disabled={busy || Boolean(account.limited)} aria-label={`Use ${account.id}`}>Use</Button> : null}
      </div>
    </Card>
  )
}

function AddSheet({ dialog, onClose }: { dialog: { provider: 'claude' | 'chatgpt' } | null; onClose(): void }) {
  const { state, run, busy } = useDesktop()
  const [name, setName] = useState('')
  const valid = dialog?.provider === 'chatgpt' ? name === '' || NAME.test(name) : NAME.test(name)
  const submit = async () => {
    if (!dialog || !valid) return
    const next = dialog.provider === 'chatgpt' ? await run('chatgpt-connect', name ? { name } : {}) : await run('add-profile', name)
    if (next) { setName(''); onClose() }
  }
  const attached = state?.preferences.mode !== 'managed'
  return (
    <Sheet open={Boolean(dialog)} onClose={onClose} title={dialog?.provider === 'chatgpt' ? 'Add a ChatGPT seat' : 'Add a Claude account'}
      description={dialog?.provider === 'chatgpt' ? 'Sign in with a one-time code in any browser. The seat joins the pool on this service.' : 'Give the account a short name, then sign in with the matching Claude account in your browser.'}
      footer={<><Button variant="subtle" onClick={onClose}>Cancel</Button><Button onClick={() => { void submit() }} disabled={busy || !valid}>Continue to sign-in</Button></>}>
      <form onSubmit={event => { event.preventDefault(); void submit() }} className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="account-name">Account name{dialog?.provider === 'chatgpt' ? <span className="font-normal text-muted"> (optional)</span> : null}</label>
        <Input id="account-name" autoFocus placeholder="e.g. work" value={name} onChange={event => setName(event.target.value)} />
        <p className="text-xs text-muted">Letters, numbers, dashes and underscores.</p>
        {dialog?.provider === 'claude' && attached ? (
          <p className="mt-2 text-xs text-muted">Older Meridian versions cannot sign in over HTTP. If this one cannot, copy the command and run it on the service's host:{' '}
            <Button variant="link" size="xs" disabled={!NAME.test(name)} onClick={() => { void run('copy-profile-login', name).then(next => { if (next) onClose() }) }}><Copy />Copy sign-in command</Button>
          </p>
        ) : null}
      </form>
    </Sheet>
  )
}

function RenameSheet({ account, onClose }: { account: AccountView | null; onClose(): void }) {
  const { run, busy } = useDesktop()
  const [to, setTo] = useState('')
  const valid = /^\w[\w.-]{0,63}$/.test(to) && to !== account?.id
  const submit = async () => { if (account && valid && await run('rename-profile', { from: account.id, to })) { setTo(''); onClose() } }
  return (
    <Sheet open={Boolean(account)} onClose={onClose} title={`Rename ${account?.id ?? ''}`} description="Routing, pins and the pool order follow the new name. The old name keeps working as an alias."
      footer={<><Button variant="subtle" onClick={onClose}>Cancel</Button><Button onClick={() => { void submit() }} disabled={busy || !valid}>Rename</Button></>}>
      <form onSubmit={event => { event.preventDefault(); void submit() }}><Input autoFocus aria-label="New name" placeholder={account?.id} value={to} onChange={event => setTo(event.target.value)} /></form>
    </Sheet>
  )
}

function RemoveSheet({ account, onClose }: { account: AccountView | null; onClose(): void }) {
  const { state, run, busy } = useDesktop()
  // Claude accounts have no HTTP removal route: on an attached service the command runs on its host.
  const viaHost = account?.provider === 'claude' && state?.preferences.mode !== 'managed'
  const command = `meridian profile remove ${account?.id ?? ''}`
  return (
    <Sheet open={Boolean(account)} onClose={onClose} title={`Remove ${account?.id ?? ''}?`}
      description={viaHost ? 'This service runs outside the app, and Claude accounts are removed on its host.' : account?.provider === 'chatgpt' ? 'The seat stops serving requests and its sign-in is deleted from this service.' : 'The account stops serving requests and its stored sign-in is deleted.'}
      footer={<><Button variant="subtle" onClick={onClose}>Cancel</Button>{viaHost
        ? <Button onClick={() => { void run('copy-profile-remove', account?.id).then(next => { if (next) onClose() }) }} disabled={busy}><Copy />Copy command</Button>
        : <Button variant="danger" onClick={() => { void run('remove-profile', account?.id).then(next => { if (next) onClose() }) }} disabled={busy}><Trash2 />Remove</Button>}</>}>
      {viaHost ? <div className="text-sm">Run this in Terminal on the Mac hosting Meridian, then refresh:<pre className="selectable hairline mt-2 rounded-md border-border bg-bg px-2.5 py-2 font-mono text-xs text-accent2">{command}</pre></div>
        : <div className="text-sm text-muted">{account?.active ? 'This is the active account; requests move to the next account in the pool.' : 'Other accounts are not affected.'}</div>}
    </Sheet>
  )
}

