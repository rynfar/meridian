import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Switch as SwitchPrimitive, Tabs as TabsPrimitive, ToggleGroup, Tooltip as TooltipPrimitive } from 'radix-ui'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'

/** macOS-style segmented control (1h · Today · 24h · 7d). */
export function Segmented<T extends string>({ value, options, onChange, label, className, disabled }: { value: T; options: readonly { value: T; label: ReactNode; title?: string }[]; onChange(value: T): void; label: string; className?: string; disabled?: boolean }) {
  return (
    <ToggleGroup.Root type="single" value={value} aria-label={label} disabled={disabled}
      onValueChange={next => { if (next) onChange(next as T) }}
      className={cn('no-drag hairline inline-flex overflow-hidden rounded-md border-control-border bg-control', className)}>
      {options.map(option => (
        <ToggleGroup.Item key={option.value} value={option.value} title={option.title}
          className="px-2.5 py-[3px] text-sm text-muted transition-colors hover:text-text data-[state=on]:bg-accent/16 data-[state=on]:font-semibold data-[state=on]:text-accent">
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}

export const Tabs = TabsPrimitive.Root
export function TabList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return <TabsPrimitive.List className={cn('hairline-b flex gap-5 border-border', className)} {...props} />
}
/** DESIGN tab: muted text, active = accent text + 2px accent underline. */
export function Tab({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return <TabsPrimitive.Trigger className={cn('-mb-px flex items-center gap-1.5 border-b-2 border-transparent pb-2 pt-1 text-sm font-medium text-muted hover:text-text data-[state=active]:border-accent data-[state=active]:text-accent', className)} {...props} />
}
export const TabPanel = TabsPrimitive.Content

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>{children}</TooltipPrimitive.Provider>
}
export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={5} collisionPadding={8}
          className="hairline z-50 max-w-72 rounded-md border-border bg-surface px-2 py-1 text-xs leading-snug text-text shadow-panel">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export function Switch({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root className={cn('no-drag hairline relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border-control-border bg-surface2 transition-colors disabled:opacity-45 data-[state=checked]:border-accent data-[state=checked]:bg-accent', className)} {...props}>
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-px rounded-full bg-surface shadow-card transition-transform data-[state=checked]:translate-x-[15px]" />
    </SwitchPrimitive.Root>
  )
}

const field = 'no-drag hairline h-7 w-full min-w-0 rounded-md border-control-border bg-control px-2 text-sm text-text placeholder:text-muted disabled:opacity-50 focus-visible:border-accent'
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} spellCheck={false} className={cn(field, className)} {...props} />
))
Input.displayName = 'Input'
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} spellCheck={false} className={cn(field, 'h-auto py-1.5 font-mono text-xs text-accent2', className)} {...props} />
))
Textarea.displayName = 'Textarea'

/** Native select: system menus are the macOS-native choice, and CSP-clean. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <span className={cn('relative inline-flex min-w-0', className)}>
    <select ref={ref} className={cn(field, 'appearance-none pr-6')} {...props}>{children}</select>
    <ChevronDown aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
  </span>
))
Select.displayName = 'Select'

export function Kbd({ children }: { children: ReactNode }) {
  return <code className="hairline rounded-sm border-border bg-bg px-1 py-px font-mono text-xs text-accent2">{children}</code>
}
