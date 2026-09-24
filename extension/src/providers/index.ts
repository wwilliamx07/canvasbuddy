import type { AppSettings } from '../settings';
import { adapterFor, endpointFor } from './registry';
import type { ChatIO, ChatRequest, ChatResult, EmbeddingTask } from './types';

/**
 * The two calls the rest of the app makes. Everything provider-specific stays behind them.
 */

/** One model call with the chat provider and model from Settings. */
export async function callModel(settings: AppSettings, request: Omit<ChatRequest, 'model'>, io: ChatIO = {}): Promise<ChatResult> {
  const endpoint = endpointFor(settings, 'chat');
  const model = settings.chat.model.trim();
  if (!model) throw new Error('Choose a chat model in Settings.');
  return adapterFor(endpoint.provider).chat(endpoint, { ...request, model }, io);
}

/** 768-dimensional vectors from the embeddings provider and model in Settings. */
export async function embedTexts(settings: AppSettings, texts: string[], task: EmbeddingTask): Promise<number[][]> {
  if (texts.length === 0) return [];
  const endpoint = endpointFor(settings, 'embedding');
  const adapter = adapterFor(endpoint.provider);
  if (!adapter.embed) throw new Error('This provider has no embeddings API; choose another embeddings provider in Settings.');
  const model = settings.embedding.model.trim();
  if (!model) throw new Error('Choose an embedding model in Settings.');
  return adapter.embed(endpoint, texts, model, task);
}
