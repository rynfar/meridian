import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

/**
 * macOS push buttons: a raised surface with the strong ring, blue text for
 * the action a section is for, t1 for the rest. `text` is a plain text
 * button (Use, Sign in, Open Traffic); never a solid primary.
 */
export const buttonVariants = cva(
  'no-drag inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'press bg-surface text-accent hover:bg-surface2',
        subtle: 'press bg-surface text-t1 hover:bg-surface2',
        ghost: 'text-t3 hover:bg-hover hover:text-t1',
        text: 'px-0 text-accent hover:opacity-80 active:scale-100',
        link: 'px-0 text-accent hover:underline active:scale-100',
        danger: 'press bg-surface text-red hover:bg-surface2',
      },
      size: { xs: 'h-5 px-2 text-xs', sm: 'h-6 px-2.5 text-sm', md: 'h-7 px-3 text-sm', icon: 'size-[26px]', 'icon-sm': 'size-6' },
    },
    compoundVariants: [
      { variant: 'text', size: ['xs', 'sm', 'md'], className: 'h-auto px-0' },
      { variant: 'link', size: ['xs', 'sm', 'md'], className: 'h-auto px-0' },
    ],
    defaultVariants: { variant: 'default', size: 'sm' },
  },
)
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'
