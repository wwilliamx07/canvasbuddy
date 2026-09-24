import type { AppSettings } from '../settings';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { openAIChatAdapter } from './openaiChat';
import { openAIResponsesAdapter } from './openaiResponses';
import type { AdapterId, ProviderAdapter, ProviderEndpoint, ProviderId } from './types';

/**
 * The services a student can pick, and the adapter each one speaks. Adding an OpenAI-compatible
 * service is one entry here; a new wire protocol is a new adapter plus an entry.
 */

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  adapter: AdapterId;
  /** Empty for `custom`, which needs a base URL. */
  defaultBaseUrl: string;
  keyRequired: boolean;
  /** A non-blocking hint when the key does not look like this provider's. */
  keyPrefix?: string;
  /** Offers an embeddings endpoint that can return 768-dimensional vectors. */
  embeddings: boolean;
  chatPlaceholder: string;
  embedPlaceholder?: string;
  /** Runs on the student's machine (http://localhost). */
  local?: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'google', label: 'Google Gemini', adapter: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true, keyPrefix: 'AIza', embeddings: true, chatPlaceholder: 'gemini-3.5-flash-lite', embedPlaceholder: 'gemini-embedding-2' },
  { id: 'openai', label: 'OpenAI', adapter: 'openai-responses', defaultBaseUrl: 'https://api.openai.com/v1', keyRequired: true, keyPrefix: 'sk-', embeddings: true, chatPlaceholder: 'gpt-5-mini', embedPlaceholder: 'text-embedding-3-small' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', keyRequired: true, keyPrefix: 'sk-ant-', embeddings: false, chatPlaceholder: 'claude-sonnet-4-5' },
  { id: 'openrouter', label: 'OpenRouter', adapter: 'openai-chat', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, keyPrefix: 'sk-or-', embeddings: false, chatPlaceholder: 'google/gemini-2.5-flash' },
  { id: 'groq', label: 'Groq', adapter: 'openai-chat', defaultBaseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, keyPrefix: 'gsk_', embeddings: false, chatPlaceholder: 'llama-3.3-70b-versatile' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai-chat', defaultBaseUrl: 'https://api.deepseek.com/v1', keyRequired: true, keyPrefix: 'sk-', embeddings: false, chatPlaceholder: 'deepseek-chat' },
  { id: 'ollama', label: 'Ollama (local)', adapter: 'openai-chat', defaultBaseUrl: 'http://localhost:11434/v1', keyRequired: false, embeddings: true, chatPlaceholder: 'qwen3:8b', embedPlaceholder: 'nomic-embed-text', local: true },
  { id: 'lmstudio', label: 'LM Studio (local)', adapter: 'openai-chat', defaultBaseUrl: 'http://localhost:1234/v1', keyRequired: false, embeddings: true, chatPlaceholder: 'the loaded model id', embedPlaceholder: 'text-embedding-nomic-embed-text-v1.5', local: true },
  { id: 'custom', label: 'Other OpenAI-compatible', adapter: 'openai-chat', defaultBaseUrl: '', keyRequired: false, embeddings: true, chatPlaceholder: 'model id' },
];

const ADAPTERS: Record<AdapterId, ProviderAdapter> = {
  gemini: geminiAdapter,
  'openai-chat': openAIChatAdapter,
  'openai-responses': openAIResponsesAdapter,
  anthropic: anthropicAdapter,
};

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function adapterFor(id: ProviderId): ProviderAdapter {
  return ADAPTERS[providerInfo(id).adapter];
}

/** Base URL for a provider: the student's override (trailing slashes dropped) or the default. */
export function baseUrlFor(settings: AppSettings, id: ProviderId): string {
  const custom = (settings.providers[id]?.baseUrl || '').trim().replace(/\/+$/, '');
  return custom || providerInfo(id).defaultBaseUrl;
}

/** Where a role's requests go, or an error the student can act on. */
export function endpointFor(settings: AppSettings, role: 'chat' | 'embedding'): ProviderEndpoint {
  const provider = settings[role].provider;
  const info = providerInfo(provider);
  const apiKey = (settings.providers[provider]?.apiKey || '').trim();
  const baseUrl = baseUrlFor(settings, provider);
  const what = role === 'chat' ? 'chat' : 'embeddings';
  if (!baseUrl) throw new Error(`Set the base URL for ${info.label} in Settings to use it for ${what}.`);
  if (info.keyRequired && !apiKey) throw new Error(`Add your ${info.label} API key in Settings to use it for ${what}.`);
  if (role === 'embedding' && !info.embeddings) throw new Error(`${info.label} has no embeddings API; choose another embeddings provider in Settings.`);
  return { provider, baseUrl, apiKey };
}

/**
 * Host permissions the chosen providers need. Hosted providers answer CORS for any origin; a local
 * server (Ollama, LM Studio) or an arbitrary OpenAI-compatible one may not, and an extension page
 * with the host permission is exempt from CORS. Match patterns ignore the port.
 */
export function accessOriginsFor(settings: AppSettings): string[] {
  const origins = new Set<string>();
  for (const role of ['chat', 'embedding'] as const) {
    const id = settings[role].provider;
    if (!providerInfo(id).local && id !== 'custom') continue;
    let url: URL;
    try {
      url = new URL(baseUrlFor(settings, id));
    } catch {
      continue;
    }
    // The manifest can only offer https anywhere, plus plain http on this machine
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) origins.add(`${url.protocol}//${url.hostname}/*`);
  }
  return [...origins];
}
