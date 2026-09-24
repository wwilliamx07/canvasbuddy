import type { ConversationMessage, ToolCall } from '../agent/history';

/**
 * The seam between the agent loop and model APIs. The loop builds a `ChatRequest` (the
 * provider-neutral conversation and tools) and gets back a `ChatResult`; everything that differs
 * between APIs — request shape, streaming format, tool-call encoding, thinking, replay data,
 * retries, quirks — lives in one `ProviderAdapter` per API (see `registry.ts` for which provider
 * uses which adapter).
 */

/** One implementation per wire protocol. */
export type AdapterId = 'gemini' | 'openai-chat' | 'openai-responses' | 'anthropic';

/** A service the student has a key for. Several providers can share an adapter (OpenAI-compatible ones). */
export type ProviderId = 'google' | 'openai' | 'anthropic' | 'openrouter' | 'groq' | 'deepseek' | 'ollama' | 'lmstudio' | 'custom';

/** A JSON Schema, as far as tool parameters need one. */
export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [keyword: string]: unknown;
}

/** A function the model may call: the one format for built-in and connection tools alike. */
export interface ToolSpec {
  name: string;
  /** The model's only guidance — written as an instruction. */
  description: string;
  parameters: JsonSchema & { type: 'object'; properties: Record<string, JsonSchema> };
}

/** Tokens the provider reported for one call. `input` includes cached tokens. */
export interface Usage {
  input: number;
  output: number;
  cachedInput?: number;
  /** Thinking tokens, when the provider reports them separately (they are also billed as output). */
  reasoning?: number;
}

/**
 * Adapter-private data that must be sent back when a turn is replayed to the same API
 * (Anthropic thinking blocks, OpenAI Responses reasoning items). Other adapters ignore it.
 */
export interface ReplayData {
  adapter: AdapterId;
  items: unknown[];
}

export interface ProviderEndpoint {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
}

export interface ChatRequest {
  messages: ConversationMessage[];
  tools: ToolSpec[];
  model: string;
  maxOutputTokens: number;
  /** The student wants the model's thoughts (and `onThought` will receive them). */
  thinking: boolean;
}

export interface ChatIO {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onThought?: (text: string) => void;
  /** A 429 / 503 / 529 is being waited out for this many seconds. */
  onRetry?: (seconds: number) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  /** Gemini: signature carried on the text part of the turn. */
  thoughtSignature?: string;
  replay?: ReplayData;
  usage?: Usage;
  finishReason?: string;
}

export type EmbeddingTask = 'document' | 'query';

export interface ProviderAdapter {
  id: AdapterId;
  chat(endpoint: ProviderEndpoint, request: ChatRequest, io: ChatIO): Promise<ChatResult>;
  /** Vectors of exactly 768 dimensions (the schema's `VECTOR(768)`), or an error saying why not. */
  embed?(endpoint: ProviderEndpoint, texts: string[], model: string, task: EmbeddingTask): Promise<number[][]>;
}
