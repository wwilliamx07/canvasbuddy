import { getDB, q, withTransaction, type Queryable } from './pglite';
import type { CanvasFile, RetrievedChunk } from '../types/canvas';
import type { PageKind } from '../utils/textExtractor';
import type { ChunkRow, DocumentRecord } from './rows';

export type DocumentSourceType = 'file' | 'page' | 'assignment' | 'conversation' | 'discussion' | 'syllabus';

/** The files.file_id (document id) for a source; mirrored by hand in the SQL joins and prunes of graph.ts. */
export function docIdFor(sourceType: DocumentSourceType, sourceId: string, courseId?: string | null): string {
  switch (sourceType) {
    case 'file':
      return String(sourceId);
    case 'page':
      return `page:${courseId}:${sourceId}`;
    case 'assignment':
      return `assignment:${sourceId}`;
    case 'conversation':
      return `conversation:${sourceId}`;
    case 'discussion':
      return `discussion:${sourceId}`;
    case 'syllabus':
      // one per course: the source id is the course id
      return `syllabus:${sourceId}`;
  }
}

/**
 * Format a numeric JavaScript array into a pgvector string literal: '[0.1, 0.2, ...]'
 */
export function formatVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Returns what is stored for a document, so the caller can decide whether the cache is usable.
 * A cache hit requires the same Canvas version AND the same embedding model — vectors from
 * different models live in different spaces and cannot be searched together.
 */
export async function getDocumentCacheState(
  docId: string
): Promise<{ version: string; totalChunks: number; embeddingModel: string | null } | null> {
  const db = await getDB();
  const res = await db.query<{ version: string; total_chunks: number | string | null; embedding_model: string | null }>(
    'SELECT version, total_chunks, embedding_model FROM files WHERE file_id = $1',
    [String(docId)]
  );
  if (res.rows.length === 0) return null;
  return {
    version: res.rows[0].version,
    totalChunks: Number(res.rows[0].total_chunks || 0),
    embeddingModel: res.rows[0].embedding_model,
  };
}

/**
 * Records Canvas files that exist in a course without indexing them (total_chunks stays 0),
 * and removes files that no longer exist in Canvas. A version change resets total_chunks to 0,
 * which hides the old chunks from search and reads; the rows themselves are kept so the next
 * index can reuse the vectors of pages that did not change.
 */
export async function upsertAndPruneKnownFiles(
  courseId: string,
  files: CanvasFile[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const validIds: string[] = [];

  for (const f of files) {
    const fileId = String(f.id);
    validIds.push(fileId);
    const version = f.modified_at || f.updated_at || String(f.size || '1');

    await db.query(
      `INSERT INTO files (file_id, course_id, filename, display_name, version, total_chunks, source_type, html_url, content_type, size)
       VALUES ($1, $2, $3, $4, $5, 0, 'file', $6, $7, $8)
       ON CONFLICT (file_id) DO UPDATE SET
         course_id    = EXCLUDED.course_id,
         filename     = EXCLUDED.filename,
         display_name = EXCLUDED.display_name,
         html_url     = EXCLUDED.html_url,
         content_type = EXCLUDED.content_type,
         size         = EXCLUDED.size,
         -- a newer upstream version invalidates the stored chunks
         total_chunks = CASE WHEN files.version = EXCLUDED.version THEN files.total_chunks ELSE 0 END,
         version      = EXCLUDED.version`,
      [
        fileId,
        String(courseId),
        f.filename || f.display_name || `file_${fileId}`,
        f.display_name || f.filename || null,
        version,
        f.url || null,
        f.content_type || null,
        f.size != null ? Number(f.size) : null,
      ]
    );
  }
  // A file is pruned only when neither the Files listing nor any link in the course still names
  // it: instructors link files that live in other courses' (or their own) file areas.
  const linked = `file_id IN (SELECT to_ref FROM content_links WHERE course_id = $1 AND to_type = 'file')`;
  let pruned = 0;
  if (validIds.length > 0) {
    const placeholders = validIds.map((_, i) => `$${i + 2}`).join(',');
    const res = await db.query(
      `DELETE FROM files WHERE course_id = $1 AND source_type = 'file' AND file_id NOT IN (${placeholders}) AND NOT ${linked} RETURNING file_id`,
      [String(courseId), ...validIds]
    );
    pruned = res.rows.length;
  } else {
    const res = await db.query(
      `DELETE FROM files WHERE course_id = $1 AND source_type = 'file' AND NOT ${linked} RETURNING file_id`,
      [String(courseId)]
    );
    pruned = res.rows.length;
  }

  return { upserted: files.length, pruned };
}

/**
 * PGlite runs no autovacuum launcher, so planner statistics never refresh on their own; the
 * keyword half of hybrid search and its joins are planned from them. ANALYZE costs ~ms.
 */
async function refreshChunkStats(db: Queryable): Promise<void> {
  await db.query('ANALYZE file_chunks');
}

/**
 * Vectors already stored for a document, keyed by chunk content hash, so a re-index can keep
 * them for chunks whose text did not change. Only meaningful when the caller has checked that
 * the stored `embedding_model` matches the current one. Values are pgvector literals.
 */
export async function getStoredEmbeddingsByHash(docId: string): Promise<Map<string, string>> {
  const db = await getDB();
  const res = await db.query<{ content_hash: string; embedding: string }>(
    'SELECT content_hash, embedding::text AS embedding FROM file_chunks WHERE file_id = $1 AND content_hash IS NOT NULL AND embedding IS NOT NULL',
    [String(docId)]
  );
  return new Map(res.rows.map((r) => [r.content_hash, r.embedding]));
}

/**
 * Stores document metadata and replaces its text chunks with 768d vector embeddings.
 * `content` is the raw chunk text shown to the user; `embeddedText` (header + content) is what
 * the vector was computed from and is not stored. `embedding` is either a fresh vector or a
 * literal reused from `getStoredEmbeddingsByHash`.
 */
export async function storeChunksWithEmbeddings(params: {
  docId: string;
  sourceType: DocumentSourceType;
  courseId?: string | null;
  filename: string;
  displayName?: string | null;
  version: string;
  embeddingModel: string;
  htmlUrl?: string | null;
  /** What page_number counts for this document's chunks */
  pageKind: PageKind;
  chunks: Array<{
    chunkIndex: number;
    pageNumber?: number | null;
    pageEnd?: number | null;
    content: string;
    contentHash?: string | null;
    tokenCount?: number;
    embedding: number[] | string;
  }>;
}): Promise<number> {
  const { docId, sourceType, courseId, filename, displayName, version, embeddingModel, htmlUrl, pageKind, chunks } = params;
  // One transaction: the row says the document is indexed (total_chunks, version) only if every
  // chunk is in, or a failure half-way would leave a "cached" document with chunks missing
  return withTransaction(async (db) => {
    // 1. Upsert document metadata
    await db.query(
      `INSERT INTO files (file_id, course_id, filename, display_name, version, extracted_at, total_chunks, source_type, page_kind, embedding_model, html_url)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8, $9, $10)
       ON CONFLICT (file_id) DO UPDATE SET
         course_id       = COALESCE(EXCLUDED.course_id, files.course_id),
         filename        = EXCLUDED.filename,
         display_name    = EXCLUDED.display_name,
         version         = EXCLUDED.version,
         extracted_at    = CURRENT_TIMESTAMP,
         total_chunks    = EXCLUDED.total_chunks,
         source_type     = EXCLUDED.source_type,
         page_kind       = EXCLUDED.page_kind,
         embedding_model = EXCLUDED.embedding_model,
         html_url        = COALESCE(EXCLUDED.html_url, files.html_url)`,
      [
        String(docId),
        courseId ? String(courseId) : null,
        filename,
        displayName || filename,
        version,
        chunks.length,
        sourceType,
        pageKind,
        embeddingModel,
        htmlUrl || null,
      ]
    );

    // 2. Clear previous chunks for this document
    await db.query('DELETE FROM file_chunks WHERE file_id = $1', [String(docId)]);

    // 3. Insert new chunks (vector + full-text index)
    for (const chunk of chunks) {
      const chunkId = `${docId}-chunk-${chunk.chunkIndex}`;
      await db.query(
        `INSERT INTO file_chunks (chunk_id, file_id, chunk_index, page_number, page_end, content, content_hash, token_count, embedding, content_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, to_tsvector('english', $6))`,
        [
          chunkId,
          String(docId),
          chunk.chunkIndex,
          chunk.pageNumber != null ? chunk.pageNumber : null,
          chunk.pageEnd ?? chunk.pageNumber ?? null,
          chunk.content,
          chunk.contentHash ?? null,
          chunk.tokenCount || 0,
          typeof chunk.embedding === 'string' ? chunk.embedding : formatVector(chunk.embedding),
        ]
      );
    }

    await refreshChunkStats(db);
    return chunks.length;
  });
}

/**
 * Thread documents (inbox conversations, discussion topics): chunk ids are stable (one per message
 * or entry), so a re-fetch inserts new entries, updates edited ones (dropping their vector) and
 * leaves unchanged ones with theirs. Entries are stored as text with a NULL vector — keyword-
 * searchable — and embedded only when a semantic search targets the thread (`chunksToEmbed`).
 * Runs in `tx` when given (so the caller's other writes commit with it), else in its own transaction.
 */
export async function upsertDocumentChunksIncremental(params: {
  docId: string;
  sourceType: DocumentSourceType;
  courseId?: string | null;
  title: string;
  version: string;
  embeddingModel: string | null;
  htmlUrl?: string | null;
  chunks: Array<{ chunkId: string; chunkIndex: number; content: string; embedding: number[] | null }>;
  /** Delete stored chunks that are not in `chunks` (pass true only with the complete entry list). */
  pruneMissing?: boolean;
}, tx?: Queryable): Promise<{ inserted: number }> {
  return tx ? writeDocumentChunksIncremental(params, tx) : withTransaction((t) => writeDocumentChunksIncremental(params, t));
}

async function writeDocumentChunksIncremental(
  params: Parameters<typeof upsertDocumentChunksIncremental>[0],
  db: Queryable
): Promise<{ inserted: number }> {
  const { docId, sourceType, courseId, title, version, embeddingModel, htmlUrl, chunks, pruneMissing } = params;

  // course_id is looked up so a conversation about a course outside the graph does not violate the FK
  await db.query(
    `INSERT INTO files (file_id, course_id, filename, display_name, version, extracted_at, total_chunks, source_type, embedding_model, html_url)
     VALUES ($1, (SELECT course_id FROM courses WHERE course_id = $2), $3, $3, $4, CURRENT_TIMESTAMP, 0, $5, $6, $7)
     ON CONFLICT (file_id) DO UPDATE SET
       course_id = COALESCE(EXCLUDED.course_id, files.course_id),
       filename = EXCLUDED.filename, display_name = EXCLUDED.display_name, version = EXCLUDED.version,
       extracted_at = CURRENT_TIMESTAMP, embedding_model = COALESCE(EXCLUDED.embedding_model, files.embedding_model),
       html_url = COALESCE(EXCLUDED.html_url, files.html_url)`,
    [String(docId), courseId ? String(courseId) : null, title, version, sourceType, embeddingModel, htmlUrl || null]
  );

  let inserted = 0;
  for (const c of chunks) {
    // An entry whose text changed (edited reply) drops its vector so it is re-embedded on next use
    const res = await db.query<{ inserted: boolean }>(
      `INSERT INTO file_chunks (chunk_id, file_id, chunk_index, page_number, content, token_count, embedding, content_tsv)
       VALUES ($1, $2, $3, NULL, $4, $5, $6::vector, to_tsvector('english', $4))
       ON CONFLICT (chunk_id) DO UPDATE SET
         chunk_index = EXCLUDED.chunk_index,
         embedding = CASE WHEN file_chunks.content = EXCLUDED.content
                          THEN COALESCE(EXCLUDED.embedding, file_chunks.embedding) ELSE EXCLUDED.embedding END,
         content = EXCLUDED.content,
         token_count = EXCLUDED.token_count,
         content_tsv = EXCLUDED.content_tsv
       RETURNING (xmax = 0) AS inserted`,
      [c.chunkId, String(docId), c.chunkIndex, c.content, Math.ceil(c.content.length / 4), c.embedding ? formatVector(c.embedding) : null]
    );
    if (res.rows[0]?.inserted) inserted++;
  }
  if (pruneMissing) {
    await db.query('DELETE FROM file_chunks WHERE file_id = $1 AND chunk_id <> ALL($2::text[])', [String(docId), chunks.map((c) => c.chunkId)]);
  }
  await db.query(
    'UPDATE files SET total_chunks = (SELECT COUNT(*) FROM file_chunks WHERE file_id = $1) WHERE file_id = $1',
    [String(docId)]
  );
  await refreshChunkStats(db);
  return { inserted };
}

/**
 * Chunks of a thread document that need a vector from `embeddingModel`: those stored without one
 * (threads are stored as text, and embedded only when a semantic search targets them), and every
 * chunk when the stored vectors came from another model — vectors of two models live in different
 * spaces and must never be searched together, so those are dropped first.
 */
export async function chunksToEmbed(docId: string, embeddingModel: string): Promise<Array<{ chunk_id: string; content: string }>> {
  return withTransaction(async (tx) => {
    await tx.query(
      `UPDATE file_chunks SET embedding = NULL
       WHERE file_id = $1 AND embedding IS NOT NULL
         AND EXISTS (SELECT 1 FROM files WHERE file_id = $1 AND embedding_model IS DISTINCT FROM $2)`,
      [String(docId), embeddingModel]
    );
    const res = await tx.query<{ chunk_id: string; content: string }>(
      'SELECT chunk_id, content FROM file_chunks WHERE file_id = $1 AND embedding IS NULL ORDER BY chunk_index',
      [String(docId)]
    );
    return res.rows;
  });
}

/** Stores vectors for some chunks of a thread document and records the model they came from. */
export async function setChunkEmbeddings(
  docId: string,
  rows: Array<{ chunkId: string; embedding: number[] }>,
  embeddingModel: string
): Promise<void> {
  await withTransaction(async (tx) => {
    for (const r of rows) {
      await tx.query('UPDATE file_chunks SET embedding = $2::vector WHERE chunk_id = $1', [r.chunkId, formatVector(r.embedding)]);
    }
    await tx.query('UPDATE files SET embedding_model = $2 WHERE file_id = $1', [String(docId), embeddingModel]);
    await refreshChunkStats(tx);
  });
}

interface SearchRow {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  page_end: number | null;
  content: string;
  similarity: number;
  fused_score: number;
  filename: string;
  display_name: string | null;
  file_id: string;
  course_id: string | null;
  source_type: string;
  page_kind: string | null;
  html_url: string | null;
  course_name: string | null;
  module_name: string | null;
}

export interface SearchOptions {
  /** Restrict to one course. Ignored with `docId`: the document is the scope. */
  courseId?: string | null;
  /** Restrict to one document (`files.file_id`). */
  docId?: string | null;
  limit?: number;
  /**
   * The model `queryVector` came from. The vector half only ranks chunks of documents embedded by
   * the same model (other vectors live in another space); the keyword half ranks everything.
   */
  embeddingModel?: string | null;
}

/**
 * Hybrid retrieval: vector similarity (<=>) fused with Postgres full-text search via
 * reciprocal rank fusion. Course material is full of exact tokens ("Theorem 3.2", "Q4(b)")
 * where keyword match beats embeddings, and vice versa for paraphrased questions.
 * Only documents with total_chunks > 0 take part: chunks of an outdated version are kept as a
 * vector cache but must not surface.
 *
 * The vector half always walks the HNSW index: `enable_sort = off` for this statement makes the
 * planner prefer the index's ordered scan over "scan + sort" at any table size (the keyword half
 * still sorts, as it must). Filters are satisfied by hnsw.iterative_scan (set in pglite.ts).
 */
export async function searchChunksHybrid(queryText: string, queryVector: number[], options: SearchOptions = {}): Promise<RetrievedChunk[]> {
  const { courseId = null, docId = null, limit = 5, embeddingModel = null } = options;
  const vectorStr = formatVector(queryVector);
  const candidates = Math.max(20, limit * 4);

  const query = `
    WITH vec AS (
      SELECT fc.chunk_id, ROW_NUMBER() OVER (ORDER BY fc.embedding <=> $1::vector) AS rnk
      FROM file_chunks fc
      JOIN files f ON f.file_id = fc.file_id
      WHERE ($6::text IS NOT NULL OR $2::text IS NULL OR f.course_id = $2)
        AND ($6::text IS NULL OR f.file_id = $6)
        AND f.total_chunks > 0
        AND fc.embedding IS NOT NULL
        AND ($7::text IS NULL OR f.embedding_model = $7)
      ORDER BY fc.embedding <=> $1::vector
      LIMIT $4
    ),
    fts AS (
      SELECT fc.chunk_id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fc.content_tsv, q) DESC) AS rnk
      FROM file_chunks fc
      JOIN files f ON f.file_id = fc.file_id,
      websearch_to_tsquery('english', $3) q
      WHERE fc.content_tsv @@ q
        AND ($6::text IS NOT NULL OR $2::text IS NULL OR f.course_id = $2)
        AND ($6::text IS NULL OR f.file_id = $6)
        AND f.total_chunks > 0
      ORDER BY ts_rank_cd(fc.content_tsv, q) DESC
      LIMIT $4
    ),
    fused AS (
      SELECT chunk_id, SUM(1.0 / (60 + rnk)) AS score
      FROM (SELECT * FROM vec UNION ALL SELECT * FROM fts) u
      GROUP BY chunk_id
    )
    SELECT
      fc.chunk_id,
      fc.chunk_index,
      fc.page_number,
      COALESCE(fc.page_end, fc.page_number) AS page_end,
      fc.content,
      COALESCE(1 - (fc.embedding <=> $1::vector), 0) AS similarity,
      fused.score AS fused_score,
      f.filename,
      f.display_name,
      f.file_id,
      f.course_id,
      f.source_type,
      f.page_kind,
      f.html_url,
      c.name AS course_name,
      m.name AS module_name
    FROM fused
    JOIN file_chunks fc ON fc.chunk_id = fused.chunk_id
    JOIN files f ON f.file_id = fc.file_id
    LEFT JOIN courses c ON c.course_id = f.course_id
    -- A file can be linked from several modules; take one so chunks are not duplicated.
    LEFT JOIN LATERAL (
      SELECT m.name
      FROM module_items mi
      JOIN modules m ON m.module_id = mi.module_id
      WHERE mi.content_ref = f.file_id AND mi.item_type = 'File' -- an assignment or quiz can share the number
      ORDER BY m.position ASC
      LIMIT 1
    ) m ON TRUE
    ORDER BY fused.score DESC, similarity DESC
    LIMIT $5;
  `;

  const res = await withTransaction(async (tx) => {
    await tx.query('SET LOCAL enable_sort = off');
    return tx.query<SearchRow>(query, [vectorStr, courseId || null, queryText, candidates, limit, docId || null, embeddingModel || null]);
  });

  return res.rows.map((row) => ({
    chunk_id: row.chunk_id,
    chunk_index: row.chunk_index,
    page_number: row.page_number ?? undefined,
    page_end: row.page_end ?? undefined,
    content: row.content,
    similarity: row.similarity,
    filename: row.filename,
    display_name: row.display_name ?? undefined,
    file_id: row.file_id,
    course_id: row.course_id ?? undefined,
    course_name: row.course_name ?? undefined,
    module_name: row.module_name ?? undefined,
    source_type: row.source_type,
    page_kind: row.page_kind ?? undefined,
    html_url: row.html_url ?? undefined,
  }));
}

/** Every document of a course (or of all), indexed or merely known, indexed ones first. */
export async function getFilesList(courseId?: string): Promise<DocumentRecord[]> {
  const db = await getDB();
  let sql = 'SELECT * FROM files';
  const params: string[] = [];
  if (courseId) {
    sql += ' WHERE course_id = $1';
    params.push(String(courseId));
  }
  sql += ' ORDER BY total_chunks DESC, extracted_at DESC NULLS LAST, filename ASC';
  const res = await db.query<DocumentRecord>(sql, params);
  return res.rows;
}

/**
 * Chunks of an indexed document in order, optionally restricted to a page/slide range (a chunk
 * is included when its page range overlaps the requested one). Chunks of a document whose
 * total_chunks is 0 (outdated version awaiting re-index) are not returned.
 */
export async function getFileChunks(docId: string, pageRange?: { from: number; to: number }): Promise<ChunkRow[]> {
  const db = await getDB();
  const res = await db.query<ChunkRow>(
    `SELECT fc.chunk_id, fc.chunk_index, fc.page_number, COALESCE(fc.page_end, fc.page_number) AS page_end, f.page_kind, fc.content, fc.token_count
     FROM file_chunks fc JOIN files f ON f.file_id = fc.file_id
     WHERE fc.file_id = $1 AND f.total_chunks > 0
       AND ($2::int IS NULL OR (fc.page_number <= $3 AND COALESCE(fc.page_end, fc.page_number) >= $2))
     ORDER BY fc.chunk_index ASC`,
    [String(docId), pageRange?.from ?? null, pageRange?.to ?? null]
  );
  return res.rows;
}

/**
 * Forgets a document's text: its chunks go (the vector cache with them — that is what forgetting
 * means) and the row stays as a known document with total_chunks = 0, so it is indexed again the
 * next time a search or read targets it.
 */
export async function forgetDocument(docId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query('DELETE FROM file_chunks WHERE file_id = $1', [String(docId)]);
    await tx.query('UPDATE files SET total_chunks = 0 WHERE file_id = $1', [String(docId)]);
    await refreshChunkStats(tx);
  });
}

/** Highest page/slide number stored for a document (for read_document range hints). */
export async function getDocumentPageCount(docId: string): Promise<number | null> {
  const db = await getDB();
  const res = await db.query<{ max: number | string | null }>(
    'SELECT MAX(COALESCE(page_end, page_number)) AS max FROM file_chunks WHERE file_id = $1',
    [String(docId)]
  );
  return res.rows[0]?.max == null ? null : Number(res.rows[0].max);
}
