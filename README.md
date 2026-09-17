# CanvasBuddy

CanvasBuddy is your personal AI agent for the University of Toronto's quercus. CanvasBuddy can help you with all tasks related to quercus, from summarizing documents, to planning your week.

## What it can do

- List your active courses and course details
- Show upcoming assignments, planner items, and assignment details
- Browse course modules and module items
- Check announcements and recent course activity
- Review conversations/messages in Canvas
- Extract text from PDF and PowerPoint files uploaded to Canvas
- Keep multiple chat threads locally in the browser
- Maintain a local knowledge graph of your courses (modules, items, assignments) that the agent explores first and re-syncs from Canvas when stale, pruning deleted items
- Hybrid (keyword + semantic) search over course content: PDFs/slides, wiki pages, and assignment descriptions are chunked and embedded on demand into a client-side vector database, and answers cite the page or slide
- Browse the graph in the **Graph** tab: inspect nodes, trigger syncs, and index files for search

## Technical Overview

**Architecture:**
- Browser extension (Manifest v3) for Chrome/Edge, opened as a side panel, integrated with Canvas (Quercus)
- React 19 frontend with TypeScript, styled with Tailwind CSS
- Supports Google AI (Gemini) and OpenAI APIs, with tool calling on both
- Chats and settings persisted in localStorage; course graph and vector chunks in PGlite (Postgres compiled to WASM, with pgvector) stored in IndexedDB — no backend
- Embeddings via `gemini-embedding-2` or `text-embedding-3-small` (768 dimensions, configurable in Settings)
- Tools for Canvas API access, graph exploration/sync, PDF/PPTX/HTML extraction, and hybrid vector + full-text search
- The system prompt carries a live summary of what is cached and how old it is, so the agent answers from the local graph and only calls Canvas for missing, stale, or uncached data (submissions, grades, announcements, messages)

**Context Optimization:**
- Context-size-based compression: older conversation segments are automatically summarized when context exceeds the configured token threshold
- Tool-loop digests: model summarizes what it learned after each tool-call sequence

## Build:

```bash
cd extension
npm run build
```

Then load `extension/dist` as an unpacked extension (chrome://extensions → Developer mode → Load unpacked). Click the toolbar icon to open the side panel.