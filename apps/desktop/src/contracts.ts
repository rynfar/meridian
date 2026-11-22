import type { CatalogRelease } from './pluginCatalog'
import type { ConnectionStatus, Incident, Preferences, WindowKind } from './core'
import type { Supervisor } from './detect'
import type { Timeseries } from './uiData'
export type { ConnectionKind, ConnectionStatus, WindowKind } from './core'
export type { Supervisor, SupervisorKind } from './detect'
export type { Timeseries, TimeseriesBucket } from './uiData'

/** The Meridian whose data the app is showing. */
export interface InstanceInfo {
  baseUrl: string; port: number;
  /** From /health; null while it cannot be read. */
  version: string | null;
  supervisor: Supervisor;
  /** When the app started viewing this base URL (epoch ms). */
  attachedAt: number;
  /** e.g. "launchd: com.rynfar.meridian", "opencode: opencode.json provider anthropic", "app-managed". */
  detectedFrom: string;
}
export interface TimeWindow { kind: WindowKind }
export interface DetectionReport {
  at: number;
  /** What detection decided and why, for the Service view. */
  note: string;
  services: { baseUrl: string; port: number; sources: string[]; status: 'meridian' | 'not-meridian' | 'unreachable'; version?: string; supervisor: Supervisor; pid?: number; own: boolean }[];
  rejected: { source: string; detail: string; url: string; reason: string }[];
}
/** /settings/api/* sections the web settings page reads, by section name. */
export type SettingsSection = 'routing' | 'telemetry' | 'transcripts' | 'updates' | 'header' | 'layout' | 'claude-executable' | 'pricing' | 'chatgpt'
/** Sections writable through `update-settings` (PUT, or PATCH for chatgpt). */
export type WritableSettingsSection = Exclude<SettingsSection, 'pricing'>
export interface ServerSettings {
  fetchedAt?: number;
  /** Raw GET bodies; null when the section could not be read. */
  values: Partial<Record<SettingsSection, unknown>>;
  /** Sections this Meridian does not serve (HTTP 404, e.g. older versions or Antigravity). */
  unavailable: SettingsSection[];
  errors: string[];
}
export interface LoginState {
  profile: string; phase: 'starting' | 'waiting' | 'verifying' | 'cancelling' | 'success' | 'error' | 'cancelled'; output: string; url?: string;
  /** claude (default) or a ChatGPT seat. */
  provider?: 'claude' | 'chatgpt';
  /** cli: the managed CLI; http: the viewed server's /profiles routes. */
  via?: 'cli' | 'http';
  /** ChatGPT device sign-in: the one-time code to enter at `url`. */
  userCode?: string;
}
export interface DesktopState {
  desktopVersion: string; platform: string; glass: string; preferences: Omit<Preferences, 'apiKey'>; hasApiKey: boolean;
  installed: string[]; available: string[]; latest?: string; running?: string; owned: boolean; busy?: string; error?: string;
  /** Data reads; `requests` is null (not []) when the read failed — never render that as "no requests". */
  health: unknown; quota: unknown; requests: unknown; summary: unknown; logs: unknown; profiles: unknown; plugins: unknown; features: unknown; routesSummary?: unknown; retention?: unknown;
  providers?: import('../../../src/telemetry/providerView').ProviderSnapshot;
  catalog?: CatalogRelease[];
  loginAtStartup?: boolean; notificationStatus?: string;
  migration?: { label: string; canAdopt: boolean; adopted: boolean };
  /** Typed state of the viewed service; render this instead of empty tables. */
  connection: ConnectionStatus;
  instance: InstanceInfo | null;
  detection?: DetectionReport;
  window: TimeWindow;
  /** Server buckets for `window`. null + timeseriesNote: unsupported/failed (use bucketRequests). null without a note: loading. */
  timeseries: Timeseries | null;
  timeseriesNote?: string;
  settings: ServerSettings;
  /** Secondary per-endpoint failures (a single route failing while the service is up). */
  dataErrors: string[];
  incidents: Incident[]; serviceLog: string[]; lastChecked?: number; login?: LoginState;
}
export type Action = 'copy-profile-login' | 'copy-profile-remove' | 'copy-client-setup' | 'resize-panel' | 'open-desktop' | 'close-panel' | 'quit-app' | 'toggle-snooze' | 'test-notification' | 'refresh' | 'check-updates' | 'install' | 'activate' | 'start' | 'stop' | 'restart' | 'save-preferences' | 'switch-profile' | 'rename-profile' | 'add-profile' | 'login-profile' | 'login-code' | 'reload-plugins' | 'check-plugins' | 'install-plugin' | 'set-features' | 'open-page' | 'release-notes' | 'export-diagnostics' | 'acknowledge' | 'login-at-startup' | 'take-ownership' | 'return-headless' | 'open-login'
  | 'set-window' | 'redetect' | 'remove-profile' | 'reorder-profiles' | 'chatgpt-connect' | 'chatgpt-refresh'
  | 'refresh-settings' | 'update-settings' | 'reset-settings' | 'set-pricing' | 'delete-pricing' | 'reset-features'
export interface DesktopApi { state(): Promise<DesktopState>; action(action: Action, value?: unknown): Promise<DesktopState>; subscribe(callback: (state: DesktopState) => void): () => void }
declare global { interface Window { meridian: DesktopApi } }
