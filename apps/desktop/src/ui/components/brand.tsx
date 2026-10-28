import { useId } from 'react'
import { cn } from '../lib/cn'
import type { AccountProvider } from '../model/accounts'

/** The Meridian mark: wireframe globe, prime meridian in the blue→violet brand gradient. */
export function Mark({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 64 64" className={cn('size-4', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="[stop-color:var(--accent)]" />
          <stop offset="1" className="[stop-color:var(--accent2)]" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="22" fill="none" className="stroke-text" strokeOpacity={0.3} strokeWidth={3} />
      <path d="M32 10 C 22 22, 22 42, 32 54" fill="none" stroke={`url(#${id})`} strokeWidth={4} strokeLinecap="round" />
      <circle cx="32" cy="10" r="4" className="fill-accent" />
      <circle cx="32" cy="54" r="4" className="fill-accent2" />
    </svg>
  )
}

/** Account avatar: the provider brand as a quiet tint (DESIGN §2: brands live on accounts only). */
export function Avatar({ id, provider, className }: { id: string; provider: AccountProvider; className?: string }) {
  return (
    <div aria-hidden className={cn(`brand-${provider} brand-avatar grid size-[30px] shrink-0 place-items-center rounded-lg text-base font-semibold leading-none`, className)}>
      {id.slice(0, 1).toUpperCase()}
    </div>
  )
}
