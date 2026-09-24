import { vi } from 'vitest';

/**
 * Fake model responses. `sseResponse` frames `data:` events like both providers do; `splitEvery`
 * cuts the byte stream at arbitrary points so readers are tested against frames split across
 * chunks, which is what real networks deliver.
 */

export function sseResponse(events: Array<string | object>, opts: { splitEvery?: number; crlf?: boolean } = {}): Response {
  const nl = opts.crlf ? '\r\n' : '\n';
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}${nl}${nl}`).join('');
  const bytes = new TextEncoder().encode(text);
  const size = opts.splitEvery ?? bytes.length;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Gemini `streamGenerateContent?alt=sse` chunks. */
export const geminiStream = (chunks: object[], opts?: { splitEvery?: number }) => sseResponse(chunks, opts);

/** OpenAI chat-completions chunks, terminated by `[DONE]`. */
export const openaiStream = (chunks: object[], opts?: { splitEvery?: number }) => sseResponse([...chunks, '[DONE]'], opts);

/** One Gemini streaming chunk carrying `parts` (and optionally a finish reason). */
export const geminiChunk = (parts: object[], finishReason?: string) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
});

/** One OpenAI streaming chunk with a delta. */
export const openaiChunk = (delta: object, finishReason?: string) => ({
  choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
});

/** Stubs `fetch` with these responses in order and records each request's URL, headers and JSON body. */
export function captureFetch(...responses: Response[]) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected fetch to ${url}`);
      return next;
    })
  );
  return requests;
}

/** An API error response in the `{ error: { message } }` shape every provider uses. */
export const apiError = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

/** Events of a stream whose frames carry a `type` (OpenAI Responses, Anthropic). */
export const typedStream = (events: object[], opts?: { splitEvery?: number }) => sseResponse(events, opts);
