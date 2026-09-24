import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_VERSION, anthropicAdapter, anthropicTools, readAnthropicStream, toAnthropicRequest } from '../../src/providers/anthropic';
import type { ConversationMessage } from '../../src/agent/history';
import type { ChatRequest, ProviderEndpoint } from '../../src/providers/types';
import { captureFetch, typedStream } from '../helpers/llm';

afterEach(() => vi.unstubAllGlobals());

const endpoint: ProviderEndpoint = { provider: 'anthropic', baseUrl: 'https://anthropic.test/v1', apiKey: 'sk-ant-key' };
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  model: 'claude-sonnet-4-5',
  maxOutputTokens: 2000,
  thinking: false,
  ...over,
});
const thinkingBlock = { type: 'thinking', thinking: 'Check the planner.', signature: 'sig' };

/** A minimal stream: message_start with usage, one text block, and the stop reason. */
const textStream = (text: string, extra: object[] = []) =>
  typedStream([
    { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
    ...extra,
    { type: 'content_block_start', index: 9, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 9 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]);

describe('toAnthropicRequest', () => {
  it('system text goes to a cached system block; tool turns become tool_use / tool_result blocks', () => {
    const history: ConversationMessage[] = [
      { role: 'system', content: 'Prompt.' },
      { role: 'system', content: 'Digest.' },
      { role: 'user', content: 'Due?' },
      { role: 'assistant', content: 'Checking.', replay: { adapter: 'anthropic', items: [thinkingBlock] }, toolCalls: [{ id: 'tu_1', name: 'get_planner', args: { days: 7 } }] },
      { role: 'user', content: '', toolResults: [{ id: 'tu_1', name: 'get_planner', result: '{"items":[]}' }] },
      { role: 'user', content: 'Only CSC263.' },
    ];
    expect(toAnthropicRequest(history)).toEqual({
      system: [{ type: 'text', text: 'Prompt.\n\nDigest.', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Due?' }] },
        {
          role: 'assistant',
          content: [thinkingBlock, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'get_planner', input: { days: 7 } }],
        },
        // the steering message joins the tool results: turns must alternate
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '{"items":[]}' },
            { type: 'text', text: 'Only CSC263.' },
          ],
        },
      ],
    });
  });

  it('a history that starts with the assistant (after a digest) gets a user turn first', () => {
    const { messages } = toAnthropicRequest([{ role: 'assistant', content: 'Earlier answer.' }, { role: 'user', content: 'And now?' }]);
    expect(messages[0].role).toBe('user');
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] });
  });

  it('replay data from another adapter is left out', () => {
    const { messages } = toAnthropicRequest([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', replay: { adapter: 'openai-responses', items: [{ type: 'reasoning' }] } },
    ]);
    expect(messages[1].content).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('the last tool carries the cache breakpoint', () => {
    const parameters = { type: 'object' as const, properties: {} };
    const out = anthropicTools([
      { name: 'a', description: 'A', parameters },
      { name: 'b', description: 'B', parameters },
    ]);
    expect(out[0]).toEqual({ name: 'a', description: 'A', input_schema: parameters });
    expect(out[1]).toEqual({ name: 'b', description: 'B', input_schema: parameters, cache_control: { type: 'ephemeral' } });
  });
});

describe('readAnthropicStream', () => {
  it('assembles text, thinking (with signature) and tool input from deltas', async () => {
    const deltas: string[] = [];
    const thoughts: string[] = [];
    const out = await readAnthropicStream(
      typedStream(
        [
          { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the planner.' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_planner', input: {} } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"da' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ys":7}' } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
        ],
        { splitEvery: 17 }
      ),
      (t) => deltas.push(t),
      (t) => thoughts.push(t)
    );
    expect(deltas).toEqual(['Checking.']);
    expect(thoughts.join('')).toBe('Check the planner.');
    expect(out).toEqual({
      text: 'Checking.',
      toolCalls: [{ id: 'tu_1', name: 'get_planner', args: { days: 7 } }],
      thinkingBlocks: [thinkingBlock],
      usage: { input: 1000, output: 42, cachedInput: 900 },
      finishReason: 'tool_use',
    });
  });

  it('an error event throws', async () => {
    await expect(readAnthropicStream(typedStream([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), () => {})).rejects.toThrow('Overloaded');
  });
});

describe('anthropicAdapter.chat', () => {
  it('sends the browser-access and version headers and returns usage', async () => {
    const requests = captureFetch(textStream('Hi'));
    const result = await anthropicAdapter.chat(endpoint, request(), {});
    expect(requests[0].url).toBe('https://anthropic.test/v1/messages');
    expect(requests[0].headers).toMatchObject({
      'x-api-key': 'sk-ant-key',
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(requests[0].body).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 2000, stream: true });
    expect(requests[0].body.thinking).toBeUndefined();
    expect(result).toMatchObject({ text: 'Hi', toolCalls: [], usage: { input: 12, output: 7 }, finishReason: 'end_turn' });
    expect(result.replay).toBeUndefined();
  });

  it('thinking adds its budget on top of max_tokens and returns the blocks as replay data', async () => {
    const requests = captureFetch(
      textStream('Hi', [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the planner.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      ])
    );
    const result = await anthropicAdapter.chat(endpoint, request({ thinking: true }), {});
    expect(requests[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(requests[0].body.max_tokens).toBe(3024);
    expect(result.replay).toEqual({ adapter: 'anthropic', items: [thinkingBlock] });
  });

  it('does not ask for thinking mid tool loop when the open turn has no thinking blocks', async () => {
    const requests = captureFetch(textStream('Done'));
    await anthropicAdapter.chat(
      endpoint,
      request({
        thinking: true,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'x', args: {} }] }, // e.g. produced by Gemini
          { role: 'user', content: '', toolResults: [{ id: 'tu_1', name: 'x', result: '{}' }] },
        ],
      }),
      {}
    );
    expect(requests[0].body.thinking).toBeUndefined();
  });

  it('a model known not to think is never asked', async () => {
    const requests = captureFetch(textStream('Hi'));
    await anthropicAdapter.chat(endpoint, request({ thinking: true, model: 'claude-3-5-haiku-latest' }), {});
    expect(requests[0].body.thinking).toBeUndefined();
  });

  it('has no embeddings', () => {
    expect(anthropicAdapter.embed).toBeUndefined();
  });
});
