import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextSize, digestToThreshold } from '../../src/agent/digest';
import type { ConversationMessage } from '../../src/agent/history';
import { normalizeSettings } from '../../src/settings';
import { captureFetch, geminiChunk, geminiStream } from '../helpers/llm';

afterEach(() => vi.unstubAllGlobals());

const settings = (contextThreshold: number) => ({ ...normalizeSettings({ providers: { google: { apiKey: 'k' } } }), contextThreshold });
const digestReply = (text: string) => geminiStream([{ ...geminiChunk([{ text }], 'STOP'), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }]);
const turns = (n: number, chars: number): ConversationMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'x'.repeat(chars)}` }));

describe('digests', () => {
  it('contextSize uses the provider count while it describes the history, else estimates', () => {
    const history = turns(3, 400);
    expect(contextSize(history, [], { input: 5000, historyLength: 2, coverage: -1 }, 'prompt', 0)).toEqual({ tokens: 5000 + 101 + 4, measured: true });
    expect(contextSize(history, [], undefined, 'prompt', 0).measured).toBe(false);
  });

  it('under the threshold nothing is digested and no call is made', async () => {
    const requests = captureFetch();
    const result = await digestToThreshold({ history: turns(3, 100), digests: [], measure: undefined, systemPrompt: 'p', connectionToolTokens: 0, settings: settings(1_000_000) });
    expect(result).toEqual({ digests: [], usage: [] });
    expect(requests).toHaveLength(0);
  });

  it('digests the oldest turns until it fits, never the latest turn', async () => {
    const history = turns(6, 8000); // ≈2k tokens a turn
    const requests = captureFetch(...Array.from({ length: 6 }, (_, i) => digestReply(`digest ${i}`)));
    const result = await digestToThreshold({ history, digests: [], measure: undefined, systemPrompt: 'p', connectionToolTokens: 0, settings: settings(5000) });

    expect(result.digests.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(result.digests.length);
    expect(result.usage).toHaveLength(result.digests.length);
    const covered = result.digests.map((d) => d.coversUpToIndex!);
    expect(covered).toEqual([...covered].sort((a, b) => a - b));
    expect(Math.max(...covered)).toBeLessThan(history.length - 1);
    // The instruction comes last, in a user turn (Gemini rejects requests ending on a model turn)
    expect(requests[0].body.contents.at(-1).role).toBe('user');
    expect(requests[0].body.contents.at(-1).parts.at(-1).text).toMatch(/^Summarize this conversation segment/);
  });
});
