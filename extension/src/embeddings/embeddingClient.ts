import { resolveBaseUrl, type AppSettings } from '../settings';

/**
 * Retrieval is asymmetric: chunks are embedded as documents, questions as queries.
 * Gemini models are trained with these task types and rank noticeably better when told.
 */
export type EmbeddingTask = 'document' | 'query';

/**
 * Provider-qualified model id, stored alongside indexed chunks so a model change invalidates them.
 */
export function resolveEmbeddingModel(settings: AppSettings): string {
  const provider = settings.llmProvider;
  const model = settings.embeddingModel?.trim() || (provider === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-2');
  return `${provider}/${model.startsWith('models/') ? model.slice('models/'.length) : model}`;
}

/**
 * Generate a query-side vector embedding for a single text string
 */
export async function getEmbedding(text: string, settings: AppSettings, task: EmbeddingTask = 'query'): Promise<number[]> {
  const results = await batchEmbed([text], settings, task);
  if (!results || results.length === 0) {
    throw new Error('No embedding returned by provider');
  }
  return results[0];
}

/**
 * Batch generate vector embeddings for multiple texts, targeting 768 dimensions.
 */
export async function batchEmbed(
  texts: string[],
  settings: AppSettings,
  task: EmbeddingTask = 'document'
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!settings.apiKey) {
    throw new Error('API key is required to generate embeddings. Please check Settings.');
  }

  const provider = settings.llmProvider;
  const embeddingModel = resolveEmbeddingModel(settings).split('/').slice(1).join('/');

  if (provider === 'google') {
    return batchEmbedGoogle(texts, embeddingModel, settings.apiKey, task, resolveBaseUrl(settings));
  } else if (provider === 'openai') {
    return batchEmbedOpenAI(texts, embeddingModel, settings.apiKey, resolveBaseUrl(settings));
  } else {
    throw new Error(`Unsupported LLM provider for embeddings: ${provider}`);
  }
}

/**
 * Google AI Studio embeddings (defaulting to gemini-embedding-2, 768 dimensions)
 */
async function batchEmbedGoogle(texts: string[], model: string, apiKey: string, task: EmbeddingTask, baseUrl: string): Promise<number[][]> {
  const taskType = task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
  // Process in chunks of 20 to stay well within Google API limits
  const CHUNK_SIZE = 20;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const slice = texts.slice(i, i + CHUNK_SIZE);
    const cleanModel = model.startsWith('models/') ? model.slice('models/'.length) : model;

    const requestBody = {
      requests: slice.map((text) => ({
        model: `models/${cleanModel}`,
        content: {
          parts: [{ text }],
        },
        taskType,
        outputDimensionality: 768,
      })),
    };

    const response = await fetch(
      `${baseUrl}/models/${cleanModel}:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google AI Embedding Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error('Invalid embeddings response from Google AI API');
    }

    for (const item of data.embeddings) {
      if (!item.values || !Array.isArray(item.values)) {
        throw new Error('Embedding values missing in Google AI response');
      }
      allEmbeddings.push(item.values);
    }
  }

  return allEmbeddings;
}

/**
 * OpenAI embeddings (defaulting to text-embedding-3-small with dimensions: 768)
 */
async function batchEmbedOpenAI(
  texts: string[],
  model: string,
  apiKey: string,
  baseUrl: string
): Promise<number[][]> {
  const CHUNK_SIZE = 50;
  const allEmbeddings: number[][] = [];
  const endpoint = `${baseUrl}/embeddings`;

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const slice = texts.slice(i, i + CHUNK_SIZE);

    const requestBody: any = {
      model,
      input: slice,
      dimensions: 768,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Embedding Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid embeddings response from OpenAI API');
    }

    // Sort by index to maintain ordering
    const sorted = [...data.data].sort((a: any, b: any) => a.index - b.index);
    for (const item of sorted) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

