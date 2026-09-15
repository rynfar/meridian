import { object } from './core'
export interface NativeGlass {
  isGlassSupported(): boolean
  addView(handle: Buffer, options: { cornerRadius?: number; opaque?: boolean }): number
}
function isNativeGlass(value: unknown): value is NativeGlass {
  const candidate = object(value)
  return typeof candidate.isGlassSupported === 'function' && typeof candidate.addView === 'function'
}
export async function loadNativeGlass(): Promise<NativeGlass | undefined> {
  if (process.platform !== 'darwin') return undefined
  // The optional macOS-only package is intentionally absent on other systems.
  // Keep this import dynamic, including for the TypeScript/Linux build.
  const packageName = 'electron-liquid-glass'
  const loaded: unknown = await import(packageName)
  const candidate = object(loaded).default
  if (!isNativeGlass(candidate)) throw new Error('Unexpected native glass module interface.')
  return candidate.isGlassSupported() ? candidate : undefined
}
