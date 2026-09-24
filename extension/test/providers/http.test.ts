import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDimensions, isAbortError, postJson, readApiError, readRetryDelay, sendWithRetry } from '../../src/providers/http';
import { readSSE } from '../../src/utils/sse';
import { captureFetch } from '../helpers/llm';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('readSSE', () => {
  it('handles CRLF, frames split across chunks, multi-line data and a tail without a blank line', async () => {
    const text = 'data: one\r\n\r\ndata: two-a\ndata: two-b\n\n: comment\n\ndata: tail';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of readSSE(new Response(body))) out.push(d);
    expect(out).toEqual(['one', 'two-a\ntwo-b', 'tail']);
  });
});

describe('errors and rate limits', () => {
  it('readApiError includes the provider message', async () => {
    const r = new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400, statusText: 'Bad Request' });
    expect(await readApiError(r)).toBe('API error 400 Bad Request: API key not valid');
  });

  it('readApiError leaves out an empty status text (HTTP/2 has no reason phrase)', async () => {
    const r = new Response(JSON.stringify({ error: { message: 'Resource has been exhausted' } }), { status: 429 });
    expect(await readApiError(r)).toBe('API error 429: Resource has been exhausted');
  });

  it.each([
    ['Retry-After seconds', new Response('{}', { status: 429, headers: { 'retry-after': '7' } }), 7],
    ['retry-after-ms', new Response('{}', { status: 429, headers: { 'retry-after-ms': '2500' } }), 2.5],
    [
      'Gemini RetryInfo',
      new Response(JSON.stringify({ error: { message: 'Quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } }), { status: 429 }),
      12,
    ],
    ['nothing said', new Response('{}', { status: 429 }), null],
  ])('readRetryDelay: %s', async (_name, response, seconds) => {
    expect((await readRetryDelay(response)).seconds).toBe(seconds);
  });

  it('readRetryDelay: an HTTP date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
    const r = new Response('{}', { status: 429, headers: { 'retry-after': 'Wed, 23 Sep 2026 12:00:30 GMT' } });
    expect((await readRetryDelay(r)).seconds).toBe(30);
  });

  const rateLimited = (seconds?: number) =>
    new Response(JSON.stringify({ error: { message: 'Too many tokens' } }), { status: 429, headers: seconds ? { 'retry-after': String(seconds) } : {} });

  it('sendWithRetry waits the requested delay and retries', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValueOnce(rateLimited(5)).mockResolvedValueOnce(new Response('ok'));
    const onRetry = vi.fn();
    const pending = sendWithRetry(send, undefined, onRetry);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(200);
    expect(onRetry).toHaveBeenCalledWith(5);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sendWithRetry falls back to 4 s then 12 s and gives up after two retries', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => rateLimited());
    const onRetry = vi.fn();
    const pending = sendWithRetry(send, undefined, onRetry);
    await vi.advanceTimersByTimeAsync(16_000);
    expect((await pending).status).toBe(429);
    expect(onRetry.mock.calls).toEqual([[4], [12]]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sendWithRetry fails at once when the provider asks for more than 60 s', async () => {
    const send = vi.fn(async () => rateLimited(90));
    await expect(sendWithRetry(send)).rejects.toThrow('API error 429: Too many tokens (try again in 90 s)');
    expect(send).toHaveBeenCalledOnce();
  });

  it('sendWithRetry: Stop ends the wait', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = sendWithRetry(async () => rateLimited(30), abort.signal);
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort();
    const error = await pending.catch((e) => e);
    expect(isAbortError(error)).toBe(true);
  });

  it('sendWithRetry passes other statuses straight through', async () => {
    const send = vi.fn(async () => new Response('bad', { status: 400 }));
    expect((await sendWithRetry(send)).status).toBe(400);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('postJson / assertDimensions', () => {
  it('posts JSON with the content type and the caller headers, and returns the response unread', async () => {
    const requests = captureFetch(new Response('nope', { status: 400 }));
    const response = await postJson('https://api.test/x', { 'x-api-key': 'k' }, { a: 1 }, {});
    expect(response.status).toBe(400);
    expect(requests[0]).toEqual({ url: 'https://api.test/x', headers: { 'Content-Type': 'application/json', 'x-api-key': 'k' }, body: { a: 1 } });
  });

  it('529 (Anthropic overloaded) is retried like 429', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 529, headers: { 'retry-after': '1' } })).mockResolvedValueOnce(new Response('ok'));
    const pending = sendWithRetry(send);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(200);
  });

  it('assertDimensions passes 768-dimensional vectors and names the model otherwise', () => {
    const ok = [new Array(768).fill(0)];
    expect(assertDimensions(ok, 'm')).toBe(ok);
    expect(() => assertDimensions([new Array(1536).fill(0)], 'big-model')).toThrow('"big-model" returned 1536-dimensional vectors');
  });
});
