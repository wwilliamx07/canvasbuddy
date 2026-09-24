import type { ConversationMessage, ToolCall } from '../agent/history';
import { readSSE, parseSSEJson } from '../utils/sse';
import { parseToolArgs, postJson, readApiError } from './http';
import { modelInfo } from './models';
import { openAIEmbed } from './openaiChat';
import type { ChatResult, ProviderAdapter, ToolSpec, Usage } from './types';

/**
 * OpenAI Responses API (`/responses`) — the only OpenAI API that returns reasoning summaries.
 * Requests are stateless (`store: false`); a reasoning model's encrypted reasoning items are
 * returned (`include: ['reasoning.encrypted_content']`), kept as the turn's `replay` data and sent
 * back with the function calls they led to, so the model keeps its reasoning across tool rounds.
 */

export function toResponsesInput(messages: ConversationMessage[]): any[] {
  const input: any[] = [];
  for (const msg of messages) {
    if (msg.toolResults?.length) {
      for (const r of msg.toolResults) input.push({ type: 'function_call_output', call_id: r.id, output: r.result });
      continue;
    }
    if (msg.role === 'assistant') {
      if (msg.replay?.adapter === 'openai-responses') input.push(...msg.replay.items);
      if (msg.content) input.push({ role: 'assistant', content: msg.content });
      for (const c of msg.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
      }
      continue;
    }
    // System messages (the prompt, digests) keep their place; the API accepts them in the input
    input.push({ role: msg.role, content: msg.content });
  }
  return input;
}

export function responsesTools(tools: ToolSpec[]) {
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

export function usageFromResponses(usage: any): Usage | undefined {
  if (!usage || typeof usage.input_tokens !== 'number') return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens ?? 0,
    ...(cached ? { cachedInput: cached } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

export async function readResponsesStream(
  response: Response,
  onDelta: (text: string) => void,
  onThought?: (text: string) => void
): Promise<{ text: string; toolCalls: ToolCall[]; reasoningItems: any[]; usage?: Usage; finishReason?: string }> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  const reasoningItems: any[] = [];
  let usage: Usage | undefined;
  let finishReason: string | undefined;

  for await (const data of readSSE(response)) {
    const event = parseSSEJson(data);
    if (!event?.type) continue;
    switch (event.type) {
      case 'response.output_text.delta':
        text += event.delta;
        onDelta(event.delta);
        break;
      case 'response.reasoning_summary_text.delta':
        onThought?.(event.delta);
        break;
      case 'response.reasoning_summary_part.done':
        onThought?.('\n\n'); // summaries come in parts; keep them apart
        break;
      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type === 'function_call') toolCalls.push({ id: item.call_id, name: item.name, args: parseToolArgs(item.arguments) });
        else if (item?.type === 'reasoning') reasoningItems.push(item);
        break;
      }
      case 'response.completed':
        usage = usageFromResponses(event.response?.usage);
        finishReason = event.response?.status;
        break;
      case 'response.incomplete':
        usage = usageFromResponses(event.response?.usage);
        finishReason = event.response?.incomplete_details?.reason || 'incomplete';
        break;
      case 'response.failed':
        throw new Error(event.response?.error?.message || 'The model failed to answer.');
      case 'error':
        throw new Error(event.message || event.error?.message || 'The model returned an error.');
    }
  }
  return { text, toolCalls, reasoningItems, usage, finishReason };
}

export const openAIResponsesAdapter: ProviderAdapter = {
  id: 'openai-responses',

  async chat(endpoint, request, io): Promise<ChatResult> {
    const thinking = modelInfo(endpoint.provider, request.model).thinking;
    const base = {
      model: request.model,
      input: toResponsesInput(request.messages),
      max_output_tokens: request.maxOutputTokens,
      ...(request.tools.length ? { tools: responsesTools(request.tools) } : {}),
      stream: true,
      store: false,
    };
    // Reasoning models always return their (encrypted) reasoning for replay; summaries only when wanted
    const reasoning = {
      include: ['reasoning.encrypted_content'],
      ...(request.thinking ? { reasoning: { summary: 'auto' } } : {}),
    };
    const tryReasoning = thinking === 'summaries' || (thinking === 'unknown' && request.thinking);
    const url = `${endpoint.baseUrl}/responses`;
    const headers = { Authorization: `Bearer ${endpoint.apiKey}` };

    let response = await postJson(url, headers, tryReasoning ? { ...base, ...reasoning } : base, io);
    if (!response.ok && tryReasoning && thinking === 'unknown' && response.status === 400) {
      // A model that does not reason rejects the reasoning fields; answer without them
      const message = await readApiError(response);
      if (!/reason/i.test(message)) throw new Error(message);
      response = await postJson(url, headers, base, io);
    }
    if (!response.ok) throw new Error(await readApiError(response));

    const result = await readResponsesStream(response, io.onDelta ?? (() => {}), request.thinking ? io.onThought : undefined);
    if (!result.text && result.toolCalls.length === 0 && result.finishReason && result.finishReason !== 'completed') {
      throw new Error(`The model returned no answer (${result.finishReason}).`);
    }
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      ...(result.reasoningItems.length ? { replay: { adapter: 'openai-responses' as const, items: result.reasoningItems } } : {}),
      usage: result.usage,
      finishReason: result.finishReason,
    };
  },

  embed: (endpoint, texts, model) => openAIEmbed(endpoint, texts, model),
};
