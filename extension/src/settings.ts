import type { AppSettings } from './components/Settings/Settings';
import { DEFAULT_FRESHNESS } from './canvas/freshness';

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  baseUrl: '',
  model: 'gemini-3.5-flash-lite',
  embeddingModel: 'gemini-embedding-2',
  llmProvider: 'google',
  contextThreshold: 15000,
  freshness: { ...DEFAULT_FRESHNESS },
};

/** Where each provider's API lives when `baseUrl` is left empty. */
export const DEFAULT_BASE_URLS: Record<AppSettings['llmProvider'], string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * API root for the configured provider: the user's `baseUrl` (trailing slashes dropped) or the
 * provider default. Resolved at call time rather than stored, so switching providers never
 * carries the other provider's URL along.
 */
export function resolveBaseUrl(settings: AppSettings): string {
  const custom = (settings.baseUrl || '').trim().replace(/\/+$/, '');
  return custom || DEFAULT_BASE_URLS[settings.llmProvider];
}

/** Merge a possibly-old persisted settings object over the defaults. */
export function normalizeSettings(parsed: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(parsed || {}),
    freshness: { ...DEFAULT_FRESHNESS, ...(parsed?.freshness || {}) },
  };
}
