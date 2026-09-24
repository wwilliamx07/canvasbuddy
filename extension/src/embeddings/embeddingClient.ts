import type { AppSettings } from '../settings';
import { embedTexts } from '../providers';
import type { EmbeddingTask } from '../providers/types';

export type { EmbeddingTask } from '../providers/types';

/**
 * Embeddings for indexing and search, through the embeddings provider chosen in Settings
 * (`providers/`). Retrieval is asymmetric: chunks are embedded as documents, questions as queries;
 * providers that support task types (Gemini) rank noticeably better when told.
 */

/** Provider-qualified model id, stored alongside indexed chunks so a model change invalidates them. */
export function resolveEmbeddingModel(settings: AppSettings): string {
  return `${settings.embedding.provider}/${settings.embedding.model.trim().replace(/^models\//, '')}`;
}

/** A query-side vector for a single text. */
export async function getEmbedding(text: string, settings: AppSettings, task: EmbeddingTask = 'query'): Promise<number[]> {
  const results = await batchEmbed([text], settings, task);
  if (!results || results.length === 0) throw new Error('No embedding returned by provider');
  return results[0];
}

/** 768-dimensional vectors for many texts, in input order. */
export function batchEmbed(texts: string[], settings: AppSettings, task: EmbeddingTask = 'document'): Promise<number[][]> {
  return embedTexts(settings, texts, task);
}
