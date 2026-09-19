# 02 — Agent loop and conversation model

Source: `src/App.tsx` (provider adapters, history building, chat state). The tool catalogue and system prompt live in `src/agent/` (see `03-tools.md`).

## Two representations of a conversation

There is a deliberate split between what the **user sees** and what the **model sees**.

| Type | Purpose | Persisted? |
|---|---|---|
| `Message` (`components/ChatUI`) | Display bubbles: `role`, `content`, `timestamp`, plus `activity` (one line per tool call the turn made) and a transient `streaming` flag. | Yes, `Chat.messages` (`streaming` is stripped on save) |
| `ConversationMessage` | The model-facing turn: `role`, `content`, plus structured `toolCalls` / `toolResults` and Gemini `thoughtSignature`s. | Yes, `Chat.apiHistory` (tool results capped at `PERSISTED_TOOL_RESULT_MAX` = 1,500 chars) |
| `ContextDigest` | Compact memory produced by an LLM summarization call when the history exceeds the threshold; `coversUpToIndex` is an index into `apiHistory`. (`kind: 'tool_loop'` digests are legacy — still replayed, no longer produced.) | Yes, `Chat.contextDigests` |

`buildApiHistory(apiHistory, digests, courseOverview)` assembles the model-facing history:

1. One `system` message: `SYSTEM_PROMPT` only.
2. Every digest, oldest first, as a `system` message labelled `[Conversation memory | <iso>]`.
3. `apiHistory` after the highest `coversUpToIndex` — real user / assistant / tool-call / tool-result turns.
4. The course roster (`getGraphOverviewText`) is **prepended to the latest user turn's content**, not put in the system prompt, so the prefix (prompt + tool schemas + digests) stays identical between turns and cacheable by the provider.

Chats saved by older versions have no `apiHistory`; `reviveChat` rebuilds it from the display messages.

## The turn: `handleSendMessage`

```
user text
  → append to messages (display) and apiHistory (model)
  → ensureContextWithinThreshold()        (may create conversation digests)
  → fetch course overview
  → loop (max MAX_TOOL_ROUNDS = 12):
      append an empty assistant bubble (streaming: true)
      callLLM(buildApiHistory(...), settings, { onDelta, signal })   (tools included; streamed)
        onDelta appends to the bubble, one paint per animation frame
      parse function calls (either provider format)
      finalize the bubble: full text + an activity line per call (or drop it if it has neither)
      append assistant ConversationMessage (with toolCalls + signatures)
      if no function calls: break
      execute each tool sequentially (abort checked between tools) → append a toolResults turn
  → cap persisted tool results, ensureContextWithinThreshold(), save
  → on error: keep the interrupted bubble's partial text, append an "Error: …" bubble
  → on Stop (AbortError): keep the partial text, no error bubble
    either way: a dangling tool-call turn keeps its text as a plain assistant turn and loses its calls;
    partial text of an interrupted turn is appended as an assistant turn
```

Notes:
- **Streaming.** `callLLM(history, settings, { includeTools?, onDelta?, signal? })`: with `onDelta` the provider's streaming endpoint is used and text fragments are forwarded as they arrive; without it (digests) the plain endpoint is used. A shared `readSSE` reader yields each `data:` payload; `readOpenAIStream` / `readGeminiStream` merge the chunks into the **non-streaming response shape**, so `parseFunctionCalls`, `extractTextThoughtSignature` and the signature replay are unchanged. `handleSendMessage` holds an `AbortController` (`abortRef`); the Stop button aborts the fetch and the loop checks `signal.aborted` between tools.
- Tools run **sequentially**. PGlite is a single connection and Canvas rate-limits bursts.
- Tool arguments are coerced to strings before execution; implementations parse them.
- There is **no tool-loop digest call** any more: the tool turns themselves are persisted (capped) and the threshold summarizer compacts them when needed. This removed one LLM call per tool-using turn and the consecutive-assistant-turn replay problem.

## Provider adapters

`callLLM(messages, settings, includeTools)` dispatches on `settings.llmProvider`.

### OpenAI (`toOpenAIMessages`, `toOpenAITools`)
- Endpoint: `${resolveBaseUrl(settings)}/chat/completions`, Bearer auth. `resolveBaseUrl` (`src/settings.ts`) returns the user's `baseUrl` or the provider default in `DEFAULT_BASE_URLS` (`https://api.openai.com/v1`).
- Tool schemas are converted from the Google-style `TOOL_CONFIG` (uppercase types) to JSON-Schema function tools.
- Streaming: `stream: true`; `delta.content` → `onDelta`, `delta.tool_calls[]` fragments are accumulated by `index` (id, name, then argument pieces) and joined at `[DONE]`; a `{ error }` event throws with its message.
- History mapping: assistant turns with `toolCalls` → `tool_calls[]`; `toolResults` → one `role: 'tool'` message per result keyed by `tool_call_id`; digests → mid-conversation `system` messages.
- `max_completion_tokens: 2000`. Errors include the provider's message body (`readApiError`).

### Google Gemini (`toGeminiRequest`)
- Endpoint: `${resolveBaseUrl(settings)}/models/{model}:generateContent` (default root `https://generativelanguage.googleapis.com/v1beta`; key in the `x-goog-api-key` header).
- All `system` messages (prompt + digests) are concatenated into `systemInstruction`; ordering relative to user turns is lost, which is acceptable because digests are memory, not dialogue. Parts flagged `thought` are excluded from the visible text.
- `toolResults` → a `user` content with `functionResponse` parts; `toolCalls` → `model` content with `functionCall` parts.
- Streaming: `:streamGenerateContent?alt=sse`. Visible text parts are concatenated into one part; a `thoughtSignature` seen on any text part (Gemini sends it on the last chunk, sometimes with empty text) is carried on that merged part; function-call parts keep their own; `finishReason` / `promptFeedback` come from whichever chunk carries them.
- **Thought signatures.** Gemini 3 attaches an opaque `thoughtSignature` to function-call parts (and sometimes text parts) and requires it to be echoed back verbatim when the turn is replayed. The loop captures them on `ToolCall.thoughtSignature` / `ConversationMessage.thoughtSignature`. If a replayed model turn has no signature on any call (e.g. after a provider switch), the first call gets the documented placeholder `skip_thought_signature_validator`.
- `maxOutputTokens: 2000`. API key goes in the `x-goog-api-key` header. If the response has no text and no function calls and `finishReason` ≠ `STOP` (or the prompt was blocked), `callLLM` throws with the reason instead of returning an empty turn.

`parseFunctionCalls` inspects the raw response and handles both shapes (`choices[0].message.tool_calls` vs `candidates[0].content.parts[].functionCall`). Gemini calls have no ids; synthetic `call_N` ids are assigned.

## Context management

Driven by `settings.contextThreshold` (default 15,000 tokens; ~4 chars/token estimate, tool schema size included).

`ensureContextWithinThreshold` runs before the model call and after the turn. While the estimated history exceeds the threshold, it takes the oldest un-digested turns up to 25 % of the threshold (`takeMessagesByTokenBudget` — which never splits an assistant tool-call turn from its tool-result turn and always leaves the latest turn verbatim), flattens tool turns to text, asks the model (no tools) for a digest with the instruction as the **final user turn** (Gemini rejects requests ending on a model turn), and records a `conversation` digest.

## Chat persistence

`chats` state is mirrored to `localStorage['canvas-buddy-chats']` on every mutation (`saveCurrentChat`, `createNewChat`, `deleteChat`). On mount, the last chat is selected. Dates are revived from ISO strings. A new chat is titled from its first user message (`chatTitleFor`).

## Where to look when…

- The model asks for the wrong thing → tool descriptions in `agent/tools.ts` and `SYSTEM_PROMPT` in `agent/prompt.ts`.
- A provider rejects the request → the adapter for that provider in `App.tsx`; the thrown error now carries the provider's message.
- The model's answer is stale → not a model problem: check the freshness engine (`04-knowledge-graph.md`) and the collection's TTL/probe.
- Memory seems lost between turns → `Chat.apiHistory` (tool results are capped at 1,500 chars) and the conversation digests.

