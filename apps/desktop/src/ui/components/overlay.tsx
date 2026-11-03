import { useEffect, useRef, type ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'
import { Button } from './button'

/**
 * Modal sheet on the native <dialog>: focus trapping, Escape and the backdrop
 * come from the platform, and nothing injects <style> (Radix Dialog's scroll
 * lock would, which the strict CSP blocks). Raised panel, floating shadow.
 */
export function Sheet({ open, onClose, title, description, children, footer, className }: { open: boolean; onClose(): void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog ref={ref} onCancel={event => { event.preventDefault(); onClose() }}
      className={cn('pop m-auto w-[440px] max-w-[calc(100vw-48px)] rounded-xl bg-surface p-0 text-t1 open:animate-pop', className)}>
      {open ? (
        <div className="flex max-h-[calc(100vh-80px)] flex-col">
          <div className="flex items-start gap-3 px-5 pb-2 pt-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold tracking-title">{title}</h2>
              {description ? <p className="mt-1 text-cap text-t3 [text-wrap:pretty]">{description}</p> : null}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><X /></Button>
          </div>
          <div className="scroll-y min-h-0 flex-1 px-5 py-3">{children}</div>
          {footer ? <div className="flex justify-end gap-2 px-5 pb-4 pt-2">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}

/** Non-modal dropdown (modal menus lock scroll by injecting a <style> tag). */
export function Menu({ trigger, children, align = 'end' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={4} collisionPadding={8}
          className="pop z-50 min-w-48 origin-[var(--radix-dropdown-menu-content-transform-origin)] animate-pop rounded-lg bg-surface p-1 text-base">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
export function MenuItem({ children, onSelect, disabled, danger }: { children: ReactNode; onSelect(): void; disabled?: boolean; danger?: boolean }) {
  return (
    <DropdownMenu.Item disabled={disabled} onSelect={onSelect}
      className={cn('flex h-6 items-center gap-2 rounded-seg px-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-surface [&_svg]:size-3.5 [&_svg]:text-t3 data-[highlighted]:[&_svg]:text-surface', danger ? 'text-red' : 'text-t1')}>
      {children}
    </DropdownMenu.Item>
  )
}
export function MenuSeparator() { return <DropdownMenu.Separator className="mx-2 my-1 h-px bg-ring" /> }
