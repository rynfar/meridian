import { ArrowLeftRight, Clock3, Cog, Database, ScrollText, Users } from 'lucide-react'
import type { ComponentType } from 'react'
import { useDesktop } from '../lib/desktop'
import { cn } from '../lib/cn'
import { Mark } from '../components/brand'
import { Dot } from '../components/pill'
import { fmtInt, pct } from '../model/format'
import { instanceLines } from '../model/status'
import { pageTitles, pages, type Page } from './nav'
import { number, object } from '../../core'

const icons: Record<Page, ComponentType<{ className?: string; strokeWidth?: number }>> = { today: Clock3, traffic: ArrowLeftRight, cache: Database, accounts: Users, logs: ScrollText, service: Cog }

export function Sidebar({ page, onNavigate, limited }: { page: Page; onNavigate(page: Page): void; limited: number }) {
  const { state } = useDesktop()
  const summary = object(state?.summary)
  const ok = state?.connection.kind === 'ok'
  const requests = number(summary.totalRequests)
  const hit = requests ? number(object(summary.tokenUsage).avgCacheHitRate) : undefined
  const footer = instanceLines(state)
  const alerts = state?.incidents.length ?? 0
  const badge: Partial<Record<Page, { text: string; className: string }>> = {}
  if (ok && requests !== undefined) badge.traffic = { text: fmtInt(requests), className: 'text-muted' }
  if (ok && hit !== undefined) badge.cache = { text: pct(hit), className: 'text-accent2' }
  if (limited) badge.accounts = { text: `${limited} limited`, className: 'rounded-full bg-red/16 px-1.5 font-semibold text-red' }
  if (alerts) badge.logs = { text: String(alerts), className: 'rounded-full bg-yellow/16 px-1.5 font-semibold text-yellow' }

  return (
    <aside className="glass-sidebar hairline-r flex min-h-0 flex-col border-border px-2.5 pb-2.5">
      {/* Native traffic lights sit here (trafficLightPosition 20,20); the strip drags the window. */}
      <div className="drag h-[46px] shrink-0" />
      <div className="drag flex items-center gap-2 px-2 pb-3.5 text-xs font-bold tracking-wider"><Mark />MERIDIAN</div>
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {pages.map(id => {
          const Icon = icons[id]
          const active = page === id
          return (
            <button key={id} type="button" onClick={() => onNavigate(id)} aria-current={active ? 'page' : undefined}
              className={cn('no-drag flex items-center gap-2.5 rounded-lg px-2.5 py-[5px] text-left text-base font-medium', active ? 'bg-accent/16 text-accent' : 'text-text hover:bg-accent/8')}>
              <Icon className={cn('size-4', active ? 'text-accent' : 'text-muted')} strokeWidth={1.8} />
              <span className="flex-1">{pageTitles[id]}</span>
              {id === 'service' && state && state.connection.kind !== 'ok' && state.instance ? <Dot tone={state.connection.kind === 'starting' ? 'yellow' : 'red'} /> : null}
              {badge[id] ? <span className={cn('num text-2xs', badge[id].className)}>{badge[id].text}</span> : null}
            </button>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 px-2.5 pb-1 text-xs text-muted">
        <span className="leading-snug">{footer.title}</span>
        {footer.detail ? <span className="truncate font-mono text-2xs" title={state?.instance?.detectedFrom}>{footer.detail}</span> : null}
        {footer.version ? <span>{footer.version}</span> : null}
      </div>
    </aside>
  )
}
