# CanvasBuddy — Architecture Reference

This folder is the map of the project for developers and agents. Each document covers one subsystem at a level that explains *what it is, why it is shaped that way, and where the boundaries are* — not every function. Read `01-overview.md` first; the rest can be read in any order.

| Doc | Covers | Primary source files |
|---|---|---|
| [01-overview.md](01-overview.md) | What the product is, runtime environment, build, directory layout, data-flow diagram | `manifest.json`, `vite.config.ts`, `src/main.tsx`, `src/background.ts` |
| [02-agent-loop.md](02-agent-loop.md) | Conversation model, provider adapters (Gemini/OpenAI), the tool-calling loop, persisted tool turns, digests and thresholds | `src/App.tsx` |
| [03-tools.md](03-tools.md) | The 8 graph-backed tools, the "kept current on demand" rule, document ids, the system prompt, how to add a tool | `src/agent/tools.ts`, `src/agent/prompt.ts` |
| [04-knowledge-graph.md](04-knowledge-graph.md) | PGlite database, schema, graph queries, sync + prune semantics, the freshness engine (`ensureCollection`, `sync_state`, TTLs, probes, unavailable collections) | `src/db/pglite.ts`, `src/db/schema.ts`, `src/db/graph.ts`, `src/canvas/freshness.ts`, `src/canvas/collections.ts` |
| [05-rag.md](05-rag.md) | Document indexing pipeline, chunking, embeddings, hybrid search | `src/canvas/sync.ts`, `src/db/rag.ts`, `src/embeddings/embeddingClient.ts`, `src/utils/textExtractor.ts` |
| [06-canvas-api.md](06-canvas-api.md) | How the extension authenticates to Canvas, endpoints used, pagination, response shapes | `src/canvas/http.ts`, `src/canvas/collections.ts`, `src/canvas/sync.ts`, `src/types/canvas.ts` |
| [07-ui.md](07-ui.md) | React component tree, state ownership, persistence in localStorage, Graph Explorer | `src/components/**`, `src/App.tsx` |
| [08-conventions-and-gotchas.md](08-conventions-and-gotchas.md) | Non-obvious constraints you must know before changing things | — |

## One-paragraph summary

CanvasBuddy is a Manifest V3 Chrome side-panel extension that runs an LLM agent over a student's Canvas (Quercus, University of Toronto) account. Everything runs client-side: the React UI, a Postgres-in-WASM database (PGlite + pgvector, persisted in IndexedDB) that holds a local knowledge graph of courses/modules/assignments/files/pages plus a vector index of document text, and the agent loop that calls Gemini or OpenAI with the user's own API key. Canvas is reached with the browser's existing session cookies. The agent's eight tools all read the local graph; a freshness engine (per-collection TTLs, cheap change probes where Canvas offers one, per-course "unavailable" tracking) brings each collection up to date before it is read, so the model never decides between live and cached data.

## Keeping this reference current

When a change alters a boundary described here (a new tool, a schema migration, a new provider, a new persistence location), update the relevant doc in the same commit. Line numbers are deliberately avoided; file names and identifiers are used instead so the docs survive refactors.
