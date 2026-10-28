import { ArrowLeftRight, Clock3, Cog, Database, ScrollText, Users } from 'lucide-react'
import type { ComponentType } from 'react'
import { useDesktop } from '../lib/desktop'
import { cn } from '../lib/cn'
import { Mark } from '../components/brand'
import { Dot } from '../components/pill'
import { fmtInt, pct } from '../model/format'
import { promptShare } from '../model/prompt'
import { instanceLines } from '../model/status'
import { pageShortcut, pageTitles, pages, type Page } from './nav'
import { number, object } from '../../core'

const icons: Record<Page, ComponentType<{ className?: string; strokeWidth?: number }>> = { today: Clock3, traffic: ArrowLeftRight, cache: Database, accounts: Users, logs: ScrollText, service: Cog }

export function Sidebar({ page, onNavigate, limited }: { page: Page; onNavigate(page: Page): void; limited: number }) {
  const { state } = useDesktop()
  const ok = state?.connection.kind === 'ok'
  const requests = number(object(state?.summary).totalRequests)
  // Same definition as the Today hero and the menu-bar tile: token-weighted.
  const share = promptShare(state?.summary).share
  const footer = instanceLines(state)
  const alerts = state?.incidents.length ?? 0
  const aux: Partial<Record<Page, { text: string; className?: string; dot?: 'yellow' | 'red' }>> = {}
  if (ok && requests !== undefined) aux.traffic = { text: fmtInt(requests) }
  if (ok && share !== null) aux.cache = { text: pct(share), className: 'text-cache' }
  if (limited) aux.accounts = { text: String(limited), dot: 'yellow' }
  if (alerts) aux.logs = { text: String(alerts), dot: 'yellow' }
  if (state && state.connection.kind !== 'ok' && state.instance) aux.service = { text: '', dot: state.connection.kind === 'starting' ? 'yellow' : 'red' }

  return (
    <aside className="glass-sidebar rule-r flex min-h-0 flex-col px-2.5 pb-3.5">
      {/* Native traffic lights sit here (trafficLightPosition 20,20); the strip drags the window. */}
      <div className="drag h-[50px] shrink-0" />
      <div className="drag flex items-center gap-2 px-2 pb-4 text-2xs font-bold leading-none tracking-brand text-t2"><Mark />MERIDIAN</div>
      <nav aria-label="Main" className="flex flex-col gap-px">
        {pages.map(id => {
          const Icon = icons[id]
          const active = page === id
          const badge = aux[id]
          return (
            <button key={id} type="button" onClick={() => onNavigate(id)} aria-current={active ? 'page' : undefined}
              aria-keyshortcuts={`Meta+${pages.indexOf(id) + 1}`} title={`${pageTitles[id]}  ${pageShortcut[id]}`}
              className={cn('no-drag flex h-7 items-center gap-[9px] rounded-md px-[9px] text-left text-base font-medium transition-colors duration-150', active ? 'lift bg-surface text-t1' : 'text-t2 hover:bg-hover')}>
              <Icon className={cn('size-[15px]', active ? 'text-t1' : 'text-t3')} strokeWidth={1.6} />
              <span className="flex-1">{pageTitles[id]}</span>
              {badge ? <span className={cn('num flex items-center gap-[5px] text-meta text-t4', badge.className)}>{badge.dot ? <Dot tone={badge.dot} size={6} /> : null}{badge.text}</span> : null}
            </button>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 px-[9px] text-xs text-t3">
        <span className="font-medium leading-snug text-t2">{footer.title}</span>
        {footer.detail ? <span className="num truncate" title={state?.instance?.detectedFrom}>{footer.detail}</span> : null}
        {footer.version ? <span>{footer.version}</span> : null}
      </div>
    </aside>
  )
}
