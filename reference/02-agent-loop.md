# 02 — Agent loop and conversation model

Sources: `src/agent/run.ts` (`runAgent`, the loop), `src/agent/digest.ts` (context size and digests), `src/chats.ts` (chats and their persistence), `src/App.tsx` (chat state, the `RunHost` it hands the loop, commands), `src/providers/` (`callModel` / `embedTexts`, the provider registry, one adapter per wire protocol, the model catalogue, shared HTTP + retry — no React, no app state), `src/agent/history.ts` (conversation types, history building and budgeting, tool-step helpers — pure). Tests: `extension/test/agent/`, `extension/test/providers/`. The tool catalogue and system prompt are in `src/agent/tools.ts` / `prompt.ts` (see `03-tools.md`).

## Two representations of a conversation

There is a deliberate split between what the **user sees** and what the **model sees**.

| Type | Purpose | Persisted? |
|---|---|---|
| `Message` (`ui/model.ts`) | Display bubbles: `role`, `content`, `timestamp`, plus `steps` (the run's thoughts and tool calls, see below) and the transient `streaming` / `queued` flags. | Yes, `Chat.messages` (`streaming` and queued messages are dropped on save, step text is capped) |
| `ConversationMessage` (`agent/history.ts`) | The model-facing turn: `role`, `content`, plus structured `toolCalls` / `toolResults`, Gemini `thoughtSignature`s and adapter `replay` data (below). | Yes, `Chat.apiHistory` (tool results capped at `PERSISTED_TOOL_RESULT_MAX` = 1,500 chars) |
| `ContextDigest` | Compact memory produced by an LLM summarization call when the history exceeds the threshold; `coversUpToIndex` is an index into `apiHistory`. | Yes, `Chat.contextDigests` |

`buildApiHistory(apiHistory, digests, systemPrompt, courseOverview)` assembles the model-facing history:

1. One `system` message: the session's prompt (`buildSystemPrompt`, see `03-tools.md`).
2. Every digest, oldest first, as a `system` message labelled `[Conversation memory | <iso>]`.
3. `apiHistory` after the highest `coversUpToIndex` — real user / assistant / tool-call / tool-result turns.
4. The course roster (`getGraphOverviewText`) is **prepended to the latest user turn's content**, not put in the system prompt, so the prefix (prompt + tool schemas + digests) stays identical between turns and cacheable by the provider.

A chat also carries `loadedTools` (the connection tools it has loaded, see `09-connections.md`), `usage` (token totals, below) and `contextMeasure` (below). `reviveChat` (`chats.ts`) revives dates and defaults missing `apiHistory` / `loadedTools` / `usage` to empty; there are no other compatibility shims.

## The run: `handleSendMessage` → `runAgent`

`handleSendMessage` starts a run when idle (`runConversation` in `App.tsx`, which calls `runAgent` in `agent/run.ts`); while a run is in flight (`runningRef`) it fills the **steering slot** instead (below). `runAgent(host, start, message)` holds no React state: everything it needs from the app comes through a `RunHost` — settings, system prompt, the tools (`RunTools`: built-ins, live connection tools, the find tool, what a call declares), the abort signal, `paint(messages)` and `save(snapshot)`, `takeQueued`, `awaitApproval`, `awaitContinue`, `allowAlways`, `courseOverview` — so it is tested with a fake host (`test/agent/run.test.ts`).

```
user text
  → append to messages (display) and apiHistory (model)
  → digestToThreshold()                  (may create conversation digests), save
  → fetch course overview
  → loop (no hard cap):
      settings.toolRoundsBeforeAsking (default 12) rounds since the user turn / last "keep going"? → wait for the
        student (model.continuePrompt): Keep going → reset the round count, read the steering slot;
        Stop here → leave the loop as if answered (tool turns kept); a message sent meanwhile = keep going
      open the turn's assistant bubble if none is open (streaming: true)
      callModel(settings, { messages: buildApiHistory(...), tools, maxOutputTokens, thinking },
                { onDelta, onThought?, onRetry, signal })                     (always streamed)
        onDelta appends to the bubble's text, onThought to this call's thought step; one paint per frame
      the call's text joins the bubble's text; one tool step per result.toolCalls entry (status running)
      append assistant ConversationMessage (toolCalls, thoughtSignature, replay)
      if no function calls: break
      execute each tool sequentially (abort checked between tools); each result settles its step
        (a connection tool that is not read-only / always allowed first waits in `awaiting` for approval)
      append a toolResults turn
      steering slot filled? → close the bubble, append the queued message as a plain user turn
                              (display + apiHistory), reset the round count, continue
  → close the bubble, cap persisted tool results, digestToThreshold(), save (with the loaded set)
  → on error: keep the interrupted call's partial text, settle running tool steps as errors,
    append an "Error: …" bubble
  → on Stop (AbortError): same, no error bubble, and the slot is emptied
    either way: a dangling tool-call turn keeps its text as a plain assistant turn and loses its calls;
    partial text of an interrupted call is appended as an assistant turn
  → slot filled (queued during the final answer, or before an error)? → it is the next user turn of
    the same run: back to the top
```

**One bubble per user turn.** Every model call of a turn writes into the same assistant bubble: text of successive calls is joined with a blank line, and `Message.steps` collects, in order, a `thought` step per call that returned thoughts and a `tool` step per call (`describeToolCall` label, `detail` = compact JSON args, `result` = first 300 chars of the result or the message of an `{ error }` result, `status` running → done/error). A turn with neither text nor steps leaves no bubble. Steps are display-only; nothing of them goes back to the model. `persistableMessage` caps step text on save (thoughts 4,000 chars, labels/args 500, results 300).

**Steering.** The slot (`queuedRef`) holds one message sent mid-run: `sendMessage` while running puts it there (a second one replaces the first) and shows it at the end of the transcript as a user bubble with `queued: true`; `editQueued` takes it back out for the composer; Stop empties it. The loop reads the slot only **after the current step's tool results have been appended** and before the next model call, so a tool-call turn is never separated from its results and the injected turn is an ordinary user message (no framing) next to the results it may correct. A message queued while the model is writing its final answer (no tool calls pending) is not injected into that answer; the run finishes it and then takes the message as the next turn. Gemini and Anthropic merge it into the `user` turn that carries the tool results (both require alternating turns); the OpenAI adapters take a `user` message after the tool outputs as is. The course roster moves to the injected turn like to any latest user turn. Digests treat it as any other user turn.

Notes:
- **Streaming.** Every call streams; `onDelta` gets text fragments as they arrive and `onThought` thought fragments (passed only while "Show the assistant's reasoning" is on). Digest calls pass no callbacks, no tools and `thinking: false`; they get the run's abort signal, so Stop ends a digest call too. `runConversation` holds an `AbortController` (`abortRef`); the Stop button aborts the fetch and the loop checks `signal.aborted` between tools.
- Tools run **sequentially**. PGlite is a single connection and Canvas rate-limits bursts.
- Built-in tool arguments are coerced to strings before execution; implementations parse them. **Connection tools** (`liveToolsByName`, from `connectionTools(records)`) are dispatched to `runConnectionTool` with the arguments unchanged; one the server does not mark read-only and the student has not always-allowed sets its step to `awaiting` and the loop waits on `awaitApproval()` (resolved by `model.respondToApproval`; "Always allow" also applies to the rest of the run through `allowedThisRun`). Deny → `{ error: 'The student declined this action.' }`. Stop aborts first, then answers deny, so the wait ends in an AbortError. See `09-connections.md`.
- **The declared tools are recomputed before every model call** (`declaredTools(currentLoaded)`, a `ToolSpec[]`): the built-in `TOOL_CONFIG`, then `find_connection_tools` when connection tools load on demand, then the connection tools — all of them for small setups, else the chat's loaded set in load order. All are JSON Schema; each adapter converts them. `find_connection_tools` is dispatched first (`runFindConnectionTools`, then `applyLoad` on the run's `currentLoaded`, saved with the chat); calling a live connection tool loads it too. What a call declares (`declaredToolTokens`) is added to every context estimate. See `09-connections.md` → Lazy loading.
- **Rate limits.** Every adapter posts through `postJson` → `sendWithRetry` (`providers/http.ts`): a 429, 503 or 529 is waited out up to twice, for the delay the provider asks (`Retry-After` seconds or date, OpenAI `retry-after-ms`, Gemini `RetryInfo.retryDelay` in the error body; else 4 s then 12 s), capped at 60 s — a longer requested wait fails at once with the provider's message and "try again in N s". The wait is abort-aware. `ChatIO.onRetry(seconds)` lets the loop add a `notice` step ("Rate limited — retrying in 12 s"), settled when the call returns. Digest calls retry the same way without a step.

## Providers (`src/providers/`)

The loop makes two calls and knows nothing past them: `callModel(settings, request, io)` and `embedTexts(settings, texts, task)` (`providers/index.ts`). Everything that differs between APIs lives in one **adapter per wire protocol**:

```
ChatRequest { messages: ConversationMessage[], tools: ToolSpec[], model, maxOutputTokens, thinking }
ChatIO      { signal?, onDelta?, onThought?, onRetry? }
ChatResult  { text, toolCalls: ToolCall[], thoughtSignature?, replay?, usage?, finishReason? }
ProviderAdapter { id, chat(endpoint, request, io), embed?(endpoint, texts, model, task) }
```

**Registry** (`registry.ts`). `PROVIDERS` lists the services a student can pick, and the adapter each one speaks:

| Provider | Adapter | Default base URL | Key | Embeddings |
|---|---|---|---|---|
| `google` | `gemini` | `generativelanguage.googleapis.com/v1beta` | required | yes |
| `openai` | `openai-responses` | `api.openai.com/v1` | required | yes |
| `anthropic` | `anthropic` | `api.anthropic.com/v1` | required | no |
| `openrouter`, `groq`, `deepseek` | `openai-chat` | their `/v1` roots | required | no |
| `ollama`, `lmstudio` | `openai-chat` | `http://localhost:11434/v1`, `:1234/v1` | none | yes |
| `custom` | `openai-chat` | none (required) | optional | yes |

An OpenAI-compatible service is one registry entry; a new protocol is a new adapter plus entries. `endpointFor(settings, role)` resolves the provider for `chat` or `embedding`, its key (`settings.providers[id].apiKey`) and base URL (override or default, trailing slashes dropped), and throws an error the student can act on ("Add your Anthropic API key in Settings to use it for chat.") — shown as the run's error bubble. `accessOriginsFor(settings)` lists the host permissions local and custom providers need (see `07-ui.md` → Settings).

**Model catalogue** (`models.ts`). `modelInfo(provider, model)` → `{ thinking: 'summaries' | 'none' | 'unknown', contextWindow? }`, by name-prefix rules so a new version of a known family is recognised. It informs and never blocks: `none` means "don't ask for thoughts" (asking fails), `unknown` means try and fall back. `isKnown768Embedding` drives a Settings hint only.

**Shared** (`http.ts`): `postJson` (JSON POST through `sendWithRetry`, response returned unread so an adapter can inspect a 400), `readApiError` (`API error 400 Bad Request: <provider message>`; the status text is left out when empty, as on HTTP/2), `assertDimensions` (every adapter's vectors must be 768-d, else an error naming the model). `utils/sse.ts` `readSSE` yields each `data:` payload for every stream reader.

### Gemini (`gemini.ts`)
- `:streamGenerateContent?alt=sse`, key in `x-goog-api-key`, `generationConfig.maxOutputTokens`.
- All `system` messages (prompt + digests) are concatenated into `systemInstruction`; ordering relative to user turns is lost, which is acceptable because digests are memory, not dialogue. `toolResults` → a `user` content with `functionResponse` parts; `toolCalls` → `model` content with `functionCall` parts. Consecutive user turns (tool results followed by a steering message) are merged. A model turn with no text and no calls (Gemini can end a tool loop with an empty `STOP`) is left out, since Gemini rejects an empty text part and every later request of the chat would fail.
- Tools: a schema that fits Gemini's OpenAPI subset (every built-in tool) goes as `parameters` with upper-case types; anything richer (connection tools) as `parametersJsonSchema`, unchanged.
- `readGeminiStream` merges the chunks into the non-streaming response shape: visible text parts concatenated into one part; a `thoughtSignature` seen on any text part (Gemini sends it on the last chunk, sometimes with empty text) carried on that merged part; function-call parts keep their own; `finishReason`, `promptFeedback`, `usageMetadata` from whichever chunk carries them. Calls have no ids; synthetic `call_N` ids are assigned.
- **Thoughts.** With `thinking` (and a model not known to lack it) the request adds `thinkingConfig: { includeThoughts: true }`; `thought: true` parts go to `onThought` and never into the text. A model without thinking answers 400; the adapter retries once without it when the error mentions thinking. Thoughts are display-only.
- **Thought signatures.** Gemini 3 attaches an opaque `thoughtSignature` to function-call parts (and sometimes text parts) and requires it echoed back verbatim when the turn is replayed. They are kept on `ToolCall.thoughtSignature` / `ConversationMessage.thoughtSignature`. If a replayed model turn has no signature on any call (e.g. produced by another provider), the first call gets the documented placeholder `skip_thought_signature_validator`.
- No text, no calls and `finishReason` ≠ `STOP` (or a blocked prompt) → throws with the reason instead of returning an empty turn.
- Embeddings: `:batchEmbedContents`, batches of 20, `taskType` `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`, `outputDimensionality: 768`.

### OpenAI Responses (`openaiResponses.ts`) — OpenAI itself
- `/responses`, Bearer key, `store: false` (stateless), `max_output_tokens`, tools as flat `{ type: 'function', name, parameters, strict: false }`. History: `toolCalls` → `function_call` items, `toolResults` → `function_call_output` items, `system` messages stay in place.
- The only OpenAI API that returns reasoning summaries. For a reasoning model the request includes `reasoning.encrypted_content`; with `thinking` it adds `reasoning: { summary: 'auto' }` and summary deltas go to `onThought`. For a model the catalogue does not know, the fields are sent only while `thinking` is on (so its reasoning is not replayed otherwise) and dropped after a 400 that mentions reasoning.
- **Replay.** The encrypted reasoning items are returned as `replay: { adapter: 'openai-responses', items }`, stored on the assistant turn and sent back before its function calls, so the model keeps its reasoning across tool rounds.
- Embeddings: `/embeddings` with `dimensions: 768` (shared `openAIEmbed`).

### OpenAI-compatible Chat Completions (`openaiChat.ts`)
- `/chat/completions`, Bearer key only when set, `max_tokens`, `stream_options.include_usage`. Assistant `toolCalls` → `tool_calls[]`; `toolResults` → one `role: 'tool'` message per result; digests → mid-conversation `system` messages.
- Stream: `delta.content` → `onDelta`; `delta.reasoning_content` (DeepSeek) or `delta.reasoning` (OpenRouter, Groq, Ollama) → `onThought` when `thinking`; `delta.tool_calls[]` fragments accumulated by `index`; usage from the final chunk.
- Embeddings: `/embeddings`, batches of 50, re-sorted by `index`, no `dimensions` field (compatible servers may reject it) — the vectors are checked instead.

### Anthropic (`anthropic.ts`)
- `/messages` with `x-api-key`, `anthropic-version: 2023-06-01` and `anthropic-dangerous-direct-browser-access: true` (required for calls from a browser).
- System text becomes one `system` block with `cache_control`, and the last tool carries one too, so the prompt + tool prefix is cached explicitly. Messages must alternate and start with a user turn: consecutive same-role turns are merged and a placeholder user turn is prepended when a digest leaves the history starting with the assistant.
- **Thinking** (`budget_tokens: 1024`, added on top of `max_tokens`): thinking deltas → `onThought`; the signed thinking blocks are returned as `replay: { adapter: 'anthropic', items }` and put back at the start of their assistant turn. Anthropic requires them while a tool loop continues, so thinking is requested only when the open tool-call turn carries Anthropic thinking blocks (not after a turn another provider produced).
- No embeddings API.

**Replay is per adapter.** Each adapter sends back only replay data its own id produced and ignores the rest, so switching provider mid-chat works (the other provider's reasoning is simply dropped).

**Usage.** Every adapter returns `usage: { input, output, cachedInput?, reasoning? }` from the provider's own counts (`input` includes cached tokens).

## Context management

Driven by `settings.contextThreshold` (default 15,000 tokens).

**What is compared against it** (`contextSize` in `agent/digest.ts`, shown by the Settings meter): the provider's own count when there is one, else an estimate.
- After every model call that reports usage, the run records `Chat.contextMeasure = { input, historyLength, coverage }`: the call's input tokens, how many `apiHistory` turns it was sent, and the digests' coverage index then.
- `measuredContextTokens` = `input` + an estimate (~4 chars/token) of the turns added since. It is null — and the whole history is estimated, tool schemas included — when there is no measure, the history got shorter than the measure, or a digest was written since (the coverage changed, so the measured request no longer describes what will be sent).
- Capping tool results at the end of a turn (`capHistory`) subtracts what it removed inside the measured turns from the measure, so a long result read in this turn does not count at full size against the next one.

`digestToThreshold` runs before the first model call of a user turn and after the turn. Tool results inside the turn are not digested: they are persisted capped and compacted by later digests. While the context exceeds the threshold (measured at first; estimated once a digest is written), it takes the oldest un-digested turns up to 25 % of the threshold (`takeMessagesByTokenBudget` — which never splits an assistant tool-call turn from its tool-result turn and always leaves the latest turn verbatim), flattens tool turns to text, asks the model (no tools) for a digest with the instruction as the **final user turn** (Gemini rejects requests ending on a model turn), and records a `conversation` digest.

## Token usage

Every adapter returns the provider's `usage` (`{ input, output, cachedInput?, reasoning? }`, `input` including cached tokens; see Providers). The run adds it up in two places:
- **`Message.usage`** on the turn's assistant bubble: every model call of the bubble plus the digest calls of that user turn — those run before the bubble opens (held as pending) or after it closed (added to it). Shown after the answer's time: "4.1k in (3.2k cached) · 380 out". Persisted.
- **`Chat.usage`** (`ChatUsage`): running totals for `answers` and `digests`, each with its call count (`countUsage`; a call without usage still counts as a call). Persisted.

A provider that reports nothing leaves both unchanged, and the context stays estimated. Cost is not computed (the model catalogue carries no prices).

## Commands (`src/commands.ts`)

A message that is `/name [args]` (`parseCommand`; "/courses/123 …" is text) is run by the app and **never sent to the model**. `handleSendMessage` calls `dispatchCommand(input, commandContext, running)`: `commands.ts` holds the registry and the argument checks and is pure; `App.tsx` implements `CommandContext` over its state. A refusal — unknown command, wrong arguments, nothing to do, or any command but `/new` while a run is in flight (the run repaints the transcript) — comes back as a string the composer shows under itself, keeping the text. An outcome is a **notice**: a display `Message` with `notice: true` (`appendNotice`), persisted with the chat and never in `apiHistory`; without a chat it is shown and not kept.

| Command | Does |
|---|---|
| `/compact [what to keep]` | One digest over **every** un-digested turn, the latest included (`coversUpToIndex` = the last index), so the next turn starts from the digests alone. The focus is appended to the digest instruction. Notice: "Compacted 42 messages · ≈18k → ≈1.3k tokens" with the call's usage; it counts as a digest in `Chat.usage`. While it runs `isLoading` is on, Stop aborts it, and sending is refused ("Compacting…") rather than queued. Also Settings → **Compact now**. |
| `/new` | A new chat (the chat list's New chat). Allowed during a run, which it stops first (see Chat persistence). |
| `/usage` | `Chat.usage`: answers and summaries, calls and tokens. |
| `/export` | Downloads the chat as Markdown (`chatMarkdown`: text, one line per tool step, notices in italics). |
| `/tools [unload <name>]` | The connection tools the chat has loaded (or that all are sent / none are on); `unload` drops one by function name, MCP name or label. |
| `/help` | The list. |

There is deliberately no refresh / sync / index command: memory is engine-managed.

## Chat persistence

`chats` state is mirrored to `localStorage[<slot.chatsKey>]` (`canvas-buddy-chats:<host>/<userId>`) by an effect whenever the `chats` state changes (`saveCurrentChat`, `createNewChat`, `deleteChat` only update state); settings are mirrored the same way. A failed write (the origin's storage is full) is shown in the banner (`writeStorage`), never thrown from a render. Chats are loaded once the identity is known (after connecting) and the last one created is selected (the chat list itself is sorted by last update). A new chat is titled from its first user message (`chatTitleFor`).

**A run belongs to one chat** (`runChatIdRef`). Leaving that chat while it runs or compacts — New chat, `/new`, selecting another chat, deleting it — stops it first (`leaveBusyChat` → Stop). The run's last steps still arrive after that: they are saved to its own chat (`saveCurrentChat(activeChatId, …)`) and painted only while that chat is on screen (`inView`). A message sent in the new chat before the stopped run has wound down is refused ("Stopping the previous answer…") rather than queued into it.

## Where to look when…

- The model asks for the wrong thing → tool descriptions in `agent/tools.ts` and `buildSystemPrompt` in `agent/prompt.ts`.
- A provider rejects the request → its adapter in `providers/` (tests in `test/providers/`); the thrown error carries the provider's message. A missing key, base URL or model → `endpointFor` / `callModel` (`providers/registry.ts`, `providers/index.ts`).
- The model's answer is stale → not a model problem: check the freshness engine (`04-knowledge-graph.md`) and the collection's TTL/probe.
- Memory seems lost between turns → `Chat.apiHistory` (tool results are capped at 1,500 chars) and the conversation digests.

