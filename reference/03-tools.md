# 03 — Tools

Sources: `src/agent/tools.ts` (`TOOL_CONFIG` = schemas the model sees, `toolFunctions` = implementations), `src/agent/prompt.ts` (`SYSTEM_PROMPT`). A tool must appear in both maps under the same name.

## The one rule

**Every tool reads the local graph, and the graph is kept current on demand.** Before a tool reads a collection it calls `ensureCollection(kind, …)` (see `04-knowledge-graph.md` → Freshness); the engine decides whether to sync, the tool never does. The model has no concept of "live" vs "cached". The only cache-related parameter is `refresh: true`, which the prompt tells the model to set *only* when the user says something changed.

## Contract

```ts
interface ToolConfig {           // Google function-declaration style; converted for OpenAI by toOpenAITools
  name: string;
  description: string;           // the model's only guidance — write it as an instruction
  parameters: { type: 'OBJECT'; properties: Record<string, { type: 'STRING'|'INTEGER'|'NUMBER'|'BOOLEAN'; description; enum? }>; required?: string[] };
}
type ToolFn = (args: Record<string, string>, settings: AppSettings) => Promise<string>;
```

- **Args arrive as strings.** Parse with the `bool`/`int` helpers in `tools.ts`.
- **Return a JSON string, never throw.** `ok(payload)` / `fail(message)` / `withNotes(payload, notes)`.
- **Shape the output.** Tools return projected rows; nothing raw from Canvas reaches the model (shaping happens at store time in `canvas/collections.ts` and at read time in the tool).
- **Report what the engine did via `notes`.** `notesFrom(results)` turns `EnsureResult`s into lines like "modules re-synced from Canvas just now" or "files are not available in this course". The prompt tells the model to mention notes only when they affect the answer.

## Catalogue (7 tools)

| Tool | Answers | Collections it ensures | Notes |
|---|---|---|---|
| `list_content(kind, course_id?, search?, module_id?, bucket?, include_submission?, limit?, refresh?)` | course roster (with what each course's Home shows and its nav bar), module structure, items inside modules, assignments with due dates, every known file / page of a course | `courses` · `modules` · `assignments` (+`submissions` when `include_submission`) · `files`/`pages` + `modules` + `home` | `kind="courses"` rows carry `home_view` ("front page \"Home Page\" (page home-page)", "modules", …) and `nav` (tab labels, external tools with their launch URL). `kind="items"` rows carry `content_ref` (the `document_id` for search/read; for ExternalUrl/ExternalTool items, the destination URL) and `indexed`. `kind="files"` / `"pages"` are the **union** of the Files/Pages area (when visible), module items and everything linked from the home page, other pages, assignment descriptions and announcements; each row says `linked_from` ("home page; module: Week 3"), and the front page comes first under `pages`. `bucket` defaults to `upcoming`. |
| `get_assignment(course_id, assignment_id, refresh?)` | one assignment: description text (≤3000 chars, links kept as markers), due/points/submission types, your submission state/score/grade | `assignments`, `submissions` | Description is fetched lazily (`fetchAssignmentWithDescription`) and cached in `assignments.description` while `description_version = updated_at`; rendering it goes through `ingestHtml`, which also records its links. |
| `search_documents(query, course_id?, document_type?, document_id?, limit?)` | best excerpts across indexed documents and inbox messages, with page/slide for citation (`page_or_slide` is a number, or a range like `"4-7"` when small slides were merged into one chunk) | (`inbox` when `document_type="conversation"`) | With `document_type + document_id` the document is indexed if needed (`indexDocumentJustInTime`; for a conversation, `embedConversationIfNeeded`) and the search is restricted to it — the common "what does lecture 4 say about X" path is `list_content(items)` → `search_documents(document=…)`. Without them, previously indexed documents are searched semantically and every stored inbox message by keyword (chunks without vectors take part in the FTS half only). |
| `read_document(document_type, document_id, course_id?, pages?)` | verbatim text of pages/slides `"3-5"`, or a whole inbox thread | (`inbox` for conversations) | Indexes if needed, then serves from `file_chunks` — no re-download. A chunk is returned when its page range overlaps the request, labelled `[page 3]` / `[pages 4-7]`. Wiki pages and descriptions keep their links as markers (`Syllabus [file 44541003]`, `[page week-1]`, `<https://…>`) so the model can hop to what they point at. Output capped at ~12 k chars with a note. Replaces the old unbounded `extract_text_from_file`. |
| `get_announcements(course_id, limit?, refresh?)` | recent announcements with text (≤600 chars, links kept as markers) | `announcements` | Links in announcements are recorded at sync time, so "slides for today: <link>" makes the file listable. |
| `get_planner(start_date?, end_date?, refresh?)` | cross-course to-do: assignments, quizzes, events with submission state | `planner` | Rolling window −7 d…+28 d is cached; a range outside it is fetched live (shaped, not stored). Defaults to the next 7 days. |
| `get_inbox(scope?, search?, limit?, refresh?)` | conversations newest first, snippet of last message; `search` also matches stored message bodies (FTS) and returns `matching_message` | `inbox` | Threads are fetched and their messages stored **as text** during the inbox sync (no embedding). A thread is embedded lazily the first time `search_documents` targets it; `read_document(conversation)` and keyword search never need vectors. |

Removed in the Tier 1 rewrite (do not re-add): `explore_graph`, `sync_canvas_node`, `get_course_assignments`, `get_assignment_details`, `get_file_metadata`, `extract_text_from_file`, `index_for_search`, `get_planner_items`, `get_course_announcements`, `get_conversations`, `get_course_quizzes`, `index_file_for_search`.

## Document ids

`document_type` + `document_id` map to a `files.file_id` through `docIdFor()` in `db/rag.ts`:

| type | `document_id` is | doc id |
|---|---|---|
| `file` | Canvas file id (= `content_ref` of a File item) | `<id>` |
| `page` | page slug (= `content_ref` of a Page item) | `page:<course_id>:<slug>` |
| `assignment` | assignment id | `assignment:<id>` |
| `conversation` | conversation id | `conversation:<id>` |

`search_documents` results echo `document_type` / `document_id` in this form so the model can follow up with `read_document`.

## The system prompt (`agent/prompt.ts`)

Deliberately short. Built by `buildSystemPrompt(intro)`, where the first sentence comes from the deployment profile (`canvas/profiles.ts`: "…Canvas (Quercus at the University of Toronto)" or "…Canvas (the course site at <host>)") and is fixed for the session so the prefix stays cacheable. It says: data is kept current automatically, set `refresh` only when the user says something changed; query narrowly (`search`, `course_id`, small `limit`); which tool for which question — including that a course which keeps its material on its home page is explored through `kind="files"`/`"pages"`, and that the course list names external tools to point the student at; the document flow (locate → `search_documents` with document id → cite page/slide), and that document text carries link markers the model can follow. A style rule also tells the model to write math as LaTeX (`$…$` inline, `$$…$$` display) rather than ASCII approximations or code spans, since `renderMarkdown` renders it through KaTeX (see `07-ui.md`). There are **no staleness rules** — that was the point of the redesign.

The course roster (`getGraphOverviewText`: names + ids) is **not** in the system prompt. `buildApiHistory` in `App.tsx` prepends it to the latest user turn, so the system prompt + tool schemas form a stable, cacheable prefix.

## Adding a tool

1. Add a `ToolConfig` to `TOOL_CONFIG` with a description written as an instruction (when to use it, what to pass, what *not* to use it for).
2. Add the implementation to `toolFunctions`. First line of work: `ensureCollection` / `ensureCollections` for whatever it reads. Never call a `sync*` or fetch Canvas directly for collection data.
3. Read through `db/graph.ts` / `db/rag.ts` functions; add a query there if none fits.
4. Return shaped rows with `withNotes(payload, notesFrom(results))`.
5. Update `SYSTEM_PROMPT` only if the tool changes the recommended workflow, and this document.
