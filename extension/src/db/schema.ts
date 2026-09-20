/**
 * Database schema for PGlite. Runs on every start; every statement is idempotent (IF NOT EXISTS),
 * so a database is created complete on first use and left alone afterwards. There are no
 * migrations yet — nobody has a database worth carrying forward — so a schema change is made in
 * the CREATE TABLE and an existing database is reset ("Forget this memory").
 */

export const SCHEMA_SQL = `
-- 1. Vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Courses Table
CREATE TABLE IF NOT EXISTS courses (
  course_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  course_code   TEXT,
  term          TEXT,
  default_view  TEXT,        -- what "Home" shows: wiki | modules | syllabus | assignments | feed
  syllabus_body    TEXT,     -- the Syllabus tab body (raw HTML); the syllabus:<course> document is indexed from it
  syllabus_version TEXT,     -- fingerprint of syllabus_body (Canvas gives it no timestamp)
  synced_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Modules Table
CREATE TABLE IF NOT EXISTS modules (
  module_id     TEXT PRIMARY KEY,
  course_id     TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INT DEFAULT 0,
  synced_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. Module Items Table
CREATE TABLE IF NOT EXISTS module_items (
  item_id       TEXT PRIMARY KEY,
  module_id     TEXT REFERENCES modules(module_id) ON DELETE CASCADE,
  item_type     TEXT NOT NULL,
  title         TEXT NOT NULL,
  position      INT DEFAULT 0,
  content_ref   TEXT,
  html_url      TEXT,
  synced_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. Assignments Table
--    Synced from the compact assignment_groups listing (no description). The description is
--    fetched lazily by get_assignment / indexing and cached while description_version = updated_at.
CREATE TABLE IF NOT EXISTS assignments (
  assignment_id   TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  due_at          TIMESTAMPTZ,
  points_possible NUMERIC,
  html_url        TEXT,
  description     TEXT,          -- raw HTML from Canvas; indexed on demand
  updated_at      TEXT,
  synced_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  submission_types TEXT,         -- comma-joined
  group_name       TEXT,
  description_version TEXT       -- updated_at at the time description was fetched
);

-- 5a. The student's own submission state per assignment (shaped at store time)
CREATE TABLE IF NOT EXISTS submissions (
  assignment_id  TEXT PRIMARY KEY,
  course_id      TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  workflow_state TEXT,           -- unsubmitted | submitted | graded | pending_review
  submitted_at   TIMESTAMPTZ,
  graded_at      TIMESTAMPTZ,
  score          NUMERIC,
  grade          TEXT,
  late           BOOLEAN,
  missing        BOOLEAN,
  excused        BOOLEAN,
  synced_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5c. Announcements (HTML already converted to text)
CREATE TABLE IF NOT EXISTS announcements (
  announcement_id TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  posted_at       TIMESTAMPTZ,
  author          TEXT,
  text            TEXT,
  html_url        TEXT,
  synced_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5f. Discussion topics (the course forum). The topic message is stored as text; the reply
--     tree is fetched on demand into the 'discussion:<id>' document (one chunk per entry) and
--     replies_synced_for records the last_reply_at those entries correspond to.
CREATE TABLE IF NOT EXISTS discussions (
  discussion_id   TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  author          TEXT,
  posted_at       TIMESTAMPTZ,
  last_reply_at   TIMESTAMPTZ,
  reply_count     INT DEFAULT 0,
  message         TEXT,
  html_url        TEXT,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  locked          BOOLEAN NOT NULL DEFAULT FALSE,
  assignment_id   TEXT,              -- graded discussions
  replies_synced_for TEXT,
  synced_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5g. Quizzes (the Quizzes tab): the fields the assignments listing lacks — time limit,
--     attempts, availability window, question count. assignment_id joins the student's submission.
CREATE TABLE IF NOT EXISTS quizzes (
  quiz_id          TEXT PRIMARY KEY,
  course_id        TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  quiz_type        TEXT,
  time_limit       INT,              -- minutes; NULL = none
  allowed_attempts INT,              -- -1 = unlimited
  question_count   INT,
  points_possible  NUMERIC,
  due_at           TIMESTAMPTZ,
  unlock_at        TIMESTAMPTZ,
  lock_at          TIMESTAMPTZ,
  published        BOOLEAN NOT NULL DEFAULT TRUE,
  description      TEXT,             -- HTML → text with link markers
  assignment_id    TEXT,
  html_url         TEXT,
  lock_explanation TEXT,
  synced_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5d. Planner window (cross-course to-do list; course_id has no FK because the planner may
--     reference courses that are not in the graph)
CREATE TABLE IF NOT EXISTS planner_items (
  item_key       TEXT PRIMARY KEY,   -- '<plannable_type>:<plannable_id>'
  plannable_type TEXT NOT NULL,
  plannable_id   TEXT,
  course_id      TEXT,
  context_name   TEXT,
  title          TEXT NOT NULL,
  date           TIMESTAMPTZ,
  points         NUMERIC,
  submitted      BOOLEAN,
  late           BOOLEAN,
  missing        BOOLEAN,
  graded         BOOLEAN,
  new_activity   BOOLEAN,
  html_url       TEXT,
  synced_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5e. Inbox: conversation list + messages of threads that have been fetched
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  subject         TEXT,
  context_name    TEXT,
  course_id       TEXT,              -- no FK: may reference a course outside the graph
  participants    TEXT,              -- JSON [{id, name}]
  last_message    TEXT,
  last_message_at TIMESTAMPTZ,
  workflow_state  TEXT,              -- read | unread | archived
  message_count   INT,
  starred         BOOLEAN,
  thread_synced_for TEXT,            -- last_message_at value the stored messages correspond to
  synced_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  author_id       TEXT,
  author_name     TEXT,
  created_at      TIMESTAMPTZ,
  body            TEXT NOT NULL,
  body_tsv        TSVECTOR
);

-- 5b. Wiki Pages
CREATE TABLE IF NOT EXISTS pages (
  page_url      TEXT NOT NULL,
  course_id     TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  updated_at    TEXT,
  html_url      TEXT,
  front_page    BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (course_id, page_url)
);

-- 6. Graph Edges Table (Prerequisites, References)
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id   BIGSERIAL PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_type   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  relation  TEXT NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id, relation)
);

-- 7. Indexable documents: Canvas files, plus wiki pages, assignment descriptions, inbox threads,
--    discussion threads and course syllabi. A row with total_chunks = 0 is "known but not indexed".
--    file_id is the Canvas file id for files, 'page:<course>:<url>' for pages,
--    'assignment:<id>', 'conversation:<id>', 'discussion:<id>', 'syllabus:<course>'.
CREATE TABLE IF NOT EXISTS files (
  file_id         TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(course_id) ON DELETE SET NULL,
  filename        TEXT NOT NULL,
  display_name    TEXT,
  version         TEXT NOT NULL,
  extracted_at    TIMESTAMPTZ,
  total_chunks    INT DEFAULT 0,
  source_type     TEXT DEFAULT 'file',   -- 'file' | 'page' | 'assignment' | 'conversation' | 'discussion' | 'syllabus'
  embedding_model TEXT,                  -- provider/model the stored vectors came from
  html_url        TEXT,
  content_type    TEXT,
  size            BIGINT
);

-- 8. Document Chunks & Vector Embeddings
CREATE TABLE IF NOT EXISTS file_chunks (
  chunk_id      TEXT PRIMARY KEY,
  file_id       TEXT REFERENCES files(file_id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  page_number   INT,
  page_end      INT,             -- last page/slide covered when small pages were merged (NULL = page_number)
  content       TEXT NOT NULL,
  token_count   INT,
  content_hash  TEXT,            -- sha-256 of content; lets a re-index reuse vectors of unchanged chunks
  embedding     VECTOR(768),
  content_tsv   TSVECTOR       -- full-text index for hybrid (keyword + vector) search
);

-- 9. Freshness state per scope ('courses', 'planner', 'inbox', 'course:<id>:<collection>').
--    Owned by canvas/freshness.ts. status = 'ok' | 'unavailable' (course hides the collection).
CREATE TABLE IF NOT EXISTS sync_state (
  scope       TEXT PRIMARY KEY,
  synced_at   TIMESTAMPTZ,
  probed_at   TIMESTAMPTZ,
  fingerprint TEXT,
  status      TEXT NOT NULL DEFAULT 'ok',
  error       TEXT
);

-- 10. Course navigation (Tabs API): what the course's nav bar offers, incl. external tools.
CREATE TABLE IF NOT EXISTS course_tabs (
  course_id TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  tab_id    TEXT NOT NULL,
  label     TEXT NOT NULL,
  type      TEXT,             -- 'internal' | 'external'
  html_url  TEXT,
  position  INT,
  PRIMARY KEY (course_id, tab_id)
);

-- 11. Hyperlinks found in HTML bodies (front page, wiki pages, assignment descriptions,
--     announcements, discussion topics, quiz descriptions, the syllabus). This is how content the
--     instructor organised as "a page with links" becomes discoverable when the Files/Pages areas
--     are hidden from students.
CREATE TABLE IF NOT EXISTS content_links (
  course_id TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  from_type TEXT NOT NULL,    -- 'page' | 'assignment' | 'announcement' | 'discussion' | 'quiz' | 'syllabus'
  from_id   TEXT NOT NULL,    -- page slug / assignment id / announcement id / discussion id / quiz id / course id
  to_type   TEXT NOT NULL,    -- 'file' | 'page' | 'assignment' | 'quiz' | 'discussion' | 'module' | 'external'
  to_ref    TEXT NOT NULL,    -- file id / page slug / assignment id / … / URL
  label     TEXT,
  position  INT NOT NULL,
  PRIMARY KEY (course_id, from_type, from_id, position)
);

-- Indexes for fast traversal and joins
CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id);
CREATE INDEX IF NOT EXISTS idx_module_items_module ON module_items(module_id);
CREATE INDEX IF NOT EXISTS idx_module_items_content ON module_items(content_ref);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_file ON file_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_tsv ON file_chunks USING GIN(content_tsv);
-- Approximate nearest-neighbour index for the vector half of hybrid search (cosine, matches <=>).
-- Filtered searches rely on hnsw.iterative_scan (set in pglite.ts) so a course filter cannot starve the LIMIT.
CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding ON file_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_files_course ON files(course_id);
CREATE INDEX IF NOT EXISTS idx_pages_course ON pages(course_id);
CREATE INDEX IF NOT EXISTS idx_submissions_course ON submissions(course_id);
CREATE INDEX IF NOT EXISTS idx_announcements_course ON announcements(course_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_discussions_course ON discussions(course_id, last_reply_at DESC);
CREATE INDEX IF NOT EXISTS idx_quizzes_course ON quizzes(course_id, due_at);
CREATE INDEX IF NOT EXISTS idx_planner_date ON planner_items(date);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_tsv ON messages USING GIN(body_tsv);
CREATE INDEX IF NOT EXISTS idx_content_links_to ON content_links(course_id, to_type, to_ref);
`;

