# 08 — Conventions and gotchas

Things that are easy to break because the reason for them is not visible at the call site.

## Database

- **Never open PGlite from a second page.** `getDB()` takes a page-lifetime Web Lock; a second side panel (another browser window) gets an error by design. Do not "fix" this by removing the lock — the IndexedDB VFS will corrupt.
- **Schema changes go in `schema.ts` as idempotent statements.** `SCHEMA_SQL` runs on every start. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. There is no migration version table.
- **`VECTOR(768)` is fixed.** Both embedding providers are asked for 768 dimensions. Changing it means a migration and a full re-index.
- **Stringify ids.** Every Canvas id is stored and compared as `TEXT`. Always wrap with `String(...)` before passing to SQL; mixing numbers in causes silent non-matches.
- **Prune is destructive by design.** Sync functions delete rows not present in the fetched list. Only call them with a *complete* list (`fetchAllPages`), never with a filtered or single-page result.
- **Go through `ensureCollection`, not the raw `sync*` functions,** from tools and UI. The engine owns `sync_state`; calling a sync directly leaves the stamps stale. Pass `refresh: true` only for user-initiated "refresh now" actions.
- **Never write the legacy `*_synced_at` columns on `courses`.** They are migrated into `sync_state` on startup and otherwise ignored.
- **`files` rows with `total_chunks = 0` mean "known, not indexed".** Every `indexed` flag in the app derives from this; don't insert chunk rows without updating `total_chunks`, and don't set `total_chunks` without chunks.
- **Composite doc ids** come from `docIdFor()` in `db/rag.ts` everywhere in TypeScript; the SQL LEFT JOINs in `graph.ts` (`'page:' || course_id || ':' || …`, `'assignment:' || …`, `substring(file_id from N)` in the prunes) mirror the same formats by hand. Change both together.
- **Syncs run inside `withTransaction`.** Upsert/prune functions take an optional `tx`; pass it through so a failure rolls the whole collection back. Don't call `getDB()` inside a function that received a `tx`.

## Agent / providers

- **Tool args are strings.** The loop stringifies every argument before calling a tool. `true` arrives as `'true'`, `5` as `'5'`.
- **Tool implementations return JSON strings and never throw.** The model reads `{ error }` and can recover; an exception ends the turn.
- **Gemini thought signatures must round-trip.** If you touch `toGeminiRequest`, `parseFunctionCalls`, or the shape of `ConversationMessage`, preserve `thoughtSignature` on both function-call parts and text parts, and keep the `skip_thought_signature_validator` fallback for unsigned replays.
- **Tool results are persisted, capped.** `Chat.apiHistory` holds real tool-call/result turns with each result cut to `PERSISTED_TOOL_RESULT_MAX` (1,500 chars). Keep tool payloads compact; the cap is a safety net, not a budget.
- **Never split a tool-call turn from its results** when slicing history (`takeMessagesByTokenBudget` guards this); providers reject orphaned tool results.
- **The course roster rides on the latest user turn**, not the system prompt (`buildApiHistory`). Adding per-turn content to the system prompt breaks prefix caching.
- **`TOOL_CONFIG` uses uppercase Google types** (`STRING`, `INTEGER`, …). `toOpenAITools` lowercases them; don't write JSON-Schema types directly.
- **The system prompt and tool descriptions are one contract.** Changing what a tool does without updating its description (and any prompt rule naming it) will produce confident misuse.
- **No staleness language in the prompt or tool descriptions.** The model must not be told to "go live", "re-sync" or judge ages; that is the engine's job. `refresh` is the only cache-related parameter and is reserved for "the user says something changed".
- **Tools call `ensureCollection` before reading a collection**, and never fetch Canvas list data themselves.
- **Digests are `role: 'system'` messages.** OpenAI accepts them mid-history; Gemini folds them into `systemInstruction`. Don't emit them as user/assistant turns or they will be summarized again as conversation.

## Canvas

- **Requests rely on session cookies + host permissions.** If a fetch suddenly returns HTML, the user is logged out of Quercus. Adding a new Canvas host requires a `host_permissions` change in `manifest.json`.
- **Use `canvas/http.ts`** (`CANVAS_BASE`, `canvasGet`, `fetchAllPages`) for every Canvas request so 403/404 become `CanvasHttpError` and the freshness engine can mark a collection unavailable. Nothing else may hardcode the base URL.
- **Files and Pages are usually hidden.** All probed UofT courses 403/404 their Files/Pages areas. Code paths must tolerate `unavailable` (the tools fall back to module-linked items). A 403 on a *single* file is different: Canvas denies that file (locked module/folder, unpublished) — `fetchFileMetadata` explains this in its error.
- **Keep Canvas calls sequential.** Parallel bursts trigger throttling; the code deliberately awaits in series.
- **`include[]=items` on modules is best-effort.** Canvas omits inline items for large modules; the modules full sync falls back to the per-module items endpoint when `items` is not an array.
- **Assignment descriptions are lazy.** The compact listing has none; never assume `assignments.description` is populated — go through `fetchAssignmentWithDescription` (which caches it).

## Build / extension

- **CSP requires `'wasm-unsafe-eval'`** for PGlite. Don't tighten it.
- **`optimizeDeps.exclude` for PGlite packages** is required; Vite's pre-bundling breaks the WASM loader.
- **The pdf.js worker is imported with `?url`** so Vite emits it as an asset. Importing it any other way breaks PDF parsing in the packed extension.
- **`removeReservedViteChunks`** in `vite.config.ts` deletes a `__vite-browser-external` artifact that Chrome rejects as a reserved filename. Keep it unless the upstream plugin stops emitting that chunk.
- **`@types/chrome` must be installed** for `tsconfig.app.json` (`types: ["vite/client", "chrome"]`) to type-check; a missing install shows as "Cannot find type definition file for 'chrome'".

## Persistence

- **`localStorage` is written synchronously on every chat mutation.** Large chats serialize fully each time; keep display messages text-only.
- **Settings auto-save on each keystroke.** There is no "unsaved" state; the API key is in localStorage in plain text.

## Style

- Comments explain *why*, not *what*, and are used sparingly; match that density.
- SQL lives in `src/db/*`; components and tools call functions, not `db.query`.
- Errors thrown from sync/index code carry a labelled context (`Failed to fetch modules for course 123: 403`) so the model or UI can show something actionable.
- Types for Canvas payloads are intentionally thin (only fields read by the code); extend them when you read a new field rather than mirroring the whole Canvas object.
