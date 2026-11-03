import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Switch as SwitchPrimitive, Tabs as TabsPrimitive, ToggleGroup, Tooltip as TooltipPrimitive } from 'radix-ui'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'

const track = 'no-drag edge inline-flex rounded-lg bg-well p-0.5'
const segment = 'rounded-seg px-[11px] py-[3px] text-sm font-medium text-t3 transition-colors duration-150 hover:text-t1'

/** Native segmented control: well track with ring; the selected segment is raised. */
export function Segmented<T extends string>({ value, options, onChange, label, className, disabled }: { value: T; options: readonly { value: T; label: ReactNode; title?: string }[]; onChange(value: T): void; label: string; className?: string; disabled?: boolean }) {
  return (
    <ToggleGroup.Root type="single" value={value} aria-label={label} disabled={disabled}
      onValueChange={next => { if (next) onChange(next as T) }}
      className={cn(track, className)}>
      {options.map(option => (
        <ToggleGroup.Item key={option.value} value={option.value} title={option.title}
          className={cn(segment, 'data-[state=on]:bg-surface data-[state=on]:text-t1 data-[state=on]:press')}>
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}

export const Tabs = TabsPrimitive.Root
/** Tabs read as a segmented control, the macOS form for switching views. */
export function TabList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return <TabsPrimitive.List className={cn(track, 'self-start', className)} {...props} />
}
export function Tab({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return <TabsPrimitive.Trigger className={cn(segment, 'flex items-center gap-1.5 data-[state=active]:bg-surface data-[state=active]:text-t1 data-[state=active]:press', className)} {...props} />
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
          className="pop z-50 max-w-72 animate-fade rounded-md bg-surface px-2 py-1 text-xs leading-snug text-t1">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export function Switch({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root className={cn('no-drag edge-strong relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-well transition-colors duration-150 disabled:opacity-45 data-[state=checked]:bg-accent', className)} {...props}>
      <SwitchPrimitive.Thumb className="press block size-3.5 translate-x-0.5 rounded-full bg-surface transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
}

const field = 'no-drag edge h-6 w-full min-w-0 rounded-md bg-well px-2 text-sm text-t1 placeholder:text-t4 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-0'
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} spellCheck={false} className={cn(field, className)} {...props} />
))
Input.displayName = 'Input'
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} spellCheck={false} className={cn(field, 'h-auto py-1.5 font-mono text-xs text-t2', className)} {...props} />
))
Textarea.displayName = 'Textarea'

/** Native select: system menus are the macOS-native choice, and CSP-clean. Raised like a pop-up button. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <span className={cn('relative inline-flex min-w-0', className)}>
    <select ref={ref} className="no-drag press h-6 w-full min-w-0 appearance-none rounded-md bg-surface pl-2 pr-6 text-sm text-t1 disabled:opacity-50" {...props}>{children}</select>
    <ChevronDown aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
  </span>
))
Select.displayName = 'Select'

/** Shortcut hint: 10.5/500 t3 on a strong inset ring. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('edge-strong inline-block rounded-kbd px-[5px] py-0.5 font-sans text-2xs font-medium leading-none text-t3', className)}>{children}</kbd>
}

/** Inline literal (an environment variable, a command): mono, t2. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="selectable rounded-kbd bg-well px-1 py-px font-mono text-xs text-t2">{children}</code>
}
