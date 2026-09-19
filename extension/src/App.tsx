import { useState, useEffect, useRef } from 'react';
import { Navigation } from './components/Navigation/Navigation';
import { ChatUI } from './components/ChatUI/ChatUI';
import type { Message } from './components/ChatUI/ChatUI';
import { Settings, type AppSettings } from './components/Settings/Settings';
import { normalizeSettings, resolveBaseUrl } from './settings';
import { GraphExplorer } from './components/GraphExplorer/GraphExplorer';
import { getGraphOverviewText } from './db/graph';
import { buildSystemPrompt } from './agent/prompt';
import { Connect } from './components/Connect/Connect';
import { activateCanvas, hasOriginPermission, releaseOriginPermission, findConnectableHost } from './canvas/connection';
import { resolveIdentity, memorySlotFor, forgetMemory, type MemorySlot } from './canvas/identity';
import { onSessionLost } from './canvas/http';
import { configureDatabase, closeDB } from './db/pglite';
import { profileFor, type CanvasProfile } from './canvas/profiles';
import { TOOL_CONFIG, toolFunctions, type ToolConfig } from './agent/tools';
import './App.css';

// ---------------------------------------------------------------------------
// Conversation model
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  // Gemini 3 attaches an opaque signature to function-call parts and requires it to be
  // echoed back verbatim when the turn is replayed in history.
  thoughtSignature?: string;
}

interface ToolResult {
  id: string;
  name: string;
  result: string; // JSON string
}

// A turn in the model-facing history. Tool calls/results are carried as structured fields so
// each provider gets real function-call turns instead of JSON pasted into a user message.
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];   // assistant turn that requested tools
  toolResults?: ToolResult[]; // user/tool turn that answers them
  thoughtSignature?: string; // Gemini: signature carried on the text part of a model turn
}

// Gemini rejects replayed function calls that carry no signature (e.g. after a provider switch
// or when the model omitted one); this documented placeholder tells it to skip the check.
const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

interface ContextDigest {
  id: string;
  kind: 'conversation' | 'tool_loop'; // tool_loop digests are legacy (no longer produced) but still valid memory
  content: string;
  createdAt: Date;
  coversUpToIndex?: number; // index into Chat.apiHistory
}

interface Chat {
  id: string;
  title: string;
  messages: Message[];               // Display only - user and assistant text shown in UI
  apiHistory: ConversationMessage[]; // Model-facing turns incl. tool calls/results (capped)
  contextDigests: ContextDigest[];   // Compact memory for turns that were summarized away
  createdAt: Date;
  updatedAt: Date;
}

type Connection =
  | { status: 'checking'; host?: string }
  | { status: 'disconnected'; host?: string; reason?: string }
  | { status: 'connected'; host: string; profile: CanvasProfile; memory: MemorySlot; live: boolean };

/** Persisted tool results are capped; the model saw the full result within its own turn. */
const PERSISTED_TOOL_RESULT_MAX = 1500;
const MAX_TOOL_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

type FunctionCall = ToolCall;

// Convert the Google-style TOOL_CONFIG to OpenAI's function-tool schema
function toOpenAITools(tools: ToolConfig[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters.properties).map(([key, param]) => [
            key,
            {
              type: param.type.toLowerCase(),
              description: param.description,
              ...(param.enum ? { enum: param.enum } : {}),
            },
          ])
        ),
        required: tool.parameters.required || [],
      },
    },
  }));
}

function parseJsonOrString(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// OpenAI chat format: system/user/assistant(+tool_calls)/tool messages
function toOpenAIMessages(messages: ConversationMessage[]): any[] {
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.toolResults?.length) {
      for (const r of msg.toolResults) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.result });
      }
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

// Gemini format: systemInstruction + contents with text / functionCall / functionResponse parts
function toGeminiRequest(messages: ConversationMessage[]): { systemInstruction?: any; contents: any[] } {
  const systemTexts: string[] = [];
  const contents: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemTexts.push(msg.content);
      continue;
    }
    if (msg.toolResults?.length) {
      contents.push({
        role: 'user',
        parts: msg.toolResults.map((r) => ({
          functionResponse: { name: r.name, response: { result: parseJsonOrString(r.result) } },
        })),
      });
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const parts: any[] = [];
      if (msg.content) {
        parts.push({ text: msg.content, ...(msg.thoughtSignature ? { thoughtSignature: msg.thoughtSignature } : {}) });
      }
      const anySigned = msg.toolCalls.some((c) => c.thoughtSignature);
      msg.toolCalls.forEach((c, i) => {
        const part: any = { functionCall: { name: c.name, args: c.args } };
        if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
        else if (!anySigned && i === 0) part.thoughtSignature = GEMINI_SKIP_SIGNATURE;
        parts.push(part);
      });
      contents.push({ role: 'model', parts });
      continue;
    }
    if (msg.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: [{ text: msg.content, ...(msg.thoughtSignature ? { thoughtSignature: msg.thoughtSignature } : {}) }],
      });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: msg.content }] });
  }

  return {
    systemInstruction: systemTexts.length ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
    contents,
  };
}

function parseFunctionCalls(responseData: any): FunctionCall[] {
  const functionCalls: FunctionCall[] = [];

  // OpenAI: choices[0].message.tool_calls[].function.{name, arguments (JSON string)}
  const openAIToolCalls = responseData?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(openAIToolCalls)) {
    for (const call of openAIToolCalls) {
      if (call?.function?.name) {
        let args: Record<string, any> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        functionCalls.push({ id: call.id || `call_${functionCalls.length}`, name: call.function.name, args });
      }
    }
    return functionCalls;
  }

  // Google: candidates[0].content.parts[].functionCall
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return functionCalls;

  for (const part of parts) {
    if (part.functionCall) {
      functionCalls.push({
        id: part.functionCall.id || `call_${functionCalls.length}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
    }
  }

  return functionCalls;
}

// Gemini: signature attached to a text part of the model turn (needed when replaying it)
function extractTextThoughtSignature(responseData: any): string | undefined {
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && parts[i].thoughtSignature) return parts[i].thoughtSignature;
  }
  return undefined;
}

function extractTextContent(responseData: any): string {
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let output = '';
  for (const part of parts) {
    if (part.text && !part.thought) output += part.text;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Yields the `data:` payload of each server-sent event. Both providers stream this way; the
 * caller decides what a payload means. Events are separated by a blank line and may use CRLF.
 */
async function* readSSE(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('The provider returned no response body to stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dataOf = (event: string): string =>
    event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const data = dataOf(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const tail = dataOf(buffer);
    if (tail) yield tail;
  } finally {
    // Leaving early (`[DONE]`, an error) must close the connection, not just drop the lock
    reader.cancel().catch(() => {});
  }
}

function parseSSEJson(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * OpenAI stream → the non-streaming response shape. Text deltas go to `onDelta`; tool calls
 * arrive as fragments keyed by `index` (id and name first, then argument pieces) and are joined.
 */
async function readOpenAIStream(response: Response, onDelta: (text: string) => void): Promise<any> {
  let content = '';
  let finishReason: string | undefined;
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  for await (const data of readSSE(response)) {
    if (data === '[DONE]') break;
    const chunk = parseSSEJson(data);
    if (!chunk) continue;
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const fragment of delta.tool_calls || []) {
      const index = typeof fragment.index === 'number' ? fragment.index : toolCalls.length;
      const call = (toolCalls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
    }
  }

  const tool_calls = toolCalls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return {
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) } }],
  };
}

/**
 * Gemini stream → the non-streaming response shape. Visible text parts are concatenated into one
 * part; a thought signature seen on any text part (Gemini sends it on the last chunk, sometimes
 * with empty text) is carried on that merged part, and function-call parts keep their own, so
 * `parseFunctionCalls` / `extractTextThoughtSignature` and the signature replay work unchanged.
 */
async function readGeminiStream(response: Response, onDelta: (text: string) => void): Promise<any> {
  const parts: any[] = [];
  let textPart: any = null;
  let finishReason: string | undefined;
  let promptFeedback: any;

  for await (const data of readSSE(response)) {
    const chunk = parseSSEJson(data);
    if (!chunk) continue;
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback;
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === 'string' && !part.thought) {
        if (!textPart) {
          textPart = { text: '' };
          parts.push(textPart);
        }
        textPart.text += part.text;
        if (part.thoughtSignature) textPart.thoughtSignature = part.thoughtSignature;
        if (part.text) onDelta(part.text);
      } else {
        parts.push(part);
      }
    }
  }

  return {
    candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(promptFeedback ? { promptFeedback } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : (error as any)?.name === 'AbortError';
}

/** The provider's real error message, not just the HTTP status line. */
async function readApiError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    // no JSON body
  }
  return `API error ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`;
}

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessageTokens(message: ConversationMessage): number {
  let tokens = estimateTokenCount(message.content) + 4;
  for (const call of message.toolCalls || []) tokens += estimateTokenCount(JSON.stringify(call.args)) + 8;
  for (const res of message.toolResults || []) tokens += estimateTokenCount(res.result) + 8;
  return tokens;
}

const TOOL_SCHEMA_TOKENS = estimateTokenCount(JSON.stringify(TOOL_CONFIG));

function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), TOOL_SCHEMA_TOKENS);
}

function digestToConversationMessage(digest: ContextDigest): ConversationMessage {
  const label = digest.kind === 'tool_loop' ? 'Tool loop memory' : 'Conversation memory';
  return {
    role: 'system',
    content: `[${label} | ${digest.createdAt.toISOString()}]\n${digest.content}`,
  };
}

function getConversationCoverageIndex(digests: ContextDigest[]): number {
  return digests.reduce((maxIndex, digest) => {
    if (digest.kind === 'conversation' && typeof digest.coversUpToIndex === 'number') {
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
function buildApiHistory(
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
function takeMessagesByTokenBudget(messages: ConversationMessage[], tokenBudget: number): ConversationMessage[] {
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

interface CallOptions {
  includeTools?: boolean;       // default true
  onDelta?: (text: string) => void; // when set, the provider's streaming endpoint is used
  signal?: AbortSignal;
}
type CallLLM = (messages: ConversationMessage[], settings: AppSettings, options?: CallOptions) => Promise<{ text: string; rawResponse: any }>;

async function generateDigestText(
  transcript: ConversationMessage[],
  settings: AppSettings,
  callLLMFn: CallLLM
): Promise<string> {
  const prompt =
    'Summarize this conversation segment into a compact persistent memory digest. Preserve durable facts (course ids, assignment/file names and ids, due dates, grades), decisions, user preferences, and unresolved tasks. Do not repeat raw text or tool payloads.';

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

  const response = await callLLMFn(
    [
      { role: 'system', content: 'You are a memory compaction step for a Canvas student-assistant agent. Reply with the digest only.' },
      ...flattened,
      { role: 'user', content: prompt },
    ],
    settings,
    { includeTools: false }
  );

  return response.text.trim();
}

function capToolResults(message: ConversationMessage): ConversationMessage {
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
// Persistence
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'canvas-buddy-settings';

function reviveChat(chat: any): Chat {
  const messages: Message[] = (chat.messages || []).map((msg: any) => ({ ...msg, timestamp: new Date(msg.timestamp) }));
  // Chats saved before tool turns were persisted: rebuild the history from the visible messages
  const apiHistory: ConversationMessage[] = Array.isArray(chat.apiHistory)
    ? chat.apiHistory
    : messages.map((m) => ({ role: m.role, content: m.content }));
  return {
    ...chat,
    messages,
    apiHistory,
    createdAt: new Date(chat.createdAt),
    updatedAt: new Date(chat.updatedAt),
    contextDigests: (chat.contextDigests || []).map((digest: any) => ({ ...digest, createdAt: new Date(digest.createdAt) })),
  };
}

function chatTitleFor(content: string): string {
  const firstLine = content.trim().split('\n')[0];
  return firstLine.length > 48 ? firstLine.slice(0, 47) + '…' : firstLine || 'New chat';
}

/** One line of tool activity for the chat bubble, from the call the model made. */
function describeToolCall(name: string, args: Record<string, any>): string {
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
    case 'get_planner':
      return 'Checking the planner';
    case 'get_inbox':
      return `Checking the inbox${q(args.search)}`;
    default:
      return `Running ${name}`;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'graph' | 'settings'>('chat');
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [apiHistory, setApiHistory] = useState<ConversationMessage[]>([]);
  const [contextDigests, setContextDigests] = useState<ContextDigest[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentContextTokens, setCurrentContextTokens] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => normalizeSettings(null));
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connection, setConnection] = useState<Connection>({ status: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);
  const [connectNonce, setConnectNonce] = useState(0); // bumps on Connect so the same host re-resolves
  // Known instances are granted in the manifest, so Disconnect cannot release them; it just stops
  // auto-connecting for this session so the user can pick another Canvas.
  const autoConnectRef = useRef(true);
  // Chats live under the connected identity's key (canvas/identity.ts), known only once connected
  const chatsKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadChatIntoView = (chat: Chat | null) => {
    setCurrentChatId(chat?.id ?? null);
    setMessages(chat?.messages ?? []);
    setApiHistory(chat?.apiHistory ?? []);
    setContextDigests(chat?.contextDigests ?? []);
  };

  const loadChats = (key: string) => {
    chatsKeyRef.current = key;
    let parsed: Chat[] = [];
    try {
      const saved = localStorage.getItem(key);
      if (saved) parsed = JSON.parse(saved).map(reviveChat);
    } catch (error) {
      console.error('Failed to load chats:', error);
    }
    setChats(parsed);
    loadChatIntoView(parsed.length > 0 ? parsed[parsed.length - 1] : null);
  };

  const persistChats = (updated: Chat[]) => {
    if (chatsKeyRef.current) localStorage.setItem(chatsKeyRef.current, JSON.stringify(updated));
  };

  useEffect(() => {
    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    if (savedSettings) {
      try {
        setSettings(normalizeSettings(JSON.parse(savedSettings)));
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    }
    setSettingsLoaded(true);
  }, []);

  // The origin permission is optional and Chrome can revoke it, so a remembered host is
  // re-checked on every start; the Connect screen comes back whenever it is missing.
  useEffect(() => {
    if (!settingsLoaded) return;
    const host = settings.canvasHost;
    let cancelled = false;
    if (!host) {
      chatsKeyRef.current = null;
      setChats([]);
      loadChatIntoView(null);
      if (!autoConnectRef.current) {
        setConnection({ status: 'disconnected' });
        return;
      }
      // No remembered host: connect silently to the tab's Canvas or a known instance if possible
      setConnection({ status: 'checking' });
      findConnectableHost().then(({ host: found, tabHost }) => {
        if (cancelled) return;
        if (found) setCanvasHost(found);
        else setConnection({ status: 'disconnected', host: tabHost ?? undefined });
      });
      return () => {
        cancelled = true;
      };
    }
    setConnection({ status: 'checking', host });
    (async () => {
      if (!(await hasOriginPermission(host))) return { status: 'disconnected', host } as Connection;
      const profile = activateCanvas(host);
      const resolved = await resolveIdentity(host);
      if (!resolved) return { status: 'disconnected', host, reason: `Not signed in to ${host}. Sign in there, then connect again.` } as Connection;
      const memory = memorySlotFor(resolved.identity);
      configureDatabase(memory.dbName);
      return { status: 'connected', host, profile, memory, live: resolved.live } as Connection;
    })()
      .then((next) => {
        if (cancelled) return;
        if (next.status === 'connected') {
          loadChats(next.memory.chatsKey);
          setNotice(next.live ? null : `Not signed in to ${host}; showing what's remembered for ${next.memory.name}.`);
        }
        setConnection(next);
      })
      .catch((e) => {
        if (!cancelled) setConnection({ status: 'disconnected', host, reason: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [settingsLoaded, settings.canvasHost, connectNonce]);

  // A sign-in page mid-session means the session ended or another account signed in. The
  // database stays that of the identity it was opened for; a different account is never mixed in.
  useEffect(() => {
    if (connection.status !== 'connected') {
      onSessionLost(null);
      return;
    }
    const { host, memory } = connection;
    let checking = false;
    onSessionLost(() => {
      if (checking) return;
      checking = true;
      resolveIdentity(host)
        .then((resolved) => {
          if (!resolved || !resolved.live) setNotice(`Not signed in to ${host}; showing what's remembered for ${memory.name}.`);
          else if (resolved.identity.userId !== memory.userId) setNotice(`Signed in as ${resolved.identity.name}. Reload to switch memory.`);
        })
        .finally(() => {
          checking = false;
        });
    });
    return () => onSessionLost(null);
  }, [connection]);

  const setCanvasHost = (host: string) => {
    setSettings((prev) => {
      const next = { ...prev, canvasHost: host };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const handleConnected = (host: string) => {
    // The effect above resolves the identity and opens its memory
    autoConnectRef.current = true;
    setCanvasHost(host);
    setConnectNonce((n) => n + 1);
  };

  const handleForgetMemory = async () => {
    if (connection.status !== 'connected') return;
    const { memory } = connection;
    if (!window.confirm(`Forget everything remembered for ${memory.name} (${memory.host})? Courses, documents and chats for this account will be deleted.`)) return;
    await closeDB();
    await forgetMemory(memory);
    window.location.reload();
  };

  const handleDisconnect = () => {
    if (connection.status === 'connected') void releaseOriginPermission(connection.host);
    autoConnectRef.current = false;
    setCanvasHost('');
  };

  // Fixed for the session, so the prompt + tool schemas stay a cacheable prefix
  const systemPrompt = buildSystemPrompt(
    connection.status === 'connected' ? connection.profile.promptIntro(connection.host) : profileFor('').promptIntro('')
  );

  const saveCurrentChat = (
    chatId: string,
    msgs: Message[],
    history: ConversationMessage[],
    digests: ContextDigest[]
  ) => {
    setChats((prevChats) => {
      const updated = prevChats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              title: chat.title.startsWith('Chat ') || chat.title === 'New chat'
                ? chatTitleFor(msgs.find((m) => m.role === 'user')?.content || chat.title)
                : chat.title,
              messages: msgs.map(({ streaming: _streaming, ...m }) => m),
              apiHistory: history,
              contextDigests: digests,
              updatedAt: new Date(),
            }
          : chat
      );
      persistChats(updated);
      return updated;
    });
  };

  const createNewChat = (): string => {
    const newChatId = Date.now().toString();
    const newChat: Chat = {
      id: newChatId,
      title: 'New chat',
      messages: [],
      apiHistory: [],
      contextDigests: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setChats((prevChats) => {
      const updated = [...prevChats, newChat];
      persistChats(updated);
      return updated;
    });
    loadChatIntoView(newChat);
    return newChatId;
  };

  const switchChat = (chatId: string) => {
    if (currentChatId) saveCurrentChat(currentChatId, messages, apiHistory, contextDigests);
    const chat = chats.find((c) => c.id === chatId);
    if (chat) loadChatIntoView(chat);
  };

  const deleteChat = (chatId: string) => {
    const updated = chats.filter((c) => c.id !== chatId);
    setChats(updated);
    persistChats(updated);
    if (currentChatId === chatId) loadChatIntoView(updated.length > 0 ? updated[updated.length - 1] : null);
  };

  const handleSettingsChange = (newSettings: AppSettings) => {
    setSettings(newSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
  };

  useEffect(() => {
    if (!currentChatId) {
      setCurrentContextTokens(0);
      return;
    }
    setCurrentContextTokens(estimateConversationTokens(buildApiHistory(apiHistory, contextDigests, systemPrompt)));
  }, [apiHistory, contextDigests, currentChatId, settings.contextThreshold, systemPrompt]);

  const callLLM: CallLLM = async (history, settings, options = {}) => {
    const { includeTools = true, onDelta, signal } = options;

    if (settings.llmProvider === 'openai') {
      const response = await fetch(`${resolveBaseUrl(settings)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: toOpenAIMessages(history),
          max_completion_tokens: 2000,
          ...(includeTools && TOOL_CONFIG.length > 0 ? { tools: toOpenAITools(TOOL_CONFIG) } : {}),
          ...(onDelta ? { stream: true } : {}),
        }),
        signal,
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = onDelta ? await readOpenAIStream(response, onDelta) : await response.json();
      return { text: data.choices?.[0]?.message?.content || '', rawResponse: data };
    }

    if (settings.llmProvider === 'google') {
      const { systemInstruction, contents } = toGeminiRequest(history);
      const requestBody: any = {
        ...(systemInstruction ? { systemInstruction } : {}),
        contents,
        generationConfig: { maxOutputTokens: 2000 },
      };
      if (includeTools && TOOL_CONFIG.length > 0) {
        requestBody.tools = [{ functionDeclarations: TOOL_CONFIG }];
      }

      const method = onDelta ? 'streamGenerateContent?alt=sse' : 'generateContent';
      const response = await fetch(
        `${resolveBaseUrl(settings)}/models/${settings.model}:${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
          body: JSON.stringify(requestBody),
          signal,
        }
      );
      if (!response.ok) throw new Error(await readApiError(response));
      const data = onDelta ? await readGeminiStream(response, onDelta) : await response.json();
      const text = extractTextContent(data);
      const finishReason = data?.candidates?.[0]?.finishReason;
      const blocked = data?.promptFeedback?.blockReason;
      if (!text && parseFunctionCalls(data).length === 0 && (blocked || (finishReason && finishReason !== 'STOP'))) {
        throw new Error(`The model returned no answer (${blocked ? `blocked: ${blocked}` : `finish reason: ${finishReason}`}).`);
      }
      return { text, rawResponse: data };
    }

    throw new Error('Unknown LLM provider');
  };

  /** Summarize the oldest un-digested turns until the estimated history fits the threshold. */
  const ensureContextWithinThreshold = async (
    history: ConversationMessage[],
    digests: ContextDigest[]
  ): Promise<ContextDigest[]> => {
    let nextDigests = [...digests];
    let estimatedTokens = estimateConversationTokens(buildApiHistory(history, nextDigests, systemPrompt));

    while (estimatedTokens > settings.contextThreshold) {
      const coveredUpToIndex = getConversationCoverageIndex(nextDigests);
      const remaining = history.slice(coveredUpToIndex + 1);
      if (remaining.length <= 1) break; // keep at least the latest turn verbatim

      const sliceBudget = Math.max(1000, Math.floor(settings.contextThreshold * 0.25));
      const toDigest = takeMessagesByTokenBudget(remaining.slice(0, -1), sliceBudget);
      if (toDigest.length === 0) break;

      const digestText = await generateDigestText(toDigest, settings, callLLM);
      if (!digestText) break;

      nextDigests = [
        ...nextDigests,
        {
          id: `digest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind: 'conversation',
          content: digestText,
          createdAt: new Date(),
          coversUpToIndex: coveredUpToIndex + toDigest.length,
        },
      ];
      estimatedTokens = estimateConversationTokens(buildApiHistory(history, nextDigests, systemPrompt));
    }

    return nextDigests;
  };

  const handleStop = () => abortRef.current?.abort();

  const handleSendMessage = async (content: string) => {
    const hadActiveChat = Boolean(currentChatId);
    const activeChatId = hadActiveChat ? currentChatId! : createNewChat();
    const baseMessages = hadActiveChat ? messages : [];
    const baseHistory = hadActiveChat ? apiHistory : [];
    const baseDigests = hadActiveChat ? contextDigests : [];

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content, timestamp: new Date() };
    let currentMessages = [...baseMessages, userMessage];
    let currentHistory: ConversationMessage[] = [...baseHistory, { role: 'user', content }];
    let currentDigests = [...baseDigests];

    setMessages(currentMessages);
    setApiHistory(currentHistory);
    setIsLoading(true);

    const abort = new AbortController();
    abortRef.current = abort;
    const { signal } = abort;

    // Text of the model turn in flight, kept until that turn is appended to the history so an
    // interrupted turn can still be shown (and remembered) as far as it got.
    let partialText = '';
    let bubbleId: string | null = null;
    let paintHandle = 0;
    const paintPartial = () => {
      paintHandle = 0;
      const id = bubbleId;
      const text = partialText;
      if (id) setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: text } : m)));
    };

    try {
      currentDigests = await ensureContextWithinThreshold(currentHistory, currentDigests);
      setContextDigests(currentDigests);
      saveCurrentChat(activeChatId, currentMessages, currentHistory, currentDigests);

      let courseOverview: string | null = null;
      try {
        courseOverview = await getGraphOverviewText();
      } catch (e) {
        console.warn('Course overview unavailable:', e);
      }

      let toolRounds = 0;
      while (true) {
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          throw new Error(`Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls without a final answer.`);
        }

        // One bubble per model turn, created before the call so tokens have somewhere to land
        bubbleId = (Date.now() + Math.random()).toString();
        partialText = '';
        currentMessages = [...currentMessages, { id: bubbleId, role: 'assistant', content: '', timestamp: new Date(), streaming: true }];
        setMessages(currentMessages);

        const result = await callLLM(buildApiHistory(currentHistory, currentDigests, systemPrompt, courseOverview), settings, {
          signal,
          onDelta: (text) => {
            partialText += text;
            if (!paintHandle) paintHandle = requestAnimationFrame(paintPartial); // one paint per frame
          },
        });
        if (paintHandle) cancelAnimationFrame(paintHandle);
        paintHandle = 0;
        const functionCalls = parseFunctionCalls(result.rawResponse);

        const bubble: Message = {
          ...currentMessages[currentMessages.length - 1],
          content: result.text,
          streaming: false,
          ...(functionCalls.length > 0 ? { activity: functionCalls.map((c) => describeToolCall(c.name, c.args)) } : {}),
        };
        // A turn with neither text nor tool calls has nothing to show
        currentMessages = bubble.content || bubble.activity ? [...currentMessages.slice(0, -1), bubble] : currentMessages.slice(0, -1);
        setMessages(currentMessages);

        const textSignature = extractTextThoughtSignature(result.rawResponse);
        currentHistory = [
          ...currentHistory,
          {
            role: 'assistant',
            content: result.text || '',
            ...(functionCalls.length > 0 ? { toolCalls: functionCalls } : {}),
            ...(textSignature ? { thoughtSignature: textSignature } : {}),
          },
        ];
        partialText = '';
        bubbleId = null;

        if (functionCalls.length === 0) break;

        toolRounds += 1;
        const toolResults: ToolResult[] = [];
        for (const functionCall of functionCalls) {
          if (signal.aborted) throw new DOMException('Stopped by the user', 'AbortError');
          const toolImpl = toolFunctions[functionCall.name];
          let toolResult = JSON.stringify({ error: `Tool not found: ${functionCall.name}` });
          if (toolImpl) {
            try {
              const stringArgs = Object.fromEntries(
                Object.entries(functionCall.args).map(([key, value]) => [key, value == null ? '' : String(value)])
              );
              toolResult = await toolImpl(stringArgs, settings);
            } catch (error) {
              toolResult = JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' });
            }
          }
          toolResults.push({ id: functionCall.id, name: functionCall.name, result: toolResult });
        }
        currentHistory = [...currentHistory, { role: 'user', content: '', toolResults }];
      }

      // Persist real tool turns (results capped) so the next turn has them without a digest call
      currentHistory = currentHistory.map(capToolResults);
      currentDigests = await ensureContextWithinThreshold(currentHistory, currentDigests);
      setApiHistory(currentHistory);
      setContextDigests(currentDigests);
      saveCurrentChat(activeChatId, currentMessages, currentHistory, currentDigests);
    } catch (error) {
      if (paintHandle) cancelAnimationFrame(paintHandle);
      const aborted = isAbortError(error);
      if (!aborted) console.error('Error calling API:', error);

      // The interrupted turn keeps whatever text arrived; an empty bubble is dropped
      const interrupted = bubbleId ? currentMessages[currentMessages.length - 1] : null;
      let finalMessages = interrupted
        ? partialText
          ? [...currentMessages.slice(0, -1), { ...interrupted, content: partialText, streaming: false }]
          : currentMessages.slice(0, -1)
        : currentMessages;
      if (!aborted) {
        finalMessages = [
          ...finalMessages,
          {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: `Error: ${error instanceof Error ? error.message : 'Failed to get response from AI'}`,
            timestamp: new Date(),
          },
        ];
      }
      // A tool-call turn without results would make the next request malformed: keep its text as
      // a plain turn (what the user saw) and drop the calls. An interrupted turn keeps its text.
      const capped = currentHistory.map(capToolResults);
      const last = capped[capped.length - 1];
      let safeHistory = last?.toolCalls?.length
        ? [...capped.slice(0, -1), ...(last.content ? [{ role: 'assistant' as const, content: last.content }] : [])]
        : capped;
      if (partialText) safeHistory = [...safeHistory, { role: 'assistant', content: partialText }];
      setMessages(finalMessages);
      setApiHistory(safeHistory);
      saveCurrentChat(activeChatId, finalMessages, safeHistory, currentDigests);
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-full w-full bg-gray-900">
      <Navigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={switchChat}
        onNewChat={createNewChat}
        onDeleteChat={deleteChat}
      />

      <main className="flex-1 flex flex-col overflow-hidden h-full">
        {notice && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 flex-shrink-0">
            <span>{notice}</span>
            <button onClick={() => window.location.reload()} className="font-medium underline whitespace-nowrap">
              Reload
            </button>
          </div>
        )}
        {activeTab === 'settings' ? (
          <Settings
            settings={settings}
            onSettingsChange={handleSettingsChange}
            currentContextTokens={currentContextTokens}
            connection={
              connection.status === 'connected'
                ? { host: connection.host, profileName: connection.profile.name, memoryName: connection.memory.name }
                : null
            }
            onDisconnect={handleDisconnect}
            onForgetMemory={handleForgetMemory}
          />
        ) : connection.status === 'checking' ? (
          <div className="flex-1 flex items-center justify-center bg-gray-50 text-sm text-gray-500">
            {connection.host ? `Connecting to ${connection.host}…` : 'Loading…'}
          </div>
        ) : connection.status === 'disconnected' ? (
          <Connect initialError={connection.reason} onConnected={handleConnected} />
        ) : activeTab === 'chat' ? (
          <ChatUI
            messages={messages}
            onSendMessage={handleSendMessage}
            onStop={handleStop}
            isLoading={isLoading}
          />
        ) : (
          <GraphExplorer settings={settings} memoryLabel={`${connection.memory.name} · ${connection.host}`} />
        )}
      </main>
    </div>
  );
}

export default App;
