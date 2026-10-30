import { useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Ellipsis, LogIn, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Label, Panel } from '../components/card'
import { Button } from '../components/button'
import { Dot, Pill, toneText } from '../components/pill'
import { LimitBar } from '../components/limit'
import { Input, Segmented, Tip } from '../components/controls'
import { Menu, MenuItem, MenuSeparator, Sheet } from '../components/overlay'
import { Avatar } from '../components/brand'
import { ConnectionProblem, Empty, Skeleton } from '../components/state'
import { fmtInt, pct, plural, usd, when } from '../model/format'
import { untilText } from '../model/pace'
import { utilTone } from '../model/tone'
import { accountAction, chatGptManaged, limitPill, moveInOrder, ownerCommands, type AccountProvider, type AccountView, type ChatGptOwnerView, type OwnerCommand } from '../model/accounts'
import { accountsRead, providerState } from '../model/status'
import { Glyph } from '../components/glyph'
import { object } from '../../core'
import type { Navigate } from '../shell/nav'

const providerName: Record<AccountProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', antigravity: 'Antigravity' }
const providerNote: Record<AccountProvider, string> = { claude: 'Anthropic subscription', chatgpt: 'OpenAI subscription', antigravity: 'Google subscription · signed in through the Antigravity CLI' }
type Dialog = { kind: 'add'; provider: 'claude' | 'chatgpt' } | { kind: 'rename'; account: AccountView } | { kind: 'remove'; account: AccountView } | { kind: 'owner'; owner: ChatGptOwnerView | null; account?: AccountView } | null
const NAME = /^[a-zA-Z0-9_-]{1,64}$/

export function Accounts({ navigate }: { navigate: Navigate }) {
  const { state, now, run, busy } = useDesktop()
  const { data, accounts } = useModels()
  const [filter, setFilter] = useState<'all' | AccountProvider>('all')
  const [dialog, setDialog] = useState<Dialog>(null)

  if (data.kind === 'failed' && state) return <div className="px-[26px] py-5"><ConnectionProblem data={data} state={state} busy={busy} run={action => { void run(action) }} goService={() => navigate('service')} /></div>
  if (data.kind === 'loading' || !state) return <div className="grid grid-cols-2 gap-4 px-[26px] pt-[22px]">{[0, 1, 2, 3].map(index => <Panel key={index} className="flex flex-col gap-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-10" /><Skeleton className="h-4 w-32" /></Panel>)}</div>

  const providers = (['claude', 'chatgpt', 'antigravity'] as const).filter(id => accounts.accounts.some(account => account.provider === id))
  // Meridian signs ChatGPT seats in only where it owns their logins; elsewhere the owner's commands do.
  const chatgptOwner = accounts.chatgpt?.owner ?? null
  const read = accountsRead(state, accounts.accounts.length)
  const health = object(state.health)
  const claudeServed = health.backend !== 'antigravity'
  const visible = (filter === 'all' ? providers : providers.filter(id => id === filter))
  const switchable = state.connection.kind === 'ok' && !accounts.follow

  return (
    <div className="scroll-y h-full px-[26px] pb-6 pt-[22px]">
      <div className="mb-5 flex items-center gap-4">
        {providers.length > 1 ? <Segmented<'all' | AccountProvider> label="Provider" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, ...providers.map(id => ({ value: id, label: providerName[id] }))]} /> : null}
        {accounts.routing ? <Tip content="How requests choose an account. Change it in Service → Routing."><button type="button" onClick={() => navigate('service', { section: 'routing' })} className="text-cap text-t3 transition-colors hover:text-accent">Routing <span className="font-medium text-t1">{accounts.routing}</span></button></Tip> : null}
        <span className="flex-1" />
        {claudeServed ? <Button variant="text" size="sm" onClick={() => setDialog({ kind: 'add', provider: 'claude' })} disabled={busy || Boolean(state.login)}><Plus />Add Claude account</Button> : null}
        {chatgptOwner ? <Button variant="text" size="sm" onClick={() => setDialog(chatGptManaged(chatgptOwner) ? { kind: 'add', provider: 'chatgpt' } : { kind: 'owner', owner: chatgptOwner })} disabled={busy || Boolean(state.login)}><Plus />Add ChatGPT seat</Button> : null}
      </div>
      {accounts.follow ? <div className="mb-5 flex items-center gap-2 text-cap text-t2"><Dot tone="accent" size={6} />Following the active account from <span className="font-mono text-xs text-t1">{accounts.follow.url}</span>{accounts.follow.stale ? <span className="text-yellow">(stale)</span> : null}<span className="text-t3">· switching is controlled there.</span></div> : null}

      {read.kind === 'loading' ? <div className="grid grid-cols-2 gap-4">{[0, 1].map(index => <Panel key={index} className="flex flex-col gap-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-10" /><Skeleton className="h-4 w-32" /></Panel>)}</div>
        : read.kind === 'failed' ? <Empty title="Could not read the accounts" detail={<span className="selectable">{read.message}</span>}><Button onClick={() => { void run('refresh') }} disabled={busy}><RefreshCw />Refresh</Button></Empty>
        : !accounts.accounts.length ? <Empty title="No accounts on this service" detail="Add a Claude account to start serving requests.">{claudeServed ? <Button onClick={() => setDialog({ kind: 'add', provider: 'claude' })}><Plus />Add Claude account</Button> : null}</Empty>
        : read.warning ? <div role="status" className="mb-5 flex items-center gap-2 text-meta text-yellow"><Glyph kind="warn" /><span className="selectable truncate" title={read.warning}>Some account data could not be read: {read.warning}</span></div> : null}

      {visible.map(provider => {
        const list = accounts.accounts.filter(account => account.provider === provider)
        const ids = list.map(account => account.id)
        const status = providerState(state, provider)
        return (
          <section key={provider} className="mb-7">
            <Label className="mb-2.5 px-0.5"><span className={`brand-${provider} brand-swatch size-2 rounded-xs`} /><span className="text-t2">{providerName[provider]}</span><span className="font-normal">· {providerNote[provider]} · {plural(list.length, 'account')}</span>{status ? <span title={status.text} className={cn('min-w-0 truncate font-normal', status.failing ? 'text-yellow' : 'text-t3')}>· {status.text}</span> : null}</Label>
            <div className="grid grid-cols-2 gap-4">
              {list.map((account, index) => (
                <AccountCard key={account.id} account={account} now={now} busy={busy} switchable={switchable && provider !== 'antigravity'} follow={Boolean(accounts.follow)}
                  first={index === 0} last={index === list.length - 1}
                  onUse={() => { void run('switch-profile', account.id) }}
                  onCommands={account.provider === 'chatgpt' && !chatGptManaged(account.owner) ? () => setDialog({ kind: 'owner', owner: account.owner ?? null, account }) : undefined}
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
      <OwnerSheet dialog={dialog?.kind === 'owner' ? dialog : null} onClose={() => setDialog(null)} />
    </div>
  )
}

/** One account as a raised panel: identity, limits with pace, then plain-text actions and a ⋯ menu. */
function AccountCard({ account, now, busy, switchable, follow, first, last, canReorder, onUse, onLogin, onRenew, onRename, onRemove, onMove, onCommands }: {
  account: AccountView; now: number; busy: boolean; switchable: boolean; follow: boolean; first: boolean; last: boolean; canReorder: boolean;
  onUse(): void; onLogin(): void; onRenew(): void; onRename(): void; onRemove(): void; onMove(direction: -1 | 1): void;
  /** A ChatGPT seat whose login another tool owns: its sign-in steps replace Sign in again and Renew. */
  onCommands?: () => void
}) {
  const action = accountAction(account, follow, now)
  const primary = account.windows.filter(window => window.primary)
  const extra = account.windows.filter(window => !window.primary)
  const manageable = account.provider !== 'antigravity'
  // "Max 20x" already says "Max": show the detail alone when it contains the plan word.
  const plan = account.planDetail && account.planDetail.toLowerCase().includes(account.plan.toLowerCase()) ? account.planDetail : [account.plan, account.planDetail].filter(Boolean).join(' · ')
  return (
    <Panel className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <Avatar id={account.id} provider={account.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-md font-semibold leading-tight tracking-title text-t1" title={account.label}>{account.label}</span>
            {account.active ? <Tip content={follow ? 'Followed from another Meridian' : 'Serving requests now'}><span className="inline-flex items-center gap-1.5 text-xs text-t3"><Dot tone="accent" size={6} />{follow ? 'following' : null}</span></Tip> : null}
            {plan ? <span className="text-xs text-t3">{plan}</span> : null}
            {account.needsLogin ? <span className="text-meta font-medium text-red">needs sign-in</span> : null}
            {account.limited ? <Tip content={account.limited.rationale ?? (account.limited.stale ? 'From the last reading; awaiting a fresh one.' : undefined)}><span className="text-meta font-medium text-yellow">{[limitPill(account.limited), untilText(account.limited.resetsAt, now)].filter(text => text !== 'limited').join(' · ')}</span></Tip> : null}
            {account.duplicateOf.length ? <Tip content={account.duplicateTitle}><Pill tone="yellow">duplicate of {account.duplicateOf.join(', ')}</Pill></Tip> : null}
            {account.aliases.length ? <span className="text-xs text-t3">aka {account.aliases.join(', ')}</span> : null}
          </div>
          <div className="mt-0.5 truncate text-meta text-t3">{[account.email, account.organization && account.organization !== `${account.email}'s Organization` ? account.organization : ''].filter(Boolean).join(' · ') || providerName[account.provider]}</div>
        </div>
        {manageable ? (
          <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${account.id}`}><Ellipsis /></Button>}>
            {!account.active ? <MenuItem disabled={!switchable || busy} onSelect={onUse}><LogIn />Use this account</MenuItem> : null}
            {onCommands ? <MenuItem onSelect={onCommands}><RefreshCw />Sign-in steps…</MenuItem> : <>
              <MenuItem disabled={busy} onSelect={onLogin}><RefreshCw />Sign in again</MenuItem>
              {account.provider === 'chatgpt' ? <MenuItem disabled={busy} onSelect={onRenew}><RefreshCw />Renew seat</MenuItem> : null}
            </>}
            <MenuItem disabled={busy} onSelect={onRename}><Pencil />Rename…</MenuItem>
            {canReorder ? <><MenuSeparator /><MenuItem disabled={busy || first} onSelect={() => onMove(-1)}><ArrowUp />Move earlier in the pool</MenuItem><MenuItem disabled={busy || last} onSelect={() => onMove(1)}><ArrowDown />Move later in the pool</MenuItem></> : null}
            <MenuSeparator />
            <MenuItem danger disabled={busy} onSelect={onRemove}><Trash2 />Remove…</MenuItem>
          </Menu>
        ) : null}
      </div>

      {account.usageNote ? <div className={cn('text-xs', account.needsLogin ? 'text-red' : 'text-t3')}>{account.usageNote}{account.fetchedAt && !account.needsLogin ? ` · read ${when(account.fetchedAt, now)}` : ''}</div> : null}
      {primary.length ? <div className="grid grid-cols-2 gap-x-5 gap-y-3">{primary.map(window => <LimitBar key={window.type} name={window.label} window={window} now={now} />)}</div> : !account.needsLogin ? <div className="text-cap text-t3">No usage windows reported.</div> : null}
      {extra.length ? (
        <div className="num flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {extra.map(window => <span key={window.type} className="text-t3" title={window.resetsAt ? `resets ${when(window.resetsAt, now)}` : undefined}>{window.label} <b className={cn('font-medium', window.stale ? 'text-t3' : (window.utilization ?? 0) >= 0.6 ? toneText[utilTone(window.utilization)] : 'text-t1')}>{pct(window.utilization)}</b></span>)}
        </div>
      ) : null}
      {account.extraUsage ? <div className="text-xs text-t3">{account.extraUsage.text}</div> : null}
      {account.renewal.soon ? <div className="text-xs text-yellow">Sign in again {account.renewal.days === null ? 'soon' : account.renewal.days <= 0 ? 'today' : `within ${account.renewal.days} ${account.renewal.days === 1 ? 'day' : 'days'}`} — its sign-in expires.</div> : null}

      <div className="num mt-auto flex items-center gap-2 pt-0.5 text-xs text-t3">
        {account.served !== undefined || account.refused ? <span>{fmtInt(account.served ?? 0)} served{account.refused ? <> · <span className="text-red">{fmtInt(account.refused)} refused</span></> : null}</span> : <span className="text-t3">No requests in this window</span>}
        {account.costUsd !== undefined ? <span className="text-t3">· {usd(account.costUsd)} API-equivalent</span> : null}
        <span className="flex-1" />
        {action.kind === 'sign-in' ? <Button variant="text" size="sm" onClick={onCommands ?? onLogin} disabled={busy && !onCommands}>Sign in</Button>
          : action.kind === 'use' && switchable ? <Button variant="text" size="sm" onClick={onUse} disabled={busy} aria-label={`Use ${account.id}`}>Use</Button> : null}
      </div>
    </Panel>
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
        <label className="text-base font-medium" htmlFor="account-name">Account name{dialog?.provider === 'chatgpt' ? <span className="font-normal text-t3"> (optional)</span> : null}</label>
        <Input id="account-name" autoFocus placeholder="e.g. work" value={name} onChange={event => setName(event.target.value)} />
        <p className="text-xs text-t3">Letters, numbers, dashes and underscores.</p>
        {dialog?.provider === 'claude' && attached ? (
          <p className="mt-2 text-xs text-t3">Older Meridian versions cannot sign in over HTTP. If this one cannot, copy the command and run it on the service's host:{' '}
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
  // A seat whose login another tool owns is removed there; the server says how.
  const elsewhere = account?.provider === 'chatgpt' && !chatGptManaged(account.owner) ? account.removal || (account.owner?.remove ? `Run \`${account.owner.remove}\` in an opencode session.` : 'Remove it where its login is kept.') : ''
  if (elsewhere) return (
    <Sheet open={Boolean(account)} onClose={onClose} title={`Remove ${account?.id ?? ''}`} description="Meridian only reads this seat's login, so it cannot remove the seat." footer={<Button variant="subtle" onClick={onClose}>Done</Button>}>
      <p className="selectable text-base text-t2 [text-wrap:pretty]">{elsewhere}</p>
    </Sheet>
  )
  return (
    <Sheet open={Boolean(account)} onClose={onClose} title={`Remove ${account?.id ?? ''}?`}
      description={viaHost ? 'This service runs outside the app, and Claude accounts are removed on its host.' : account?.provider === 'chatgpt' ? 'The seat stops serving requests and its sign-in is deleted from this service.' : 'The account stops serving requests and its stored sign-in is deleted.'}
      footer={<><Button variant="subtle" onClick={onClose}>Cancel</Button>{viaHost
        ? <Button onClick={() => { void run('copy-profile-remove', account?.id).then(next => { if (next) onClose() }) }} disabled={busy}><Copy />Copy command</Button>
        : <Button variant="danger" onClick={() => { void run('remove-profile', account?.id).then(next => { if (next) onClose() }) }} disabled={busy}><Trash2 />Remove</Button>}</>}>
      {viaHost ? <div className="text-base">Run this in Terminal on the Mac hosting Meridian, then refresh:<pre className="selectable mt-2 rounded-md bg-well px-2.5 py-2 font-mono text-xs text-t1">{command}</pre></div>
        : <div className="text-base text-t3">{account?.active ? 'This is the active account; requests move to the next account in the pool.' : 'Other accounts are not affected.'}</div>}
    </Sheet>
  )
}


/** Where another tool owns ChatGPT logins: the commands to run there, as selectable text. */
function OwnerSheet({ dialog, onClose }: { dialog: { owner: ChatGptOwnerView | null; account?: AccountView } | null; onClose(): void }) {
  const owner = dialog?.owner
  const account = dialog?.account
  const commands: OwnerCommand[] = ownerCommands(owner, account ? { label: account.label, expired: account.tokenState === 'expired' } : undefined)
  const holder = owner?.name === 'meridian' ? 'Meridian' : owner?.name ?? ''
  return (
    <Sheet open={Boolean(dialog)} onClose={onClose} title={account ? `Sign ${account.label} in again` : 'Add a ChatGPT seat'}
      description={!owner ? undefined : owner.name === 'meridian' ? 'Meridian holds the ChatGPT logins here but cannot sign seats in over HTTP. Bring a signed-in account into its store:' : `${holder} owns the ChatGPT logins this Meridian serves. Run these in a terminal on the machine running Meridian; it picks the seat up by itself.`}
      footer={<Button variant="subtle" onClick={onClose}>Done</Button>}>
      {commands.length ? <div className="flex flex-col gap-3">
        {commands.map(command => (
          <div key={command.label}>
            <div className="text-sm font-medium text-t2">{command.label}</div>
            <pre className="selectable mt-1 whitespace-pre-wrap break-all rounded-md bg-well px-2.5 py-2 font-mono text-xs text-t1">{command.command}</pre>
            {command.note ? <p className="mt-1 text-xs text-t3">{command.note}</p> : null}
          </div>
        ))}
      </div> : <p className="text-base text-t3">This service does not say how its ChatGPT seats are signed in.</p>}
    </Sheet>
  )
}
