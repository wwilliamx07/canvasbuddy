import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAIResponsesAdapter, readResponsesStream, responsesTools, toResponsesInput } from '../../src/providers/openaiResponses';
import type { ChatRequest, ProviderEndpoint } from '../../src/providers/types';
import { apiError, captureFetch, typedStream } from '../helpers/llm';

afterEach(() => vi.unstubAllGlobals());

const endpoint: ProviderEndpoint = { provider: 'openai', baseUrl: 'https://openai.test/v1', apiKey: 'sk-key' };
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  model: 'gpt-5-mini',
  maxOutputTokens: 2000,
  thinking: false,
  ...over,
});
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
const completed = (usage = { input_tokens: 40, output_tokens: 6 }) => ({ type: 'response.completed', response: { status: 'completed', usage } });

describe('toResponsesInput', () => {
  it('replays reasoning items before the calls they led to, and results as function_call_output', () => {
    expect(
      toResponsesInput([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Due dates?' },
        { role: 'assistant', content: '', replay: { adapter: 'openai-responses', items: [reasoningItem] }, toolCalls: [{ id: 'call_1', name: 'get_planner', args: { days: 7 } }] },
        { role: 'user', content: '', toolResults: [{ id: 'call_1', name: 'get_planner', result: '{"items":[]}' }] },
        { role: 'assistant', content: 'Nothing due.' },
      ])
    ).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Due dates?' },
      reasoningItem,
      { type: 'function_call', call_id: 'call_1', name: 'get_planner', arguments: '{"days":7}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"items":[]}' },
      { role: 'assistant', content: 'Nothing due.' },
    ]);
  });

  it('drops replay data another adapter produced', () => {
    expect(toResponsesInput([{ role: 'assistant', content: 'ok', replay: { adapter: 'anthropic', items: [{ type: 'thinking' }] } }])).toEqual([
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('tools are flat function definitions, not strict', () => {
    const parameters = { type: 'object' as const, properties: {} };
    expect(responsesTools([{ name: 't', description: 'd', parameters }])).toEqual([{ type: 'function', name: 't', description: 'd', parameters, strict: false }]);
  });
});

describe('readResponsesStream', () => {
  it('collects text, summaries, calls, reasoning items and usage', async () => {
    const deltas: string[] = [];
    const thoughts: string[] = [];
    const out = await readResponsesStream(
      typedStream(
        [
          { type: 'response.reasoning_summary_text.delta', delta: 'Look up ' },
          { type: 'response.reasoning_summary_text.delta', delta: 'the planner' },
          { type: 'response.reasoning_summary_part.done' },
          { type: 'response.output_item.done', item: reasoningItem },
          { type: 'response.output_text.delta', delta: 'One ' },
          { type: 'response.output_text.delta', delta: 'moment.' },
          { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'get_planner', arguments: '{"days":7}' } },
          completed({ input_tokens: 40, output_tokens: 6, input_tokens_details: { cached_tokens: 32 }, output_tokens_details: { reasoning_tokens: 4 } } as any),
        ],
        { splitEvery: 13 }
      ),
      (t) => deltas.push(t),
      (t) => thoughts.push(t)
    );
    expect(deltas.join('')).toBe('One moment.');
    expect(thoughts.join('')).toBe('Look up the planner\n\n');
    expect(out).toEqual({
      text: 'One moment.',
      toolCalls: [{ id: 'call_9', name: 'get_planner', args: { days: 7 } }],
      reasoningItems: [reasoningItem],
      usage: { input: 40, output: 6, cachedInput: 32, reasoning: 4 },
      finishReason: 'completed',
    });
  });

  it('failed and error events throw', async () => {
    await expect(readResponsesStream(typedStream([{ type: 'response.failed', response: { error: { message: 'server broke' } } }]), () => {})).rejects.toThrow('server broke');
    await expect(readResponsesStream(typedStream([{ type: 'error', message: 'bad request' }]), () => {})).rejects.toThrow('bad request');
  });
});

describe('openAIResponsesAdapter.chat', () => {
  it('a reasoning model always returns encrypted reasoning; summaries only when wanted', async () => {
    const requests = captureFetch(typedStream([{ type: 'response.output_item.done', item: reasoningItem }, { type: 'response.output_text.delta', delta: 'Hi' }, completed()]));
    const result = await openAIResponsesAdapter.chat(endpoint, request(), {});
    expect(requests[0].url).toBe('https://openai.test/v1/responses');
    expect(requests[0].headers.Authorization).toBe('Bearer sk-key');
    expect(requests[0].body).toMatchObject({ model: 'gpt-5-mini', max_output_tokens: 2000, stream: true, store: false, include: ['reasoning.encrypted_content'] });
    expect(requests[0].body.reasoning).toBeUndefined();
    expect(result.replay).toEqual({ adapter: 'openai-responses', items: [reasoningItem] });
    expect(result.usage).toEqual({ input: 40, output: 6 });
  });

  it('asks for summaries when thinking is on', async () => {
    const requests = captureFetch(typedStream([{ type: 'response.output_text.delta', delta: 'Hi' }, completed()]));
    await openAIResponsesAdapter.chat(endpoint, request({ thinking: true }), {});
    expect(requests[0].body.reasoning).toEqual({ summary: 'auto' });
  });

  it('a model known not to reason gets no reasoning fields', async () => {
    const requests = captureFetch(typedStream([{ type: 'response.output_text.delta', delta: 'Hi' }, completed()]));
    const result = await openAIResponsesAdapter.chat(endpoint, request({ model: 'gpt-4.1-mini', thinking: true }), {});
    expect(requests[0].body.include).toBeUndefined();
    expect(requests[0].body.reasoning).toBeUndefined();
    expect(result.replay).toBeUndefined();
  });

  it('an unknown model that rejects reasoning is asked again without it', async () => {
    const requests = captureFetch(
      apiError(400, "Unsupported parameter: 'reasoning.summary' is not supported with this model."),
      typedStream([{ type: 'response.output_text.delta', delta: 'Hi' }, completed()])
    );
    const result = await openAIResponsesAdapter.chat(endpoint, request({ model: 'some-new-model', thinking: true }), {});
    expect(requests).toHaveLength(2);
    expect(requests[1].body.reasoning).toBeUndefined();
    expect(result.text).toBe('Hi');
  });

  it('an incomplete, empty answer is an error', async () => {
    captureFetch(typedStream([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]));
    await expect(openAIResponsesAdapter.chat(endpoint, request(), {})).rejects.toThrow('The model returned no answer (max_output_tokens).');
  });
});

describe('openAIResponsesAdapter.embed', () => {
  it('asks OpenAI for 768 dimensions', async () => {
    const requests = captureFetch(new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(768).fill(0) }] })));
    await openAIResponsesAdapter.embed!(endpoint, ['a'], 'text-embedding-3-small', 'query');
    expect(requests[0].url).toBe('https://openai.test/v1/embeddings');
    expect(requests[0].body).toEqual({ model: 'text-embedding-3-small', input: ['a'], dimensions: 768 });
  });
});
