import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Action, DesktopState } from '../../contracts'

export interface Desktop {
  state: DesktopState | undefined;
  /** Wall clock, refreshed with every state and every 30 seconds. */
  now: number;
  /** Runs a named action; resolves to the new state, or undefined after reporting the error. */
  run(action: Action, value?: unknown): Promise<DesktopState | undefined>;
  /** The action this window is waiting on, if any. */
  pending: Action | null;
  /** True while this window or the service is busy with a mutation. */
  busy: boolean;
  notice: Notice | null;
  dismiss(): void;
  say(text: string, tone?: Notice['tone']): void;
}
export interface Notice { id: number; text: string; tone: 'error' | 'info' | 'success' }

const Context = createContext<Desktop | null>(null)

/** IPC wraps errors as "Error invoking remote method 'meridian:action': Error: …". */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error:\s*)+/, '')
}

export function DesktopProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>()
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState<Action | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const seq = useRef(0)
  const say = useCallback((text: string, tone: Notice['tone'] = 'info') => setNotice({ id: ++seq.current, text, tone }), [])

  useEffect(() => {
    let alive = true
    const update = (next: DesktopState) => { if (alive) { setState(next); setNow(Date.now()) } }
    const unsubscribe = window.meridian.subscribe(update)
    window.meridian.state().then(update).catch(error => say(`Could not load Meridian: ${cleanError(error)}`, 'error'))
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => { alive = false; unsubscribe(); clearInterval(timer) }
  }, [say])

  useEffect(() => {
    document.documentElement.classList.toggle('native-glass', state?.glass === 'Native Liquid Glass')
  }, [state?.glass])

  useEffect(() => {
    if (!notice || notice.tone === 'error') return
    const timer = setTimeout(() => setNotice(current => (current?.id === notice.id ? null : current)), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const run = useCallback(async (action: Action, value?: unknown) => {
    setPending(action)
    try {
      const next = await window.meridian.action(action, value)
      setState(next); setNow(Date.now())
      return next
    } catch (error) {
      say(cleanError(error), 'error')
      return undefined
    } finally { setPending(null) }
  }, [say])

  const value = useMemo<Desktop>(() => ({ state, now, run, pending, busy: Boolean(pending) || Boolean(state?.busy), notice, dismiss: () => setNotice(null), say }), [state, now, run, pending, notice, say])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useDesktop(): Desktop {
  const desktop = useContext(Context)
  if (!desktop) throw new Error('useDesktop outside DesktopProvider')
  return desktop
}
