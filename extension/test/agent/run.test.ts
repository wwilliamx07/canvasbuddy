import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent, type RunHost } from '../../src/agent/run';
import type { ToolFn } from '../../src/agent/tools';
import { snapshotOf, type ChatSnapshot } from '../../src/chats';
import { normalizeSettings, type AppSettings } from '../../src/settings';
import type { Message } from '../../src/ui/model';
import type { ToolSpec } from '../../src/providers/types';
import { apiError, captureFetch, geminiChunk, geminiStream } from '../helpers/llm';

/**
 * The agent loop against a fake host (no React) and recorded Gemini streams: what a run paints,
 * saves and sends. The loop's contract is in `reference/02-agent-loop.md`.
 */

afterEach(() => vi.unstubAllGlobals());

const TOOLS: ToolSpec[] = [{ name: 'list_content', description: 'd', parameters: { type: 'object', properties: {} } }];

const user = (content: string, id = content): Message => ({ id, role: 'user', content, timestamp: new Date() });

const answer = (text: string, usage = { promptTokenCount: 100, candidatesTokenCount: 5 }) =>
  geminiStream([{ ...geminiChunk([{ text }], 'STOP'), usageMetadata: usage }]);
const calls = (...fns: Array<{ name: string; args: object }>) =>
  geminiStream([geminiChunk(fns.map((f) => ({ functionCall: f })), 'STOP')]);

function harness(opts: { builtIn?: Record<string, ToolFn>; settings?: Partial<AppSettings>; host?: Partial<RunHost> } = {}) {
  const paints: Message[][] = [];
  const saves: ChatSnapshot[] = [];
  const queue: Message[] = [];
  const abort = new AbortController();
  const host: RunHost = {
    settings: { ...normalizeSettings({ providers: { google: { apiKey: 'AIza-key' } } }), ...opts.settings },
    systemPrompt: 'You help students.',
    signal: abort.signal,
    tools: {
      builtIn: opts.builtIn ?? {},
      live: [],
      findTool: null,
      loadLimits: { max: 8, tokenBudget: 6000 },
      declared: () => TOOLS,
      declaredTokens: () => 0,
    },
    paint: (m) => paints.push(m),
    save: (s) => saves.push(s),
    takeQueued: () => queue.shift() ?? null,
    awaitApproval: async () => 'deny',
    awaitContinue: async () => false,
    allowAlways: () => {},
    courseOverview: async () => 'The student\'s courses: CSC263 (course_id 1)',
    frame: { request: (paint) => (queueMicrotask(paint), 1), cancel: () => {} },
    ...opts.host,
  };
  const last = () => saves[saves.length - 1];
  return { host, paints, saves, queue, abort, last };
}

describe('runAgent', () => {
  it('an answer: one bubble with its usage, the roster on the user turn, and the measure', async () => {
    const requests = captureFetch(answer('Hello there.'));
    const h = harness();
    await runAgent(h.host, snapshotOf(null), user('hi'));

    const { messages, history, usage, measure } = h.last();
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there.' },
    ]);
    expect(messages.map((m) => [m.role, m.content, m.streaming])).toEqual([
      ['user', 'hi', undefined],
      ['assistant', 'Hello there.', undefined],
    ]);
    expect(messages[1].usage).toEqual({ input: 100, output: 5 });
    expect(usage).toMatchObject({ answerCalls: 1, answers: { input: 100, output: 5 } });
    expect(measure).toEqual({ input: 100, historyLength: 1, coverage: -1 });
    // The roster rides on the latest user turn, not the system prompt
    expect(requests[0].body.contents[0].parts[0].text).toMatch(/^The student's courses: CSC263[\s\S]*hi$/);
    expect(requests[0].body.systemInstruction.parts[0].text).toBe('You help students.');
  });

  it('a tool round: string args, results as a turn, one bubble with the step', async () => {
    captureFetch(calls({ name: 'list_content', args: { kind: 'courses', limit: 5 } }), answer('Two courses.'));
    const listContent = vi.fn<ToolFn>(async (args) => JSON.stringify({ data: [args.kind, args.limit] }));
    const h = harness({ builtIn: { list_content: listContent } });
    await runAgent(h.host, snapshotOf(null), user('my courses?'));

    expect(listContent).toHaveBeenCalledWith({ kind: 'courses', limit: '5' }, h.host.settings);
    const { messages, history } = h.last();
    expect(history.map((m) => [m.role, m.content, Boolean(m.toolCalls), Boolean(m.toolResults)])).toEqual([
      ['user', 'my courses?', false, false],
      ['assistant', '', true, false],
      ['user', '', false, true],
      ['assistant', 'Two courses.', false, false],
    ]);
    expect(history[2].toolResults![0]).toMatchObject({ name: 'list_content', result: '{"data":["courses","5"]}' });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ content: 'Two courses.', steps: [{ kind: 'tool', label: 'Listing courses', status: 'done' }] });
  });

  it('steering: a message queued during a step is read after its results, and the answer gets its own bubble', async () => {
    const requests = captureFetch(calls({ name: 'list_content', args: { kind: 'courses' } }), answer('Biology too.'));
    const h = harness({
      builtIn: {
        list_content: async () => {
          h.queue.push(user('also biology'));
          return '{"data":[]}';
        },
      },
    });
    await runAgent(h.host, snapshotOf(null), user('my courses?'));

    const { messages, history } = h.last();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    expect(history[3]).toEqual({ role: 'user', content: 'also biology' });
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'my courses?'],
      ['assistant', ''],
      ['user', 'also biology'],
      ['assistant', 'Biology too.'],
    ]);
    // Gemini gets the steering text in the same user content as the tool results
    const lastContent = requests[1].body.contents.at(-1);
    expect(lastContent.parts.map((p: object) => Object.keys(p)[0])).toEqual(['functionResponse', 'text']);
  });

  it('a message queued during the final answer is the next turn of the same run', async () => {
    captureFetch(answer('First.'), answer('Second.'));
    const h = harness({ host: { courseOverview: async () => null } });
    h.queue.push(user('and then?'));
    await runAgent(h.host, snapshotOf(null), user('hi'));
    expect(h.last().history.map((m) => m.content)).toEqual(['hi', 'First.', 'and then?', 'Second.']);
  });

  it('an error keeps what was said and shows the message', async () => {
    captureFetch(calls({ name: 'list_content', args: {} }), apiError(400, 'Bad request'));
    const h = harness({ builtIn: { list_content: async () => '{}' } });
    await runAgent(h.host, snapshotOf(null), user('hi'));

    const { messages, history } = h.last();
    expect(messages.at(-1)!.content).toMatch(/^Error: API error 400.*Bad request/);
    // The tool-call turn has its results, so the history stays valid for the next request
    expect(history.at(-1)!.toolResults).toHaveLength(1);
  });

  it('Stop between two calls of a step drops the unanswered calls, keeps the text, and shows no error', async () => {
    captureFetch(
      geminiStream([geminiChunk([{ text: 'Checking.' }, { functionCall: { name: 'list_content', args: { kind: 'a' } } }, { functionCall: { name: 'list_content', args: { kind: 'b' } } }], 'STOP')])
    );
    const h = harness({
      builtIn: {
        list_content: async () => {
          h.abort.abort();
          return '{}';
        },
      },
    });
    await runAgent(h.host, snapshotOf(null), user('hi'));

    const { messages, history } = h.last();
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Checking.' },
    ]);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Checking.' });
    expect(messages.at(-1)!.steps!.map((s) => s.status)).toEqual(['done', 'error']);
    expect(messages.some((m) => m.content.startsWith('Error'))).toBe(false);
  });

  it('asks after toolRoundsBeforeAsking rounds; "stop here" ends the turn with the tool turns kept', async () => {
    const requests = captureFetch(calls({ name: 'list_content', args: {} }));
    const awaitContinue = vi.fn(async () => false);
    const h = harness({ builtIn: { list_content: async () => '{}' }, settings: { toolRoundsBeforeAsking: 1 }, host: { awaitContinue } });
    await runAgent(h.host, snapshotOf(null), user('hi'));

    expect(awaitContinue).toHaveBeenCalledWith(1);
    expect(requests).toHaveLength(1);
    expect(h.last().history.at(-1)!.toolResults).toHaveLength(1);
  });

  it('continues a chat: prior turns are sent and kept', async () => {
    const requests = captureFetch(answer('Friday.'));
    const h = harness({ host: { courseOverview: async () => null } });
    const start: ChatSnapshot = { ...snapshotOf(null), history: [{ role: 'user', content: 'A1?' }, { role: 'assistant', content: 'Due soon.' }] };
    await runAgent(h.host, start, user('when exactly?'));
    expect(requests[0].body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(h.last().history).toHaveLength(4);
  });
});
