import type { CatalogRelease } from './pluginCatalog'
import type { Incident, Preferences } from './core'
export interface DesktopState {
  desktopVersion: string; platform: string; glass: string; preferences: Omit<Preferences, 'apiKey'>; hasApiKey: boolean;
  installed: string[]; available: string[]; latest?: string; running?: string; owned: boolean; busy?: string; error?: string;
  health: unknown; quota: unknown; requests: unknown; summary: unknown; logs: unknown; profiles: unknown; plugins: unknown; features: unknown; routesSummary?: unknown; retention?: unknown;
  providers?: import('../../../src/telemetry/providerView').ProviderSnapshot;
  catalog?: CatalogRelease[];
  loginAtStartup?: boolean; notificationStatus?: string;
  migration?: { label: string; canAdopt: boolean; adopted: boolean }; dataErrors: string[]; incidents: Incident[]; serviceLog: string[]; lastChecked?: number; login?: { output: string; url?: string };
}
export type Action = 'resize-panel' | 'open-desktop' | 'close-panel' | 'quit-app' | 'toggle-snooze' | 'test-notification' | 'refresh' | 'check-updates' | 'install' | 'activate' | 'start' | 'stop' | 'restart' | 'save-preferences' | 'switch-profile' | 'rename-profile' | 'add-profile' | 'login-profile' | 'login-code' | 'reload-plugins' | 'check-plugins' | 'install-plugin' | 'set-features' | 'open-page' | 'release-notes' | 'export-diagnostics' | 'acknowledge' | 'login-at-startup' | 'take-ownership' | 'return-headless' | 'open-login'
export interface DesktopApi { state(): Promise<DesktopState>; action(action: Action, value?: unknown): Promise<DesktopState>; subscribe(callback: (state: DesktopState) => void): () => void }
declare global { interface Window { meridian: DesktopApi } }
