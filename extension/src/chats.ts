import type { Message } from './ui/model';
import { persistableMessage, type ChatUsage, type ContextDigest, type ContextMeasure, type ConversationMessage } from './agent/history';
import type { LoadedTool } from './connections/tools';

/**
 * Chats as they are kept per Canvas identity (`localStorage[slot.chatsKey]`). Pure apart from
 * `readChats` / `writeStorage`; `App` owns the state and mirrors it here (see
 * `reference/02-agent-loop.md` → Chat persistence).
 */

export interface Chat {
  id: string;
  title: string;
  /** Display only: the bubbles the UI shows. */
  messages: Message[];
  /** Model-facing turns incl. tool calls/results (capped). */
  apiHistory: ConversationMessage[];
  /** Compact memory for turns that were summarized away. */
  contextDigests: ContextDigest[];
  /** Connection tools this chat has loaded (lazy loading). */
  loadedTools?: LoadedTool[];
  /** Token totals the provider reported, answers vs digests. */
  usage?: ChatUsage;
  /** The provider's count of the last call's input. */
  contextMeasure?: ContextMeasure;
  createdAt: Date;
  updatedAt: Date;
}

/** What a run (or a command) saves of the chat it works on. */
export interface ChatSnapshot {
  messages: Message[];
  history: ConversationMessage[];
  digests: ContextDigest[];
  loaded: LoadedTool[];
  usage: ChatUsage;
  measure: ContextMeasure | undefined;
}

export const NEW_CHAT_TITLE = 'New chat';

export function newChat(now = new Date()): Chat {
  return {
    id: now.getTime().toString(),
    title: NEW_CHAT_TITLE,
    messages: [],
    apiHistory: [],
    contextDigests: [],
    loadedTools: [],
    usage: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function snapshotOf(chat: Chat | null): ChatSnapshot {
  return {
    messages: chat?.messages ?? [],
    history: chat?.apiHistory ?? [],
    digests: chat?.contextDigests ?? [],
    loaded: chat?.loadedTools ?? [],
    usage: chat?.usage ?? {},
    measure: chat?.contextMeasure,
  };
}

/** A chat's title: the first line of its first user message, clipped. */
export function chatTitleFor(content: string): string {
  const firstLine = content.trim().split('\n')[0];
  return firstLine.length > 48 ? firstLine.slice(0, 47) + '…' : firstLine || NEW_CHAT_TITLE;
}

/** The chat with `snapshot` saved into it; a chat still called "New chat" takes its title from its first user message. */
export function withSnapshot(chat: Chat, snapshot: ChatSnapshot, now = new Date()): Chat {
  const firstUser = snapshot.messages.find((m) => m.role === 'user' && !m.queued);
  return {
    ...chat,
    title: chat.title === NEW_CHAT_TITLE && firstUser ? chatTitleFor(firstUser.content) : chat.title,
    messages: snapshot.messages.filter((m) => !m.queued).map(persistableMessage),
    apiHistory: snapshot.history,
    contextDigests: snapshot.digests,
    loadedTools: snapshot.loaded,
    usage: snapshot.usage,
    contextMeasure: snapshot.measure,
    updatedAt: now,
  };
}

/** A chat parsed from JSON: dates revived, fields older chats lack defaulted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON of any age
export function reviveChat(raw: any): Chat {
  return {
    ...raw,
    messages: (raw.messages || []).map((m: Message) => ({ ...m, timestamp: new Date(m.timestamp) })),
    apiHistory: raw.apiHistory || [],
    loadedTools: raw.loadedTools || [],
    usage: raw.usage || {},
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    contextDigests: (raw.contextDigests || []).map((d: ContextDigest) => ({ ...d, createdAt: new Date(d.createdAt) })),
  };
}

/** The chats stored under `key`; an unreadable entry is logged and read as none. */
export function readChats(key: string): Chat[] {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved).map(reviveChat) : [];
  } catch (error) {
    console.error('Failed to load chats:', error);
    return [];
  }
}

/** Writes one localStorage entry; returns why it failed (the origin's storage is full), or null. */
export function writeStorage(key: string, value: unknown, what: string): string | null {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return null;
  } catch (error) {
    console.error(`Failed to save ${what}:`, error);
    return `Could not save ${what}: this browser's storage for CanvasBuddy is full. Delete old chats to free space.`;
  }
}
