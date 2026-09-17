# CanvasBuddy — instructions for agents

## Read the reference before touching code

This project has an architecture reference in `reference/`. **Before editing any file under `extension/src`, read `reference/README.md` and the doc for the subsystem you are changing.** The docs explain why the code is shaped the way it is; several constraints (database lock, destructive prune, id conventions, Gemini signature replay, CSP/Vite requirements) are invisible at the call site and easy to break.

Minimum reading per task:

| Touching… | Read first |
|---|---|
| anything | `reference/README.md`, `reference/08-conventions-and-gotchas.md` |
| `src/App.tsx` agent loop, providers, digests | `reference/02-agent-loop.md` |
| `src/agent/*` (tools, system prompt) | `reference/03-tools.md` |
| `src/db/*`, `src/canvas/{sync,freshness,collections,http}.ts` | `reference/04-knowledge-graph.md` |
| indexing, chunking, embeddings, search | `reference/05-rag.md` |
| Canvas fetches, endpoints, auth | `reference/06-canvas-api.md` |
| `src/components/*` | `reference/07-ui.md` |

## Keep the reference true

If a change alters something the reference describes — a tool added/removed/changed, a schema migration, a new doc id convention, a new provider, a new persistence location, a changed prompt rule — **update the relevant `reference/*.md` in the same commit.** Do not leave the docs describing behaviour that no longer exists.

## Planned work

`plan.md` (git-ignored, repo root) holds the current review findings and the ranked improvement plan. Check it before proposing changes so you don't re-derive or contradict decisions already made. Items there are proposals until the user confirms them.

## Hard rules

- Do not change code without the user's confirmation when the change alters the tool contract, the schema, or the system prompt.
- Do not remove the PGlite Web Lock, the `'wasm-unsafe-eval'` CSP, `optimizeDeps.exclude` for PGlite, or the `?url` pdf.js worker import.
- Never call a sync/prune function with a partial list.
- Tools and UI reach Canvas through `ensureCollection` (freshness engine), never by fetching collection data directly. No staleness/"go live" language in the prompt or tool descriptions.
- Tool implementations return JSON strings and never throw; tool args arrive as strings.
- SQL lives in `src/db/*`; components and tools call functions.

## Build / check

```bash
cd extension
npm install
npx tsc -p tsconfig.app.json --noEmit   # type-check
npm run build                            # → extension/dist, load unpacked
```
