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

/** Merge a possibly-old persisted settings object over the defaults. */
export function normalizeSettings(parsed: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(parsed || {}),
    freshness: { ...DEFAULT_FRESHNESS, ...(parsed?.freshness || {}) },
  };
}
