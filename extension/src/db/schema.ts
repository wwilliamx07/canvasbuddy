/**
 * Database schema and DDL migrations for PGlite
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
  synced_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  -- Per-collection sync markers so staleness can be judged even when a collection is empty
  modules_synced_at     TIMESTAMPTZ,
  assignments_synced_at TIMESTAMPTZ,
  files_synced_at       TIMESTAMPTZ,
  pages_synced_at       TIMESTAMPTZ
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
CREATE TABLE IF NOT EXISTS assignments (
  assignment_id   TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  due_at          TIMESTAMPTZ,
  points_possible NUMERIC,
  html_url        TEXT,
  description     TEXT,          -- raw HTML from Canvas; indexed on demand
  updated_at      TEXT,
  synced_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5b. Wiki Pages
CREATE TABLE IF NOT EXISTS pages (
  page_url      TEXT NOT NULL,
  course_id     TEXT REFERENCES courses(course_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  updated_at    TEXT,
  html_url      TEXT,
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

-- 7. Indexable documents: Canvas files, plus wiki pages and assignment descriptions.
--    A row with total_chunks = 0 is "known but not indexed".
--    file_id is the Canvas file id for files, 'page:<course>:<url>' for pages,
--    'assignment:<id>' for assignment descriptions.
CREATE TABLE IF NOT EXISTS files (
  file_id         TEXT PRIMARY KEY,
  course_id       TEXT REFERENCES courses(course_id) ON DELETE SET NULL,
  filename        TEXT NOT NULL,
  display_name    TEXT,
  version         TEXT NOT NULL,
  extracted_at    TIMESTAMPTZ,
  total_chunks    INT DEFAULT 0,
  source_type     TEXT DEFAULT 'file',   -- 'file' | 'page' | 'assignment'
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
  content       TEXT NOT NULL,
  token_count   INT,
  embedding     VECTOR(768),
  content_tsv   TSVECTOR       -- full-text index for hybrid (keyword + vector) search
);

-- Migrations for databases created by earlier versions (all idempotent)
ALTER TABLE courses     ADD COLUMN IF NOT EXISTS modules_synced_at     TIMESTAMPTZ;
ALTER TABLE courses     ADD COLUMN IF NOT EXISTS assignments_synced_at TIMESTAMPTZ;
ALTER TABLE courses     ADD COLUMN IF NOT EXISTS files_synced_at       TIMESTAMPTZ;
ALTER TABLE courses     ADD COLUMN IF NOT EXISTS pages_synced_at       TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS updated_at  TEXT;
ALTER TABLE files       ADD COLUMN IF NOT EXISTS source_type     TEXT DEFAULT 'file';
ALTER TABLE files       ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE files       ADD COLUMN IF NOT EXISTS html_url        TEXT;
ALTER TABLE files       ADD COLUMN IF NOT EXISTS content_type    TEXT;
ALTER TABLE files       ADD COLUMN IF NOT EXISTS size            BIGINT;
ALTER TABLE files       ALTER COLUMN extracted_at DROP DEFAULT;
ALTER TABLE file_chunks ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR;
UPDATE file_chunks SET content_tsv = to_tsvector('english', content) WHERE content_tsv IS NULL;

-- Indexes for fast traversal and joins
CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id);
CREATE INDEX IF NOT EXISTS idx_module_items_module ON module_items(module_id);
CREATE INDEX IF NOT EXISTS idx_module_items_content ON module_items(content_ref);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_file ON file_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_tsv ON file_chunks USING GIN(content_tsv);
CREATE INDEX IF NOT EXISTS idx_files_course ON files(course_id);
CREATE INDEX IF NOT EXISTS idx_pages_course ON pages(course_id);
`;

