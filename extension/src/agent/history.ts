import { TOOL_CONFIG } from './tools';
import { FIND_TOOL_NAME } from '../connections/tools';
import { estimateTokenCount } from '../utils/tokens';
import type { Message, Step } from '../ui/model';
import type { ReplayData, Usage } from '../providers/types';

/**
 * The model-facing conversation: its types, history budgeting and digests, and how a run's tool
 * calls become steps in the chat bubble. Pure functions, used by the agent loop in `App.tsx`
 * (see `reference/02-agent-loop.md`).
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  // Gemini 3 attaches an opaque signature to function-call parts and requires it to be
  // echoed back verbatim when the turn is replayed in history.
  thoughtSignature?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string; // JSON string
}

// A turn in the model-facing history. Tool calls/results are carried as structured fields so
// each provider gets real function-call turns instead of JSON pasted into a user message.
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];   // assistant turn that requested tools
  toolResults?: ToolResult[]; // user/tool turn that answers them
  thoughtSignature?: string; // Gemini: signature carried on the text part of a model turn
  replay?: ReplayData; // opaque reasoning items the producing adapter needs echoed back
}

export interface ContextDigest {
  id: string;
  kind: 'conversation';
  content: string;
  createdAt: Date;
  coversUpToIndex?: number; // index into Chat.apiHistory
}

/** Max output tokens per model call (thinking budgets are added on top by the adapters that need it). */
export const MAX_OUTPUT_TOKENS = 2000;

/** Persisted tool results are capped; the model saw the full result within its own turn. */
export const PERSISTED_TOOL_RESULT_MAX = 1500;

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

export function estimateMessageTokens(message: ConversationMessage): number {
  let tokens = estimateTokenCount(message.content) + 4;
  for (const call of message.toolCalls || []) tokens += estimateTokenCount(JSON.stringify(call.args)) + 8;
  for (const res of message.toolResults || []) tokens += estimateTokenCount(res.result) + 8;
  return tokens;
}

export const TOOL_SCHEMA_TOKENS = estimateTokenCount(JSON.stringify(TOOL_CONFIG));

export function estimateConversationTokens(messages: ConversationMessage[], extraToolTokens = 0): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), TOOL_SCHEMA_TOKENS + extraToolTokens);
}

export function digestToConversationMessage(digest: ContextDigest): ConversationMessage {
  return {
    role: 'system',
    content: `[Conversation memory | ${digest.createdAt.toISOString()}]\n${digest.content}`,
  };
}

export function getConversationCoverageIndex(digests: ContextDigest[]): number {
  return digests.reduce((maxIndex, digest) => {
    if (typeof digest.coversUpToIndex === 'number') {
      return Math.max(maxIndex, digest.coversUpToIndex);
    }
    return maxIndex;
  }, -1);
}

/**
 * Model-facing history: stable prefix (system prompt, digests) → un-digested turns. The course
 * roster changes between turns, so it is attached to the latest user turn rather than the prompt,
 * keeping the prefix cacheable.
 */
export function buildApiHistory(
  apiHistory: ConversationMessage[],
  digests: ContextDigest[],
  systemPrompt: string,
  courseOverview: string | null = null
): ConversationMessage[] {
  const orderedDigests = [...digests].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const coveredUpToIndex = getConversationCoverageIndex(orderedDigests);
  const remaining = apiHistory.slice(coveredUpToIndex + 1).map((m) => ({ ...m }));

  if (courseOverview) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].role === 'user' && !remaining[i].toolResults) {
        remaining[i] = { ...remaining[i], content: `${courseOverview}\n\n---\n\n${remaining[i].content}` };
        break;
      }
    }
  }

  return [
    { role: 'system', content: systemPrompt },
    ...orderedDigests.map(digestToConversationMessage),
    ...remaining,
  ];
}

/**
 * Oldest turns up to a token budget, never splitting an assistant tool-call turn from the
 * tool-result turn that answers it (providers reject orphaned tool results).
 */
export function takeMessagesByTokenBudget(messages: ConversationMessage[], tokenBudget: number): ConversationMessage[] {
  const selected: ConversationMessage[] = [];
  let totalTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const messageTokens = estimateMessageTokens(message);
    const mustInclude = selected.length > 0 && Boolean(selected[selected.length - 1].toolCalls?.length) && Boolean(message.toolResults?.length);
    if (!mustInclude && selected.length > 0 && totalTokens + messageTokens > tokenBudget) break;
    selected.push(message);
    totalTokens += messageTokens;
  }

  // Never end on an assistant turn that is waiting for tool results
  while (selected.length > 0 && selected[selected.length - 1].toolCalls?.length && selected.length < messages.length) {
    selected.push(messages[selected.length]);
  }
  return selected;
}

export function capToolResults(message: ConversationMessage): ConversationMessage {
  if (!message.toolResults?.length) return message;
  return {
    ...message,
    toolResults: message.toolResults.map((r) =>
      r.result.length > PERSISTED_TOOL_RESULT_MAX
        ? { ...r, result: r.result.slice(0, PERSISTED_TOOL_RESULT_MAX) + '…[truncated]' }
        : r
    ),
  };
}

// ---------------------------------------------------------------------------
// Token usage and the measured context size
// ---------------------------------------------------------------------------

/** Sum of two usages; either may be missing (a provider that reported none). */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a || !b) return a ?? b;
  const cachedInput = (a.cachedInput ?? 0) + (b.cachedInput ?? 0);
  const reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(cachedInput ? { cachedInput } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

/** A chat's token totals, by what the calls were for. Persisted with the chat. */
export interface ChatUsage {
  answers?: Usage;
  digests?: Usage;
  /** Model calls counted in each total. */
  answerCalls?: number;
  digestCalls?: number;
}

export function countUsage(total: ChatUsage, kind: 'answer' | 'digest', usage: Usage | undefined): ChatUsage {
  return kind === 'answer'
    ? { ...total, answers: addUsage(total.answers, usage), answerCalls: (total.answerCalls ?? 0) + 1 }
    : { ...total, digests: addUsage(total.digests, usage), digestCalls: (total.digestCalls ?? 0) + 1 };
}

/**
 * The provider's own count of the last model call's input, and where the chat stood when it was
 * made: `historyLength` turns of `apiHistory` under digests covering up to `coverage`. Persisted
 * with the chat. Its tokenizer is the provider's, so it replaces the ~4 chars/token estimate for
 * everything it covers.
 */
export interface ContextMeasure {
  input: number;
  historyLength: number;
  coverage: number;
}

/**
 * The context size from the last measured call plus an estimate of the turns added since, or null
 * when there is no measure or a digest has been written since (it changed what is sent).
 */
export function measuredContextTokens(history: ConversationMessage[], digests: ContextDigest[], measure: ContextMeasure | undefined): number | null {
  if (!measure || measure.coverage !== getConversationCoverageIndex(digests) || measure.historyLength > history.length) return null;
  return history.slice(measure.historyLength).reduce((total, m) => total + estimateMessageTokens(m), measure.input);
}

/**
 * Caps persisted tool results (`capToolResults`) and takes what capping removed from the turns a
 * measure covers off that measure, so a long result read in this turn does not count at full size
 * against the next one.
 */
export function capHistory(history: ConversationMessage[], measure: ContextMeasure | undefined): { history: ConversationMessage[]; measure: ContextMeasure | undefined } {
  const capped = history.map(capToolResults);
  if (!measure) return { history: capped, measure };
  let removed = 0;
  for (let i = 0; i < Math.min(measure.historyLength, history.length); i++) {
    if (capped[i] !== history[i]) removed += estimateMessageTokens(history[i]) - estimateMessageTokens(capped[i]);
  }
  return { history: capped, measure: removed > 0 ? { ...measure, input: Math.max(0, measure.input - removed) } : measure };
}

/** The one-line label of a tool step in the chat bubble, from the call the model made. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const q = (s: unknown) => (typeof s === 'string' && s.trim() ? ` "${s.trim()}"` : '');
  switch (name) {
    case 'list_content':
      return `Listing ${args.kind || 'content'}${q(args.search)}`;
    case 'get_assignment':
      return 'Reading an assignment';
    case 'search_documents':
      return `Searching ${args.document_id ? 'the document' : 'documents'} for${q(args.query)}`;
    case 'read_document':
      return `Reading ${args.document_type || 'document'}${args.pages ? ` pages ${args.pages}` : ''}`;
    case 'get_announcements':
      return 'Checking announcements';
    case 'get_discussions':
      return `Checking discussions${q(args.search)}`;
    case 'get_planner':
      return 'Checking the planner';
    case 'get_inbox':
      return `Checking the inbox${q(args.search)}`;
    case FIND_TOOL_NAME:
      return `Looking for ${args.service ? `${args.service} ` : ''}tools${q(args.query)}`;
    default:
      return `Running ${name}`;
  }
}

export const STEP_RESULT_MAX = 300;
export const STEP_DETAIL_MAX = 500;
export const STEP_THOUGHT_MAX = 4000;

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** A finished tool call's step fields: the message of an `{ error }` result, else an excerpt. */
export function toolStepOutcome(result: string): Pick<Step, 'result' | 'status'> {
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error != null) {
      return { result: clip(String(parsed.error), STEP_RESULT_MAX), status: 'error' };
    }
  } catch {
    // not JSON; shown as is
  }
  return { result: clip(result, STEP_RESULT_MAX), status: 'done' };
}

/** A display message as persisted: transient flags dropped, step text capped. */
export function persistableMessage({ streaming: _streaming, queued: _queued, ...message }: Message): Message {
  if (!message.steps) return message;
  return {
    ...message,
    steps: message.steps.map((s) => ({
      ...s,
      label: clip(s.label, s.kind === 'thought' ? STEP_THOUGHT_MAX : STEP_DETAIL_MAX),
      ...(s.detail ? { detail: clip(s.detail, STEP_DETAIL_MAX) } : {}),
      ...(s.result ? { result: clip(s.result, STEP_RESULT_MAX) } : {}),
    })),
  };
}

export const joinText = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b);

