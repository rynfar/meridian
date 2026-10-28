import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

/** DESIGN: control fill, blue text and border; hover is a blue tint. Never a solid primary. */
export const buttonVariants = cva(
  'no-drag inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hairline border-accent/50 bg-control text-accent hover:bg-accent/10',
        subtle: 'hairline border-control-border bg-control text-text hover:bg-surface2',
        ghost: 'text-muted hover:bg-accent/10 hover:text-accent',
        link: 'px-0 text-accent hover:underline',
        danger: 'hairline border-red/40 bg-control text-red hover:bg-red/10',
      },
      size: { xs: 'h-5 px-2 text-2xs', sm: 'h-6 px-2.5 text-sm', md: 'h-7 px-3 text-sm', icon: 'size-7', 'icon-sm': 'size-6' },
    },
    defaultVariants: { variant: 'default', size: 'sm' },
  },
)
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'
