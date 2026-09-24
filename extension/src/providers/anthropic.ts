import type { ConversationMessage, ToolCall } from '../agent/history';
import { readSSE, parseSSEJson } from '../utils/sse';
import { parseToolArgs, postJson, readApiError } from './http';
import { modelInfo } from './models';
import type { ChatResult, ProviderAdapter, ToolSpec, Usage } from './types';

/**
 * Anthropic Messages API (`/v1/messages`). Browser calls need the
 * `anthropic-dangerous-direct-browser-access` header. The system prompt and the tool list carry
 * `cache_control` breakpoints, so the stable prefix is cached explicitly. Extended thinking returns
 * signed thinking blocks that must be sent back, unchanged, in the assistant turn they belong to
 * while a tool loop continues; they are kept as the turn's `replay` data. Messages must alternate
 * user/assistant and start with a user turn.
 */

export const ANTHROPIC_VERSION = '2023-06-01';
const THINKING_BUDGET = 1024; // the API's minimum; thoughts are for display, not depth

export function toAnthropicRequest(messages: ConversationMessage[]): { system: any[]; messages: any[] } {
  const systemTexts: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  const push = (role: 'user' | 'assistant', content: any[]) => {
    if (!content.length) return;
    const prev = out[out.length - 1];
    if (prev?.role === role) prev.content.push(...content); // e.g. tool results followed by a steering message
    else out.push({ role, content });
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemTexts.push(msg.content);
    } else if (msg.toolResults?.length) {
      push('user', msg.toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.result })));
    } else if (msg.role === 'assistant') {
      push('assistant', [
        ...(msg.replay?.adapter === 'anthropic' ? msg.replay.items : []),
        ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
        ...(msg.toolCalls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
      ]);
    } else if (msg.content) {
      push('user', [{ type: 'text', text: msg.content }]);
    }
  }
  // After a digest the remaining history can start with an assistant turn
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(The earlier conversation is summarized above.)' }] });

  const system = systemTexts.length
    ? [{ type: 'text', text: systemTexts.join('\n\n'), cache_control: { type: 'ephemeral' } }]
    : [];
  return { system, messages: out };
}

export function anthropicTools(tools: ToolSpec[]) {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

/**
 * Thinking may be requested only when the turn a tool loop continues from carries its thinking
 * blocks (a turn produced by another provider, or with thinking off, does not).
 */
function canThink(messages: ConversationMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') return !m.toolCalls?.length || m.replay?.adapter === 'anthropic';
    if (!m.toolResults?.length) return true; // a fresh user turn: no open tool loop
  }
  return true;
}

export async function readAnthropicStream(
  response: Response,
  onDelta: (text: string) => void,
  onThought?: (text: string) => void
): Promise<{ text: string; toolCalls: ToolCall[]; thinkingBlocks: any[]; usage?: Usage; finishReason?: string }> {
  const blocks: any[] = [];
  let usage: Usage | undefined;
  let finishReason: string | undefined;

  for await (const data of readSSE(response)) {
    const event = parseSSEJson(data);
    if (!event?.type) continue;
    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage ?? {};
        const cached = u.cache_read_input_tokens ?? 0;
        usage = {
          input: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0,
          ...(cached ? { cachedInput: cached } : {}),
        };
        break;
      }
      case 'content_block_start': {
        const b = event.content_block ?? {};
        blocks[event.index] =
          b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, json: '' }
          : b.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' }
          : b.type === 'text' ? { type: 'text', text: '' }
          : { ...b }; // redacted_thinking and anything newer is kept as sent
        break;
      }
      case 'content_block_delta': {
        const block = blocks[event.index];
        const d = event.delta ?? {};
        if (!block) break;
        if (d.type === 'text_delta') {
          block.text += d.text;
          onDelta(d.text);
        } else if (d.type === 'input_json_delta') block.json += d.partial_json;
        else if (d.type === 'thinking_delta') {
          block.thinking += d.thinking;
          onThought?.(d.thinking);
        } else if (d.type === 'signature_delta') block.signature += d.signature;
        break;
      }
      case 'message_delta':
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        if (usage && typeof event.usage?.output_tokens === 'number') usage.output = event.usage.output_tokens;
        break;
      case 'error':
        throw new Error(event.error?.message || 'The model returned an error.');
    }
  }

  const present = blocks.filter(Boolean);
  const toolCalls = present
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: parseToolArgs(b.json) }));
  return {
    text: present.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls,
    thinkingBlocks: present.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
    usage,
    finishReason,
  };
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  async chat(endpoint, request, io): Promise<ChatResult> {
    const { system, messages } = toAnthropicRequest(request.messages);
    const think = request.thinking && modelInfo(endpoint.provider, request.model).thinking !== 'none' && canThink(request.messages);
    const response = await postJson(
      `${endpoint.baseUrl}/messages`,
      {
        'x-api-key': endpoint.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      {
        model: request.model,
        // The thinking budget is part of max_tokens and must stay below it
        max_tokens: request.maxOutputTokens + (think ? THINKING_BUDGET : 0),
        ...(system.length ? { system } : {}),
        messages,
        ...(request.tools.length ? { tools: anthropicTools(request.tools) } : {}),
        ...(think ? { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET } } : {}),
        stream: true,
      },
      io
    );
    if (!response.ok) throw new Error(await readApiError(response));

    const result = await readAnthropicStream(response, io.onDelta ?? (() => {}), think ? io.onThought : undefined);
    if (!result.text && result.toolCalls.length === 0 && result.finishReason && result.finishReason !== 'end_turn') {
      throw new Error(`The model returned no answer (${result.finishReason}).`);
    }
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      ...(result.thinkingBlocks.length ? { replay: { adapter: 'anthropic' as const, items: result.thinkingBlocks } } : {}),
      usage: result.usage,
      finishReason: result.finishReason,
    };
  },
};
