import { useEffect, useRef, type ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'
import { Button } from './button'

/**
 * Modal sheet on the native <dialog>: focus trapping, Escape and the backdrop
 * come from the platform, and nothing injects <style> (Radix Dialog's scroll
 * lock would, which the strict CSP blocks).
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
      className={cn('hairline m-auto w-[440px] max-w-[calc(100vw-48px)] rounded-2xl border-border bg-surface p-0 text-text shadow-panel', className)}>
      {open ? (
        <div className="flex max-h-[calc(100vh-80px)] flex-col">
          <div className="hairline-b flex items-start gap-3 border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-md font-semibold">{title}</h2>
              {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><X /></Button>
          </div>
          <div className="scroll-y min-h-0 flex-1 px-5 py-4">{children}</div>
          {footer ? <div className="hairline-t flex justify-end gap-2 border-border px-5 py-3">{footer}</div> : null}
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
          className="hairline z-50 min-w-44 rounded-lg border-border bg-surface p-1 text-sm shadow-panel">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
export function MenuItem({ children, onSelect, disabled, danger }: { children: ReactNode; onSelect(): void; disabled?: boolean; danger?: boolean }) {
  return (
    <DropdownMenu.Item disabled={disabled} onSelect={onSelect}
      className={cn('flex items-center gap-2 rounded-md px-2 py-1 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent/12 [&_svg]:size-3.5', danger ? 'text-red data-[highlighted]:bg-red/10' : 'text-text data-[highlighted]:text-accent')}>
      {children}
    </DropdownMenu.Item>
  )
}
export function MenuSeparator() { return <DropdownMenu.Separator className="hairline-t my-1 border-border" /> }
