import { useState, useEffect } from 'react';
import { Navigation } from './components/Navigation/Navigation';
import { ChatUI } from './components/ChatUI/ChatUI';
import type { Message } from './components/ChatUI/ChatUI';
import { Settings, type AppSettings } from './components/Settings/Settings';
import { normalizeSettings } from './settings';
import { GraphExplorer } from './components/GraphExplorer/GraphExplorer';
import { getGraphOverviewText } from './db/graph';
import { SYSTEM_PROMPT } from './agent/prompt';
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
    { role: 'system', content: SYSTEM_PROMPT },
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

async function generateDigestText(
  transcript: ConversationMessage[],
  settings: AppSettings,
  callLLMFn: (messages: ConversationMessage[], settings: AppSettings, includeTools?: boolean) => Promise<{ text: string; rawResponse: any }>
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
    false
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

const CHATS_KEY = 'canvas-buddy-chats';
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

  const loadChatIntoView = (chat: Chat | null) => {
    setCurrentChatId(chat?.id ?? null);
    setMessages(chat?.messages ?? []);
    setApiHistory(chat?.apiHistory ?? []);
    setContextDigests(chat?.contextDigests ?? []);
  };

  useEffect(() => {
    const savedChats = localStorage.getItem(CHATS_KEY);
    if (savedChats) {
      try {
        const parsed: Chat[] = JSON.parse(savedChats).map(reviveChat);
        setChats(parsed);
        if (parsed.length > 0) loadChatIntoView(parsed[parsed.length - 1]);
        localStorage.setItem(CHATS_KEY, JSON.stringify(parsed));
      } catch (error) {
        console.error('Failed to load chats:', error);
      }
    }

    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    if (savedSettings) {
      try {
        setSettings(normalizeSettings(JSON.parse(savedSettings)));
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    }
  }, []);

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
              messages: msgs,
              apiHistory: history,
              contextDigests: digests,
              updatedAt: new Date(),
            }
          : chat
      );
      localStorage.setItem(CHATS_KEY, JSON.stringify(updated));
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
      localStorage.setItem(CHATS_KEY, JSON.stringify(updated));
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
    localStorage.setItem(CHATS_KEY, JSON.stringify(updated));
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
    setCurrentContextTokens(estimateConversationTokens(buildApiHistory(apiHistory, contextDigests)));
  }, [apiHistory, contextDigests, currentChatId, settings.contextThreshold]);

  const callLLM = async (
    history: ConversationMessage[],
    settings: AppSettings,
    includeTools: boolean = true
  ): Promise<{ text: string; rawResponse: any }> => {
    if (settings.llmProvider === 'openai') {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
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
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = await response.json();
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

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
          body: JSON.stringify(requestBody),
        }
      );
      if (!response.ok) throw new Error(await readApiError(response));
      const data = await response.json();
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
    let estimatedTokens = estimateConversationTokens(buildApiHistory(history, nextDigests));

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
      estimatedTokens = estimateConversationTokens(buildApiHistory(history, nextDigests));
    }

    return nextDigests;
  };

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
        const result = await callLLM(buildApiHistory(currentHistory, currentDigests, courseOverview), settings);
        const functionCalls = parseFunctionCalls(result.rawResponse);

        if (result.text) {
          currentMessages = [
            ...currentMessages,
            { id: (Date.now() + Math.random()).toString(), role: 'assistant', content: result.text, timestamp: new Date() },
          ];
          setMessages(currentMessages);
        }

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

        if (functionCalls.length === 0) break;

        toolRounds += 1;
        const toolResults: ToolResult[] = [];
        for (const functionCall of functionCalls) {
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
      console.error('Error calling API:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to get response from AI'}`,
        timestamp: new Date(),
      };
      const errorMessages = [...currentMessages, errorMessage];
      // Drop any dangling tool-call turn so the next request is well-formed
      const safeHistory = currentHistory.map(capToolResults).filter((m, i, arr) => !(m.toolCalls?.length && i === arr.length - 1));
      setMessages(errorMessages);
      setApiHistory(safeHistory);
      saveCurrentChat(activeChatId, errorMessages, safeHistory, currentDigests);
    } finally {
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
        {activeTab === 'chat' && (
          <ChatUI
            messages={messages}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'graph' && <GraphExplorer settings={settings} />}
        {activeTab === 'settings' && (
          <Settings
            settings={settings}
            onSettingsChange={handleSettingsChange}
            currentContextTokens={currentContextTokens}
          />
        )}
      </main>
    </div>
  );
}

export default App;
