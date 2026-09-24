import type { ChatIO } from './types';

/**
 * What every adapter shares on the wire: POSTing with rate-limit retries, turning an error
 * response into a readable message, and recognising a Stop.
 */

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : (error as any)?.name === 'AbortError';
}

/** A tool call's arguments from the JSON the model streamed; unparseable (a cut-off stream) reads as none. */
export function parseToolArgs(json: string): Record<string, unknown> {
  try {
    const parsed = json ? JSON.parse(json) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseJsonOrString(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * "API error 429 Too Many Requests: <provider message>". HTTP/2 and HTTP/3 carry no reason phrase,
 * so `statusText` is often empty and is left out then.
 */
function apiErrorMessage(response: Response, detail: string): string {
  const status = [response.status, response.statusText].filter(Boolean).join(' ');
  return `API error ${status}${detail ? `: ${detail}` : ''}`;
}

/** The provider's real error message, not just the HTTP status line. */
export async function readApiError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    // no JSON body
  }
  return apiErrorMessage(response, detail);
}

export const RATE_LIMIT_RETRIES = 2;
export const RETRY_WAIT_MAX_S = 60;
export const RETRY_FALLBACK_S = [4, 12];
/** Too many requests; overloaded (Anthropic answers 529). */
const RETRY_STATUSES = new Set([429, 503, 529]);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () => new DOMException('Stopped by the user', 'AbortError');
    if (signal?.aborted) return reject(stopped());
    const onAbort = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long the provider asks to wait, from whichever form it uses: `Retry-After` (seconds or a
 * date), OpenAI's `retry-after-ms`, or Gemini's `google.rpc.RetryInfo` `retryDelay: "12s"` in the
 * error body. Reads the body, so it also returns the error message.
 */
export async function readRetryDelay(response: Response): Promise<{ seconds: number | null; message: string }> {
  let seconds: number | null = null;
  const header = response.headers.get('retry-after');
  if (header) {
    const n = Number(header);
    seconds = Number.isFinite(n) ? n : Math.max(0, (Date.parse(header) - Date.now()) / 1000) || null;
  }
  const ms = Number(response.headers.get('retry-after-ms'));
  if (seconds === null && Number.isFinite(ms) && ms > 0) seconds = ms / 1000;
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // no JSON body
  }
  if (seconds === null && Array.isArray(body?.error?.details)) {
    const delay = body.error.details.find((d: any) => typeof d?.retryDelay === 'string')?.retryDelay;
    const match = /^([\d.]+)s$/.exec(delay ?? '');
    if (match) seconds = Number(match[1]);
  }
  const detail = body?.error?.message || body?.message || '';
  return { seconds, message: apiErrorMessage(response, detail) };
}

/**
 * Sends, and waits out a 429 / 503 / 529 up to twice with the delay the provider asks for (capped
 * at 60 s; a longer wait fails at once with the provider's message). Stop ends a wait immediately.
 */
export async function sendWithRetry(send: () => Promise<Response>, signal?: AbortSignal, onRetry?: (seconds: number) => void): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (!RETRY_STATUSES.has(response.status) || attempt >= RATE_LIMIT_RETRIES) return response;
    const { seconds, message } = await readRetryDelay(response);
    const wait = Math.ceil(seconds ?? RETRY_FALLBACK_S[attempt]);
    if (wait > RETRY_WAIT_MAX_S) throw new Error(`${message} (try again in ${wait} s)`);
    onRetry?.(wait);
    await sleep(wait * 1000, signal);
  }
}

/** POST JSON with retries; returns the response unread (ok or not) so adapters can inspect a 400. */
export function postJson(url: string, headers: Record<string, string>, body: unknown, io: ChatIO): Promise<Response> {
  return sendWithRetry(
    () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: io.signal }),
    io.signal,
    io.onRetry
  );
}

/** Every adapter answers 768-dimensional vectors, because the schema stores `VECTOR(768)`. */
export function assertDimensions(vectors: number[][], model: string): number[][] {
  const wrong = vectors.find((v) => v.length !== 768);
  if (wrong) {
    throw new Error(`The embedding model "${model}" returned ${wrong.length}-dimensional vectors; CanvasBuddy needs 768. Choose a model that can produce 768 dimensions.`);
  }
  return vectors;
}
