import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The theme's custom text sizes must not be mistaken for text colours when merging.
const merge = extendTailwindMerge({
  extend: {
    theme: { text: ['3xs', '2xs', 'xs', 'meta', 'sm', 'cap', 'base', 'md', 'lg', 'xl', 'unit', '2xl', 'hero'], radius: ['xs', 'sm', 'kbd', 'seg', 'md', 'lg', 'xl', 'full'] },
  },
})
export function cn(...inputs: ClassValue[]) { return merge(clsx(inputs)) }
