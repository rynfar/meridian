import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Empty } from '../../components/state'
import type { DesktopState, SettingsSection } from '../../../contracts'

/** Section heading for one Service panel. */
export function PanelHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold tracking-title text-t1">{title}</h2>
        {description ? <p className="mt-1 max-w-[620px] text-cap leading-relaxed text-t3 [text-wrap:pretty]">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  )
}

/** macOS Settings row: label left, control right; help text t3 beneath, status t4, environment notes in warn. */
export function SettingRow({ label, htmlFor, control, description, status, env, className }: { label: ReactNode; htmlFor?: string; control?: ReactNode; description?: ReactNode; status?: ReactNode[]; env?: string | null; className?: string }) {
  return (
    <div className={cn('px-4 py-2.5', className)}>
      <div className="flex min-h-6 items-center gap-4">
        <label htmlFor={htmlFor} className="min-w-0 flex-1 text-base text-t1">{label}</label>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {description ? <p className="mt-0.5 max-w-[580px] text-sm leading-relaxed text-t3 [text-wrap:pretty]">{description}</p> : null}
      {status?.filter(Boolean).map((line, index) => <p key={index} className="num mt-0.5 text-xs text-t4">{line}</p>)}
      {env ? <p className="mt-0.5 text-xs text-yellow">{env}</p> : null}
    </div>
  )
}

/** A grouped inset panel of rows, with an optional section label above it. */
export function Group({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={cn('mb-6', className)}>
      {title ? <div className="mb-1.5 px-1 text-sm font-medium text-t2">{title}</div> : null}
      <div className="lift separated overflow-hidden rounded-xl bg-surface">{children}</div>
    </div>
  )
}

/** Definition row inside a Group. */
export function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-[34px] items-baseline gap-4 px-4 py-2 text-base">
      <span className="w-40 shrink-0 text-t3">{label}</span>
      <span className={cn('min-w-0 flex-1 break-words text-t1', mono && 'selectable font-mono text-xs')}>{children}</span>
    </div>
  )
}

/** A server settings section's body, or why it cannot be shown. */
export function readSection(state: DesktopState, section: SettingsSection): { value: Record<string, unknown> | null; problem: ReactNode | null } {
  if (state.settings.unavailable.includes(section)) return { value: null, problem: <Empty title="Not available on this Meridian" detail={`Meridian ${state.running ?? ''} does not serve these settings. Update it to change them here.`} /> }
  const raw = state.settings.values[section]
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw as Record<string, unknown>, problem: null }
  if (state.connection.kind !== 'ok') return { value: null, problem: <Empty title="Not connected" detail="Server settings appear once Meridian can be read." /> }
  const error = state.settings.errors.find(item => item.toLowerCase().includes(section))
  return { value: null, problem: <Empty title="Could not read these settings" detail={error ?? 'Choose Refresh settings to try again.'} /> }
}

/** "In use: …" for 1.86's boolean envOverride map, and envOverrideText for newer envSources. */
export function envNote(flag: unknown): string | null {
  return flag === true ? 'Set by an environment variable on the service; the saved setting is ignored.' : null
}
