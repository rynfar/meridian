import { useCallback, useState } from 'react'
import { CircleAlert, X } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { limitedCount } from '../model/accounts'
import { healthChip } from '../model/status'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { LoginSheet } from './LoginSheet'
import { pageTitles, windowed, type Focus, type Page } from './nav'
import { Today } from '../screens/Today'
import { Traffic } from '../screens/Traffic'
import { Cache } from '../screens/Cache'
import { Accounts } from '../screens/Accounts'
import { Logs } from '../screens/Logs'
import { Service } from '../screens/service/Service'

export function App() {
  const { state, notice, dismiss } = useDesktop()
  const { accounts, serving } = useModels()
  const [page, setPage] = useState<Page>('today')
  const [focus, setFocus] = useState<Focus>({})
  const navigate = useCallback((next: Page, nextFocus: Focus = {}) => { setPage(next); setFocus(nextFocus) }, [])
  const chip = healthChip(state, serving)
  // Partial failures while the service itself answers: say which, never hide them.
  const partial = state?.connection.kind === 'ok' ? state.dataErrors : []

  return (
    <div className="grid h-full grid-cols-[216px_minmax(0,1fr)]">
      <Sidebar page={page} onNavigate={next => navigate(next)} limited={limitedCount(accounts)} />
      <main className="glass-content relative flex min-h-0 min-w-0 flex-col">
        <Toolbar title={pageTitles[page]} chip={chip} showWindow={windowed.includes(page)} />
        {state?.error ? <Banner tone="red" text={state.error} /> : partial.length ? <Banner tone="yellow" text={`${partial.length === 1 ? 'One data source is' : `${partial.length} data sources are`} unavailable: ${partial.join(' · ')}`} /> : null}
        <div className="min-h-0 flex-1">
          {page === 'today' ? <Today navigate={navigate} />
            : page === 'traffic' ? <Traffic navigate={navigate} focus={focus} />
            : page === 'cache' ? <Cache navigate={navigate} />
            : page === 'accounts' ? <Accounts navigate={navigate} />
            : page === 'logs' ? <Logs navigate={navigate} />
            : <Service section={focus.section} />}
        </div>
        {notice ? (
          <div role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('hairline absolute bottom-4 right-4 z-40 flex max-w-[420px] items-start gap-2 rounded-xl border-border bg-surface px-3 py-2 text-sm shadow-panel', notice.tone === 'error' && 'border-red/40')}>
            {notice.tone === 'error' ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-red" /> : null}
            <span className="min-w-0 flex-1 break-words">{notice.text}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}><X /></Button>
          </div>
        ) : null}
      </main>
      <LoginSheet />
    </div>
  )
}

function Banner({ tone, text }: { tone: 'red' | 'yellow'; text: string }) {
  return <div className={cn('hairline-b truncate border-border px-5 py-1.5 text-xs', tone === 'red' ? 'bg-red/10 text-red' : 'bg-yellow/10 text-yellow')} title={text}>{text}</div>
}
