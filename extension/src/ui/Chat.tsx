import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, ChevronRight, CircleAlert, Clock, Plus, Square, Trash2 } from 'lucide-react';
import type { AppModel, ApprovalDecision, ChatSummary, CommandInfo, Message, Step } from './model';
import { formatUsage, timeAgo } from './format';
import { renderMarkdown } from '../utils/markdown';
import { Logo, Spinner } from './primitives';

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

function NoticeStep({ step }: { step: Step }) {
  return (
    <li className="flex items-center gap-1 text-[11.5px] text-(--ink-mute)">
      <Clock size={11} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{step.label}</span>
      {step.status === 'running' && <Spinner size={10} />}
    </li>
  );
}

function ThoughtStep({ step }: { step: Step }) {
  return (
    <li
      className="prose prose-sm thought max-w-none break-words"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(step.label) }}
    />
  );
}

function ToolStep({ step, onApprove }: { step: Step; onApprove: (decision: ApprovalDecision) => void }) {
  const [expanded, setOpen] = useState(false);
  const awaiting = step.status === 'awaiting';
  const open = expanded || awaiting; // the student sees what they are approving
  const expandable = Boolean(step.detail || step.result) && !awaiting;
  return (
    <li>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left text-[12px] text-(--ink-soft) enabled:hover:text-(--ink)"
      >
        <ChevronRight size={12} className={`shrink-0 text-(--ink-mute) transition-transform ${open ? 'rotate-90' : ''} ${expandable ? '' : 'opacity-0'}`} />
        <span className="min-w-0 flex-1 truncate">{step.label}</span>
        {step.status === 'running' && <span className="shrink-0 text-(--ink-mute)"><Spinner size={11} /></span>}
        {step.status === 'error' && <CircleAlert size={12} className="shrink-0 text-(--error)" />}
      </button>
      {open && (
        <div className="mt-1 ml-4 space-y-1 rounded-md bg-(--bg-sunken) px-2 py-1.5 font-mono text-[10.5px] leading-snug break-all whitespace-pre-wrap text-(--ink-mute)">
          {step.detail && <div>{step.detail}</div>}
          {step.result && <div className={step.status === 'error' ? 'text-(--error)' : 'text-(--ink-soft)'}>{step.result}</div>}
        </div>
      )}
      {awaiting && (
        <div className="mt-1.5 ml-4">
          <p className="mb-1.5 text-[11.5px] text-(--ink-soft)">This changes something in a connected service. Allow it?</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onApprove('allow')}
              className="rounded-full bg-(--accent) px-3 py-1 text-[12px] text-(--accent-ink) hover:opacity-90"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => onApprove('always')}
              className="rounded-full border border-(--line) px-3 py-1 text-[12px] text-(--ink-soft) hover:bg-(--bg-sunken)"
            >
              Always allow
            </button>
            <button
              type="button"
              onClick={() => onApprove('deny')}
              className="rounded-full border border-(--line) px-3 py-1 text-[12px] text-(--error) hover:bg-(--error-soft)"
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The run's thoughts and tool calls above the answer. Open while the assistant works and nothing
 * is written yet, closed once text arrives; a click overrides either.
 */
function StepsBlock({
  steps,
  working,
  hasContent,
  onApprove,
}: {
  steps: Step[];
  working: boolean;
  hasContent: boolean;
  onApprove: (decision: ApprovalDecision) => void;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const awaiting = steps.some((s) => s.status === 'awaiting');
  const open = awaiting || (manual ?? (working && !hasContent));
  const n = steps.length;
  const title = `${working ? 'Working through' : 'Worked through'} ${n} step${n === 1 ? '' : 's'}`;
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="flex items-center gap-1 text-[11.5px] tracking-wide text-(--ink-mute) hover:text-(--ink-soft)"
      >
        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {title}
        {working && !open && <span className="ml-0.5"><Spinner size={10} /></span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="mt-1 ml-1.5 space-y-1.5 overflow-hidden border-l border-(--line) pl-2.5"
          >
            {steps.map((s, i) =>
              s.kind === 'thought' ? (
                <ThoughtStep key={i} step={s} />
              ) : s.kind === 'notice' ? (
                <NoticeStep key={i} step={s} />
              ) : (
                <ToolStep key={i} step={s} onApprove={onApprove} />
              )
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

function AssistantMark() {
  return <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent)" aria-hidden />;
}

/** The time, and for an answer the tokens its model calls used ("4.1k in (3.2k cached) · 380 out"). */
function Timestamp({ date, align = 'left', usage }: { date: Date; align?: 'left' | 'right'; usage?: Message['usage'] }) {
  return (
    <div className={`mt-1 text-[10.5px] text-(--ink-mute) ${align === 'right' ? 'text-right' : ''}`}>
      {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {usage && <span title="Tokens the provider reported for this answer"> · {formatUsage(usage)}</span>}
    </div>
  );
}

/** A command's outcome: a muted line between rules, not a bubble. */
function NoticeRow({ message }: { message: Message }) {
  return (
    <div className="flex items-start gap-2 text-[11.5px] text-(--ink-mute)">
      <span className="mt-2 h-px flex-1 bg-(--line)" />
      <div className="max-w-[85%] text-center whitespace-pre-line">
        {message.content}
        {message.usage && <div className="text-[10.5px]">{formatUsage(message.usage)}</div>}
      </div>
      <span className="mt-2 h-px flex-1 bg-(--line)" />
    </div>
  );
}

/** The run has made many rounds of tool calls without an answer and waits: keep going, or stop there. */
function ContinuePrompt({ rounds, onRespond }: { rounds: number; onRespond: (keepGoing: boolean) => void }) {
  return (
    <div className="rounded-xl border border-(--line) bg-(--bg-raised) px-3 py-2.5">
      <p className="mb-2 text-[12.5px] text-(--ink-soft)">
        {rounds} rounds of tool calls and no answer yet. Keep going, or stop here? You can also send a message to steer it.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onRespond(true)}
          className="rounded-full bg-(--accent) px-3 py-1 text-[12px] text-(--accent-ink) hover:opacity-90"
        >
          Keep going
        </button>
        <button
          type="button"
          onClick={() => onRespond(false)}
          className="rounded-full border border-(--line) px-3 py-1 text-[12px] text-(--ink-soft) hover:bg-(--bg-sunken)"
        >
          Stop here
        </button>
      </div>
    </div>
  );
}

/** Commands matching what follows the `/`, above the composer. */
function CommandSuggestions({ commands, picked, onPick }: { commands: CommandInfo[]; picked: number; onPick: (c: CommandInfo) => void }) {
  return (
    <ul role="listbox" className="absolute inset-x-0 bottom-full mb-1.5 overflow-hidden rounded-xl border border-(--line) bg-(--bg-raised) py-1">
      {commands.map((c, i) => (
        <li key={c.name} role="option" aria-selected={i === picked}>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()} // keep the textarea focused
            onClick={() => onPick(c)}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${i === picked ? 'bg-(--accent-soft)' : 'hover:bg-(--bg-sunken)'}`}
          >
            <span className="shrink-0 text-[12.5px] text-(--ink)">{c.usage}</span>
            <span className="min-w-0 truncate text-[11.5px] text-(--ink-mute)">{c.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MessageRow({
  message,
  isFirst,
  showThoughts,
  onEditQueued,
  onApprove,
}: {
  message: Message;
  isFirst: boolean;
  showThoughts: boolean;
  onEditQueued: () => void;
  onApprove: (decision: ApprovalDecision) => void;
}) {
  if (message.notice) return <NoticeRow message={message} />;
  const separator = message.role === 'user' && !isFirst;
  if (message.role === 'user') {
    return (
      <div className={separator ? 'mt-5 border-t border-(--line) pt-5' : ''}>
        <div className="flex justify-end">
          <div
            className={`max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] break-words whitespace-pre-wrap text-(--ink) ${
              message.queued ? 'border border-dashed border-(--line-strong) bg-(--bg-raised)' : 'bg-(--user-bubble)'
            }`}
          >
            {message.content}
          </div>
        </div>
        {message.queued ? (
          <div className="mt-1 flex items-center justify-end gap-2 text-[10.5px] text-(--ink-mute)">
            <span>Queued · read after the current step</span>
            <button type="button" onClick={onEditQueued} className="text-(--accent) hover:underline">
              Edit
            </button>
          </div>
        ) : (
          <Timestamp date={message.timestamp} align="right" />
        )}
      </div>
    );
  }

  const hasContent = message.content.length > 0;
  const steps = (message.steps ?? []).filter((s) => showThoughts || s.kind !== 'thought');
  const thinking = !hasContent && steps.length === 0;

  return (
    <div className="flex gap-2">
      <AssistantMark />
      <div className="min-w-0 flex-1">
        {steps.length > 0 && <StepsBlock steps={steps} working={Boolean(message.streaming)} hasContent={hasContent} onApprove={onApprove} />}
        {thinking && message.streaming && <TypingDots />}
        {hasContent && (
          <div
            className={`prose prose-sm max-w-none break-words [&_*]:break-words [&_code]:break-all [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto ${
              message.streaming ? 'streaming-caret' : ''
            }`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        )}
        {!message.streaming && (hasContent || steps.length > 0) && <Timestamp date={message.timestamp} usage={message.usage} />}
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
  const { messages, isLoading, sendMessage, editQueued, stop, respondToApproval, continuePrompt, respondToContinue, settings, commands } = model;
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState<string | null>(null); // why a command did not run
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // The prefix typed before ↑/↓ loaded a suggestion into the draft; keeps the list open on it until the next keystroke
  const [browsing, setBrowsing] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading, continuePrompt]);

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

  // While a run is in flight a sent message waits in the steering slot (see AppModel.sendMessage)
  const send = (value = draft) => {
    const text = value.trim();
    if (!text) return;
    setBrowsing(null);
    const refused = sendMessage(text);
    if (refused) {
      setDraft(value);
      setHint(refused);
      return;
    }
    setDraft('');
    setHint(null);
  };

  const changeDraft = (value: string) => {
    setDraft(value);
    setHint(null);
    setDismissed(false);
    setPicked(0);
    setBrowsing(null);
  };

  // `/` plus letters and nothing else: suggest the matching commands
  const typed = browsing ?? /^\/([a-z]*)$/i.exec(draft)?.[1].toLowerCase();
  const suggestions = typed !== undefined && !dismissed ? commands.filter((c) => c.name.startsWith(typed)) : [];
  /** Enter on a suggestion runs it, unless it needs arguments (then it is completed for typing them). */
  const pick = (c: CommandInfo, run: boolean) => {
    if (run && !c.needsArgs) send(`/${c.name}`);
    else changeDraft(`/${c.name} `);
    taRef.current?.focus();
  };

  const pullQueued = () => {
    const text = editQueued();
    setBrowsing(null);
    if (text) setDraft((d) => (d.trim() ? `${text}
${d}` : text));
    taRef.current?.focus();
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
                <MessageRow message={m} isFirst={i === 0} showThoughts={settings.showReasoning} onEditQueued={pullQueued} onApprove={respondToApproval} />
              </div>
            ))}
            {showLoadingRow && <div className={messages.length > 0 ? 'mt-4' : ''}><LoadingRow /></div>}
            {continuePrompt && <div className="mt-4"><ContinuePrompt rounds={continuePrompt.rounds} onRespond={respondToContinue} /></div>}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-(--line) px-3 py-2.5">
        <div className="relative flex items-end gap-2 rounded-2xl border border-(--line) bg-(--bg-raised) px-3 py-2">
          {suggestions.length > 0 && <CommandSuggestions commands={suggestions} picked={picked} onPick={(c) => pick(c, true)} />}
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => changeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  // Load the highlighted command into the draft, ready for arguments to be appended
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  const next = (Math.min(picked, suggestions.length - 1) + step + suggestions.length) % suggestions.length;
                  setPicked(next);
                  setBrowsing(typed ?? '');
                  setDraft(`/${suggestions[next].name} `);
                  setHint(null);
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  pick(suggestions[Math.min(picked, suggestions.length - 1)], e.key === 'Enter');
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={isLoading ? 'Add a correction or detail…' : 'Ask about a course, or / for commands'}
            rows={1}
            className="max-h-[88px] min-h-[20px] flex-1 resize-none bg-transparent text-[13.5px] leading-[18px] outline-none placeholder:text-(--ink-mute) disabled:opacity-60"
          />
          {isLoading && (
            <button
              type="button"
              aria-label="Stop"
              onClick={stop}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-(--line-strong) text-(--ink-soft) hover:bg-(--bg-sunken)"
            >
              <Square size={12} fill="currentColor" />
            </button>
          )}
          {(!isLoading || draft.trim() !== '') && (
            <button
              type="button"
              aria-label={isLoading ? 'Queue message' : 'Send'}
              onClick={() => send()}
              disabled={draft.trim() === ''}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--accent) text-(--accent-ink) transition-opacity disabled:opacity-30"
            >
              <ArrowUp size={16} strokeWidth={2} />
            </button>
          )}
        </div>
        {hint && <p className="mt-1 px-1 text-[11px] text-(--warn)">{hint}</p>}
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
