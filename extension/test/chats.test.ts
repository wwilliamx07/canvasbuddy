import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatTitleFor, newChat, readChats, reviveChat, snapshotOf, withSnapshot, writeStorage } from '../src/chats';
import type { Message } from '../src/ui/model';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const msg = (over: Partial<Message>): Message => ({ id: 'm', role: 'user', content: '', timestamp: new Date('2026-09-23T12:00:00Z'), ...over });

describe('chats', () => {
  it('a new chat takes its title from its first user message, once', () => {
    const chat = newChat(new Date('2026-09-23T12:00:00Z'));
    const first = withSnapshot(chat, { ...snapshotOf(chat), messages: [msg({ content: 'When is A1 due?\nand A2' })] });
    expect(first.title).toBe('When is A1 due?');
    const later = withSnapshot(first, { ...snapshotOf(first), messages: [msg({ content: 'Something else' })] });
    expect(later.title).toBe('When is A1 due?');
    expect(chatTitleFor('x'.repeat(60))).toHaveLength(48);
  });

  it('a queued message is neither saved nor used as the title; transient flags are dropped', () => {
    const chat = newChat();
    const saved = withSnapshot(chat, {
      ...snapshotOf(chat),
      messages: [msg({ content: 'queued', queued: true }), msg({ role: 'assistant', content: 'hi', streaming: true })],
    });
    expect(saved.title).toBe('New chat');
    expect(saved.messages).toEqual([msg({ role: 'assistant', content: 'hi' })]);
  });

  it('round-trips through storage with dates revived and missing fields defaulted', () => {
    const chat = withSnapshot(newChat(), { ...snapshotOf(null), messages: [msg({ content: 'hi' })] });
    expect(writeStorage('k', [chat], 'your chats')).toBeNull();
    const [read] = readChats('k');
    expect(read.messages[0].timestamp).toBeInstanceOf(Date);
    expect(read.updatedAt).toBeInstanceOf(Date);
    expect(reviveChat({ id: '1', title: 't', messages: [], createdAt: 0, updatedAt: 0 })).toMatchObject({ apiHistory: [], loadedTools: [], usage: {}, contextDigests: [] });
  });

  it('an unreadable entry reads as no chats; a full storage is reported, not thrown', () => {
    localStorage.setItem('bad', '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readChats('bad')).toEqual([]);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(writeStorage('k', [], 'your chats')).toMatch(/Could not save your chats: .*full/);
  });
});
