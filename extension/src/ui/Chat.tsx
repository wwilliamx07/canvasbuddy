import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Dot, Plus, Square, Trash2 } from 'lucide-react';
import type { AppModel, ChatSummary, Message } from './model';
import { timeAgo } from './format';
import { renderMarkdown } from '../utils/markdown';
import { Logo } from './primitives';

const MAX_TEXTAREA_LINES = 4;

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-(--ink-mute)"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}

function ActivityList({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1">
      {lines.map((line, i) => (
        <li key={i} className="flex items-start gap-1 text-[11.5px] tracking-wide text-(--ink-mute) uppercase">
          <Dot size={14} className="mt-[-1px] shrink-0 text-(--accent)" />
          <span className="truncate normal-case">{line}</span>
        </li>
      ))}
    </ul>
  );
}

function AssistantMark() {
  return <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent)" aria-hidden />;
}

function Timestamp({ date, align = 'left' }: { date: Date; align?: 'left' | 'right' }) {
  return (
    <div className={`mt-1 text-[10.5px] text-(--ink-mute) ${align === 'right' ? 'text-right' : ''}`}>
      {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  );
}

function MessageRow({ message, isFirst }: { message: Message; isFirst: boolean }) {
  const separator = message.role === 'user' && !isFirst;
  if (message.role === 'user') {
    return (
      <div className={separator ? 'mt-5 border-t border-(--line) pt-5' : ''}>
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-(--user-bubble) px-3.5 py-2 text-[13.5px] break-words whitespace-pre-wrap text-(--ink)">
            {message.content}
          </div>
        </div>
        <Timestamp date={message.timestamp} align="right" />
      </div>
    );
  }

  const hasContent = message.content.length > 0;
  const activityOnly = !hasContent && (message.activity?.length ?? 0) > 0;
  const thinking = !hasContent && !activityOnly;

  return (
    <div className="flex gap-2">
      <AssistantMark />
      <div className="min-w-0 flex-1">
        {message.activity && message.activity.length > 0 && <div className="mb-1.5">
          <ActivityList lines={message.activity} />
        </div>}
        {thinking && message.streaming && <TypingDots />}
        {hasContent && (
          <div
            className={`prose prose-sm max-w-none break-words [&_*]:break-words [&_code]:break-all [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto ${
              message.streaming ? 'streaming-caret' : ''
            }`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
        {(hasContent || activityOnly) && <Timestamp date={message.timestamp} />}
      </div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex gap-2">
      <AssistantMark />
      <TypingDots />
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <Logo size={88} className="mb-2" />
      <div className="serif text-[20px] text-(--ink)">What are you working on?</div>
      <p className="max-w-[32ch] text-[13px] text-(--ink-mute)">
        Ask about due dates, lecture content, or anything else in your courses — CanvasBuddy reads it straight from Canvas.
      </p>
    </div>
  );
}

export function ChatArea({ model }: { model: AppModel }) {
  const { messages, isLoading, sendMessage, stop } = model;
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const lineHeight = 18;
    const max = lineHeight * MAX_TEXTAREA_LINES + 16;
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  }, [draft]);

  const anyStreaming = messages.some((m) => m.streaming);
  const showLoadingRow = isLoading && !anyStreaming;

  const send = () => {
    const text = draft.trim();
    if (!text || isLoading) return;
    sendMessage(text);
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !showLoadingRow ? (
          <EmptyChat />
        ) : (
          <div>
            {messages.map((m, i) => (
              <div key={m.id} className={i > 0 ? 'mt-4' : ''}>
                <MessageRow message={m} isFirst={i === 0} />
              </div>
            ))}
            {showLoadingRow && <div className={messages.length > 0 ? 'mt-4' : ''}><LoadingRow /></div>}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-(--line) px-3 py-2.5">
        <div className="flex items-end gap-2 rounded-2xl border border-(--line) bg-(--bg-raised) px-3 py-2">
          <textarea
            ref={taRef}
            value={draft}
            disabled={isLoading}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about a course…"
            rows={1}
            className="max-h-[88px] min-h-[20px] flex-1 resize-none bg-transparent text-[13.5px] leading-[18px] outline-none placeholder:text-(--ink-mute) disabled:opacity-60"
          />
          <button
            type="button"
            aria-label={isLoading ? 'Stop' : 'Send'}
            onClick={isLoading ? stop : send}
            disabled={!isLoading && draft.trim() === ''}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--accent) text-(--accent-ink) transition-opacity disabled:opacity-30"
          >
            {isLoading ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} strokeWidth={2} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatListPopover({
  chats,
  currentChatId,
  onSelect,
  onDelete,
  onNew,
  onClose,
}: {
  chats: ChatSummary[];
  currentChatId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const sorted = [...chats].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return (
    <>
      <motion.div
        className="absolute inset-0 z-20 bg-black/5"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      />
      <motion.div
        className="absolute inset-x-2 top-2 z-30 max-h-[70%] overflow-y-auto rounded-xl border border-(--line) bg-(--bg-raised) py-1"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <button
          type="button"
          onClick={() => {
            onNew();
            onClose();
          }}
          className="flex w-full items-center gap-2 border-b border-(--line) px-3 py-2.5 text-left text-[13px] font-medium text-(--accent) hover:bg-(--accent-soft)"
        >
          <Plus size={15} /> New chat
        </button>
        <AnimatePresence initial={false}>
          {sorted.map((c) => (
            <motion.div
              key={c.id}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className={`group flex items-center gap-2 px-3 py-2 ${c.id === currentChatId ? 'bg-(--accent-soft)' : 'hover:bg-(--bg-sunken)'}`}
            >
              <button
                type="button"
                onClick={() => {
                  onSelect(c.id);
                  onClose();
                }}
                className="min-w-0 flex-1 text-left"
              >
                <div className={`truncate text-[13px] ${c.id === currentChatId ? 'text-(--accent)' : 'text-(--ink)'}`}>{c.title}</div>
                <div className="text-[11px] text-(--ink-mute)">{timeAgo(c.updatedAt)}</div>
              </button>
              <button
                type="button"
                aria-label="Delete chat"
                onClick={() => onDelete(c.id)}
                className="rounded-full p-1.5 text-(--ink-mute) opacity-0 hover:bg-(--bg-sunken) hover:text-(--error) group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        {sorted.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-(--ink-mute)">No chats yet</div>}
      </motion.div>
    </>
  );
}
