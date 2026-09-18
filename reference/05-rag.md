# 05 — RAG: indexing and hybrid search

Sources: `src/canvas/sync.ts` (`indexDocumentJustInTime`, `loadDocumentSource`, `buildChunkHeader`), `src/utils/textExtractor.ts`, `src/embeddings/embeddingClient.ts`, `src/db/rag.ts`.

## Design

Documents are indexed **just in time**, not in bulk: nothing is downloaded or embedded until the agent (or the user in the Graph Explorer) asks for a specific document. This is a rule, not an optimization: **no sync ever spends embedding calls**; vectors are computed only for a document a semantic search is about to look through. Indexing stores page-bound chunks with 768-d vectors and a full-text index in PGlite; search fuses vector and keyword ranking. Answers cite the document and page/slide range because every chunk records exactly which pages it covers.

Four document kinds live in the same tables (`DocumentSourceType = 'file' | 'page' | 'assignment' | 'conversation'`); the first three share the JIT pipeline below, inbox threads are indexed incrementally during the inbox sync:

| Kind | `source_id` | `docId` in `files` | Text source |
|---|---|---|---|
| Canvas file (PDF, PPTX) | file id | file id | download via `/files/:id/public_url`, parse |
| Wiki page | page slug | `page:<course>:<slug>` | `body` from `/courses/:id/pages/:slug` (falls back to `/front_page` for the front page), through `ingestHtml` → text with link markers; the page's links are recorded on every fetch |
| Assignment description | assignment id | `assignment:<id>` | `description` from `/courses/:id/assignments/:id` (also cached into `assignments.description`), through `ingestHtml` |
| Inbox thread | conversation id | `conversation:<id>` | messages from `/conversations/:id` during the inbox sync; one chunk per message, chunk id = message id, stored with a NULL vector. `embedConversationIfNeeded` (called by `search_documents` when it targets the thread) embeds only the messages still lacking a vector. |

Doc ids come from `docIdFor()` in `db/rag.ts`; nothing else builds them by hand.

## Pipeline: `indexDocumentJustInTime(target, settings)`

```
loadDocumentSource(target)         metadata fetched eagerly, text loader is lazy
  → getDocumentCacheState(docId)   {version, totalChunks, embeddingModel}
  → cache hit?  same version AND totalChunks > 0 AND same embedding model → return 'cached'
  → source.loadPages()             StructuredPage[] = [{pageNumber, text}]
  → chunkStructuredDocument(pages, 400 tokens, 50 overlap)
  → sha256(chunk.content) per chunk; getStoredEmbeddingsByHash(docId) if the stored model matches
  → buildChunkHeader()             "CSC236 · Week 3 · Lecture 5.pdf"
  → batchEmbed(header + " · slides 4-7\n" + chunk, task='document')   only chunks with no reusable vector
  → storeChunksWithEmbeddings()    upsert files row, DELETE old chunks, INSERT new (fresh or reused vectors)
```

Points worth knowing:

- **Cache key = upstream version + embedding model.** `version` is `modified_at || updated_at || size` for files, `updated_at` for pages/assignments. `embedding_model` is provider-qualified (`google/gemini-embedding-2`, `openai/text-embedding-3-small`) via `resolveEmbeddingModel`. Vectors from different models live in different spaces, so changing the model in Settings silently invalidates every document on next use.
- **Metadata before download.** `loadDocumentSource` fetches only what is needed to compute the cache key; the (possibly large) file download happens inside `loadPages`, after the cache check. File metadata goes through `fetchFileMetadata`, which tries `/courses/:c/files/:id` before `/files/:id` and turns a 403 into an error naming the likely causes (locked module/folder, unpublished).
- **Context header is embedded, not stored.** A slide fragment like "- O(n log n)" embeds poorly on its own, so the course code, containing module (looked up via `module_items.content_ref`), document title, and page label are prepended to the text that is embedded. The stored `content` is the raw chunk, so citations and display stay clean.
- **Re-index embeds only what changed.** Each chunk stores `content_hash` (SHA-256 of the stored text). When a document's version moves, chunks whose text is identical keep their stored vector; only new or modified chunks go to the embedding API. The hash deliberately excludes the context header and page label, so a renamed module or a shifted page number does not re-embed anything. Reuse requires the same `embedding_model`. `IndexResult.chunksEmbedded` reports how many were actually sent.
- **Chunking is page-bound, in both directions.** A page/slide up to 1.4× the target stays one chunk; longer pages are split by word count with overlap (line breaks survive the split). Runs of *small* pages — typical slides — are merged into one chunk while one side is under `minChunkTokens` (target/4) and the total stays within the target, so a 30-token slide is embedded with its neighbours' context. Every chunk carries `pageNumber..pageEnd`; a normal-sized page always keeps its own chunk and its own citation.

## Text extraction (`utils/textExtractor.ts`)

- **PDF** — `pdfjs-dist` with the worker bundled through Vite's `?url` import. Text items are joined with a space, or a newline where pdf.js sets `hasEOL`, so bullet lists and table rows keep their line structure; runs of whitespace are collapsed.
- **PPTX** — unzip with `jszip`, read `ppt/slides/slideN.xml`, extract `<a:t>` runs, sort numerically by N.
- **HTML** (pages, descriptions, announcements) — `htmlToTextWithLinks` (`utils/canvasLinks.ts`) first replaces every `<a>` / `<iframe>` with its text plus a marker (`[file 123]`, `[page slug]`, `[assignment 45]`, `<https://…>`), then `htmlToText`: `DOMParser`, drop `script/style`, turn block elements and `<br>` into newlines, collapse whitespace. The markers are part of the stored/embedded chunk text — a few tokens of noise, in exchange for excerpts the model can act on.
- Only `.pdf` and `.pptx` are supported for files; anything else throws.

## Embeddings (`embeddings/embeddingClient.ts`)

- Always 768 dimensions (`outputDimensionality` / `dimensions`) to match `VECTOR(768)` in the schema.
- Google: `:batchEmbedContents` in batches of 20, with `taskType` `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions (asymmetric retrieval improves ranking).
- OpenAI: `/embeddings` in batches of 50, results re-sorted by `index`. Honours `settings.baseUrl` for compatible providers.
- Uses the same API key and provider as chat; there is no separate embedding credential.

## Storage (`db/rag.ts`)

- `storeChunksWithEmbeddings` (files/pages/assignments) upserts the `files` row, deletes existing chunks for the doc, and inserts new ones with `page_end`, `content_hash`, `embedding = $::vector` (a fresh vector or a literal reused via `getStoredEmbeddingsByHash`) and `content_tsv = to_tsvector('english', content)`.
- `upsertDocumentChunksIncremental` (conversations) keys chunks by a stable id, inserts only new ones, always with a NULL vector; `getChunksMissingEmbedding` / `setChunkEmbeddings` fill vectors in when `embedConversationIfNeeded` runs.
- `upsertAndPruneKnownFiles` (files collection sync) registers files with `total_chunks = 0` and resets `total_chunks` to 0 when the version changed. The old chunks are **kept** as a vector cache for the next index but are invisible: every reader (`searchChunksHybrid`, `getFileChunks`, `getGraphStatistics`) filters on `files.total_chunks > 0`.
- Indexes: GIN on `content_tsv`; B-tree on `file_id`, `course_id`; **HNSW** (`vector_cosine_ops`) on `embedding`. The vector half of every search walks the HNSW index regardless of table size: `searchChunksHybrid` runs with `SET LOCAL enable_sort = off`, which makes the index's ordered scan the only cheap way to satisfy `ORDER BY embedding <=> q` (the keyword half still sorts, as it must). `hnsw.iterative_scan = relaxed_order` and a raised `hnsw.max_scan_tuples` (both set in `pglite.ts`) make a filtered scan — one course, or one document among thousands of chunks — keep walking the graph until the `LIMIT` is met instead of returning fewer rows. PGlite has no autovacuum launcher, so the chunk writers run `ANALYZE file_chunks` (milliseconds) after each write so the keyword half and the joins are planned from real statistics. HNSW inserts cost ~1 ms per vector, negligible next to the embedding call. Measured at 3k chunks: global 4 ms, one-course and one-document searches 7–16 ms.

## Search: `searchChunksHybrid(queryText, queryVector, courseId, limit, docId?)`

```
vec   = top-N chunks by cosine distance (embedding <=> query) via the HNSW index,
        optional course / document filter satisfied by iterative scan
fts   = top-N chunks by ts_rank_cd(content_tsv, websearch_to_tsquery(query)) where tsv @@ query
fused = SUM(1 / (60 + rank)) over vec ∪ fts, grouped by chunk        -- reciprocal rank fusion
result = fused ⋈ file_chunks ⋈ files ⋈ courses, plus ONE module name via LEFT JOIN LATERAL
         ORDER BY fused score DESC, cosine similarity DESC LIMIT limit
```

- N = `max(20, limit × 4)` candidates per ranker. `docId` restricts both rankers to one document. Chunks with a NULL vector take part in the keyword half only. Both rankers require `files.total_chunks > 0`.
- Rationale: course material is full of exact tokens ("Theorem 3.2", "Q4(b)") where keyword match beats embeddings, and paraphrased questions where embeddings win. RRF needs no score calibration between the two.
- The lateral join picks the first module (by position) that references the file so a file linked from several modules does not duplicate rows.
- Returned `similarity` is `1 − cosine distance`; the fused score is computed but not returned to the tool. Rows carry `page_number` and `page_end`; the tool reports `page_or_slide` as `4` or `"4-7"`.

## Callers

- Agent: `search_documents` (indexes the named document via `indexDocumentJustInTime` when `document_id` is given, then `getEmbedding(query)` + `searchChunksHybrid`), `read_document` (indexes if needed, then `getFileChunks(docId, pageRange)` — a chunk is returned when its page range overlaps the requested one).
- Inbox sync (`canvas/collections.ts`): stores thread messages as text; `embedConversationIfNeeded` embeds on first semantic search.
- Graph Explorer: the "Index for search" button on a selected file/page/assignment node calls the same `indexDocumentJustInTime`; `getFileChunks(docId)` shows stored chunks in the side panel.

## Extending

- New file type → add a branch in `extractStructuredFromFile` returning `StructuredPage[]`.
- New document kind → add to `DocumentSourceType` and `docIdFor`, a branch in `loadDocumentSource` returning a `DocumentSource` (version, lazy `loadPages`), and an `indexed` LEFT JOIN in the matching `exploreGraph` entity.
- Changing vector dimensions requires a schema migration (`VECTOR(768)` is fixed) and re-indexing everything.
