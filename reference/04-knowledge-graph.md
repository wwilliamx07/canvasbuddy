# 04 — Knowledge graph (PGlite)

Sources: `src/db/pglite.ts`, `src/db/schema.ts`, `src/db/graph.ts`, `src/canvas/freshness.ts`, `src/canvas/collections.ts`, `src/canvas/http.ts`.

## Why a local Postgres

The graph is a **cache of Canvas structure** that makes most agent questions answerable without a network call and with compact, filterable rows. Postgres (via PGlite, compiled to WASM) was chosen over a key-value store because the queries are relational (joins across modules → items → files, staleness computed from timestamps) and because pgvector + full-text search give hybrid RAG in the same engine. Everything persists to IndexedDB, **one database per Canvas identity** (`idb://<dbName>`, see below).

## Database lifecycle (`db/pglite.ts`)

- **One database per identity.** `canvas/identity.ts` resolves who is signed in (`GET /users/self` → `<host>/<userId>`, name) and keeps a registry in `localStorage['canvas-buddy-memories']` mapping each identity to a `dbName` and a chats key. Names derive from the identity: `canvas-buddy-<host>-<userId>` for the database, `canvas-buddy-chats:<host>/<userId>` for the chats. `App` calls `configureDatabase(dbName)` before anything touches the database; `getDB()` throws until then. A signed-out session falls back to the last identity seen on that host (banner: "showing what's remembered for …"); a *different* account signing in mid-session is reported ("Reload to switch memory"), never mixed in. "Forget this memory" (Settings) closes the database (`closeDB`), deletes every IndexedDB database whose name ends with the data dir, removes the chats key and the registry entry, and reloads.
- `getDB()` returns a process-wide singleton; concurrent callers share one init promise.
- Init runs `SCHEMA_SQL` every time. Every statement is `CREATE … IF NOT EXISTS`, so a database is created complete on first use and left alone afterwards. There are **no migrations yet** — with no users there is no database worth carrying forward — so a schema change is made in the `CREATE TABLE` itself and an existing database is reset with "Forget this memory". Migrations become worth writing once there are installs to keep.
- **Exclusive Web Lock.** PGlite's IndexedDB filesystem is not safe to open from two pages at once, and Chrome opens one side panel per window. `acquireExclusiveLock` requests `navigator.locks` `canvas-buddy-pglite:<dbName>` with `ifAvailable: true` and holds it for the page lifetime. A second panel throws a clear "already open in another window" error instead of corrupting the database.

## Schema

```
courses (course_id PK, name, course_code, term, default_view [what "Home" shows], syllabus_body [raw HTML],
         syllabus_version [fingerprint], synced_at)
   │
   ├── course_tabs (PK (course_id, tab_id), label, type internal|external, html_url, position)   -- the nav bar
   ├── modules (module_id PK, course_id FK cascade, name, position, synced_at)
   │      └── module_items (item_id PK, module_id FK cascade, item_type, title, position,
   │                        content_ref, html_url, synced_at)
   ├── assignments (assignment_id PK, course_id FK cascade, name, due_at, points_possible, html_url,
   │                submission_types, group_name, updated_at, synced_at,
   │                description [raw HTML, lazy], description_version [updated_at it was fetched at])
   ├── submissions (assignment_id PK, course_id FK cascade, workflow_state, submitted_at, graded_at,
   │                score, grade, late, missing, excused, synced_at)          -- the student's own
   ├── discussions (discussion_id PK, course_id FK cascade, title, author, posted_at, last_reply_at, reply_count,
   │                message [HTML→text], html_url, pinned, locked, assignment_id [graded], replies_synced_for, synced_at)
   ├── quizzes (quiz_id PK, course_id FK cascade, title, quiz_type, time_limit, allowed_attempts, question_count,
   │            points_possible, due_at, unlock_at, lock_at, published, description [HTML→text], assignment_id,
   │            html_url, lock_explanation, synced_at)
   ├── announcements (announcement_id PK, course_id FK cascade, title, posted_at, author,
   │                  text [HTML→text], html_url, synced_at)
   ├── pages (PK (course_id, page_url), title, updated_at, html_url, front_page, synced_at)
   ├── content_links (PK (course_id, from_type, from_id, position), to_type, to_ref, label)
   │        -- hyperlinks found in HTML bodies: from page/assignment/announcement/discussion/quiz/syllabus → file/page/assignment/quiz/discussion/module/external
   └── files (file_id PK, course_id FK set-null, filename, display_name, version,
              extracted_at, total_chunks, source_type, embedding_model, html_url, content_type, size)
          └── file_chunks (chunk_id PK, file_id FK cascade, chunk_index, page_number, page_end,
                           content, content_hash, token_count, embedding VECTOR(768) [HNSW],
                           content_tsv TSVECTOR [GIN])

planner_items (item_key PK '<type>:<id>', plannable_type, plannable_id, course_id [no FK], context_name,
               title, date, points, submitted, late, missing, graded, new_activity, html_url)
conversations (conversation_id PK, subject, context_name, course_id [no FK], participants JSON,
               last_message, last_message_at, workflow_state, message_count, starred, thread_synced_for)
   └── messages (message_id PK, conversation_id FK cascade, author_id, author_name, created_at, body, body_tsv)

graph_edges (edge_id, from_type, from_id, to_type, to_id, relation)   -- no FKs

sync_state (scope PK, synced_at, probed_at, fingerprint, status ok|unavailable, error)
   -- scope = 'courses' | 'planner' | 'inbox' | 'course:<id>:<collection>'; owned by freshness.ts
```

Key modelling decisions:

- **All ids are `TEXT`.** Canvas ids are numeric but are stringified everywhere (`String(x)`) so the same column can hold page slugs and composite ids.
- **`module_items.content_ref`** is the pointer into the content tables: a file id for `File` items, a page slug for `Page` items, an assignment/quiz id otherwise. It is the `document_id` that `search_documents` / `read_document` take. `ExternalUrl` / `ExternalTool` items are the exception: `content_ref` holds their destination URL (`external_url`) when Canvas sends one, so the model can send the student there directly.
- **`files` is the "documents" table**, not just Canvas files. `source_type` is `'file' | 'page' | 'assignment' | 'conversation' | 'discussion' | 'syllabus'` and `file_id` comes from `docIdFor()` in `db/rag.ts` (`<file id>`, `page:<course>:<slug>`, `assignment:<id>`, `conversation:<id>`, `discussion:<id>`, `syllabus:<course>`). A row with `total_chunks = 0` is *known but not indexed*; this is how the `indexed` flag is derived in every query.
- **Canvas is a link graph, and `content_links` records it.** Every HTML body the app touches (front page, wiki pages at index time, assignment descriptions, announcements, discussion topics, quiz descriptions and the syllabus at sync time) goes through `ingestHtml` (`canvas/links.ts`): the links are stored as `content_links` rows and what they point at is *registered* — a linked file becomes a `files` row (`total_chunks = 0`, `filename` from the anchor's title, `display_name` from its text), a linked page becomes a `pages` row. That is what makes files a course keeps on its home page (rather than in modules, with the Files area hidden) listable and indexable. Registration never overwrites an existing row; links into *another* course are recorded but its content is not adopted.
- **The front page is the root.** `courses.default_view` says what "Home" shows; when it is `wiki`, the `home` collection fetches `/front_page`, flags that row in `pages.front_page`, and ingests its links. `list_content(kind="courses")` reports this as `home_view`, and `kind="pages"` lists the front page first.
- **`assignments.description` is lazy.** The compact `assignment_groups` listing omits it; `get_assignment` / indexing fetch it once and cache it while `description_version = updated_at`. A sync that sees a new `updated_at` nulls it.
- **Discussion replies are a thread document, like inbox messages.** `discussions` holds the topic list (message as text); the reply tree is fetched on demand (`ensureDiscussionThread`, only when the topic's `last_reply_at` differs from `replies_synced_for`) into the `discussion:<id>` document — chunk 0 is the topic, then one chunk per entry in reading order, keyed by entry id so a re-fetch updates edited entries (dropping their vector), inserts new ones and prunes deleted ones (`upsertDocumentChunksIncremental` with `pruneMissing`). No vector until a semantic search targets the thread.
- **The syllabus is a document of the course.** `courses.syllabus_body` holds the Syllabus tab HTML (fingerprinted in `syllabus_version`, since Canvas gives it no timestamp); `syllabus:<course>` is indexed from it through the ordinary JIT pipeline. `setCourseSyllabus(null)` drops the document and its links.
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
| `courses` | `/courses?enrollment_state=active&include[]=term` + `/courses/:c/tabs` per course | — (TTL) | — (`default_view` and the nav bar are stored alongside the roster) |
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
| `syllabus` | `/courses/:c?include[]=syllabus_body` | the body itself, fingerprinted (`length:hash`); the probe's fetch is handed to the sync as `probeData` | stores `courses.syllabus_body`, ingests its links |
| `home` | `/courses/:c/front_page` (404 = no front page, not "unavailable") | front page `updated_at`; the probe's fetch is handed to the sync as `probeData` | sets `pages.front_page`, ingests the page's links (registers linked files/pages). Ensured by `list_content(kind="files"/"pages")`. |

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
- **In-flight dedupe**: concurrent calls for the same scope share one promise.
- **Registry** (`COLLECTIONS` in `collections.ts`): each `CollectionSpec` declares `kind`, `sync(ctx, { state, probeData, settings })` and optionally `probe(ctx, state)`. All thirteen kinds are registered (see the table above).
- **Overview text** (`getGraphOverviewText`) is now just the course roster (names + ids). `exploreGraph('courses')` reports `files_status`/`pages_status` from `sync_state`.
- **Forgetting** (`forgetCollection(kind, courseId)` in `freshness.ts`) is the one user-driven change to the graph besides forgetting the whole memory: `forgetCollectionRows` (`graph.ts`) deletes what the collection stored for the course — the rows, the dependent documents and the `content_links` found in their bodies, mirroring the collection's prune; files still named by a link keep their row and lose their text, as in the Files-area prune — then the scope's `sync_state` row goes in the same transaction (pages also drops the `home` stamp, since the front page row is gone), so the next `ensureCollection` starts from nothing. It never calls a prune function.

## Query layer (`db/graph.ts`)

- `exploreGraph({ entity_type, course_id, module_id, search_term, limit, include_items, bucket, include_submission })` builds a parameterized query per entity type. All string filters are `ILIKE '%term%'`; limits are clamped to 1–200 (default 25). Rows are projected to what the model needs (ids, names, dates, positions, `indexed` — computed for File, Page and Assignment items alike). `bucket` filters assignments by due date; `include_submission` joins the student's submission row.
- Tool-specific reads: `listCourseFiles` / `listCoursePages` (the union described above, with `linked_from` aggregated from module items and `content_links`), `getAssignmentRow`, `listAnnouncements`, `listDiscussions` (title/message ILIKE, `replies_read` from the thread document), `getDiscussionRow`, `listQuizzes` (bucket on `due_at`, optional submission join through `assignment_id`), `getCourseSyllabus`, `listPlannerItems`, `listConversations` (subject/last-message ILIKE + message FTS, returns `matching_message`), `getConversationMessages`.
- Link writes: `storeContentLinks` (replace the links of one source + register targets), `setFrontPage`, `replaceCourseTabs`.
- `getCourseHierarchy(courseId, includeItems)` returns `{ course, treeNodes, assignments, prerequisites }` for the Memory sheet. `treeNodes` is a flat list (modules at depth 0, items at depth 1) regrouped client-side; `assignments` is projected (no description).
- `getGraphStatistics()` — six `COUNT(*)`s for the Memory sheet's stat tiles.

## Adding a collection or column

1. Add the DDL to `schema.ts` (in the `CREATE TABLE`; there are no migrations yet, an existing database is reset).
2. Add a Canvas type to `types/canvas.ts`.
3. Add a shaped row type to `types/canvas.ts` and an `upsertAndPrune<X>(courseId, rows, tx)` to `graph.ts` following the full-list + prune pattern.
4. Add the kind to `CollectionKind` + `DEFAULT_FRESHNESS` in `freshness.ts`, the Settings field list, and a `CollectionSpec` in `collections.ts` (fetch → shape → `withTransaction(upsert)`; add a `probe` if Canvas offers a narrow change check).
5. Add a read function to `graph.ts` and expose it through a tool in `agent/tools.ts` (which must `ensureCollection` first), and in the Memory sheet (`ui/useMemoryExplorer.ts`) if useful; add a `forgetCollectionRows` branch for a new collection kind.
