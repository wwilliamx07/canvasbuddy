import { DEFAULT_FRESHNESS, type FreshnessSettings } from './canvas/freshness';
import type { ProviderId } from './providers/types';

/** A key (and optional base URL override) per provider; chat and embeddings each pick a provider. */
export interface ProviderSettings {
  apiKey: string;
  /** Empty = the provider's default (`providers/registry.ts`). Required for `custom`. */
  baseUrl?: string;
}

export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

export interface AppSettings {
  providers: Partial<Record<ProviderId, ProviderSettings>>;
  chat: ModelChoice;
  /** Must produce 768-dimensional vectors (the schema's `VECTOR(768)`). */
  embedding: ModelChoice;
  contextThreshold: number;
  /** Request the model's thoughts and show them in the run's steps. */
  showReasoning: boolean;
  /** Rounds of tool calls a turn makes without an answer before asking the student whether to keep going. */
  toolRoundsBeforeAsking: number;
  /** Lazy connection tools: most tools a chat keeps loaded (declared on every call). */
  loadedToolsMax: number;
  /** Lazy connection tools: most estimated tokens of loaded tool definitions per call. */
  loadedToolsTokenBudget: number;
  /** Per-collection max ages in minutes; missing keys fall back to DEFAULT_FRESHNESS. */
  freshness?: Partial<FreshnessSettings>;
  /** The connected Canvas host ("q.utoronto.ca"); empty until the Connect screen succeeds. */
  canvasHost?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  providers: {},
  chat: { provider: 'google', model: 'gemini-3.5-flash-lite' },
  embedding: { provider: 'google', model: 'gemini-embedding-2' },
  contextThreshold: 15000,
  showReasoning: false,
  toolRoundsBeforeAsking: 12,
  loadedToolsMax: 8,
  loadedToolsTokenBudget: 6000,
  freshness: { ...DEFAULT_FRESHNESS },
};

/** The flat shape settings had before providers were split by role. */
interface LegacySettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  embeddingModel?: string;
  llmProvider?: 'openai' | 'google';
}

/**
 * The old flat fields as the new shape. An OpenAI key with a custom base URL was an
 * OpenAI-compatible service, which now has its own provider (`custom`), since OpenAI itself moved
 * to the Responses API.
 */
function fromLegacy(old: LegacySettings): Pick<AppSettings, 'providers' | 'chat' | 'embedding'> {
  const baseUrl = (old.baseUrl || '').trim();
  const provider: ProviderId = old.llmProvider === 'openai' ? (baseUrl ? 'custom' : 'openai') : 'google';
  const embeddingDefault = provider === 'google' ? 'gemini-embedding-2' : 'text-embedding-3-small';
  return {
    providers: old.apiKey || baseUrl ? { [provider]: { apiKey: old.apiKey || '', ...(baseUrl ? { baseUrl } : {}) } } : {},
    chat: { provider, model: old.model || (provider === 'google' ? DEFAULT_SETTINGS.chat.model : '') },
    embedding: { provider, model: old.embeddingModel || embeddingDefault },
  };
}

/** Merge a possibly-old persisted settings object over the defaults. */
export function normalizeSettings(parsed: (Partial<AppSettings> & LegacySettings) | null | undefined): AppSettings {
  const input = parsed || {};
  const isLegacy = !input.chat && (input.llmProvider !== undefined || input.apiKey !== undefined || input.model !== undefined);
  const legacy = isLegacy ? fromLegacy(input) : null;
  const { apiKey: _apiKey, baseUrl: _baseUrl, model: _model, embeddingModel: _embeddingModel, llmProvider: _llmProvider, ...rest } = input;
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    providers: { ...(legacy?.providers ?? input.providers ?? {}) },
    chat: { ...DEFAULT_SETTINGS.chat, ...(legacy?.chat ?? input.chat ?? {}) },
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(legacy?.embedding ?? input.embedding ?? {}) },
    freshness: { ...DEFAULT_FRESHNESS, ...(input.freshness || {}) },
  };
}
