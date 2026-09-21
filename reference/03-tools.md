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

## Catalogue (8 tools)

| Tool | Answers | Collections it ensures | Notes |
|---|---|---|---|
| `list_content(kind, course_id?, search?, module_id?, bucket?, include_submission?, limit?, refresh?)` | course roster (with what each course's Home shows, its nav bar, and `has_syllabus`), module structure, items inside modules, assignments with due dates, quizzes with their rules, every known file / page of a course | `courses` · `modules` · `assignments` (+`submissions` when `include_submission`) · `quizzes` (+`submissions`) · `files`/`pages` + `modules` + `home` + `syllabus` + `announcements` + `discussions` + `quizzes` (every body the course publishes, so the listing is the union it claims to be) | `kind="courses"` rows carry `home_view` ("front page \"Home Page\" (page home-page)", "modules", …), `nav` (tab labels, external tools with their launch URL) and `has_syllabus`. `kind="items"` rows carry `content_ref` (the `document_id` for search/read; for ExternalUrl/ExternalTool items, the destination URL) and `indexed` (File, Page, Assignment and Discussion items). `kind="quizzes"` rows carry `time_limit_minutes`, `allowed_attempts` (`"unlimited"` for −1), `questions`, `available_from`/`available_until`, `locked` (Canvas's explanation), and `submission` when asked; `bucket` defaults to `all`. `kind="files"` / `"pages"` are the **union** of the Files/Pages area (when visible), module items and everything linked from the bodies the call ensures (home page, syllabus, announcements, discussion topics, quiz descriptions) plus any page or assignment description already read; each row says `linked_from` ("home page; module: Week 3; syllabus"); under `pages` the Syllabus tab (when the course has one) comes first as a pseudo-row `{document_type: "syllabus", document_id: <course_id>}`, then the front page. `bucket` defaults to `upcoming` for assignments. |
| `get_assignment(course_id, assignment_id, refresh?)` | one assignment: description text (≤3000 chars, links kept as markers), due/points/submission types, your submission state/score/grade | `assignments`, `submissions` | Description is fetched lazily (`fetchAssignmentWithDescription`) and cached in `assignments.description` while `description_version = updated_at`; rendering it goes through `ingestHtml`, which also records its links. |
| `search_documents(query, course_id?, document_type?, document_id?, limit?)` | best excerpts across indexed documents, discussion replies and inbox messages, with page/slide for citation (`page_or_slide` is a number, or a range like `"4-7"` when small slides were merged into one chunk; null for thread entries) | (`inbox` when `document_type="conversation"`; `discussions` + the thread when `"discussion"`; `syllabus` when `"syllabus"`) | With `document_type + document_id` the document is indexed if needed (`indexDocumentJustInTime`; for a conversation `embedConversationIfNeeded`; for a discussion `ensureDiscussionThread` + `embedDiscussionIfNeeded`) and the search is restricted to it — the common "what does lecture 4 say about X" path is `list_content(items)` → `search_documents(document=…)`. Without them, previously indexed documents are searched semantically and every stored inbox message and discussion entry by keyword (chunks without vectors take part in the FTS half only). |
| `read_document(document_type, document_id, course_id?, pages?)` | verbatim text of pages/slides `"3-5"`, the syllabus, a whole discussion thread (topic + replies, each "author (date) replying to X: text"), or a whole inbox thread | (`inbox` for conversations; `discussions` for discussions; `syllabus`) | Indexes if needed, then serves from `file_chunks` — no re-download; threads are read without embedding (nothing semantic happens). A chunk is returned when its page range overlaps the request, labelled `[page 3]` / `[pages 4-7]`. Wiki pages and descriptions keep their links as markers (`Syllabus [file 44541003]`, `[page week-1]`, `<https://…>`) so the model can hop to what they point at. Output capped at ~12 k chars with a note. Replaces the old unbounded `extract_text_from_file`. |
| `get_announcements(course_id, limit?, refresh?)` | recent announcements with text (≤600 chars, links kept as markers) | `announcements` | Links in announcements are recorded at sync time, so "slides for today: <link>" makes the file listable. |
| `get_planner(start_date?, end_date?, refresh?)` | cross-course to-do: assignments, quizzes, events with submission state | `planner` | Rolling window −7 d…+28 d is cached; a range outside it is fetched live (shaped, not stored). Defaults to the next 7 days. |
| `get_discussions(course_id, search?, limit?, refresh?)` | discussion topics (the forum), pinned first then most recent activity, with author, dates, reply count, topic text (≤400 chars) and whether it is graded; `search` matches title and topic text | `discussions` | Topics only. Replies live in the `discussion:<id>` document: `read_document(discussion)` fetches the reply tree on demand (`ensureDiscussionThread`, only when `last_reply_at` moved) and returns it as text; `search_documents(discussion, id)` does the same and then embeds the entries still lacking a vector. |
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
| `discussion` | discussion topic id (= `content_ref` of a Discussion item) | `discussion:<id>` |
| `syllabus` | the course id | `syllabus:<course_id>` |

`search_documents` results echo `document_type` / `document_id` in this form so the model can follow up with `read_document`.

## The system prompt (`agent/prompt.ts`)

Seven bullet points. Built by `buildSystemPrompt(intro)`, where the first sentence comes from the deployment profile (`canvas/profiles.ts`: "…Canvas (Quercus at the University of Toronto)" or "…Canvas (the course site at <host>)") and is fixed for the session so the prefix stays cacheable. It says only what the tool descriptions cannot: the roster comes with the latest message (use its ids); ask narrowly (`course_id`, `search`, small `limit`); where course material lives (modules, home page/syllabus, links in other content) and that `kind="files"` gathers all of it while a hidden Files tab is normal; the document flow (locate → `search_documents` → `read_document` only for actual text → cite page/slide); `refresh` only when the user says something changed; lead with the answer and mention tool notes only when they matter; math as LaTeX (rendered through KaTeX, see `07-ui.md`). **Which tool answers which question lives in the tool descriptions**, not here — each description is written as "what this returns and what it is for", and the prompt must not restate it. There are **no staleness rules** and no explanation of caching or memory: freshness is the engine's job and the model has nothing to decide.

The course roster (`getGraphOverviewText`: names + ids) is **not** in the system prompt. `buildApiHistory` in `App.tsx` prepends it to the latest user turn, so the system prompt + tool schemas form a stable, cacheable prefix.

## Adding a tool

1. Add a `ToolConfig` to `TOOL_CONFIG` with a description written as an instruction (when to use it, what to pass, what *not* to use it for).
2. Add the implementation to `toolFunctions`. First line of work: `ensureCollection` / `ensureCollections` for whatever it reads. Never call a `sync*` or fetch Canvas directly for collection data.
3. Read through `db/graph.ts` / `db/rag.ts` functions; add a query there if none fits.
4. Return shaped rows with `withNotes(payload, notesFrom(results))`.
5. Put what the tool is for in its description; touch the system prompt only if the workflow itself changes. Update this document.
