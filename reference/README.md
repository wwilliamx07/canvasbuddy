# CanvasBuddy — Architecture Reference

This folder is the map of the project for developers and agents. Each document covers one subsystem at a level that explains *what it is, why it is shaped that way, and where the boundaries are* — not every function. Read `01-overview.md` first; the rest can be read in any order.

| Doc | Covers | Primary source files |
|---|---|---|
| [01-overview.md](01-overview.md) | What the product is, runtime environment, build, Chrome vs Firefox builds, directory layout, data-flow diagram | `manifest.json`, `vite.config.ts`, `src/main.tsx`, `src/background.ts` |
| [02-agent-loop.md](02-agent-loop.md) | Conversation model, providers (registry, adapters for Gemini / OpenAI Responses / Anthropic / OpenAI-compatible, model catalogue), the tool-calling loop, persisted tool turns, digests and thresholds, token usage, composer commands | `src/agent/{run,digest,history}.ts`, `src/chats.ts`, `src/App.tsx`, `src/providers/*`, `src/commands.ts` |
| [03-tools.md](03-tools.md) | The 8 graph-backed tools (+ `find_connection_tools`), the "kept current on demand" rule, document ids, the system prompt, how to add a tool | `src/agent/tools.ts`, `src/agent/prompt.ts` |
| [04-knowledge-graph.md](04-knowledge-graph.md) | PGlite database, schema, graph queries, sync + prune semantics, the freshness engine (`ensureCollection`, `sync_state`, TTLs, probes, unavailable collections) | `src/db/pglite.ts`, `src/db/schema.ts`, `src/db/graph.ts`, `src/canvas/freshness.ts`, `src/canvas/collections.ts` |
| [05-rag.md](05-rag.md) | Document indexing pipeline, chunking, embeddings, hybrid search | `src/canvas/sync.ts`, `src/db/rag.ts`, `src/embeddings/embeddingClient.ts`, `src/utils/textExtractor.ts` |
| [06-canvas-api.md](06-canvas-api.md) | How the extension authenticates to Canvas, endpoints used, pagination, response shapes | `src/canvas/http.ts`, `src/canvas/collections.ts`, `src/canvas/sync.ts`, `src/types/canvas.ts` |
| [07-ui.md](07-ui.md) | The `AppModel` seam, component tree, connection/chat/memory/settings surfaces, the engine-managed-memory rule, styling | `src/ui/**`, `src/App.tsx` |
| [08-conventions-and-gotchas.md](08-conventions-and-gotchas.md) | Non-obvious constraints you must know before changing things | — |
| [09-connections.md](09-connections.md) | Remote MCP servers as connections: Streamable HTTP client, OAuth, permissions, connection tools and approval | `src/connections/*`, `src/ui/useConnections.ts`, `src/ui/Connections.tsx` |

## One-paragraph summary

CanvasBuddy is a Manifest V3 browser extension (Chrome side panel; Firefox sidebar from the same source) that runs an LLM agent over a student's Canvas account (built against Quercus at the University of Toronto; any Canvas can be connected). Everything runs client-side: the React UI, a Postgres-in-WASM database (PGlite + pgvector, persisted in IndexedDB) that holds a local knowledge graph of courses/modules/assignments/files/pages plus a vector index of document text, and the agent loop that calls the student's chosen model provider (Gemini, OpenAI, Anthropic, an OpenAI-compatible service or a local server) with their own API key. Canvas is reached with the browser's existing session cookies. The agent's eight Canvas tools all read the local graph; a freshness engine (per-collection TTLs, cheap change probes where Canvas offers one, per-course "unavailable" tracking) brings each collection up to date before it is read, so the model never decides between live and cached data. Other services (Notion, or Google Calendar through an aggregator) come from remote MCP servers the student connects.

## Keeping this reference current

When a change alters a boundary described here (a new tool, a schema change, a new provider, a new persistence location), update the relevant doc in the same commit. Line numbers are deliberately avoided; file names and identifiers are used instead so the docs survive refactors.
