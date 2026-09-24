# 05 — RAG: indexing and hybrid search

Sources: `src/canvas/sync.ts` (`indexDocumentJustInTime`, `loadDocumentSource`, `buildChunkHeader`), `src/utils/textExtractor.ts`, `src/embeddings/embeddingClient.ts`, `src/db/rag.ts`.

## Design

Documents are indexed **just in time**, not in bulk: nothing is downloaded or embedded until the agent asks for a specific document (the user cannot trigger indexing; the Memory sheet only shows what was read). This is a rule, not an optimization: **no sync ever spends embedding calls**; vectors are computed only for a document a semantic search is about to look through. Indexing stores page-bound chunks with 768-d vectors and a full-text index in PGlite; search fuses vector and keyword ranking. Answers cite the document and page/slide range because every chunk records exactly which pages it covers.

Six document kinds live in the same tables (`DocumentSourceType = 'file' | 'page' | 'assignment' | 'conversation' | 'discussion' | 'syllabus'`); files, pages, assignments and the syllabus share the JIT pipeline below, while inbox and discussion threads are stored incrementally as entries:

| Kind | `sourceId` | `docId` in `files` | Text source |
|---|---|---|---|
| Canvas file (PDF, PPTX, DOCX, any text file) | file id | file id | download from `/files/:id/public_url`, falling back to the file's own `url` on the Canvas host (with the session) when the signed CDN link is refused; parse (see Text extraction) |
| Wiki page | page slug | `page:<course>:<slug>` | `body` from `/courses/:id/pages/:slug` (falls back to `/front_page` for the front page), through `ingestHtml` → text with link markers; the page's links are recorded on every fetch |
| Assignment description | assignment id | `assignment:<id>` | `description` from `/courses/:id/assignments/:id`, through `ingestHtml` at fetch time (the text is cached into `assignments.description`) |
| Syllabus | course id | `syllabus:<course>` | `courses.syllabus_body`, already text with link markers — the `syllabus` collection ran the body through `ingestHtml` when it stored it (the tool ensures it first) |
| Discussion thread | discussion id | `discussion:<id>` | `/courses/:c/discussion_topics/:id/view`, fetched by `ensureDiscussionThread` when the topic's `last_reply_at` moved; chunk 0 = the topic, then one chunk per reply ("author (date) replying to X: text"), keyed by entry id, NULL vector. Reply HTML keeps its links as markers (`htmlToTextWithLinks`), and the replies' links are recorded as one `discussion_replies` source per topic, so a file posted in a reply becomes listable. `embedDiscussionIfNeeded` embeds on first semantic search. |
| Inbox thread | conversation id | `conversation:<id>` | messages from `/conversations/:id` during the inbox sync; one chunk per message, chunk id = message id, stored with a NULL vector. `embedConversationIfNeeded` (called by `search_documents` when it targets the thread) embeds only the messages still lacking a vector. |

Doc ids come from `docIdFor()` in `db/rag.ts`; nothing else in TypeScript builds them (the SQL joins in `graph.ts` mirror the formats, see `08-conventions-and-gotchas.md`).

## Pipeline: `indexDocumentJustInTime(target, settings)`

```
loadDocumentSource(target)         metadata fetched eagerly, text loader is lazy
  → getDocumentCacheState(docId)   {version, totalChunks, embeddingModel}
  → cache hit?  same version AND totalChunks > 0 AND same embedding model → return 'cached'
  → source.loadPages()             StructuredPage[] = [{pageNumber, text}]
  → chunkStructuredDocument(pages, 400 tokens, 50 overlap)
  → sha256(chunk.content) per chunk; getStoredEmbeddingsByHash(docId) if the stored model matches
  → buildChunkHeader()             "CSC236 · Week 3 · Lecture 5.pdf" (getDocumentContext in db/graph.ts)
  → batchEmbed(header + " · slides 4-7\n" + chunk, task='document')   only chunks with no reusable vector
  → storeChunksWithEmbeddings()    upsert files row, DELETE old chunks, INSERT new (fresh or reused vectors)
```

Points worth knowing:

- **Cache key = upstream version + embedding model.** `version` is `modified_at || updated_at || size` for files, `updated_at` for pages/assignments, the stored fingerprint for the syllabus. `embedding_model` is provider-qualified (`<embedding provider>/<model>`, e.g. `google/gemini-embedding-2`, `ollama/nomic-embed-text`) via `resolveEmbeddingModel`. Vectors from different models live in different spaces, so after a model change in Settings a document is re-embedded the next time a search or read targets it; until then the vector half of search skips it (`embeddingModel` filter, see Search) and it is found by keyword only. A thread document is re-embedded whole the first time a semantic search targets it under the new model (`chunksToEmbed`).
- **Metadata before download.** `loadDocumentSource` fetches only what is needed to compute the cache key; the (possibly large) file download happens inside `loadPages`, after the cache check. File metadata goes through `fetchFileMetadata`, which tries `/courses/:c/files/:id` before `/files/:id` and turns a 403 into an error naming the likely causes (locked module/folder, unpublished).
- **Context header is embedded, not stored.** A slide fragment like "- O(n log n)" embeds poorly on its own, so the course code, containing module (looked up via `module_items.content_ref`), document title, and page label are prepended to the text that is embedded. The stored `content` is the raw chunk, so citations and display stay clean.
- **Re-index embeds only what changed.** Each chunk stores `content_hash` (SHA-256 of the stored text). When a document's version moves, chunks whose text is identical keep their stored vector; only new or modified chunks go to the embedding API. The hash deliberately excludes the context header and page label, so a renamed module or a shifted page number does not re-embed anything. Reuse requires the same `embedding_model`. `IndexResult.chunksEmbedded` reports how many were actually sent.
- **Chunking is page-bound, in both directions.** A page/slide up to 1.4× the target stays one chunk; longer pages are split by word count with overlap (line breaks survive the split). Runs of *small* pages — typical slides — are merged into one chunk while one side is under `minChunkTokens` (target/4) and the total stays within the target, so a 30-token slide is embedded with its neighbours' context. Every chunk carries `pageNumber..pageEnd`; a normal-sized page always keeps its own chunk and its own citation.

## Text extraction (`utils/textExtractor.ts`)

- **PDF** — `pdfjs-dist` with the worker bundled through Vite's `?url` import; the loading task is destroyed after extraction so the worker does not keep every document the panel has read. Text items are joined with a space, or a newline where pdf.js sets `hasEOL`, so bullet lists and table rows keep their line structure; runs of whitespace are collapsed.
- **PPTX** — unzip with `jszip`, read `ppt/slides/slideN.xml` and parse it as XML (entities decoded), one line per DrawingML paragraph (`a:p`) with its runs (`a:t`) joined as written, slides sorted numerically by N.
- **DOCX** — unzip with `jszip`, walk `word/document.xml` in order: each `w:p` becomes a paragraph (runs joined, `w:tab` → tab, `w:br` → newline), each `w:tbl` becomes tab-separated rows. Word has no page boundaries, so *sections* are synthetic: a new one at every `Heading1`/`Heading2` paragraph style, or every ~1,500 words when the document has no headings. Headers, footers and footnotes are ignored. Element names are matched without their namespace prefix (`xmlName`) because DOM implementations differ on whether `localName` keeps it.
- **Everything else is text.** Any file that is not PDF/PPTX/DOCX is decoded as UTF-8 (BOM stripped, CRLF normalised) and cut into ~1,500-word sections at line boundaries — source code, Markdown, CSV, notebooks (as raw JSON), HTML files (tags and all). Before decoding, a NUL byte in the first 8 KB or more than 5 % invalid sequences in the decoded sample rejects the file as binary with a clear error (`.xlsx`, `.doc`, images, media); there is no extension allow-list.
- **Page kind.** `pageKindFor(filename)` says what `page_number` counts — `page` (PDF), `slide` (PPTX), `section` (everything else) — and is stored in `files.page_kind` so `search_documents` (`unit`), `read_document` (`[section 3]`, `unit`) and the Memory sheet label chunks with a thing the document actually has. Wiki pages, assignment descriptions and the syllabus are one `page`.
- **HTML** (pages, descriptions, announcements) — `htmlToTextWithLinks` (`utils/canvasLinks.ts`) first replaces every `<a>` / `<iframe>` with its text plus a marker (`[file 123]`, `[page slug]`, `[assignment 45]`, `<https://…>`), then `htmlToText`: `DOMParser`, drop `script/style`, turn block elements and `<br>` into newlines, collapse whitespace. The markers are part of the stored/embedded chunk text — a few tokens of noise, in exchange for excerpts the model can act on.

## Embeddings (`embeddings/embeddingClient.ts` → `providers/`)

- `batchEmbed` / `getEmbedding` call `embedTexts`, which uses **the embeddings provider and model chosen in Settings** (`settings.embedding`), independent of the chat provider; the key comes from that provider's entry in `settings.providers`. Providers with an embeddings API: Google, OpenAI, Ollama, LM Studio and a custom OpenAI-compatible server (Anthropic, OpenRouter, Groq and DeepSeek have none).
- Always 768 dimensions to match `VECTOR(768)`: Gemini is asked with `outputDimensionality`, OpenAI with `dimensions`; other servers are not asked (they may reject the field) and every adapter's vectors pass `assertDimensions`, which fails with the model's name if they are not 768-d. Known 768-d models (`isKnown768Embedding`, e.g. `nomic-embed-text`) only drive a Settings hint.
- Gemini: `:batchEmbedContents` in batches of 20, with `taskType` `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions (asymmetric retrieval improves ranking). OpenAI-style: `/embeddings` in batches of 50, results re-sorted by `index`. See `02-agent-loop.md` → Providers.

## Storage (`db/rag.ts`)

- `storeChunksWithEmbeddings` (files/pages/assignments) runs in one transaction — the row claims the document is indexed only if every chunk made it in — and upserts the `files` row, deletes existing chunks for the doc, and inserts new ones with `page_end`, `content_hash`, `embedding = $::vector` (a fresh vector or a literal reused via `getStoredEmbeddingsByHash`) and `content_tsv = to_tsvector('english', content)`.
- `upsertDocumentChunksIncremental` (conversations, discussions) keys chunks by a stable id: new ones are inserted with a NULL vector, an entry whose text changed is updated and loses its vector, unchanged ones keep theirs; with `pruneMissing` (discussions pass the complete tree) entries no longer present are deleted. `chunksToEmbed` / `setChunkEmbeddings` fill vectors in when `embedThreadIfNeeded` runs; `chunksToEmbed` first drops every vector of the thread when `files.embedding_model` names another model, so a thread never holds vectors of two models.
- `upsertAndPruneKnownFiles` (files collection sync) registers files with `total_chunks = 0` and resets `total_chunks` to 0 when the version changed. The old chunks are **kept** as a vector cache for the next index but are invisible: every reader (`searchChunksHybrid`, `getFileChunks`, `getGraphStatistics`) filters on `files.total_chunks > 0`.
- Indexes: GIN on `content_tsv`; B-tree on `file_id`, `course_id`; **HNSW** (`vector_cosine_ops`) on `embedding`. The vector half of every search walks the HNSW index regardless of table size: `searchChunksHybrid` runs with `SET LOCAL enable_sort = off`, which makes the index's ordered scan the only cheap way to satisfy `ORDER BY embedding <=> q` (the keyword half still sorts, as it must). `hnsw.iterative_scan = relaxed_order` and a raised `hnsw.max_scan_tuples` (both set in `pglite.ts`) make a filtered scan — one course, or one document among thousands of chunks — keep walking the graph until the `LIMIT` is met instead of returning fewer rows. PGlite has no autovacuum launcher, so the chunk writers run `ANALYZE file_chunks` (milliseconds) after each write so the keyword half and the joins are planned from real statistics.

## Search: `searchChunksHybrid(queryText, queryVector, { courseId?, docId?, limit?, embeddingModel? })`

```
vec   = top-N chunks by cosine distance (embedding <=> query) via the HNSW index,
        optional course / document filter satisfied by iterative scan
fts   = top-N chunks by ts_rank_cd(content_tsv, websearch_to_tsquery(query)) where tsv @@ query
fused = SUM(1 / (60 + rank)) over vec ∪ fts, grouped by chunk        -- reciprocal rank fusion
result = fused ⋈ file_chunks ⋈ files ⋈ courses, plus ONE module name via LEFT JOIN LATERAL
         ORDER BY fused score DESC, cosine similarity DESC LIMIT limit
```

- N = `max(20, limit × 4)` candidates per ranker. `docId` restricts both rankers to one document, and then `courseId` is ignored (the document is the scope; a thread or linked file may carry another course, or none). Chunks with a NULL vector take part in the keyword half only. Both rankers require `files.total_chunks > 0`.
- `embeddingModel` (the model the query vector came from; `search_documents` always passes it) restricts the vector half to documents whose `files.embedding_model` matches. A document embedded by an earlier model still takes part in the keyword half until a search or read targets it and re-indexes it.
- Rationale: course material is full of exact tokens ("Theorem 3.2", "Q4(b)") where keyword match beats embeddings, and paraphrased questions where embeddings win. RRF needs no score calibration between the two.
- The lateral join picks the first module (by position) that references the file so a file linked from several modules does not duplicate rows.
- Returned `similarity` is `1 − cosine distance`; the fused score is computed but not returned to the tool. Rows carry `page_number` and `page_end`; the tool reports `page_or_slide` as `4` or `"4-7"`.

## Callers

- Agent: `search_documents` (indexes the named document via `indexDocumentJustInTime` when `document_id` is given, then `getEmbedding(query)` + `searchChunksHybrid`), `read_document` (indexes if needed, then `getFileChunks(docId, pageRange)` — a chunk is returned when its page range overlaps the requested one).
- Inbox sync (`canvas/collections.ts`): stores thread messages as text; `embedConversationIfNeeded` embeds on first semantic search. Discussions: `ensureDiscussionThread` stores the reply tree when read; `embedDiscussionIfNeeded` embeds on first semantic search.
- Memory sheet: `getFileChunks(docId)` previews a selected node's chunks; "Forget text" calls `forgetDocument(docId)`, which deletes the document's chunks (the vector cache goes with them — forgetting is the one case where kept vectors are dropped on purpose) and sets `total_chunks = 0`, so the row stays a known document and the next search or read re-indexes it from scratch.

## Extending

- New structured file type → add a branch in `extractStructuredFromFile` returning `StructuredPage[]` and a `PageKind` for it in `pageKindFor` (the text fallback already covers anything that decodes as UTF-8).
- New document kind → add to `DocumentSourceType` and `docIdFor`, a branch in `loadDocumentSource` returning a `DocumentSource` (version, lazy `loadPages`), and an `indexed` LEFT JOIN in the matching `exploreGraph` entity.
- Changing vector dimensions means changing `VECTOR(768)` in the schema (so every database must be recreated) and the adapters' requested dimensions and `assertDimensions`.
