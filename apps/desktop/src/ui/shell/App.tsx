import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { useModels } from '../lib/models'
import { cn } from '../lib/cn'
import { Button } from '../components/button'
import { Glyph } from '../components/glyph'
import { limitedCount } from '../model/accounts'
import { healthChip } from '../model/status'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { LoginSheet } from './LoginSheet'
import { pageTitles, shortcutFor, windowed, type Focus, type Page } from './nav'
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

  // ⌘1–⌘6 open the screens. ⌘R belongs to the application menu's "Refresh
  // data" (main.ts): left unhandled here, so it reaches the menu whichever
  // sees the key first, and refreshes exactly once.
  useEffect(() => {
    const mac = state?.platform ? state.platform === 'darwin' : true
    const onKey = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event, mac)
      if (shortcut?.kind !== 'page') return
      event.preventDefault()
      navigate(shortcut.page)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, state?.platform])

  return (
    <div className="grid h-full grid-cols-[216px_minmax(0,1fr)]">
      <Sidebar page={page} onNavigate={next => navigate(next)} limited={limitedCount(accounts)} />
      <main className="glass-content relative flex min-h-0 min-w-0 flex-col bg-bg">
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
          <div role={notice.tone === 'error' ? 'alert' : 'status'} className="pop absolute bottom-4 right-4 z-40 flex max-w-[420px] animate-pop items-start gap-2 rounded-xl bg-surface py-2 pl-3 pr-2 text-cap">
            {notice.tone === 'error' ? <Glyph kind="bad" className="mt-[3px]" /> : notice.tone === 'success' ? <Glyph kind="ok" className="mt-[3px]" /> : null}
            <span className="min-w-0 flex-1 break-words text-t1">{notice.text}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}><X /></Button>
          </div>
        ) : null}
      </main>
      <LoginSheet />
    </div>
  )
}

/** A data problem above the screen: glyph and coloured text on the canvas, never a tinted band. */
function Banner({ tone, text }: { tone: 'red' | 'yellow'; text: string }) {
  return (
    <div role="status" className="rule-b flex items-center gap-2 px-[22px] py-1.5 text-meta" title={text}>
      <Glyph kind={tone === 'red' ? 'bad' : 'warn'} />
      <span className={cn('truncate', tone === 'red' ? 'text-red' : 'text-yellow')}>{text}</span>
    </div>
  )
}
