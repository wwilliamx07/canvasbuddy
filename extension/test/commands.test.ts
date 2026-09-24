import { describe, expect, it, vi } from 'vitest';
import { chatMarkdown, COMMANDS, compactionNotice, dispatchCommand, parseCommand, type CommandContext } from '../src/commands';
import type { Message } from '../src/ui/model';

function fakeContext(over: Partial<CommandContext> = {}) {
  const notices: string[] = [];
  const ctx: CommandContext = {
    notice: (text) => notices.push(text),
    newChat: vi.fn(),
    compact: vi.fn(async () => {}),
    canCompact: () => true,
    exportChat: vi.fn(),
    hasChat: () => true,
    usage: () => ({}),
    tools: () => ({ mode: 'lazy', loaded: [], total: 40, max: 8 }),
    unloadTool: () => null,
    ...over,
  };
  return { ctx, notices };
}

describe('parseCommand', () => {
  it('reads /name and its arguments', () => {
    expect(parseCommand('/compact keep A2 details')).toEqual({ name: 'compact', args: 'keep A2 details' });
    expect(parseCommand('  /HELP  ')).toEqual({ name: 'help', args: '' });
    expect(parseCommand('/tools unload notion__search')).toEqual({ name: 'tools', args: 'unload notion__search' });
  });

  it('text that merely starts with a slash is not a command', () => {
    expect(parseCommand('/courses/123/files is broken')).toBeNull();
    expect(parseCommand('what does /compact do?')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
});

describe('dispatchCommand', () => {
  it('plain text is not handled', () => {
    expect(dispatchCommand('When is A1 due?', fakeContext().ctx, false)).toEqual({ handled: false });
  });

  it('an unknown command is refused, not sent', () => {
    expect(dispatchCommand('/sync', fakeContext().ctx, false)).toEqual({ handled: true, refused: 'Unknown command /sync · /help lists them.' });
  });

  it('only /new runs while an answer is being written', () => {
    const { ctx } = fakeContext();
    expect(dispatchCommand('/usage', ctx, true)).toEqual({ handled: true, refused: '/usage runs once the answer is finished.' });
    expect(dispatchCommand('/help', ctx, true).handled).toBe(true);
    expect(dispatchCommand('/new', ctx, true)).toEqual({ handled: true });
    expect(ctx.newChat).toHaveBeenCalledOnce();
  });

  it('/compact passes its focus, and is refused when there is nothing to compact', () => {
    const { ctx } = fakeContext();
    const out = dispatchCommand('/compact keep every due date', ctx, false);
    expect(out).toMatchObject({ handled: true });
    expect(ctx.compact).toHaveBeenCalledWith('keep every due date');
    expect(dispatchCommand('/compact', fakeContext({ canCompact: () => false }).ctx, false)).toEqual({ handled: true, refused: 'Nothing to compact yet.' });
  });

  it('/usage reports answers and summaries separately', () => {
    const { ctx, notices } = fakeContext({
      usage: () => ({ answers: { input: 41_000, output: 3200, cachedInput: 30_000 }, answerCalls: 12, digests: { input: 9000, output: 1100 }, digestCalls: 2 }),
    });
    dispatchCommand('/usage', ctx, false);
    expect(notices).toEqual(['Answers: 12 calls · 41k in (30k cached) · 3.2k out\nSummaries: 2 calls · 9k in · 1.1k out']);
    const empty = fakeContext();
    dispatchCommand('/usage', empty.ctx, false);
    expect(empty.notices).toEqual(['No model calls in this chat yet.']);
  });

  it('/tools lists the loaded set, and unload checks its arguments', () => {
    const { ctx, notices } = fakeContext({
      tools: () => ({ mode: 'lazy', loaded: [{ name: 'notion__search', label: 'Notion: Search' }], total: 40, max: 8 }),
      unloadTool: (q) => (q === 'notion__search' ? 'Notion: Search' : null),
    });
    dispatchCommand('/tools', ctx, false);
    dispatchCommand('/tools unload notion__search', ctx, false);
    dispatchCommand('/tools unload nothing', ctx, false);
    expect(notices).toEqual(['Loaded in this chat (1 of at most 8):\nNotion: Search (notion__search)', 'Unloaded Notion: Search.', 'No loaded tool matches “nothing”.']);
    expect(dispatchCommand('/tools remove x', ctx, false)).toEqual({ handled: true, refused: 'Usage: /tools [unload <name>]' });
    const eager = fakeContext({ tools: () => ({ mode: 'eager', loaded: [], total: 3, max: 8 }) });
    expect(dispatchCommand('/tools unload x', eager.ctx, false)).toMatchObject({ refused: expect.stringContaining('nothing to unload') });
    dispatchCommand('/tools', eager.ctx, false);
    expect(eager.notices).toEqual(['All 3 connection tools are sent with every message.']);
  });

  it('/help lists every command', () => {
    const { ctx, notices } = fakeContext();
    dispatchCommand('/help', ctx, false);
    expect(notices[0].split('\n')).toHaveLength(COMMANDS.length);
    expect(COMMANDS.map((c) => c.name)).toEqual(['compact', 'new', 'usage', 'export', 'tools', 'help']);
  });

  it('there is no refresh, sync or index command (memory is engine-managed)', () => {
    for (const name of ['refresh', 'sync', 'index']) expect(COMMANDS.some((c) => c.name === name)).toBe(false);
  });
});

describe('chatMarkdown / compactionNotice', () => {
  it('writes text, one line per tool step and notices in italics; queued messages are left out', () => {
    const at = new Date('2026-09-23T14:05:00');
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'When is A1 due?', timestamp: at },
      {
        id: '2',
        role: 'assistant',
        content: 'Friday at 23:59.',
        timestamp: at,
        steps: [
          { kind: 'thought', label: 'look it up', status: 'done' },
          { kind: 'tool', label: 'Listing assignments "CSC263"', status: 'done', result: '[…]' },
          { kind: 'tool', label: 'Reading "A1.pdf"', status: 'error', result: 'Not found' },
        ],
      },
      { id: '3', role: 'assistant', content: 'Compacted 4 messages\n≈2k → ≈300 tokens', timestamp: at, notice: true },
      { id: '4', role: 'user', content: 'queued', timestamp: at, queued: true },
    ];
    const md = chatMarkdown('A1 due date', messages);
    expect(md).toContain('# A1 due date');
    expect(md).toContain('**You** · ');
    expect(md).toContain('> Listing assignments "CSC263"\n> Reading "A1.pdf" — Not found\n\nFriday at 23:59.');
    expect(md).toContain('*Compacted 4 messages · ≈2k → ≈300 tokens*');
    expect(md).not.toContain('look it up');
    expect(md).not.toContain('queued');
  });

  it('compactionNotice', () => {
    expect(compactionNotice(42, 18_400, 1_300)).toBe('Compacted 42 messages · ≈18k → ≈1.3k tokens');
  });
});
