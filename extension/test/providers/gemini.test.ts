import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractTextContent,
  extractTextThoughtSignature,
  GEMINI_SKIP_SIGNATURE,
  geminiAdapter,
  geminiTools,
  parseGeminiFunctionCalls,
  readGeminiStream,
  toGeminiRequest,
  usageFromGemini,
} from '../../src/providers/gemini';
import type { ConversationMessage } from '../../src/agent/history';
import type { ChatRequest, ProviderEndpoint, ToolSpec } from '../../src/providers/types';
import { apiError, captureFetch, geminiChunk, geminiStream, sseResponse } from '../helpers/llm';

afterEach(() => vi.unstubAllGlobals());

const history: ConversationMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'system', content: '[Conversation memory] earlier' },
  { role: 'user', content: 'When is A1 due?' },
  { role: 'assistant', content: 'Let me check.', thoughtSignature: 'sig-text', toolCalls: [{ id: 'call_0', name: 'list_content', args: { kind: 'assignments' }, thoughtSignature: 'sig-call' }] },
  { role: 'user', content: '', toolResults: [{ id: 'call_0', name: 'list_content', result: '{"rows":[{"name":"A1"}]}' }] },
  { role: 'assistant', content: 'Friday.', thoughtSignature: 'sig-answer' },
];

const endpoint: ProviderEndpoint = { provider: 'google', baseUrl: 'https://gemini.test/v1beta', apiKey: 'AIza-key' };
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  model: 'gemini-3.5-flash-lite',
  maxOutputTokens: 2000,
  thinking: false,
  ...over,
});

describe('toGeminiRequest', () => {
  it('folds system messages into systemInstruction and maps tool turns to parts', () => {
    const { systemInstruction, contents } = toGeminiRequest(history);
    expect(systemInstruction).toEqual({ parts: [{ text: 'You are helpful.\n\n[Conversation memory] earlier' }] });
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'When is A1 due?' }] },
      {
        role: 'model',
        parts: [
          { text: 'Let me check.', thoughtSignature: 'sig-text' },
          { functionCall: { name: 'list_content', args: { kind: 'assignments' } }, thoughtSignature: 'sig-call' },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'list_content', response: { result: { rows: [{ name: 'A1' }] } } } }] },
      { role: 'model', parts: [{ text: 'Friday.', thoughtSignature: 'sig-answer' }] },
    ]);
  });

  it('marks only the first call of an unsigned replayed turn with the skip placeholder', () => {
    const { contents } = toGeminiRequest([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {} }] },
    ]);
    expect(contents[1].parts).toEqual([
      { functionCall: { name: 'x', args: {} }, thoughtSignature: GEMINI_SKIP_SIGNATURE },
      { functionCall: { name: 'y', args: {} } },
    ]);
  });

  it('adds no placeholder when any call of the turn is signed', () => {
    const { contents } = toGeminiRequest([
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {}, thoughtSignature: 's' }] },
    ]);
    expect(contents[0].parts[0]).toEqual({ functionCall: { name: 'x', args: {} } });
  });

  it('merges a steering message into the user content that carries the tool results', () => {
    const { contents } = toGeminiRequest([
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {}, thoughtSignature: 's' }] },
      { role: 'user', content: '', toolResults: [{ id: 'a', name: 'x', result: 'plain text' }] },
      { role: 'user', content: 'Actually, the other course.' },
    ]);
    expect(contents).toHaveLength(2);
    expect(contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'x', response: { result: 'plain text' } } }, { text: 'Actually, the other course.' }],
    });
  });

  it('leaves out an empty model turn (Gemini rejects an empty text part) and merges the user turns around it', () => {
    const { contents } = toGeminiRequest([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'hello?' },
    ]);
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }, { text: 'hello?' }] }]);
  });

  it('ignores replay data from other adapters', () => {
    const { contents } = toGeminiRequest([{ role: 'assistant', content: 'ok', replay: { adapter: 'anthropic', items: [{ type: 'thinking' }] } }]);
    expect(contents).toEqual([{ role: 'model', parts: [{ text: 'ok' }] }]);
  });
});

describe('geminiTools', () => {
  it('a simple JSON Schema becomes OpenAPI `parameters` with upper-case types', () => {
    const tool: ToolSpec = {
      name: 'list_content',
      description: 'List',
      parameters: { type: 'object', properties: { kind: { type: 'string', description: 'k', enum: ['a', 'b'] }, limit: { type: 'integer', description: 'n' } }, required: ['kind'] },
    };
    expect(geminiTools([tool])).toEqual([
      {
        name: 'list_content',
        description: 'List',
        parameters: {
          type: 'OBJECT',
          properties: { kind: { type: 'STRING', description: 'k', enum: ['a', 'b'] }, limit: { type: 'INTEGER', description: 'n' } },
          required: ['kind'],
        },
      },
    ]);
  });

  it('a schema with keywords outside the OpenAPI subset goes as parametersJsonSchema, unchanged', () => {
    const parameters = { type: 'object' as const, properties: { filter: { type: 'object', additionalProperties: true } } };
    expect(geminiTools([{ name: 'notion__search', description: '[Notion] Search', parameters }])).toEqual([
      { name: 'notion__search', description: '[Notion] Search', parametersJsonSchema: parameters },
    ]);
  });
});

describe('parsing responses', () => {
  it('one or many calls, synthetic ids, signatures kept', () => {
    const calls = parseGeminiFunctionCalls({
      candidates: [{ content: { parts: [{ text: 'hm' }, { functionCall: { name: 'a', args: { x: 1 } }, thoughtSignature: 's1' }, { functionCall: { name: 'b' } }] } }],
    });
    expect(calls).toEqual([
      { id: 'call_0', name: 'a', args: { x: 1 }, thoughtSignature: 's1' },
      { id: 'call_1', name: 'b', args: {} },
    ]);
  });

  it('text and its signature exclude thought parts', () => {
    const data = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Answer', thoughtSignature: 'sig' }] } }] };
    expect(extractTextContent(data)).toBe('Answer');
    expect(extractTextThoughtSignature(data)).toBe('sig');
    expect(parseGeminiFunctionCalls({})).toEqual([]);
  });

  it('usage counts thoughts as output and reports cached input', () => {
    expect(usageFromGemini({ promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 60, cachedContentTokenCount: 512 })).toEqual({
      input: 900,
      output: 100,
      cachedInput: 512,
      reasoning: 60,
    });
    expect(usageFromGemini(undefined)).toBeUndefined();
  });
});

describe('readGeminiStream', () => {
  it('merges deltas into one text part and keeps a trailing empty part’s signature', async () => {
    const deltas: string[] = [];
    const data = await readGeminiStream(
      geminiStream([geminiChunk([{ text: 'Fri' }]), geminiChunk([{ text: 'day.' }]), geminiChunk([{ text: '', thoughtSignature: 'sig-end' }], 'STOP')], { splitEvery: 7 }),
      (t) => deltas.push(t)
    );
    expect(deltas.join('')).toBe('Friday.');
    expect(data.candidates[0].content.parts).toEqual([{ text: 'Friday.', thoughtSignature: 'sig-end' }]);
    expect(data.candidates[0].finishReason).toBe('STOP');
    expect(extractTextThoughtSignature(data)).toBe('sig-end');
  });

  it('forwards thoughts separately and keeps them out of the visible text', async () => {
    const thoughts: string[] = [];
    const data = await readGeminiStream(
      geminiStream([geminiChunk([{ text: '**Plan** look it up', thought: true }]), geminiChunk([{ text: ' first', thought: true }]), geminiChunk([{ text: 'Done' }])]),
      () => {},
      (t) => thoughts.push(t)
    );
    expect(thoughts.join('')).toBe('**Plan** look it up first');
    expect(extractTextContent(data)).toBe('Done');
  });

  it('keeps function-call parts with their own signatures', async () => {
    const data = await readGeminiStream(
      geminiStream([geminiChunk([{ functionCall: { name: 'list_content', args: { kind: 'courses' } }, thoughtSignature: 'sig-call' }])]),
      () => {}
    );
    expect(parseGeminiFunctionCalls(data)).toEqual([{ id: 'call_0', name: 'list_content', args: { kind: 'courses' }, thoughtSignature: 'sig-call' }]);
  });

  it('keeps the last usageMetadata', async () => {
    const data = await readGeminiStream(
      geminiStream([{ ...geminiChunk([{ text: 'a' }]), usageMetadata: { promptTokenCount: 1 } }, { ...geminiChunk([{ text: 'b' }], 'STOP'), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }]),
      () => {}
    );
    expect(data.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 2 });
  });

  it('throws on an error event', async () => {
    await expect(readGeminiStream(sseResponse([{ error: { message: 'quota exceeded' } }]), () => {})).rejects.toThrow('quota exceeded');
  });
});

describe('geminiAdapter.chat', () => {
  it('streams with the key in a header and returns calls, signature and usage', async () => {
    const requests = captureFetch(
      geminiStream([
        geminiChunk([{ text: 'Checking.', thoughtSignature: 'sig' }]),
        { ...geminiChunk([{ functionCall: { name: 'list_content', args: { kind: 'courses' } } }], 'STOP'), usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } },
      ])
    );
    const deltas: string[] = [];
    const result = await geminiAdapter.chat(endpoint, request({ tools: [{ name: 'list_content', description: 'd', parameters: { type: 'object', properties: {} } }] }), {
      onDelta: (t) => deltas.push(t),
    });
    expect(requests[0].url).toBe('https://gemini.test/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
    expect(requests[0].headers['x-goog-api-key']).toBe('AIza-key');
    expect(requests[0].body.generationConfig).toEqual({ maxOutputTokens: 2000 });
    expect(requests[0].body.tools[0].functionDeclarations[0].name).toBe('list_content');
    expect(deltas).toEqual(['Checking.']);
    expect(result).toMatchObject({
      text: 'Checking.',
      thoughtSignature: 'sig',
      toolCalls: [{ id: 'call_0', name: 'list_content', args: { kind: 'courses' } }],
      usage: { input: 50, output: 5 },
    });
  });

  it('asks for thoughts only when wanted, and forwards them', async () => {
    const requests = captureFetch(geminiStream([geminiChunk([{ text: 'hmm', thought: true }]), geminiChunk([{ text: 'Hi' }], 'STOP')]));
    const thoughts: string[] = [];
    await geminiAdapter.chat(endpoint, request({ thinking: true }), { onThought: (t) => thoughts.push(t) });
    expect(requests[0].body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect(thoughts).toEqual(['hmm']);
  });

  it('never asks a model known not to think', async () => {
    const requests = captureFetch(geminiStream([geminiChunk([{ text: 'Hi' }], 'STOP')]));
    await geminiAdapter.chat(endpoint, request({ thinking: true, model: 'gemini-2.0-flash' }), {});
    expect(requests[0].body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('retries without thoughts when the model rejects thinkingConfig', async () => {
    const requests = captureFetch(apiError(400, 'Thinking is not supported by this model.'), geminiStream([geminiChunk([{ text: 'Hi' }], 'STOP')]));
    const result = await geminiAdapter.chat(endpoint, request({ thinking: true, model: 'gemma-3' }), {});
    expect(requests).toHaveLength(2);
    expect(requests[1].body.generationConfig.thinkingConfig).toBeUndefined();
    expect(result.text).toBe('Hi');
  });

  it('an empty answer with a non-STOP finish reason is an error', async () => {
    captureFetch(geminiStream([geminiChunk([], 'MAX_TOKENS')]));
    await expect(geminiAdapter.chat(endpoint, request(), {})).rejects.toThrow('The model returned no answer (finish reason: MAX_TOKENS).');
  });
});

describe('geminiAdapter.embed', () => {
  it('asks for 768 dimensions with the task type, in batches of 20', async () => {
    const vec = new Array(768).fill(0.1);
    const reply = (n: number) => new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: vec })) }));
    const requests = captureFetch(reply(20), reply(5));
    const out = await geminiAdapter.embed!(endpoint, Array.from({ length: 25 }, (_, i) => `t${i}`), 'models/gemini-embedding-2', 'query');
    expect(out).toHaveLength(25);
    expect(requests[0].url).toBe('https://gemini.test/v1beta/models/gemini-embedding-2:batchEmbedContents');
    expect(requests[0].body.requests[0]).toEqual({ model: 'models/gemini-embedding-2', content: { parts: [{ text: 't0' }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 });
    expect(requests[1].body.requests).toHaveLength(5);
  });
});
