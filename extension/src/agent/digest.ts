import type { AppSettings } from '../settings';
import { callModel } from '../providers';
import type { Usage } from '../providers/types';
import {
  buildApiHistory,
  estimateConversationTokens,
  getConversationCoverageIndex,
  MAX_OUTPUT_TOKENS,
  measuredContextTokens,
  takeMessagesByTokenBudget,
  type ContextDigest,
  type ContextMeasure,
  type ConversationMessage,
} from './history';

/**
 * Conversation digests: how big the context is, and summarizing the oldest turns into a digest
 * when it passes the threshold (or on `/compact`). See `reference/02-agent-loop.md` → Context
 * management.
 */

/**
 * What the next call would send: the provider's count of the last call plus an estimate of the
 * turns added since, or all estimate (~4 chars/token) when there is no usable measure.
 */
export function contextSize(
  history: ConversationMessage[],
  digests: ContextDigest[],
  measure: ContextMeasure | undefined,
  systemPrompt: string,
  connectionToolTokens: number
): { tokens: number; measured: boolean } {
  const measured = measuredContextTokens(history, digests, measure);
  return measured !== null
    ? { tokens: measured, measured: true }
    : { tokens: estimateConversationTokens(buildApiHistory(history, digests, systemPrompt), connectionToolTokens), measured: false };
}

/** One digest of `transcript`; `focus` is what the student asked it to keep (`/compact`). */
export async function generateDigestText(
  transcript: ConversationMessage[],
  settings: AppSettings,
  focus = '',
  signal?: AbortSignal
): Promise<{ text: string; usage?: Usage }> {
  const prompt =
    'Summarize this conversation segment into a compact persistent memory digest. Preserve durable facts (course ids, assignment/file names and ids, due dates, grades), decisions, user preferences, and unresolved tasks. Do not repeat raw text or tool payloads.' +
    (focus ? `\nThe student asked that it keep in particular: ${focus}` : '');

  // Tool turns are flattened to text so the digest request is plain user/assistant turns; the
  // instruction goes last as a user turn because Gemini rejects requests ending on a model turn.
  const flattened: ConversationMessage[] = transcript.map((m) => {
    if (m.toolResults?.length) {
      return { role: 'user', content: m.toolResults.map((r) => `[${r.name} result] ${r.result}`).join('\n') };
    }
    if (m.toolCalls?.length) {
      return { role: 'assistant', content: `${m.content ? m.content + '\n' : ''}[called ${m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}]` };
    }
    return { role: m.role, content: m.content };
  });

  const response = await callModel(
    settings,
    {
      messages: [
        { role: 'system', content: 'You are a memory compaction step for a Canvas student-assistant agent. Reply with the digest only.' },
        ...flattened,
        { role: 'user', content: prompt },
      ],
      tools: [],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinking: false,
    },
    { signal }
  );

  return { text: response.text.trim(), usage: response.usage };
}

/**
 * Summarizes the oldest un-digested turns until the context fits `settings.contextThreshold`.
 * Returns the digests and what each digest call used. The latest turn is always kept verbatim.
 */
export async function digestToThreshold(params: {
  history: ConversationMessage[];
  digests: ContextDigest[];
  measure: ContextMeasure | undefined;
  systemPrompt: string;
  connectionToolTokens: number;
  settings: AppSettings;
  signal?: AbortSignal;
}): Promise<{ digests: ContextDigest[]; usage: Array<Usage | undefined> }> {
  const { history, measure, systemPrompt, connectionToolTokens, settings, signal } = params;
  let digests = [...params.digests];
  const usage: Array<Usage | undefined> = [];
  // A new digest invalidates the measure (it changed what is sent), so later rounds estimate
  let tokens = contextSize(history, digests, measure, systemPrompt, connectionToolTokens).tokens;

  while (tokens > settings.contextThreshold) {
    const coveredUpToIndex = getConversationCoverageIndex(digests);
    const remaining = history.slice(coveredUpToIndex + 1);
    if (remaining.length <= 1) break; // keep at least the latest turn verbatim

    const sliceBudget = Math.max(1000, Math.floor(settings.contextThreshold * 0.25));
    const toDigest = takeMessagesByTokenBudget(remaining.slice(0, -1), sliceBudget);
    if (toDigest.length === 0) break;

    const digest = await generateDigestText(toDigest, settings, '', signal);
    usage.push(digest.usage);
    if (!digest.text) break;

    digests = [
      ...digests,
      {
        id: `digest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind: 'conversation',
        content: digest.text,
        createdAt: new Date(),
        coversUpToIndex: coveredUpToIndex + toDigest.length,
      },
    ];
    tokens = contextSize(history, digests, measure, systemPrompt, connectionToolTokens).tokens;
  }

  return { digests, usage };
}
