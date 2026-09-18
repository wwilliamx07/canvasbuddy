# CanvasBuddy

CanvasBuddy is a personal AI agent for the University of Toronto's Quercus (Canvas). It runs entirely in a browser side panel — no backend — and answers questions about your courses, deadlines, documents, announcements and inbox using your own LLM API key.

## What it can do

- Answer "what's due this week / what am I missing" from your planner across all courses
- Find lectures, files and pages inside course modules — or on the course home page, where many courses keep them — and know what each course's nav bar offers (Piazza, lecture recordings…); list assignments with due dates, points and your submission status or grade
- Search inside PDFs, slides, wiki pages, assignment descriptions and inbox threads (semantic + keyword), citing the page or slide
- Read specific pages/slides of a document, or a whole message thread, verbatim
- Show recent announcements and inbox conversations
- Keep multiple chat threads locally
- Browse the local knowledge graph in the **Graph** tab: inspect courses, modules, items and indexed documents; force a refresh; index documents by hand

## How it works

**One source of knowledge, kept current on demand.** All seven agent tools read a local copy of your Canvas data stored in PGlite (Postgres compiled to WASM, with pgvector, persisted in IndexedDB). Before a tool reads a collection, a freshness engine decides whether that collection is missing, stale, or unchanged:

- each collection has a max age (TTL) you can edit in **Settings → Freshness**;
- within the TTL, collections that Canvas offers a cheap change check for (modules, announcements, inbox) are probed and updated only if something changed — e.g. only the modules whose item count moved are re-fetched, only inbox threads with a new message are re-read;
- past the TTL a full sync runs, which also catches deletions;
- collections a course hides from students (typically Files and Pages) are remembered as unavailable and not retried for a day.

The model never chooses between "live" and "cached" data and has no staleness rules; the only cache-related parameter is `refresh`, reserved for when you say something changed.

Canvas often hides a course's Files and Pages areas from students while everything stays reachable by direct link, so CanvasBuddy treats the course as a link graph: every page, description and announcement it reads has its links recorded, and the files and pages they point at become listable and indexable. Document text keeps those links as markers (`Syllabus [file 44541003]`) so the assistant can follow them.

Documents are indexed just in time: the first question about a file downloads it, extracts text per page/slide (small slides are grouped so each chunk has enough context, and every chunk remembers the page range it covers), embeds it (768-d) and stores chunks with a full-text index and an HNSW vector index; later questions hit the local index. When a document changes upstream, only the pages whose text actually changed are re-embedded. Inbox threads are stored as text when the inbox syncs (keyword-searchable for free) and embedded only when a semantic search targets that thread.

**Architecture**
- Manifest V3 extension for Chrome/Edge, opened as a side panel; Canvas is reached with your existing login session (no Canvas token)
- React 19 + TypeScript + Tailwind
- Gemini or OpenAI (and OpenAI-compatible endpoints) for chat and embeddings, with real function-call turns on both
- Chats and settings in localStorage; graph and vectors in PGlite/IndexedDB
- Hybrid retrieval: pgvector cosine similarity (HNSW index) fused with Postgres full-text search (reciprocal rank fusion)
- Assistant replies are rendered as sanitized Markdown (DOMPurify allowlist), since their text derives from content other people author on Canvas
- Context management: tool turns are persisted (capped) and older turns are summarized into digests when the configured token threshold is exceeded; the system prompt and tool schemas form a stable, cacheable prefix

For the full architecture reference see [`reference/`](reference/README.md). Agents and developers should read it before changing code (see `CLAUDE.md`).

## Build

```bash
cd extension
npm install
npm run build
```

Then load `extension/dist` as an unpacked extension (chrome://extensions → Developer mode → Load unpacked), open a Quercus tab so you are logged in, and click the toolbar icon to open the side panel. Enter your Gemini or OpenAI key in **Settings**.

Type-check with `npx tsc -p tsconfig.app.json --noEmit` from `extension/`.
