import type { ConversationMessage, ToolCall } from '../agent/history';
import { readSSE, parseSSEJson } from '../utils/sse';
import { assertDimensions, parseToolArgs, postJson, readApiError } from './http';
import type { ChatResult, ProviderAdapter, ProviderEndpoint, ToolSpec, Usage } from './types';

/**
 * OpenAI Chat Completions (`/chat/completions`) — the protocol every OpenAI-compatible service
 * speaks (OpenRouter, Groq, DeepSeek, Ollama, LM Studio, a custom base URL). OpenAI itself uses
 * the Responses adapter. Compatible services that think stream it as `delta.reasoning_content`
 * (DeepSeek) or `delta.reasoning` (OpenRouter, Groq, Ollama); both go to `onThought`.
 */

// OpenAI chat format: system/user/assistant(+tool_calls)/tool messages
export function toOpenAIMessages(messages: ConversationMessage[]): any[] {
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

export function openAIChatTools(tools: ToolSpec[]) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function usageFromOpenAI(usage: any): Usage | undefined {
  if (!usage || typeof usage.prompt_tokens !== 'number') return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens ?? 0,
    ...(cached ? { cachedInput: cached } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Reads a chat-completions stream: text deltas to `onDelta`, reasoning deltas to `onThought`,
 * tool calls accumulated by `index` (id and name first, then argument pieces), usage from the
 * final chunk (`stream_options.include_usage`).
 */
export async function readOpenAIStream(
  response: Response,
  onDelta: (text: string) => void,
  onThought?: (text: string) => void
): Promise<{ text: string; toolCalls: ToolCall[]; finishReason?: string; usage?: Usage }> {
  let text = '';
  let finishReason: string | undefined;
  let usage: Usage | undefined;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];

  for await (const data of readSSE(response)) {
    if (data === '[DONE]') break;
    const chunk = parseSSEJson(data);
    if (!chunk) continue;
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.usage) usage = usageFromOpenAI(chunk.usage) ?? usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (thought) onThought?.(thought);
    for (const fragment of delta.tool_calls || []) {
      const index = typeof fragment.index === 'number' ? fragment.index : calls.length;
      const call = (calls[index] ||= { id: '', name: '', arguments: '' });
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
    }
  }

  const toolCalls = calls
    .filter((c) => c && c.name)
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: parseToolArgs(c.arguments) }));
  return { text, toolCalls, finishReason, usage };
}

const authHeaders = (endpoint: ProviderEndpoint): Record<string, string> =>
  endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};

/** OpenAI-style `/embeddings`; shared with the Responses adapter. */
export async function openAIEmbed(endpoint: ProviderEndpoint, texts: string[], model: string): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const response = await postJson(
      `${endpoint.baseUrl}/embeddings`,
      authHeaders(endpoint),
      {
        model,
        input: texts.slice(i, i + 50),
        // OpenAI's text-embedding-3 models shorten on request; compatible servers may not know the field
        ...(endpoint.provider === 'openai' ? { dimensions: 768 } : {}),
      },
      {}
    );
    if (!response.ok) throw new Error(`Embedding failed: ${await readApiError(response)}`);
    const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error('Embedding failed: no embeddings in the response');
    // Sort by index to keep the input order
    out.push(...[...data.data].sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding));
  }
  return assertDimensions(out, model);
}

export const openAIChatAdapter: ProviderAdapter = {
  id: 'openai-chat',

  async chat(endpoint, request, io): Promise<ChatResult> {
    const response = await postJson(
      `${endpoint.baseUrl}/chat/completions`,
      authHeaders(endpoint),
      {
        model: request.model,
        messages: toOpenAIMessages(request.messages),
        // `max_tokens` is the field compatible servers share (OpenAI itself goes through Responses)
        max_tokens: request.maxOutputTokens,
        ...(request.tools.length ? { tools: openAIChatTools(request.tools) } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      io
    );
    if (!response.ok) throw new Error(await readApiError(response));
    const result = await readOpenAIStream(response, io.onDelta ?? (() => {}), request.thinking ? io.onThought : undefined);
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage, finishReason: result.finishReason };
  },

  embed: (endpoint, texts, model) => openAIEmbed(endpoint, texts, model),
};
