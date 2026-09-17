# 05 — RAG: indexing and hybrid search

Sources: `src/canvas/sync.ts` (`indexDocumentJustInTime`, `loadDocumentSource`, `buildChunkHeader`), `src/utils/textExtractor.ts`, `src/embeddings/embeddingClient.ts`, `src/db/rag.ts`.

## Design

Documents are indexed **just in time**, not in bulk: nothing is downloaded or embedded until the agent (or the user in the Graph Explorer) asks for a specific document. Indexing stores per-page/slide chunks with 768-d vectors and a full-text index in PGlite; search fuses vector and keyword ranking. Answers cite the document and page/slide because chunk boundaries never cross a page.

Four document kinds live in the same tables (`DocumentSourceType = 'file' | 'page' | 'assignment' | 'conversation'`); the first three share the JIT pipeline below, inbox threads are indexed incrementally during the inbox sync:

| Kind | `source_id` | `docId` in `files` | Text source |
|---|---|---|---|
| Canvas file (PDF, PPTX) | file id | file id | download via `/files/:id/public_url`, parse |
| Wiki page | page slug | `page:<course>:<slug>` | `body` from `/courses/:id/pages/:slug`, `htmlToText` |
| Assignment description | assignment id | `assignment:<id>` | `description` from `/courses/:id/assignments/:id` (also cached into `assignments.description`), `htmlToText` |
| Inbox thread | conversation id | `conversation:<id>` | messages from `/conversations/:id` during the inbox sync; one chunk per message, chunk id = message id, `upsertDocumentChunksIncremental` inserts and embeds only new messages |

Doc ids come from `docIdFor()` in `db/rag.ts`; nothing else builds them by hand.

## Pipeline: `indexDocumentJustInTime(target, settings)`

```
loadDocumentSource(target)         metadata fetched eagerly, text loader is lazy
  → getDocumentCacheState(docId)   {version, totalChunks, embeddingModel}
  → cache hit?  same version AND totalChunks > 0 AND same embedding model → return 'cached'
  → source.loadPages()             StructuredPage[] = [{pageNumber, text}]
  → chunkStructuredDocument(pages, 400 tokens, 50 overlap)
  → buildChunkHeader()             "CSC236 · Week 3 · Lecture 5.pdf"
  → batchEmbed(header + " · slide N\n" + chunk, task='document')
  → storeChunksWithEmbeddings()    upsert files row, DELETE old chunks, INSERT new
```

Points worth knowing:

- **Cache key = upstream version + embedding model.** `version` is `modified_at || updated_at || size` for files, `updated_at` for pages/assignments. `embedding_model` is provider-qualified (`google/gemini-embedding-2`, `openai/text-embedding-3-small`) via `resolveEmbeddingModel`. Vectors from different models live in different spaces, so changing the model in Settings silently invalidates every document on next use.
- **Metadata before download.** `loadDocumentSource` fetches only what is needed to compute the cache key; the (possibly large) file download happens inside `loadPages`, after the cache check. File metadata goes through `fetchFileMetadata`, which tries `/courses/:c/files/:id` before `/files/:id` and turns a 403 into an error naming the likely causes (locked module/folder, unpublished).
- **Context header is embedded, not stored.** A slide fragment like "- O(n log n)" embeds poorly on its own, so the course code, containing module (looked up via `module_items.content_ref`), document title, and page label are prepended to the text that is embedded. The stored `content` is the raw chunk, so citations and display stay clean.
- **Chunking is page-bound.** A page/slide up to 1.4× the target stays one chunk; longer pages are split by word count with overlap. Slides therefore often become small chunks.

## Text extraction (`utils/textExtractor.ts`)

- **PDF** — `pdfjs-dist` with the worker bundled through Vite's `?url` import. Text items per page are joined with spaces (`hasEOL` is not used, so line breaks are lost).
- **PPTX** — unzip with `jszip`, read `ppt/slides/slideN.xml`, extract `<a:t>` runs, sort numerically by N.
- **HTML** (pages, descriptions) — `DOMParser`, drop `script/style`, turn block elements and `<br>` into newlines, collapse whitespace.
- Only `.pdf` and `.pptx` are supported for files; anything else throws.

## Embeddings (`embeddings/embeddingClient.ts`)

- Always 768 dimensions (`outputDimensionality` / `dimensions`) to match `VECTOR(768)` in the schema.
- Google: `:batchEmbedContents` in batches of 20, with `taskType` `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions (asymmetric retrieval improves ranking).
- OpenAI: `/embeddings` in batches of 50, results re-sorted by `index`. Honours `settings.baseUrl` for compatible providers.
- Uses the same API key and provider as chat; there is no separate embedding credential.

## Storage (`db/rag.ts`)

- `storeChunksWithEmbeddings` (files/pages/assignments) upserts the `files` row, deletes existing chunks for the doc, and inserts new ones with `embedding = $::vector` and `content_tsv = to_tsvector('english', content)`. Every chunk is re-embedded on re-index (per-chunk hash reuse is plan.md Tier 3 #9).
- `upsertDocumentChunksIncremental` (conversations) keys chunks by a stable id, inserts only new ones, keeps a NULL vector when no API key is configured, and `getChunksMissingEmbedding` / `setChunkEmbeddings` fill vectors in on a later sync.
- `upsertAndPruneKnownFiles` (files collection sync) registers files with `total_chunks = 0`, resets chunks to 0 if the version changed, and deletes the stale chunks so an outdated version is not searchable.
- Indexes: GIN on `content_tsv`; B-tree on `file_id`, `course_id`. There is no HNSW/IVF index on `embedding`; vector search is a sequential scan, acceptable at a student's scale (thousands of chunks).

## Search: `searchChunksHybrid(queryText, queryVector, courseId, limit, docId?)`

```
vec   = top-N chunks by cosine distance (embedding <=> query), optional course filter
fts   = top-N chunks by ts_rank_cd(content_tsv, websearch_to_tsquery(query)) where tsv @@ query
fused = SUM(1 / (60 + rank)) over vec ∪ fts, grouped by chunk        -- reciprocal rank fusion
result = fused ⋈ file_chunks ⋈ files ⋈ courses, plus ONE module name via LEFT JOIN LATERAL
         ORDER BY fused score DESC, cosine similarity DESC LIMIT limit
```

- N = `max(20, limit × 4)` candidates per ranker. `docId` restricts both rankers to one document. Chunks with a NULL vector take part in the keyword half only.
- Rationale: course material is full of exact tokens ("Theorem 3.2", "Q4(b)") where keyword match beats embeddings, and paraphrased questions where embeddings win. RRF needs no score calibration between the two.
- The lateral join picks the first module (by position) that references the file so a file linked from several modules does not duplicate rows.
- Returned `similarity` is `1 − cosine distance`; the fused score is computed but not returned to the tool.

## Callers

- Agent: `search_documents` (indexes the named document via `indexDocumentJustInTime` when `document_id` is given, then `getEmbedding(query)` + `searchChunksHybrid`), `read_document` (indexes if needed, then `getFileChunks(docId, pageRange)`).
- Inbox sync (`canvas/collections.ts`): stores and embeds thread messages.
- Graph Explorer: the "Index for search" button on a selected file/page/assignment node calls the same `indexDocumentJustInTime`; `getFileChunks(docId)` shows stored chunks in the side panel.

## Extending

- New file type → add a branch in `extractStructuredFromFile` returning `StructuredPage[]`.
- New document kind → add to `DocumentSourceType` and `docIdFor`, a branch in `loadDocumentSource` returning a `DocumentSource` (version, lazy `loadPages`), and an `indexed` LEFT JOIN in the matching `exploreGraph` entity.
- Changing vector dimensions requires a schema migration (`VECTOR(768)` is fixed) and re-indexing everything.
