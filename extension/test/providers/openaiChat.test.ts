import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAIChatAdapter, openAIChatTools, readOpenAIStream, toOpenAIMessages, usageFromOpenAI } from '../../src/providers/openaiChat';
import type { ChatRequest, ProviderEndpoint } from '../../src/providers/types';
import { captureFetch, openaiChunk, openaiStream, sseResponse } from '../helpers/llm';

afterEach(() => vi.unstubAllGlobals());

const endpoint: ProviderEndpoint = { provider: 'groq', baseUrl: 'https://compat.test/v1', apiKey: 'gsk_key' };
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  model: 'llama-3.3-70b-versatile',
  maxOutputTokens: 2000,
  thinking: false,
  ...over,
});

describe('toOpenAIMessages / tools', () => {
  it('maps tool calls and results to chat messages', () => {
    expect(
      toOpenAIMessages([
        { role: 'user', content: 'When is A1 due?' },
        { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'call_0', name: 'list_content', args: { kind: 'assignments' } }] },
        { role: 'user', content: '', toolResults: [{ id: 'call_0', name: 'list_content', result: '{"rows":[]}' }] },
      ])
    ).toEqual([
      { role: 'user', content: 'When is A1 due?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'list_content', arguments: '{"kind":"assignments"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_0', content: '{"rows":[]}' },
    ]);
  });

  it('keeps system messages (digests) mid-history and sends null content for silent tool turns', () => {
    const out = toOpenAIMessages([
      { role: 'system', content: 'digest' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', args: {} }] },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'digest' });
    expect(out[1].content).toBeNull();
  });

  it('tools carry the JSON Schema as is', () => {
    const parameters = { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] };
    expect(openAIChatTools([{ name: 'find', description: 'Find', parameters }])).toEqual([{ type: 'function', function: { name: 'find', description: 'Find', parameters } }]);
  });

  it('usage reports cached and reasoning tokens', () => {
    expect(usageFromOpenAI({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 8 } })).toEqual({
      input: 100,
      output: 20,
      cachedInput: 64,
      reasoning: 8,
    });
  });
});

describe('readOpenAIStream', () => {
  it('accumulates content and tool-call fragments by index', async () => {
    const deltas: string[] = [];
    const data = await readOpenAIStream(
      openaiStream(
        [
          openaiChunk({ content: 'Checking' }),
          openaiChunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'list_', arguments: '' } }] }),
          openaiChunk({ tool_calls: [{ index: 0, function: { name: 'content', arguments: '{"kind":' } }] }),
          openaiChunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_planner', arguments: '{}' } }] }),
          openaiChunk({ tool_calls: [{ index: 0, function: { arguments: '"courses"}' } }] }, 'tool_calls'),
          { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } },
        ],
        { splitEvery: 11 }
      ),
      (t) => deltas.push(t)
    );
    expect(deltas).toEqual(['Checking']);
    expect(data).toEqual({
      text: 'Checking',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call_a', name: 'list_content', args: { kind: 'courses' } },
        { id: 'call_b', name: 'get_planner', args: {} },
      ],
      usage: { input: 30, output: 9 },
    });
  });

  it('broken argument JSON becomes {}', async () => {
    const data = await readOpenAIStream(openaiStream([openaiChunk({ tool_calls: [{ index: 0, function: { name: 'b', arguments: '{oops' } }] })]), () => {});
    expect(data.toolCalls).toEqual([{ id: 'call_0', name: 'b', args: {} }]);
  });

  it('reasoning_content and reasoning deltas go to onThought, not the text', async () => {
    const thoughts: string[] = [];
    const data = await readOpenAIStream(
      openaiStream([openaiChunk({ reasoning_content: 'first ' }), openaiChunk({ reasoning: 'then' }), openaiChunk({ content: 'Answer' }, 'stop')]),
      () => {},
      (t) => thoughts.push(t)
    );
    expect(thoughts.join('')).toBe('first then');
    expect(data.text).toBe('Answer');
  });

  it('throws on an error event', async () => {
    await expect(readOpenAIStream(sseResponse([{ error: { message: 'rate limited' } }]), () => {})).rejects.toThrow('rate limited');
  });
});

describe('openAIChatAdapter', () => {
  it('posts a streaming chat completion with usage and a bearer key', async () => {
    const requests = captureFetch(openaiStream([openaiChunk({ content: 'Hi' }, 'stop')]));
    const result = await openAIChatAdapter.chat(endpoint, request({ tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] }), {});
    expect(requests[0].url).toBe('https://compat.test/v1/chat/completions');
    expect(requests[0].headers.Authorization).toBe('Bearer gsk_key');
    expect(requests[0].body).toMatchObject({ model: 'llama-3.3-70b-versatile', max_tokens: 2000, stream: true, stream_options: { include_usage: true } });
    expect(requests[0].body.tools).toHaveLength(1);
    expect(result.text).toBe('Hi');
  });

  it('sends no Authorization header without a key (local servers)', async () => {
    const requests = captureFetch(openaiStream([openaiChunk({ content: 'Hi' }, 'stop')]));
    await openAIChatAdapter.chat({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' }, request(), {});
    expect(requests[0].headers.Authorization).toBeUndefined();
    expect(requests[0].body.tools).toBeUndefined();
  });

  it('thoughts reach onThought only when thinking was asked for', async () => {
    captureFetch(openaiStream([openaiChunk({ reasoning: 'hm' }), openaiChunk({ content: 'Hi' }, 'stop')]));
    const onThought = vi.fn();
    await openAIChatAdapter.chat(endpoint, request({ thinking: false }), { onThought });
    expect(onThought).not.toHaveBeenCalled();
  });

  it('embeddings keep input order; only OpenAI itself is sent `dimensions`', async () => {
    const vec = (x: number) => new Array(768).fill(x);
    const requests = captureFetch(new Response(JSON.stringify({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] })));
    const out = await openAIChatAdapter.embed!({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' }, ['a', 'b'], 'nomic-embed-text', 'document');
    expect(out.map((v) => v[0])).toEqual([1, 2]);
    expect(requests[0].body).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
  });

  it('embeddings of the wrong size are refused', async () => {
    captureFetch(new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0) }] })));
    await expect(openAIChatAdapter.embed!(endpoint, ['a'], 'mxbai-embed-large', 'document')).rejects.toThrow('returned 1024-dimensional vectors');
  });
});
