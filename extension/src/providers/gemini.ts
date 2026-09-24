import type { ConversationMessage, ToolCall } from '../agent/history';
import { readSSE, parseSSEJson } from '../utils/sse';
import { assertDimensions, parseJsonOrString, postJson, readApiError } from './http';
import { modelInfo } from './models';
import type { ChatResult, JsonSchema, ProviderAdapter, ToolSpec, Usage } from './types';

/**
 * Google Gemini (`generativelanguage.googleapis.com/v1beta`): `streamGenerateContent?alt=sse`,
 * key in `x-goog-api-key`. Thought signatures ride on function-call parts (and sometimes the text
 * part) and must be echoed back verbatim when the turn is replayed.
 */

// Gemini rejects replayed function calls that carry no signature (e.g. after a provider switch
// or when the model omitted one); this documented placeholder tells it to skip the check.
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

// Gemini format: systemInstruction + contents with text / functionCall / functionResponse parts
export function toGeminiRequest(messages: ConversationMessage[]): { systemInstruction?: any; contents: any[] } {
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
      // A model turn that said nothing (Gemini sometimes ends a tool loop with an empty STOP) is
      // left out: Gemini rejects an empty text part, which would fail every later request of the chat
      if (!msg.content) continue;
      contents.push({
        role: 'model',
        parts: [{ text: msg.content, ...(msg.thoughtSignature ? { thoughtSignature: msg.thoughtSignature } : {}) }],
      });
      continue;
    }
    // A steering message lands right after tool results; Gemini gets both in one user content
    const prev = contents[contents.length - 1];
    if (prev?.role === 'user') prev.parts.push({ text: msg.content });
    else contents.push({ role: 'user', parts: [{ text: msg.content }] });
  }

  return {
    systemInstruction: systemTexts.length ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
    contents,
  };
}

const OPENAPI_KEYWORDS = new Set(['type', 'description', 'enum', 'properties', 'required', 'items', 'nullable']);

/**
 * Gemini's `parameters` takes an OpenAPI subset with upper-case types; a schema that fits (every
 * built-in tool) goes there, anything richer (connection tools) as `parametersJsonSchema`.
 */
function toOpenApiSchema(schema: JsonSchema): any | null {
  if (Object.keys(schema).some((k) => !OPENAPI_KEYWORDS.has(k))) return null;
  const out: any = {};
  if (typeof schema.type === 'string') out.type = schema.type.toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const converted = toOpenApiSchema(value);
      if (!converted) return null;
      out.properties[key] = converted;
    }
  }
  if (schema.items) {
    const items = toOpenApiSchema(schema.items);
    if (!items) return null;
    out.items = items;
  }
  return out;
}

export function geminiTools(tools: ToolSpec[]) {
  return tools.map((t) => {
    const parameters = toOpenApiSchema(t.parameters);
    return parameters
      ? { name: t.name, description: t.description, parameters }
      : { name: t.name, description: t.description, parametersJsonSchema: t.parameters };
  });
}

export function parseGeminiFunctionCalls(responseData: any): ToolCall[] {
  const calls: ToolCall[] = [];
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return calls;
  for (const part of parts) {
    if (part.functionCall) {
      calls.push({
        id: part.functionCall.id || `call_${calls.length}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
    }
  }
  return calls;
}

// Gemini: signature attached to a text part of the model turn (needed when replaying it)
export function extractTextThoughtSignature(responseData: any): string | undefined {
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && parts[i].thoughtSignature) return parts[i].thoughtSignature;
  }
  return undefined;
}

export function extractTextContent(responseData: any): string {
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let output = '';
  for (const part of parts) {
    if (part.text && !part.thought) output += part.text;
  }
  return output;
}

export function usageFromGemini(meta: any): Usage | undefined {
  if (!meta || typeof meta.promptTokenCount !== 'number') return undefined;
  return {
    input: meta.promptTokenCount,
    output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    ...(meta.cachedContentTokenCount ? { cachedInput: meta.cachedContentTokenCount } : {}),
    ...(meta.thoughtsTokenCount ? { reasoning: meta.thoughtsTokenCount } : {}),
  };
}

/**
 * Gemini stream → the non-streaming response shape. Visible text parts are concatenated into one
 * part; a thought signature seen on any text part (Gemini sends it on the last chunk, sometimes
 * with empty text) is carried on that merged part, and function-call parts keep their own, so the
 * parsers above and the signature replay work unchanged. Thought parts (`thought: true`, only sent
 * when requested) are concatenated into one thought part and forwarded to `onThought`; they never
 * reach the visible text. `usageMetadata` is taken from the last chunk that carries it.
 */
export async function readGeminiStream(
  response: Response,
  onDelta: (text: string) => void,
  onThought?: (text: string) => void
): Promise<any> {
  const parts: any[] = [];
  let textPart: any = null;
  let thoughtPart: any = null;
  let finishReason: string | undefined;
  let promptFeedback: any;
  let usageMetadata: any;

  for await (const data of readSSE(response)) {
    const chunk = parseSSEJson(data);
    if (!chunk) continue;
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback;
    if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
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
      } else if (typeof part.text === 'string' && part.thought) {
        if (!thoughtPart) {
          thoughtPart = { text: '', thought: true };
          parts.push(thoughtPart);
        }
        thoughtPart.text += part.text;
        if (part.thoughtSignature) thoughtPart.thoughtSignature = part.thoughtSignature;
        if (part.text) onThought?.(part.text);
      } else {
        parts.push(part);
      }
    }
  }

  return {
    candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(promptFeedback ? { promptFeedback } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',

  async chat(endpoint, request, io): Promise<ChatResult> {
    const { systemInstruction, contents } = toGeminiRequest(request.messages);
    const body: any = {
      ...(systemInstruction ? { systemInstruction } : {}),
      contents,
      generationConfig: { maxOutputTokens: request.maxOutputTokens },
      ...(request.tools.length ? { tools: [{ functionDeclarations: geminiTools(request.tools) }] } : {}),
    };
    const url = `${endpoint.baseUrl}/models/${request.model}:streamGenerateContent?alt=sse`;
    const headers = { 'x-goog-api-key': endpoint.apiKey };
    const wantThoughts = request.thinking && modelInfo(endpoint.provider, request.model).thinking !== 'none';
    const withThoughts = { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { includeThoughts: true } } };

    let response = await postJson(url, headers, wantThoughts ? withThoughts : body, io);
    if (!response.ok && wantThoughts && response.status === 400) {
      // Models without thinking reject thinkingConfig; answer without thoughts rather than fail
      const message = await readApiError(response);
      if (!/think/i.test(message)) throw new Error(message);
      response = await postJson(url, headers, body, io);
    }
    if (!response.ok) throw new Error(await readApiError(response));

    const data = await readGeminiStream(response, io.onDelta ?? (() => {}), wantThoughts ? io.onThought : undefined);
    const text = extractTextContent(data);
    const toolCalls = parseGeminiFunctionCalls(data);
    const finishReason = data?.candidates?.[0]?.finishReason;
    const blocked = data?.promptFeedback?.blockReason;
    if (!text && toolCalls.length === 0 && (blocked || (finishReason && finishReason !== 'STOP'))) {
      throw new Error(`The model returned no answer (${blocked ? `blocked: ${blocked}` : `finish reason: ${finishReason}`}).`);
    }
    return {
      text,
      toolCalls,
      thoughtSignature: extractTextThoughtSignature(data),
      usage: usageFromGemini(data.usageMetadata),
      finishReason,
    };
  },

  async embed(endpoint, texts, model, task) {
    const taskType = task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const cleanModel = model.replace(/^models\//, '');
    const out: number[][] = [];
    // Batches of 20 stay well within Google's per-request limits
    for (let i = 0; i < texts.length; i += 20) {
      const slice = texts.slice(i, i + 20);
      const response = await postJson(
        `${endpoint.baseUrl}/models/${cleanModel}:batchEmbedContents`,
        { 'x-goog-api-key': endpoint.apiKey },
        {
          requests: slice.map((text) => ({
            model: `models/${cleanModel}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: 768,
          })),
        },
        {}
      );
      if (!response.ok) throw new Error(`Embedding failed: ${await readApiError(response)}`);
      const data = await response.json();
      if (!Array.isArray(data.embeddings)) throw new Error('Embedding failed: no embeddings in the response');
      out.push(...data.embeddings.map((e: any) => e.values));
    }
    return assertDimensions(out, model);
  },
};
