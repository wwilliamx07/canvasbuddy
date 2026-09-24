import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessOriginsFor, adapterFor, baseUrlFor, endpointFor, PROVIDERS } from '../../src/providers/registry';
import { isKnown768Embedding, modelInfo } from '../../src/providers/models';
import { callModel, embedTexts } from '../../src/providers';
import { normalizeSettings, type AppSettings } from '../../src/settings';
import { captureFetch, geminiChunk, geminiStream } from '../helpers/llm';

afterEach(() => vi.unstubAllGlobals());

const settings = (over: Partial<AppSettings>) => normalizeSettings(over);

describe('registry', () => {
  it('every provider has an adapter, and only custom lacks a default base URL', () => {
    for (const p of PROVIDERS) {
      expect(adapterFor(p.id).id).toBe(p.adapter);
      expect(Boolean(p.defaultBaseUrl)).toBe(p.id !== 'custom');
    }
  });

  it('a base URL override wins, without trailing slashes', () => {
    const s = settings({ providers: { openai: { apiKey: 'k', baseUrl: ' https://proxy.test/v1// ' } } });
    expect(baseUrlFor(s, 'openai')).toBe('https://proxy.test/v1');
    expect(baseUrlFor(s, 'google')).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('endpointFor names what is missing', () => {
    expect(() => endpointFor(settings({}), 'chat')).toThrow('Add your Google Gemini API key in Settings to use it for chat.');
    expect(() => endpointFor(settings({ chat: { provider: 'custom', model: 'm' } }), 'chat')).toThrow('Set the base URL for Other OpenAI-compatible in Settings');
    expect(() => endpointFor(settings({ providers: { anthropic: { apiKey: 'k' } }, embedding: { provider: 'anthropic', model: 'x' } }), 'embedding')).toThrow(
      'Anthropic has no embeddings API'
    );
  });

  it('local providers need no key', () => {
    expect(endpointFor(settings({ chat: { provider: 'ollama', model: 'qwen3:8b' } }), 'chat')).toEqual({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' });
  });

  it('access is needed only for local and custom providers, as port-less patterns', () => {
    expect(accessOriginsFor(settings({}))).toEqual([]);
    expect(accessOriginsFor(settings({ chat: { provider: 'ollama', model: 'm' }, embedding: { provider: 'lmstudio', model: 'e' } }))).toEqual(['http://localhost/*']);
    expect(
      accessOriginsFor(settings({ providers: { custom: { apiKey: '', baseUrl: 'https://llm.example.edu:8443/v1' } }, chat: { provider: 'custom', model: 'm' } }))
    ).toEqual(['https://llm.example.edu/*']);
    // plain http off this machine cannot be granted
    expect(accessOriginsFor(settings({ providers: { custom: { apiKey: '', baseUrl: 'http://10.0.0.5/v1' } }, chat: { provider: 'custom', model: 'm' } }))).toEqual([]);
  });
});

describe('models', () => {
  it.each([
    ['google', 'gemini-3.5-flash-lite', 'summaries'],
    ['google', 'models/gemini-2.5-pro', 'summaries'],
    ['google', 'gemini-2.0-flash', 'none'],
    ['openai', 'gpt-5-mini', 'summaries'],
    ['openai', 'o4-mini', 'summaries'],
    ['openai', 'gpt-4.1-mini', 'none'],
    ['anthropic', 'claude-sonnet-4-5', 'summaries'],
    ['anthropic', 'claude-3-7-sonnet-latest', 'summaries'],
    ['anthropic', 'claude-3-5-haiku-latest', 'none'],
    ['deepseek', 'deepseek-reasoner', 'summaries'],
    ['groq', 'llama-3.3-70b-versatile', 'unknown'],
  ] as const)('%s %s → %s', (provider, model, thinking) => {
    expect(modelInfo(provider, model).thinking).toBe(thinking);
  });

  it('known 768-dimensional embedding models', () => {
    expect(isKnown768Embedding('google', 'gemini-embedding-2')).toBe(true);
    expect(isKnown768Embedding('openai', 'text-embedding-3-large')).toBe(true);
    expect(isKnown768Embedding('ollama', 'nomic-embed-text:latest')).toBe(true);
    expect(isKnown768Embedding('ollama', 'mxbai-embed-large')).toBe(false);
  });
});

describe('callModel / embedTexts', () => {
  it('route to the chosen provider with the chosen model', async () => {
    const requests = captureFetch(geminiStream([geminiChunk([{ text: 'Hi' }], 'STOP')]));
    const result = await callModel(settings({ providers: { google: { apiKey: 'AIza' } } }), { messages: [{ role: 'user', content: 'q' }], tools: [], maxOutputTokens: 100, thinking: false });
    expect(requests[0].url).toContain('/models/gemini-3.5-flash-lite:streamGenerateContent');
    expect(result.text).toBe('Hi');
  });

  it('refuse an empty model id', async () => {
    const s = settings({ providers: { google: { apiKey: 'AIza' } }, chat: { provider: 'google', model: ' ' } });
    await expect(callModel(s, { messages: [], tools: [], maxOutputTokens: 1, thinking: false })).rejects.toThrow('Choose a chat model in Settings.');
  });

  it('embedTexts makes no request for no texts', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await embedTexts(settings({}), [], 'document')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('normalizeSettings', () => {
  it('fills defaults for an empty store', () => {
    const s = normalizeSettings(null);
    expect(s.chat).toEqual({ provider: 'google', model: 'gemini-3.5-flash-lite' });
    expect(s.embedding).toEqual({ provider: 'google', model: 'gemini-embedding-2' });
    expect(s.providers).toEqual({});
    expect(s.showReasoning).toBe(false);
    expect(s.toolRoundsBeforeAsking).toBe(12);
  });

  it('maps the old flat Google settings', () => {
    const s = normalizeSettings({ llmProvider: 'google', apiKey: 'AIza-old', model: 'gemini-2.5-flash', embeddingModel: '', contextThreshold: 20000 } as any);
    expect(s.providers).toEqual({ google: { apiKey: 'AIza-old' } });
    expect(s.chat).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
    expect(s.embedding).toEqual({ provider: 'google', model: 'gemini-embedding-2' });
    expect(s.contextThreshold).toBe(20000);
    expect(s).not.toHaveProperty('apiKey');
    expect(s).not.toHaveProperty('llmProvider');
  });

  it('old OpenAI settings with a base URL become the custom provider', () => {
    const s = normalizeSettings({ llmProvider: 'openai', apiKey: 'k', baseUrl: 'https://proxy.test/v1', model: 'm' } as any);
    expect(s.providers).toEqual({ custom: { apiKey: 'k', baseUrl: 'https://proxy.test/v1' } });
    expect(s.chat).toEqual({ provider: 'custom', model: 'm' });
    expect(s.embedding).toEqual({ provider: 'custom', model: 'text-embedding-3-small' });
  });

  it('old OpenAI settings without a base URL stay OpenAI', () => {
    const s = normalizeSettings({ llmProvider: 'openai', apiKey: 'sk-1', model: 'gpt-4o-mini' } as any);
    expect(s.chat).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(s.providers).toEqual({ openai: { apiKey: 'sk-1' } });
  });

  it('new-shape settings pass through', () => {
    const s = normalizeSettings({ providers: { anthropic: { apiKey: 'sk-ant' } }, chat: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
    expect(s.chat.provider).toBe('anthropic');
    expect(s.embedding.provider).toBe('google');
  });
});
