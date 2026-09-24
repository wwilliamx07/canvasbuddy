import { describe, expect, it } from 'vitest';
import {
  addUsage,
  buildApiHistory,
  capHistory,
  capToolResults,
  countUsage,
  estimateMessageTokens,
  measuredContextTokens,
  describeToolCall,
  estimateConversationTokens,
  joinText,
  PERSISTED_TOOL_RESULT_MAX,
  persistableMessage,
  STEP_DETAIL_MAX,
  STEP_RESULT_MAX,
  STEP_THOUGHT_MAX,
  takeMessagesByTokenBudget,
  TOOL_SCHEMA_TOKENS,
  toolStepOutcome,
  type ContextDigest,
  type ConversationMessage,
} from '../../src/agent/history';
import type { Message } from '../../src/ui/model';
import { TOOL_CONFIG } from '../../src/agent/tools';

const big = (n: number) => 'x'.repeat(n * 4); // ≈ n tokens

describe('takeMessagesByTokenBudget', () => {
  const turns: ConversationMessage[] = [
    { role: 'user', content: big(100) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'list_content', args: {} }] },
    { role: 'user', content: '', toolResults: [{ id: 'c', name: 'list_content', result: big(500) }] },
    { role: 'assistant', content: big(50) },
    { role: 'user', content: big(50) },
  ];

  it('never separates a tool-call turn from its results, even past the budget', () => {
    const taken = takeMessagesByTokenBudget(turns, 150);
    expect(taken).toHaveLength(3);
    expect(taken[2].toolResults).toBeDefined();
  });

  it('never ends on a turn that is waiting for tool results', () => {
    const taken = takeMessagesByTokenBudget(turns.slice(1), 1);
    expect(taken.map((m) => Boolean(m.toolCalls))).toEqual([true, false]);
  });

  it('always takes at least one turn', () => {
    expect(takeMessagesByTokenBudget([{ role: 'user', content: big(1000) }], 10)).toHaveLength(1);
  });
});

describe('buildApiHistory', () => {
  const digests: ContextDigest[] = [
    { id: 'd2', kind: 'conversation', content: 'second', createdAt: new Date('2026-09-02T00:00:00Z'), coversUpToIndex: 1 },
    { id: 'd1', kind: 'conversation', content: 'first', createdAt: new Date('2026-09-01T00:00:00Z'), coversUpToIndex: 0 },
  ];
  const turns: ConversationMessage[] = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', args: {} }] },
    { role: 'user', content: '', toolResults: [{ id: 'c', name: 'x', result: '{}' }] },
  ];

  it('prompt first, digests oldest first as system messages, then the un-digested turns', () => {
    const out = buildApiHistory(turns, digests, 'PROMPT');
    expect(out[0]).toEqual({ role: 'system', content: 'PROMPT' });
    expect(out[1]).toEqual({ role: 'system', content: '[Conversation memory | 2026-09-01T00:00:00.000Z]\nfirst' });
    expect(out[2].content).toContain('second');
    expect(out.slice(3).map((m) => m.content)).toEqual(['new question', '', '']);
  });

  it('puts the roster on the latest real user turn (not a tool-result turn) and leaves the input alone', () => {
    const out = buildApiHistory(turns, [], 'PROMPT', 'ROSTER');
    const newQuestion = out.find((m) => m.content.endsWith('new question'))!;
    expect(newQuestion.content).toBe('ROSTER\n\n---\n\nnew question');
    expect(out.filter((m) => m.content.startsWith('ROSTER'))).toHaveLength(1);
    expect(turns[2].content).toBe('new question');
  });

  it('estimates tokens including the tool schemas and any extra tool definitions', () => {
    const messages: ConversationMessage[] = [{ role: 'user', content: big(10) }];
    expect(estimateConversationTokens(messages)).toBe(TOOL_SCHEMA_TOKENS + 14);
    expect(estimateConversationTokens(messages, 100)).toBe(TOOL_SCHEMA_TOKENS + 114);
  });
});

describe('persisted turns and steps', () => {
  it('capToolResults cuts long results', () => {
    const capped = capToolResults({ role: 'user', content: '', toolResults: [{ id: 'a', name: 'x', result: 'y'.repeat(2000) }, { id: 'b', name: 'x', result: 'short' }] });
    expect(capped.toolResults![0].result).toHaveLength(PERSISTED_TOOL_RESULT_MAX + '…[truncated]'.length);
    expect(capped.toolResults![1].result).toBe('short');
  });

  it.each([
    ['list_content', { kind: 'assignments', search: ' CSC263 ' }, 'Listing assignments "CSC263"'],
    ['search_documents', { query: 'pumping lemma', document_id: '5' }, 'Searching the document for "pumping lemma"'],
    ['read_document', { document_type: 'file', pages: '3-5' }, 'Reading file pages 3-5'],
    ['get_inbox', {}, 'Checking the inbox'],
    ['get_discussions', { search: 'midterm' }, 'Checking discussions "midterm"'],
    ['find_connection_tools', { query: 'create page', service: 'Notion' }, 'Looking for Notion tools "create page"'],
    ['mystery', {}, 'Running mystery'],
  ])('describeToolCall %s', (name, args, label) => {
    expect(describeToolCall(name, args)).toBe(label);
  });

  it('every built-in tool has its own step label', () => {
    for (const tool of TOOL_CONFIG) expect(describeToolCall(tool.name, {})).not.toMatch(/^Running /);
  });

  it('toolStepOutcome flags { error } results and clips the rest', () => {
    expect(toolStepOutcome('{"error":"Course not found"}')).toEqual({ result: 'Course not found', status: 'error' });
    expect(toolStepOutcome('{"rows":[]}')).toEqual({ result: '{"rows":[]}', status: 'done' });
    expect(toolStepOutcome('plain text')).toEqual({ result: 'plain text', status: 'done' });
    expect(toolStepOutcome(`"${'z'.repeat(1000)}"`).result).toHaveLength(STEP_RESULT_MAX + 1);
  });

  it('persistableMessage drops transient flags and caps step text', () => {
    const message: Message = {
      id: '1',
      role: 'assistant',
      content: 'Answer',
      timestamp: new Date(),
      streaming: true,
      queued: true,
      steps: [
        { kind: 'thought', label: 't'.repeat(5000), status: 'done' },
        { kind: 'tool', label: 'Listing', detail: 'd'.repeat(900), result: 'r'.repeat(900), status: 'done' },
      ],
    };
    const saved = persistableMessage(message);
    expect(saved).not.toHaveProperty('streaming');
    expect(saved).not.toHaveProperty('queued');
    expect(saved.steps![0].label).toHaveLength(STEP_THOUGHT_MAX + 1);
    expect(saved.steps![1].detail).toHaveLength(STEP_DETAIL_MAX + 1);
    expect(saved.steps![1].result).toHaveLength(STEP_RESULT_MAX + 1);
  });

  it('joinText separates non-empty parts with a blank line', () => {
    expect(joinText('a', 'b')).toBe('a\n\nb');
    expect(joinText('', 'b')).toBe('b');
    expect(joinText('a', '')).toBe('a');
  });
});

describe('usage', () => {
  it('addUsage sums, keeps optional parts only when non-zero, and tolerates a missing side', () => {
    expect(addUsage({ input: 100, output: 10, cachedInput: 60 }, { input: 50, output: 5, reasoning: 3 })).toEqual({ input: 150, output: 15, cachedInput: 60, reasoning: 3 });
    expect(addUsage(undefined, { input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
    expect(addUsage(undefined, undefined)).toBeUndefined();
  });

  it('countUsage keeps answers and digests apart and counts calls, even without usage', () => {
    let total = countUsage({}, 'answer', { input: 100, output: 10 });
    total = countUsage(total, 'answer', undefined);
    total = countUsage(total, 'digest', { input: 40, output: 8 });
    expect(total).toEqual({ answers: { input: 100, output: 10 }, answerCalls: 2, digests: { input: 40, output: 8 }, digestCalls: 1 });
  });
});

describe('measured context', () => {
  const history: ConversationMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: big(100) },
  ];
  const digest = (coversUpToIndex: number): ContextDigest => ({ id: 'd', kind: 'conversation', content: 'x', createdAt: new Date(), coversUpToIndex });

  it('is the measured input plus an estimate of the turns added since', () => {
    const measure = { input: 5000, historyLength: 2, coverage: -1 };
    expect(measuredContextTokens(history, [], measure)).toBe(5000 + estimateMessageTokens(history[2]));
    expect(measuredContextTokens(history.slice(0, 2), [], measure)).toBe(5000);
  });

  it('is null without a measure, after a new digest, or when the history got shorter than the measure', () => {
    expect(measuredContextTokens(history, [], undefined)).toBeNull();
    expect(measuredContextTokens(history, [digest(0)], { input: 5000, historyLength: 2, coverage: -1 })).toBeNull();
    expect(measuredContextTokens(history.slice(0, 1), [], { input: 5000, historyLength: 2, coverage: -1 })).toBeNull();
    expect(measuredContextTokens(history, [digest(0)], { input: 5000, historyLength: 2, coverage: 0 })).not.toBeNull();
  });

  it('capHistory takes what capping removed inside the measured turns off the measure', () => {
    const long: ConversationMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_document', args: {} }] },
      { role: 'user', content: '', toolResults: [{ id: 'c', name: 'read_document', result: big(5000) }] },
      { role: 'assistant', content: 'answer' },
    ];
    const removed = estimateMessageTokens(long[2]) - estimateMessageTokens(capToolResults(long[2]));
    const out = capHistory(long, { input: 30_000, historyLength: 3, coverage: -1 });
    expect(out.history[2].toolResults![0].result.length).toBeLessThan(PERSISTED_TOOL_RESULT_MAX + 20);
    expect(out.measure).toEqual({ input: 30_000 - removed, historyLength: 3, coverage: -1 });
    // a result outside the measured turns does not touch the measure
    expect(capHistory(long, { input: 900, historyLength: 2, coverage: -1 }).measure).toEqual({ input: 900, historyLength: 2, coverage: -1 });
    expect(capHistory(long, undefined).measure).toBeUndefined();
  });
});
