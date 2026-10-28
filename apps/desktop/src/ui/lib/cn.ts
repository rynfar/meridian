import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The theme's custom text sizes must not be mistaken for text colours when merging.
const merge = extendTailwindMerge({
  extend: {
    theme: { text: ['3xs', '2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', 'hero'] },
  },
})
export function cn(...inputs: ClassValue[]) { return merge(clsx(inputs)) }
