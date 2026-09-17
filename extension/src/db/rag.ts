import { getDB } from './pglite';
import type { CanvasFile, RetrievedChunk } from '../types/canvas';

export type DocumentSourceType = 'file' | 'page' | 'assignment';

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
 * and removes files that no longer exist in Canvas. Indexed rows keep their chunks unless
 * the file was deleted upstream.
 */
export async function upsertAndPruneKnownFiles(
  courseId: string,
  files: CanvasFile[]
): Promise<{ upserted: number; pruned: number }> {
  const db = await getDB();
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

  let pruned = 0;
  if (validIds.length > 0) {
    const placeholders = validIds.map((_, i) => `$${i + 2}`).join(',');
    const res = await db.query(
      `DELETE FROM files WHERE course_id = $1 AND source_type = 'file' AND file_id NOT IN (${placeholders}) RETURNING file_id`,
      [String(courseId), ...validIds]
    );
    pruned = res.rows.length;
  } else {
    const res = await db.query(
      `DELETE FROM files WHERE course_id = $1 AND source_type = 'file' RETURNING file_id`,
      [String(courseId)]
    );
    pruned = res.rows.length;
  }

  return { upserted: files.length, pruned };
}

/**
 * Stores document metadata and replaces its text chunks with 768d vector embeddings.
 * `content` is the raw chunk text shown to the user; `embeddedText` (header + content) is what
 * the vector was computed from and is not stored.
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
  chunks: Array<{
    chunkIndex: number;
    pageNumber?: number | null;
    content: string;
    tokenCount?: number;
    embedding: number[];
  }>;
}): Promise<number> {
  const { docId, sourceType, courseId, filename, displayName, version, embeddingModel, htmlUrl, chunks } = params;
  const db = await getDB();

  // 1. Upsert document metadata
  await db.query(
    `INSERT INTO files (file_id, course_id, filename, display_name, version, extracted_at, total_chunks, source_type, embedding_model, html_url)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8, $9)
     ON CONFLICT (file_id) DO UPDATE SET
       course_id       = COALESCE(EXCLUDED.course_id, files.course_id),
       filename        = EXCLUDED.filename,
       display_name    = EXCLUDED.display_name,
       version         = EXCLUDED.version,
       extracted_at    = CURRENT_TIMESTAMP,
       total_chunks    = EXCLUDED.total_chunks,
       source_type     = EXCLUDED.source_type,
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
      `INSERT INTO file_chunks (chunk_id, file_id, chunk_index, page_number, content, token_count, embedding, content_tsv)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, to_tsvector('english', $5))`,
      [
        chunkId,
        String(docId),
        chunk.chunkIndex,
        chunk.pageNumber != null ? chunk.pageNumber : null,
        chunk.content,
        chunk.tokenCount || 0,
        formatVector(chunk.embedding),
      ]
    );
  }

  return chunks.length;
}

/**
 * Hybrid retrieval: vector similarity (<=>) fused with Postgres full-text search via
 * reciprocal rank fusion. Course material is full of exact tokens ("Theorem 3.2", "Q4(b)")
 * where keyword match beats embeddings, and vice versa for paraphrased questions.
 */
export async function searchChunksHybrid(
  queryText: string,
  queryVector: number[],
  courseId?: string | null,
  limit: number = 5
): Promise<RetrievedChunk[]> {
  const db = await getDB();
  const vectorStr = formatVector(queryVector);
  const candidates = Math.max(20, limit * 4);

  const query = `
    WITH vec AS (
      SELECT fc.chunk_id, ROW_NUMBER() OVER (ORDER BY fc.embedding <=> $1::vector) AS rnk
      FROM file_chunks fc
      JOIN files f ON f.file_id = fc.file_id
      WHERE ($2::text IS NULL OR f.course_id = $2)
      ORDER BY fc.embedding <=> $1::vector
      LIMIT $4
    ),
    fts AS (
      SELECT fc.chunk_id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fc.content_tsv, q) DESC) AS rnk
      FROM file_chunks fc
      JOIN files f ON f.file_id = fc.file_id,
      websearch_to_tsquery('english', $3) q
      WHERE fc.content_tsv @@ q
        AND ($2::text IS NULL OR f.course_id = $2)
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
      fc.content,
      1 - (fc.embedding <=> $1::vector) AS similarity,
      fused.score AS fused_score,
      f.filename,
      f.display_name,
      f.file_id,
      f.course_id,
      f.source_type,
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
      WHERE mi.content_ref = f.file_id
      ORDER BY m.position ASC
      LIMIT 1
    ) m ON TRUE
    ORDER BY fused.score DESC, similarity DESC
    LIMIT $5;
  `;

  const res = await db.query(query, [vectorStr, courseId || null, queryText, candidates, limit]);

  return res.rows.map((row: any) => ({
    chunk_id: row.chunk_id,
    chunk_index: Number(row.chunk_index),
    page_number: row.page_number != null ? Number(row.page_number) : undefined,
    content: row.content,
    similarity: Number(row.similarity),
    filename: row.filename,
    display_name: row.display_name,
    file_id: row.file_id,
    course_id: row.course_id,
    course_name: row.course_name,
    module_name: row.module_name,
    source_type: row.source_type,
    html_url: row.html_url,
  }));
}

/**
 * Retrieves tracked documents (indexed or merely known) with their chunk status
 */
export async function getFilesList(courseId?: string): Promise<any[]> {
  const db = await getDB();
  let sql = 'SELECT * FROM files';
  const params: any[] = [];
  if (courseId) {
    sql += ' WHERE course_id = $1';
    params.push(String(courseId));
  }
  sql += ' ORDER BY total_chunks DESC, extracted_at DESC NULLS LAST, filename ASC';
  const res = await db.query(sql, params);
  return res.rows;
}

/**
 * Retrieves all chunks for a specific document (for inspection in UI)
 */
export async function getFileChunks(docId: string): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    'SELECT chunk_id, chunk_index, page_number, content, token_count FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC',
    [String(docId)]
  );
  return res.rows;
}
