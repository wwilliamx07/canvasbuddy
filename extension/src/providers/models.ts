import type { ProviderId } from './types';

/**
 * What is known about models, by family. It informs (defaults, hints, whether to ask for
 * thoughts) and never blocks: an unknown model id works with the provider's defaults. Rules match
 * name prefixes so a new version of a known family is recognised without an edit.
 */

/** `summaries`: the API can return readable thoughts. `none`: the model does not think (asking fails). */
export type ThinkingSupport = 'summaries' | 'none' | 'unknown';

export interface ModelInfo {
  thinking: ThinkingSupport;
  /** Tokens of context, when known. */
  contextWindow?: number;
}

const RULES: Array<{ providers: ProviderId[]; match: RegExp; info: ModelInfo }> = [
  { providers: ['google'], match: /^gemini-(2\.5|[3-9])/, info: { thinking: 'summaries', contextWindow: 1_048_576 } },
  { providers: ['google'], match: /^gemini-/, info: { thinking: 'none', contextWindow: 1_048_576 } },
  { providers: ['openai'], match: /^(o\d|gpt-5)/, info: { thinking: 'summaries', contextWindow: 200_000 } },
  { providers: ['openai'], match: /^gpt-4\.1/, info: { thinking: 'none', contextWindow: 1_047_576 } },
  { providers: ['openai'], match: /^gpt-4o/, info: { thinking: 'none', contextWindow: 128_000 } },
  { providers: ['anthropic'], match: /^claude-(3-7|(opus|sonnet|haiku)-[4-9])/, info: { thinking: 'summaries', contextWindow: 200_000 } },
  { providers: ['anthropic'], match: /^claude-3/, info: { thinking: 'none', contextWindow: 200_000 } },
  { providers: ['deepseek', 'openrouter'], match: /deepseek-(reasoner|r1)/, info: { thinking: 'summaries' } },
];

export function modelInfo(provider: ProviderId, model: string): ModelInfo {
  const id = model.trim().replace(/^models\//, '');
  return RULES.find((r) => r.providers.includes(provider) && r.match.test(id))?.info ?? { thinking: 'unknown' };
}

/** Embedding models known to produce 768-dimensional vectors (natively or on request). Others are checked when they answer. */
const EMBEDDING_768: Array<{ providers: ProviderId[]; match: RegExp }> = [
  { providers: ['google'], match: /^(gemini-embedding|text-embedding-004)/ },
  { providers: ['openai'], match: /^text-embedding-3/ },
  { providers: ['ollama', 'lmstudio', 'custom'], match: /nomic-embed-text/ },
];

export function isKnown768Embedding(provider: ProviderId, model: string): boolean {
  const id = model.trim().replace(/^models\//, '');
  return EMBEDDING_768.some((r) => r.providers.includes(provider) && r.match.test(id));
}
