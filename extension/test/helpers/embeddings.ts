import type { AppSettings } from '../../src/settings';
import type { EmbeddingTask } from '../../src/embeddings/embeddingClient';

/**
 * Stand-in for `src/embeddings/embeddingClient`, installed with
 * `vi.mock('../../src/embeddings/embeddingClient', () => import('../helpers/embeddings'))`.
 * Vectors are deterministic and **distinct** per text (a seeded PRNG over a hash of the text):
 * thousands of identical vectors degenerate the HNSW graph and filtered scans return nothing.
 * `embedCalls` counts texts embedded, so sync tests can assert the lazy-embedding rule (zero).
 */

export const DIMENSIONS = 768;
export const embedCalls = { texts: 0, batches: 0 };

export function resetEmbedCalls() {
  embedCalls.texts = 0;
  embedCalls.batches = 0;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function fakeVector(text: string): number[] {
  let seed = hash(text) || 1;
  const next = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const v = Array.from({ length: DIMENSIONS }, () => next() * 2 - 1);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

export function resolveEmbeddingModel(settings: AppSettings): string {
  return `${settings.embedding.provider}/fake-embedding`;
}

export async function batchEmbed(texts: string[], _settings: AppSettings, _task: EmbeddingTask = 'document'): Promise<number[][]> {
  embedCalls.batches += 1;
  embedCalls.texts += texts.length;
  return texts.map(fakeVector);
}

export async function getEmbedding(text: string, settings: AppSettings, task: EmbeddingTask = 'query'): Promise<number[]> {
  return (await batchEmbed([text], settings, task))[0];
}
