# 04 — Knowledge graph (PGlite)

Sources: `src/db/pglite.ts`, `src/db/schema.ts`, `src/db/graph.ts`, `src/canvas/freshness.ts`, `src/canvas/collections.ts`, `src/canvas/http.ts`.

## Why a local Postgres

The graph is a **cache of Canvas structure** that makes most agent questions answerable without a network call and with compact, filterable rows. Postgres (via PGlite, compiled to WASM) was chosen over a key-value store because the queries are relational (joins across modules → items → files, links and documents) and because pgvector + full-text search give hybrid RAG in the same engine. Everything persists to IndexedDB, **one database per Canvas identity** (`idb://<dbName>`, see below).

## Database lifecycle (`db/pglite.ts`)

- **One database per identity.** `canvas/identity.ts` resolves who is signed in (`GET /users/self` → `<host>/<userId>`, name) and keeps a registry in `localStorage['canvas-buddy-memories']` mapping each identity to a `dbName` and a chats key. Names derive from the identity: `canvas-buddy-<host>-<userId>` for the database, `canvas-buddy-chats:<host>/<userId>` for the chats. `App` calls `configureDatabase(dbName)` before anything touches the database; `getDB()` throws until then. A signed-out session falls back to the last identity seen on that host (banner: "showing what's remembered for …"); a *different* account signing in mid-session is reported ("Reload to switch memory"), never mixed in. "Delete this account's data" (Settings) closes the database (`closeDB`), deletes every IndexedDB database whose name ends with the data dir, removes the chats key and the registry entry, and reloads.
- `getDB()` returns a process-wide singleton; concurrent callers share one init promise.
- Init runs `SCHEMA_SQL` every time. Every statement is `CREATE … IF NOT EXISTS`, so a database is created complete on first use and **left alone afterwards**. There are **no migrations**: a schema change is made in the `CREATE TABLE` itself and reaches an existing database only when that database is recreated ("Delete this account's data" in Settings). "Forget everything" empties the tables but keeps their definitions, so it does not apply a schema change. An older database fails at the first query naming a missing column (e.g. `column f.page_kind does not exist`).
- **Exclusive Web Lock.** PGlite's IndexedDB filesystem is not safe to open from two pages at once, and Chrome opens one side panel per window. `acquireExclusiveLock` requests `navigator.locks` `canvas-buddy-pglite:<dbName>` with `ifAvailable: true` and holds it for the page lifetime. A second panel throws a clear "already open in another window" error instead of corrupting the database. The page remembers the lock it holds (`heldLock`), so a retry after a failed init, or a reopen after `closeDB`, does not mistake its own lock for another window's.

## Schema

Eighteen tables in four groups. Conventions that hold everywhere: every id is `TEXT`; every course-scoped table has `course_id` referencing `courses` with `ON DELETE CASCADE` (the one exception, `files`, is `SET NULL`); `synced_at TIMESTAMPTZ` on a synced row is when it was last written; HTML bodies are stored as text with link markers (`ingestHtml`), never as HTML.

```
courses ─┬─ course_tabs                       planner_items          sync_state
         ├─ modules ── module_items           conversations ── messages
         ├─ assignments · submissions         graph_edges
         ├─ quizzes · discussions · announcements
         ├─ pages
         ├─ content_links
         └─ files ── file_chunks
```

### Course structure — mirrors of the Canvas listings

**`courses`** — an active enrolment. PK `course_id`.
`name`, `course_code`, `term`, `default_view` (what "Home" shows: `wiki` | `modules` | `syllabus` | `assignments` | `feed`), `syllabus_body` (the Syllabus tab as text with link markers; the `syllabus:<course>` document is indexed from it), `syllabus_version` (fingerprint `length:hash` of the HTML Canvas returned — it has no timestamp), `synced_at`.

**`course_tabs`** — one entry of the course nav bar, including LTI tools. PK `(course_id, tab_id)`.
`label`, `type` (`internal` | `external`), `html_url` (the launch URL for external tools), `position`.

**`modules`** — a module. PK `module_id`.
`course_id`, `name`, `position`, `synced_at`.

**`module_items`** — one item inside a module. PK `item_id`, FK `module_id` cascade.
`item_type` (`File` | `Page` | `Assignment` | `Quiz` | `Discussion` | `ExternalUrl` | `ExternalTool` | `SubHeader` | …), `title`, `position`, `content_ref` (the pointer into the content tables — file id, page slug, assignment/quiz id, or the destination URL for external items; see below), `html_url`, `synced_at`.

**`assignments`** — an assignment, from the compact `assignment_groups` listing. PK `assignment_id`.
`course_id`, `name`, `due_at`, `points_possible DOUBLE PRECISION`, `html_url`, `submission_types` (comma-joined), `group_name`, `updated_at` (Canvas's, as text), `description` (text with link markers; NULL until fetched lazily), `description_version` (the `updated_at` the description was fetched at — the cache is valid while it equals `updated_at`), `synced_at`.

**`submissions`** — the student's own submission for an assignment. PK `assignment_id`.
`course_id`, `workflow_state` (`unsubmitted` | `submitted` | `graded` | `pending_review`), `submitted_at`, `graded_at`, `score DOUBLE PRECISION`, `grade` (text, e.g. `A-` or `87`), `late`, `missing`, `excused`, `synced_at`.

**`quizzes`** — a quiz, with the rules the assignments listing lacks. PK `quiz_id`.
`course_id`, `title`, `quiz_type`, `time_limit` (minutes, NULL = none), `allowed_attempts` (−1 = unlimited), `question_count`, `points_possible`, `due_at`, `unlock_at`, `lock_at`, `published`, `description` (text with link markers, clipped), `assignment_id` (joins `submissions`), `html_url`, `lock_explanation` (Canvas's text when locked for the user), `synced_at`.

**`discussions`** — a forum topic; its replies live in the `discussion:<id>` document. PK `discussion_id`.
`course_id`, `title`, `author`, `posted_at`, `last_reply_at`, `reply_count`, `message` (the topic as text with link markers, clipped), `html_url`, `pinned`, `locked`, `assignment_id` (set for graded discussions), `replies_synced_for` (the `last_reply_at` the stored reply chunks correspond to; a different value means the thread is re-fetched on next read), `synced_at`.

**`announcements`** — an announcement. PK `announcement_id`.
`course_id`, `title`, `posted_at`, `author`, `text` (text with link markers, clipped), `html_url`, `synced_at`.

**`pages`** — a wiki page, metadata only; the body is fetched at index time and lives in `file_chunks`. PK `(course_id, page_url)`.
`title`, `updated_at` (Canvas's, as text; the document's version), `html_url`, `front_page` (TRUE on the course's home page, set by the `home` collection), `synced_at`.

**`content_links`** — one hyperlink found in an HTML body. PK `(course_id, from_type, from_id, position)`.
`from_type` (`page` | `assignment` | `announcement` | `discussion` | `discussion_replies` | `quiz` | `syllabus`), `from_id` (page slug / assignment, announcement, discussion or quiz id / course id for the syllabus; `discussion_replies` holds the links of every reply of one topic under the topic id, apart from the topic's own, which the discussions sync replaces), `to_type` (`file` | `page` | `assignment` | `quiz` | `discussion` | `module` | `external`), `to_ref` (file id, page slug, assignment/quiz/discussion/module id, or the URL for `external`), `label` (the anchor text), `position` (order within the body).

### Documents — what `search_documents` and `read_document` operate on

**`files`** — a document of any kind, not only a Canvas file. PK `file_id` (see doc ids below). FK `course_id` `SET NULL`.
`filename`, `display_name`, `version` (the upstream version the chunks were built from: `modified_at`/`updated_at`/size for files, `updated_at` for pages and assignments, the fingerprint for a syllabus), `extracted_at`, `total_chunks` (0 = known but not indexed), `source_type` (`file` | `page` | `assignment` | `conversation` | `discussion` | `syllabus`), `page_kind` (what `page_number` counts: `page` for PDFs, wiki pages, descriptions and the syllabus; `slide` for PPTX; `section` for DOCX and text files, whose sections are synthetic; NULL for threads), `embedding_model` (provider-qualified model the stored vectors came from), `html_url`, `content_type`, `size BIGINT`.

**`file_chunks`** — one chunk of a document. PK `chunk_id`, FK `file_id` cascade.
`chunk_index`, `page_number`, `page_end` (last page/slide/section covered when small pages were merged; NULL = `page_number`), `content` (the chunk text — for threads one entry, for others a page-bound slice with link markers), `token_count`, `content_hash` (SHA-256 of `content`; a re-index reuses the vector of an unchanged chunk), `embedding VECTOR(768)` (NULL until a semantic search targets the document; HNSW cosine index), `content_tsv TSVECTOR` (GIN; the keyword half of hybrid search).

### Cross-course — no FK to `courses`, because the planner and inbox reference courses the graph may not hold

**`planner_items`** — one to-do in the rolling planner window (−7 d … +28 d), replaced wholesale each sync. PK `item_key` = `<plannable_type>:<plannable_id>`.
`plannable_type`, `plannable_id`, `course_id`, `context_name` (course name as the planner shows it), `title`, `date`, `points`, `submitted`, `late`, `missing`, `graded`, `new_activity`, `html_url`, `synced_at`.

**`conversations`** — an inbox thread. PK `conversation_id`.
`subject`, `context_name`, `course_id`, `participants` (JSON `[{id, name}]`), `last_message` (preview), `last_message_at`, `workflow_state` (`read` | `unread` | `archived`), `message_count`, `starred`, `thread_synced_for` (the `last_message_at` the stored messages correspond to), `synced_at`.

**`messages`** — one message of a fetched inbox thread. PK `message_id`, FK `conversation_id` cascade.
`author_id`, `author_name`, `created_at`, `body`, `body_tsv TSVECTOR` (GIN; `get_inbox` keyword search).

**`graph_edges`** — a typed edge with no foreign keys. PK `edge_id BIGSERIAL`; UNIQUE over the other five columns.
`from_type`, `from_id`, `to_type`, `to_id`, `relation` (`prerequisite` module → module, `references` module item → file). `pruneOrphanEdges` runs after every module sync because nothing cascades here.

### Bookkeeping

**`sync_state`** — one row per freshness scope, owned by `canvas/freshness.ts`. PK `scope` = `courses` | `planner` | `inbox` | `course:<id>:<collection>`.
`synced_at` (last full or partial sync), `probed_at` (last probe, whatever its outcome), `fingerprint` (the probe's last value — a timestamp, an `id:date` pair, a JSON map for modules, `length:hash` for the syllabus), `status` (`ok` | `unavailable` — the course hides the area; retried after `unavailableRetry`), `error` (the message behind `unavailable`).

### Indexes

B-tree on `course_id` for `modules`, `assignments`, `files`, `pages`, `submissions`, `file_chunks(file_id)`, and `(course_id, sort column)` for `announcements` (`posted_at DESC`), `discussions` (`last_reply_at DESC`), `quizzes` (`due_at`); `module_items(module_id)`, `module_items(content_ref)`; `graph_edges(from_type, from_id)` and `(to_type, to_id)`; `content_links(course_id, to_type, to_ref)` ("what links to this file"); `planner_items(date)`; `messages(conversation_id, created_at)`. Text search: GIN on `file_chunks.content_tsv` and `messages.body_tsv`. Vectors: HNSW `vector_cosine_ops` on `file_chunks.embedding` (`idx_file_chunks_embedding`; the query must order by `<=>`).

### Key modelling decisions

- **All ids are `TEXT`.** Canvas ids are numeric but are stringified everywhere (`String(x)`) so the same column can hold page slugs and composite ids.
- **`module_items.content_ref`** is the pointer into the content tables: a file id for `File` items, a page slug for `Page` items, an assignment/quiz id otherwise. It is the `document_id` that `search_documents` / `read_document` take. `ExternalUrl` / `ExternalTool` items are the exception: `content_ref` holds their destination URL (`external_url`) when Canvas sends one, so the model can send the student there directly.
- **`files` is the "documents" table**, not just Canvas files. `source_type` is `'file' | 'page' | 'assignment' | 'conversation' | 'discussion' | 'syllabus'` and `file_id` comes from `docIdFor()` in `db/rag.ts` (`<file id>`, `page:<course>:<slug>`, `assignment:<id>`, `conversation:<id>`, `discussion:<id>`, `syllabus:<course>`). A row with `total_chunks = 0` is *known but not indexed*; this is how the `indexed` flag is derived in every query.
- **Canvas is a link graph, and `content_links` records it.** Every HTML body the app touches (front page, wiki pages at index time, assignment descriptions, announcements, discussion topics, quiz descriptions and the syllabus at sync time, discussion replies when a thread is read) goes through `ingestHtml` (replies through `htmlToTextWithLinks`, their links stored together under `discussion_replies`) (`canvas/links.ts`): the links are stored as `content_links` rows and what they point at is *registered* — a linked file becomes a `files` row (`total_chunks = 0`, `filename` from the anchor's title, `display_name` from its text), a linked page becomes a `pages` row. That is what makes files a course keeps on its home page (rather than in modules, with the Files area hidden) listable and indexable. Registration never overwrites an existing row; links into *another* course are recorded but its content is not adopted.
- **The front page is the root.** `courses.default_view` says what "Home" shows; when it is `wiki`, the `home` collection fetches `/front_page`, flags that row in `pages.front_page`, and ingests its links. `list_content(kind="courses")` reports this as `home_view`, and `kind="pages"` lists the front page first.
- **`assignments.description` is lazy, and text.** The compact `assignment_groups` listing omits it; `get_assignment` / indexing fetch it once (`fetchAssignmentWithDescription`), run it through `ingestHtml` and cache the resulting text while `description_version = updated_at`. A sync that sees a new `updated_at` nulls it. No column holds raw HTML: every body is converted (links recorded, markers kept) at the moment it enters the graph, so readers and the indexer use the stored text as-is.
- **Discussion replies are a thread document, like inbox messages.** `discussions` holds the topic list (message as text); the reply tree is fetched on demand (`ensureDiscussionThread`, only when the topic's `last_reply_at` differs from `replies_synced_for`) into the `discussion:<id>` document — chunk 0 is the topic, then one chunk per entry in reading order, keyed by entry id so a re-fetch updates edited entries (dropping their vector), inserts new ones and prunes deleted ones (`upsertDocumentChunksIncremental` with `pruneMissing`). No vector until a semantic search targets the thread.
- **The syllabus is a document of the course.** `courses.syllabus_body` holds the Syllabus tab body as text with link markers; `syllabus_version` fingerprints the HTML Canvas returned (it has no timestamp) so an unchanged body is recognised by the probe. `syllabus:<course>` is indexed from the stored text through the ordinary JIT pipeline. `setCourseSyllabus(null)` drops the document and its links.
- **`planner_items` and `conversations` have no course FK** because the planner and inbox can reference courses that are not in the graph; `files.course_id` for a conversation is looked up and left NULL if unknown.
- **`sync_state`** is the single record of when each scope was synced/probed, its probe fingerprint, and whether the course hides it (`unavailable`). Staleness can be judged even when a collection is legitimately empty.
- **`graph_edges`** holds `prerequisite` edges between modules and `references` edges from module items to files. It has no foreign keys, so `pruneOrphanEdges` runs after every module/item sync.

## Sync semantics (`canvas/collections.ts` → `db/graph.ts`, `db/rag.ts`)

Each collection is a `CollectionSpec` in the registry: a `sync` (full or, given probe data, partial) and optionally a `probe`. Syncs are **full-list + prune**, run **inside one transaction** (`withTransaction`), and **shape at store time**:

1. `fetchAllPages` (`canvas/http.ts`) follows `Link: rel="next"` until exhausted (or `maxPages` for newest-N collections). A non-OK page throws `CanvasHttpError` (with status); a partial list is never stored.
2. Rows are projected to the shaped types in `types/canvas.ts` (HTML → text, fields the model needs) and upserted with `ON CONFLICT DO UPDATE`.
3. `DELETE … WHERE <scope> AND id NOT IN (…)` prunes anything not in the fresh list, plus dependent document rows (indexed descriptions of deleted assignments, pages, conversations) and the `content_links` whose source row disappeared. The Files-area prune exempts files still named by a link in the course (`upsertAndPruneKnownFiles`), because instructors link files that live outside the course's own Files area.
4. The freshness engine records the outcome (and the probe fingerprint the sync returns) in `sync_state`.

| Collection | Canvas source | Probe (within TTL) | Partial update |
|---|---|---|---|
| `courses` | `/courses?enrollment_state=active&include[]=term` + `/courses/:c/tabs` per course | — (TTL) | — (`default_view` and the nav bar are stored alongside the roster). A course that left the active list is pruned with everything under it (`pruneCourses` → `forgetCourseRows`) and its `course:<id>:*` sync stamps (`clearSyncState`), in the same transaction |
| `modules` | `/modules?include[]=items` (+ per-module items when Canvas omits them) | module list **without** items (~350 B) → per-module fingerprint `name|position|items_count|prereqs`, stored as JSON in `sync_state.fingerprint` | yes: items re-fetched only for modules whose fingerprint changed; prune handles removals |
| `assignments` | `/assignment_groups?include[]=assignments&exclude_response_fields[]=description,rubric` (≈50 % of the plain list); falls back to `/assignments` | — (TTL; no narrow query exists) | — |
| `files` | `/files` | newest `updated_at` via `sort=updated_at&per_page=1` — **feature-detected**; 403/404 marks the course's Files area unavailable | — |
| `pages` | `/pages?published=true` | same — feature-detected | — |
| `submissions` | `/students/submissions?student_ids[]=self` | — (TTL) | — |
| `announcements` | `/discussion_topics?only_announcements=true` (newest 100) | newest `id:posted_at` | — |
| `planner` | `/planner/items` for the rolling window (`PLANNER_WINDOW` −7 d…+28 d), replaced wholesale | — (TTL) | — |
| `inbox` | `/conversations` (newest 200) + `/conversations/:id` for threads | newest `id:last_message_at` | yes: a thread is fetched only when its `last_message_at` differs from `thread_synced_for` (cap 30 per sync); messages are inserted by id as text chunks with a NULL vector. **The sync never embeds** — `embedConversationIfNeeded` embeds a thread's missing vectors the first time `search_documents` targets it. |
| `discussions` | `/courses/:c/discussion_topics?order_by=recent_activity` (newest 100) | newest topic `id:last_reply_at:posted_at` | — (topics); replies per topic on demand via `/discussion_topics/:id/view` |
| `quizzes` | `/courses/:c/quizzes` | — (TTL) | — |
| `syllabus` | `/courses/:c?include[]=syllabus_body` | the body itself, fingerprinted (`length:hash`); the probe's fetch is handed to the sync as `probeData` | stores `courses.syllabus_body` as text with link markers, records its links |
| `home` | `/courses/:c/front_page` (404 = no front page, not "unavailable") | front page `updated_at`; the probe's fetch is handed to the sync as `probeData` | sets `pages.front_page`, ingests the page's links (registers linked files/pages). Ensured by `list_content(kind="files"/"pages")`, with `syllabus`, `announcements`, `discussions` and `quizzes`, so every body that links course material has been ingested before the union is read. |

## Freshness (`canvas/freshness.ts`, `canvas/collections.ts`)

Freshness is **code policy, not model discretion**. Anything that needs a collection calls
`ensureCollection(kind, { courseId }, { settings, refresh? })` first; it returns an `EnsureResult`
(`fresh | synced | unavailable | error`, `syncedNow`, `ageMinutes`, `summary`, `error`) and never throws.

Decision procedure per scope:

```
refresh: true                       → sync now (bypasses everything)
status = unavailable, retry not due → return unavailable
probed within probeDebounce         → fresh
never synced, or age ≥ TTL          → full sync   (also the backstop for deletions a probe can't see)
within TTL and spec has a probe     → probe: changed → sync (with probe data) · unchanged/unsupported → fresh
within TTL, no probe                → fresh
```

- **TTLs** are per collection, in minutes, from `settings.freshness` (editable in Settings → Freshness; defaults in `DEFAULT_FRESHNESS`).
- **Unavailable**: a 403/404 from Canvas (`isUnavailableError`) marks the scope `unavailable` with the error; it is skipped until `unavailableRetry` elapses or the user forces `refresh`. All three probed UofT courses hide Files and Pages, so this is the normal case, not an edge case. One unavailable collection never aborts a multi-collection refresh (`ensureCollections`).
- **Errors**: a failed sync or a transient probe failure keeps the cached copy and records the message in `sync_state.error` (the Memory sheet shows "failed"); the next successful sync or probe clears it.
- **In-flight dedupe**: concurrent calls for the same scope share one promise.
- **Registry** (`COLLECTIONS` in `collections.ts`): each `CollectionSpec` declares `kind`, `sync(ctx, { state, probeData, settings })` and optionally `probe(ctx, state)`. All thirteen kinds are registered (see the table above).
- **Overview text** (`getGraphOverviewText`) is the course roster (names + ids) that rides on the latest user turn. `exploreGraph('courses')` reports `files_status`/`pages_status` from `sync_state`.
- **Forgetting** (`forgetCollection(kind, courseId)` in `freshness.ts`) is the one user-driven change to the graph besides forgetting the whole memory: `forgetCollectionRows` (`graph.ts`) deletes what the collection stored for the course — the rows, the dependent documents and the `content_links` found in their bodies, mirroring the collection's prune; files still named by a link keep their row and lose their text, as in the Files-area prune — then the scope's `sync_state` row goes in the same transaction (pages also drops the `home` stamp, since the front page row is gone), so the next `ensureCollection` starts from nothing. It never calls a prune function. `forgetEverything()` (same file) is the whole-graph version: `clearGraphRows` (`DELETE FROM courses` cascades through the course tables; `files`, `conversations`, `planner_items`, `graph_edges` explicitly) plus all of `sync_state`, in one transaction, schema kept, chats untouched; `forgetCourse(courseId)` is the per-course version (`forgetCourseRows`: the course's documents, then the course row so the cascades take the rest, then orphan edges; plus the course's sync stamps and the `courses` stamp so the roster is re-listed next turn instead of after its TTL). "Delete this account's data" (Settings) is different in kind: it deletes the database, the chats and the memory slot.

## Query layer (`db/graph.ts`)

Every read returns typed rows (`db/rows.ts`): what the SQL projects, as PGlite hands it back — `TIMESTAMPTZ` as `Date`, counts and numeric columns as `number`, Canvas's `updated_at` (stored as `TEXT`) as string. `exploreGraph` is overloaded per `entity_type`. A reader that adds a column adds it to its row type.

- `exploreGraph({ entity_type, course_id, module_id, search_term, limit, include_items, bucket, include_submission })` builds a parameterized query per entity type. All string filters are `ILIKE '%term%'`; limits are clamped to 1–200 (default 25). Rows are projected to what the model needs (ids, names, dates, positions, `indexed` — computed for File, Page, Assignment and Discussion items). `bucket` filters assignments by due date; `include_submission` joins the student's submission row.
- Tool-specific reads: `listCourseFiles` / `listCoursePages` (the union described above — rows of the area plus module File/Page items that have no row yet — with `linked_from` aggregated from module items and `content_links`), `getAssignmentRow`, `listAnnouncements`, `listDiscussions` (title/message ILIKE, `replies_read` from the thread document), `getDiscussionRow`, `listQuizzes` (bucket on `due_at`, optional submission join through `assignment_id`), `getCourseSyllabus`, `listPlannerItems`, `listConversations` (subject/last-message ILIKE + message FTS, returns `matching_message`), `getConversationMessages`.
- Link writes: `storeContentLinks` (replace the links of one source + register targets), `setFrontPage`, `replaceCourseTabs`.
- `getCourseHierarchy(courseId, includeItems)` returns `{ course, treeNodes, assignments, prerequisites }` for the Memory sheet. `treeNodes` is a flat list (modules at depth 0, items at depth 1) regrouped client-side; `assignments` is projected (no description).
- `getGraphStatistics()` — six `COUNT(*)`s for the Memory sheet's stat tiles.
- `getDocumentContext(courseId, contentRef, itemType)` — the course code and the first module of that course listing the document as an item of that type (content ids of different types can be equal, page slugs repeat across courses), for the header prepended to each chunk before embedding (`canvas/sync.ts`).

## Adding a collection or column

1. Add the DDL to `schema.ts` (in the `CREATE TABLE`; there are no migrations, so an existing database needs recreating — see Database lifecycle). Numbers the model reads are `DOUBLE PRECISION` or `INT`, not `NUMERIC`.
2. Add a Canvas type to `types/canvas.ts`.
3. Add a shaped row type to `types/canvas.ts` and an `upsertAndPrune<X>(courseId, rows, tx)` to `graph.ts` following the full-list + prune pattern.
4. Add the kind to `CollectionKind` + `DEFAULT_FRESHNESS` in `freshness.ts`, `FRESHNESS_FIELDS` in `ui/model.ts`, and a `CollectionSpec` in `collections.ts` (fetch → shape → `withTransaction(upsert)`; add a `probe` if Canvas offers a narrow change check).
5. Add a read function to `graph.ts` and expose it through a tool in `agent/tools.ts` (which must `ensureCollection` first), and in the Memory sheet (`ui/useMemoryExplorer.ts`) if useful; add a `forgetCollectionRows` branch for a new collection kind. Cover the sync and prune in `test/canvas/collections.test.ts` / `test/db/graph.test.ts`.
