# CanvasBuddy — instructions for agents

## Read the reference before touching code

This project has an architecture reference in `reference/`. **Before editing any file under `extension/src`, read `reference/README.md` and the doc for the subsystem you are changing.** The docs explain why the code is shaped the way it is; several constraints (database lock, destructive prune, id conventions, Gemini signature replay, CSP/Vite requirements) are invisible at the call site and easy to break.

Minimum reading per task:

| Touching… | Read first |
|---|---|
| anything | `reference/README.md`, `reference/08-conventions-and-gotchas.md` |
| `src/App.tsx`, `src/agent/{run,digest,history}.ts`, `src/chats.ts`, `src/providers/*`, `src/commands.ts` | `reference/02-agent-loop.md` |
| `src/agent/{tools,prompt}.ts` | `reference/03-tools.md` |
| `src/db/*`, `src/canvas/{sync,freshness,collections,http}.ts` | `reference/04-knowledge-graph.md` |
| indexing, chunking, embeddings, search | `reference/05-rag.md` |
| Canvas fetches, endpoints, auth | `reference/06-canvas-api.md` |
| `src/ui/*` | `reference/07-ui.md` |
| `src/connections/*`, connection tools | `reference/09-connections.md` |
| `extension/test/*` | `reference/01-overview.md` → Tests, `reference/08-conventions-and-gotchas.md` → Tests |

## Keep the reference true

If a change alters something the reference describes — a tool added/removed/changed, a schema change, a new doc id convention, a new provider, a new persistence location, a changed prompt rule — **update the relevant `reference/*.md` in the same commit.** Do not leave the docs describing behaviour that no longer exists.

## Planned work

`plan.md` (git-ignored, repo root) holds the current review findings and the ranked improvement plan. Check it before proposing changes so you don't re-derive or contradict decisions already made. Items there are proposals until the user confirms them.

`tmp/` (git-ignored) holds scratch material: the standalone React mockups the UI was ported from (`tmp/mockups/`, written against `tmp/mockups/src/shared/model.ts`), Canvas API probe scripts, and notes.

## Hard rules

- Do not spawn subagents on your own. Delegate only when the user explicitly asks for it in the current request.
- Do not touch the root `README.md` unless the user explicitly asks for it in the current request. "Keep the reference true" applies to `reference/*.md`, not the README.
- Do not push. Commit when asked; pushing happens only when the user says "push" in the current request — "commit" alone never implies it.
- Do not change code without the user's confirmation when the change alters the tool contract, the schema, or the system prompt.
- Do not remove the PGlite Web Lock, the `'wasm-unsafe-eval'` CSP, `optimizeDeps.exclude` for PGlite, or the `?url` pdf.js worker import.
- Never call a sync/prune function with a partial list.
- Tools reach Canvas through `ensureCollection` (freshness engine), never by fetching collection data directly. No staleness/"go live" language in the prompt or tool descriptions.
- Memory is engine-managed: nothing under `src/ui` may call `ensureCollection`, a sync, or `indexDocumentJustInTime`. The UI reads the graph and offers only forgetting (`forgetDocument`, `forgetCollection`, `forgetCourse`, `forgetEverything`; "Delete this account's data" in Settings is the account-level wipe that also removes chats). No sync/refresh/index buttons.
- The UI is written against `AppModel` (`src/ui/model.ts`); components take the model, never data-layer imports. Extend the model (and the hook that fills it) before a component.
- Tool implementations return JSON strings and never throw. Built-in tool args arrive as strings; connection (MCP) tools get the model's arguments with their JSON types, because the server validates them against its own schema.
- Connection tools past `EAGER_CONNECTION_TOKENS` load on demand through `find_connection_tools`; don't declare large connection schemas on every call.
- Connection tools never act on Canvas, and any connection tool the server does not mark read-only waits for the student's approval unless they chose "Always allow". Connections are remote MCP servers only — no code is downloaded or run, and no per-service integrations.
- SQL lives in `src/db/*` (plus the `sync_state` bookkeeping in `canvas/freshness.ts`); components, tools and `canvas/*` call functions.

## Build / check

```bash
cd extension
npm install
npx tsc -p tsconfig.app.json --noEmit   # type-check
npm test                                 # vitest: unit + fake-Canvas/LLM/MCP flows on an in-memory PGlite
npm run test:types                       # type-check the tests (and the src they import)
npm run lint                             # ESLint; clean — `any` only for external wire formats and tests
npm run build                            # → extension/dist, load unpacked
```

Tests live in `extension/test/` (mirroring `src/`); no test touches the network, an account or IndexedDB. A change to behaviour the tests pin down updates the test in the same commit; a new invariant gets a test. See `reference/08-conventions-and-gotchas.md` → Tests.
