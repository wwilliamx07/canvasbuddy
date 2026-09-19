# 08 — Conventions and gotchas

Things that are easy to break because the reason for them is not visible at the call site.

## Database

- **Never open PGlite from a second page.** `getDB()` takes a page-lifetime Web Lock (per database name); a second side panel (another browser window) gets an error by design. Do not "fix" this by removing the lock — the IndexedDB VFS will corrupt.
- **Never name the database yourself.** The data dir comes from the identity's memory slot (`canvas/identity.ts`) through `configureDatabase`; `getDB()` throws before that. The first identity seen adopts the legacy `canvas-buddy-db` on purpose (IndexedDB cannot rename), so don't "migrate" it. Switching identity in one page is not supported — reload.
- **Schema changes go in `schema.ts` as idempotent statements.** `SCHEMA_SQL` runs on every start. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. There is no migration version table.
- **`VECTOR(768)` is fixed.** Both embedding providers are asked for 768 dimensions. Changing it means a migration and a full re-index.
- **Stringify ids.** Every Canvas id is stored and compared as `TEXT`. Always wrap with `String(...)` before passing to SQL; mixing numbers in causes silent non-matches.
- **Prune is destructive by design.** Sync functions delete rows not present in the fetched list. Only call them with a *complete* list (`fetchAllPages`), never with a filtered or single-page result. Two exemptions exist on purpose: the Files-area prune keeps files still named by a `content_links` row, and unlinking never deletes a registered file (the file still exists in Canvas). Each prune also removes the `content_links` whose source row it deleted.
- **Go through `ensureCollection`, not the raw `sync*` functions,** from tools and UI. The engine owns `sync_state`; calling a sync directly leaves the stamps stale. Pass `refresh: true` only for user-initiated "refresh now" actions.
- **Never write the legacy `*_synced_at` columns on `courses`.** They are migrated into `sync_state` on startup and otherwise ignored.
- **`files` rows with `total_chunks = 0` mean "known, not indexed".** Every `indexed` flag in the app derives from this; don't insert chunk rows without updating `total_chunks`, and don't set `total_chunks` without chunks. Such a row *may* still own `file_chunks` rows — the previous version's chunks are kept so a re-index can reuse their vectors by `content_hash` — so every reader of `file_chunks` joins `files` and filters `total_chunks > 0`. Never surface chunks without that filter.
- **Vector search always goes through the HNSW index.** `searchChunksHybrid` runs inside a transaction with `SET LOCAL enable_sort = off` so the planner takes the index's ordered scan at any table size; the query must order by `embedding <=> $::vector` (cosine, matching `vector_cosine_ops`) — a different operator silently falls back to scan + sort. `hnsw.iterative_scan` / `hnsw.max_scan_tuples` are set once in `getDB()` so filtered searches fill their `LIMIT`. Chunk writers end with `ANALYZE file_chunks` because PGlite never auto-analyzes; keep that when adding a writer. When testing with synthetic vectors, make every row distinct — thousands of identical vectors degenerate the graph and filtered scans return nothing.
- **Vectors are reused across re-indexes by `content_hash`** (SHA-256 of the stored chunk text, same embedding model). If you change what is embedded per chunk in a way that must invalidate old vectors, change the hash input too, otherwise stale vectors will be kept.
- **Composite doc ids** come from `docIdFor()` in `db/rag.ts` everywhere in TypeScript; the SQL LEFT JOINs in `graph.ts` (`'page:' || course_id || ':' || …`, `'assignment:' || …`, `substring(file_id from N)` in the prunes) mirror the same formats by hand. Change both together.
- **Syncs run inside `withTransaction`.** Upsert/prune functions take an optional `tx`; pass it through so a failure rolls the whole collection back. Don't call `getDB()` inside a function that received a `tx`.

## Agent / providers

- **Tool args are strings.** The loop stringifies every argument before calling a tool. `true` arrives as `'true'`, `5` as `'5'`.
- **Tool implementations return JSON strings and never throw.** The model reads `{ error }` and can recover; an exception ends the turn.
- **Gemini thought signatures must round-trip.** If you touch `toGeminiRequest`, `parseFunctionCalls`, or the shape of `ConversationMessage`, preserve `thoughtSignature` on both function-call parts and text parts, and keep the `skip_thought_signature_validator` fallback for unsigned replays.
- **Stream readers must produce the non-streaming shape.** `readOpenAIStream` / `readGeminiStream` exist so that everything after `callLLM` is provider-agnostic and unchanged; don't parse function calls or signatures inside them. Gemini may deliver a text signature on a trailing empty text part — the reader merges it onto the concatenated text part so `extractTextThoughtSignature` (which needs non-empty text) still finds it.
- **`Message.streaming` is transient.** Strip it before persisting (`saveCurrentChat` does); a chat revived with a `streaming` bubble would show a caret forever.
- **Tool results are persisted, capped.** `Chat.apiHistory` holds real tool-call/result turns with each result cut to `PERSISTED_TOOL_RESULT_MAX` (1,500 chars). Keep tool payloads compact; the cap is a safety net, not a budget.
- **Never split a tool-call turn from its results** when slicing history (`takeMessagesByTokenBudget` guards this); providers reject orphaned tool results.
- **The course roster rides on the latest user turn**, not the system prompt (`buildApiHistory`). Adding per-turn content to the system prompt breaks prefix caching.
- **`TOOL_CONFIG` uses uppercase Google types** (`STRING`, `INTEGER`, …). `toOpenAITools` lowercases them; don't write JSON-Schema types directly.
- **The system prompt and tool descriptions are one contract.** Changing what a tool does without updating its description (and any prompt rule naming it) will produce confident misuse.
- **No staleness language in the prompt or tool descriptions.** The model must not be told to "go live", "re-sync" or judge ages; that is the engine's job. `refresh` is the only cache-related parameter and is reserved for "the user says something changed".
- **Tools call `ensureCollection` before reading a collection**, and never fetch Canvas list data themselves.
- **Lazy embedding is a rule.** No sync path may call the embedding API. Embed a document only when a semantic search is about to target it (`indexDocumentJustInTime` for files/pages/assignments, `embedConversationIfNeeded` for threads). Text is stored eagerly because it is free and keyword-searchable; vectors are not.
- **Digests are `role: 'system'` messages.** OpenAI accepts them mid-history; Gemini folds them into `systemInstruction`. Don't emit them as user/assistant turns or they will be summarized again as conversation.

## Canvas

- **Requests rely on session cookies + a runtime origin permission.** If a fetch suddenly returns HTML, the user is logged out of their Canvas. There is no fixed host: the host comes from the Connect screen (`settings.canvasHost`) and its origin is requested with `chrome.permissions.request` — which only works from a user gesture, so a tool call can never acquire a permission mid-run. A new *kind* of deployment is a profile in `canvas/profiles.ts` (name, internal hosts, origins, prompt intro). A new *known instance* (connects without asking) is that profile's `knownHosts` plus the same origin in `manifest.json` `host_permissions` — keep the two in step.
- **Use `canvas/http.ts`** (`canvasBase()`, `canvasGet`, `fetchAllPages`) for every Canvas request so 403/404 become `CanvasHttpError` and the freshness engine can mark a collection unavailable. Nothing else may hardcode a host; `canvasHost()` throws until `configureCanvas` has run, which tools surface as `{ error }`.
- **Files and Pages are usually hidden — but only the listings.** All probed UofT courses 403/404 their Files/Pages areas, yet every file or page reachable *by id* works. Discovery therefore comes from links: any HTML body that enters the app must go through `ingestHtml` (`canvas/links.ts`), never plain `htmlToText`, so its links are recorded and their targets registered. Code paths must still tolerate `unavailable`. A 403 on a *single* file is different: Canvas denies that file (locked module/folder, unpublished) — `fetchFileMetadata` explains this in its error.
- **A course's Home is data, not a fixed view.** `courses.default_view` says whether Home is the front page, modules, syllabus, assignments or the activity feed; the `home` collection only has something to fetch when a front page exists (404 there means "none", not "unavailable").
- **Link markers are part of document text.** `[file 123]`, `[page slug]`, `[assignment 45]`, `<https://…>` are what the model uses to hop; don't strip them when shaping tool output, and keep `linkMarker` as the single place that defines their form (the prompt describes it).
- **Keep Canvas calls sequential.** Parallel bursts trigger throttling; the code deliberately awaits in series.
- **`include[]=items` on modules is best-effort.** Canvas omits inline items for large modules; the modules full sync falls back to the per-module items endpoint when `items` is not an array.
- **Assignment descriptions are lazy.** The compact listing has none; never assume `assignments.description` is populated — go through `fetchAssignmentWithDescription` (which caches it).

## Build / extension

- **CSP requires `'wasm-unsafe-eval'`** for PGlite. Don't tighten it.
- **`optimizeDeps.exclude` for PGlite packages** is required; Vite's pre-bundling breaks the WASM loader.
- **The pdf.js worker is imported with `?url`** so Vite emits it as an asset. Importing it any other way breaks PDF parsing in the packed extension.
- **`removeReservedViteChunks`** in `vite.config.ts` deletes a `__vite-browser-external` artifact that Chrome rejects as a reserved filename. Keep it unless the upstream plugin stops emitting that chunk.
- **`@types/chrome` must be installed** for `tsconfig.app.json` (`types: ["vite/client", "chrome"]`) to type-check; a missing install shows as "Cannot find type definition file for 'chrome'".

## UI

- **Assistant Markdown is rendered only through `renderMarkdown`** (`utils/markdown.ts`: `marked` + DOMPurify allowlist). The model's text is built from Canvas content that other people write; the CSP stops scripts but not `<style>`/`<form>`/`<iframe>`/`<img>` overlays. Don't add another `dangerouslySetInnerHTML` that skips it, and extend the allowlist rather than disabling it.
- **KaTeX output is inserted after DOMPurify, never through it.** `renderMarkdown`'s math extensions emit a `<span data-math="N">` placeholder (sanitized like any other span); only after sanitizing does it swap each placeholder for `katex.renderToString(...)`. This is safe because KaTeX runs with `trust: false` (only class/style/aria attributes and escaped text, no URLs or scripts) — but it depends on `style` staying out of `ALLOWED_ATTR`, since KaTeX's inline `style=` attributes would otherwise leak into everything else DOMPurify sanitizes. Don't run KaTeX's HTML back through the sanitizer — the allowlist has no `style` attribute and would strip the layout KaTeX needs.

## Persistence

- **`localStorage` is written synchronously on every chat mutation.** Large chats serialize fully each time; keep display messages text-only.
- **Settings auto-save on each keystroke.** There is no "unsaved" state; the API key is in localStorage in plain text.

## Style

- Comments explain *why*, not *what*, and are used sparingly; match that density.
- SQL lives in `src/db/*`; components and tools call functions, not `db.query`.
- Errors thrown from sync/index code carry a labelled context (`Failed to fetch modules for course 123: 403`) so the model or UI can show something actionable.
- Types for Canvas payloads are intentionally thin (only fields read by the code); extend them when you read a new field rather than mirroring the whole Canvas object.
