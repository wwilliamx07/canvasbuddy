# CanvasBuddy

## What it is

CanvasBuddy is an AI agent for Canvas that lives in your browser's side panel.

It works with any Canvas site. There is no server and no account to create. It uses the Canvas session you are already logged into, and you bring your own Gemini or OpenAI API key. Everything it learns stays in your browser.

## What it can do

Ask it things like:

- What do I have due this week? What am I missing?
- Where are the lecture 5 slides for my stats course?
- What did lecture 8 say about the central limit theorem?
- Summarise the grading scheme in the syllabus.
- Is the midterm open book? How long is the quiz and how many attempts do I get?
- What was the last announcement in my algorithms course?
- Did anyone on the forum ask about question 3 of the problem set?
- What did my TA say in their last message?
- Read me pages 4 to 6 of the week 2 notes.

CanvasBuddy seamlessly navigates, learns, answers, remembers.

## Design philosophy

A few ideas shape the design of CanvasBuddy.

**Local first.** There is no backend. The database, file index and the agent loop all run in the extension itself. Canvas is reached with the cookies your browser already has, so no Canvas token is stored anywhere. You bring your own API key, and own your data.

**Lazy by default.** Nothing is fetched or computed until something needs it. Courses are listed when you ask about them, a course's modules when it is explored, a document's text when it is first read or searched, an assignment's description on first access, a discussion's replies when a thread is opened. Embedding is the strictest case: no sync ever calls the embedding API, and a document is embedded only when a semantic search is about to look through it. This keeps first use fast and your API bill proportional to what you actually ask.

**Maximal caching, engine owned.** Everything the assistant reads comes from a local copy of your Canvas. The Canvas API is only hit when a freshness engine determines required information is missing or outdated. The model never works with the Canvas API directly.

**A minimal toolset.** Eight tools, each a thin read over the local graph, rather than one tool per Canvas endpoint. Less tools and ambiguity reduces hallucinations while maintaining functionality.

## Technical overview

**Persistent memory.** A Postgres database compiled to WebAssembly (PGlite, with pgvector) persisted in IndexedDB. It holds thin mirrors of Canvas listings (courses, modules and items, assignments and your submissions, pages, files, announcements, discussions, quizzes, planner, inbox), a link graph between them, document text and vectors, and a sync stamp per collection. Chats and settings live in localStorage.

**Freshness engine.** Before a tool reads a collection, the engine checks its stamp. Each collection has a maximum age you can edit in Settings. Within that age, collections Canvas offers a cheap change check for (modules, announcements, discussions, inbox, home page, syllabus) are probed and refetched only if something moved, and only the parts that moved. Past it, a full sync runs, which is also what catches deletions. Collections a course hides from students are remembered as unavailable and not retried for a day. Concurrent requests for the same collection share one fetch.

**Just in time indexing and hybrid search.** The first question about a document downloads it, extracts text per page or slide, groups small slides so every chunk has enough context, embeds the chunks (768 dimensions) and stores them with a full text index and an HNSW vector index. Search fuses vector similarity with Postgres full text ranking, because course material is full of exact tokens like "Theorem 3.2" where keywords win and paraphrased questions where embeddings win. Every chunk remembers the page range it covers, which the model cites instead of guessing. When a document changes upstream, only chunks whose text changed are re-embedded. Inbox and discussion threads are stored as text when they sync and embedded only when a semantic search targets them.

**Link markers.** Document text keeps its links as short markers, like `[file 44541003]` or `[page week-1]`, so the assistant can follow a link from the syllabus to the file it names, or give you the URL.

**Agent loop.** Supports Gemini and OpenAI models, and OpenAI compatible endpoints. Tool turns are persisted, capped, and summarised into digests when the conversation grows past your threshold.

**Rendering.** Replies are Markdown with LaTeX. Because their text derives from content other people wrote on Canvas, they are sanitised through an allowlist before they reach the page, and math is rendered by KaTeX after sanitising.

The full architecture reference is in [`reference/`](reference/README.md).

## Build and install

```bash
cd extension
npm install
npm run build
```

1. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `extension/dist`.
2. Open your Canvas site in a tab and sign in.
3. Click the CanvasBuddy icon in the toolbar. The side panel opens. A known Canvas connects on its own; any other site shows a **Grant access** button once.
4. Open Settings in the panel and paste your Gemini or OpenAI API key.