# 01 — Overview

## What it is

An AI study assistant for Canvas LMS, packaged as a Chrome/Edge extension that opens in the **side panel**. The user chats with an agent that can read their courses, assignments, planner, announcements, inbox, and course documents, and can search inside PDFs/slides/pages with citations.

Design constraints that shape everything:

1. **No backend.** All compute, storage, and API calls happen in the extension page. The user brings their own LLM API key.
2. **Canvas access rides on the browser session.** No Canvas API token is stored; requests go out with `credentials: 'include'` and succeed because the user is logged into their Canvas in the same browser profile. Known instances (`knownHosts` in `canvas/profiles.ts`, currently `q.utoronto.ca`) are granted in the manifest and connect silently at startup; any other Canvas is connected once through the Connect screen, which requests its origin. A deployment profile (Quercus or generic) names it in the prompt.
3. **Token economy matters.** Canvas payloads are large and the user pays per token, so the system caches structure locally and instructs the model to read the cache before going live.

## Runtime environment

| Piece | Choice | Notes |
|---|---|---|
| Extension format | Manifest V3 | `extension/manifest.json` |
| Surface | Side panel (`side_panel.default_path = index.html`) | One panel per browser window. The service worker (`src/background.ts`) does nothing except `setPanelBehavior({ openPanelOnActionClick: true })`. |
| Permissions | `sidePanel`, `activeTab`, `scripting`; `host_permissions: https://*.utoronto.ca/*` (the known instances); `optional_host_permissions: https://*/*` | Known instances need no prompt. Any other Canvas origin is requested at runtime from the Connect screen (`chrome.permissions.request`, a user gesture) and re-checked on every start. `activeTab` lets the panel read the host of the tab the icon was clicked on and, with `scripting`, run a one-line Canvas signature check in that page before asking for its origin. Persistence uses localStorage and IndexedDB, so no `storage` permission is needed. |
| CSP | `script-src 'self' 'wasm-unsafe-eval'` | Required for PGlite's WASM. Inline scripts are blocked. |
| UI | React 19, TypeScript, Tailwind v4 (`@tailwindcss/postcss`), `lucide-react` icons, `marked` for Markdown, `katex` for math | |
| Database | `@electric-sql/pglite` + `@electric-sql/pglite-pgvector`, one database per Canvas identity (`idb://<dbName>` from `canvas/identity.ts`) | Postgres compiled to WASM. See `04-knowledge-graph.md`. |
| Document parsing | `pdfjs-dist` (worker bundled via `?url` import), `jszip` for PPTX | See `05-rag.md`. |
| Build | Vite 8 + `vite-plugin-web-extension` | `npm run build` → `extension/dist`, load unpacked. A small custom plugin strips a `__vite-browser-external` chunk that Vite emits for Node shims. `optimizeDeps.exclude` keeps PGlite out of pre-bundling. |
| TypeScript | Project references: `tsconfig.app.json` (browser, `types: ["vite/client", "chrome"]`) and `tsconfig.node.json` (Vite config) | Strict, `noUnusedLocals`, `verbatimModuleSyntax`. |

## Directory layout

```
canvasbuddy/
├── README.md
├── reference/                 ← this folder
└── extension/
    ├── manifest.json
    ├── index.html             ← side panel document
    ├── vite.config.ts
    ├── public/                ← logo.png, logo128.png, favicon
    └── src/
        ├── main.tsx           ← React root
        ├── background.ts      ← MV3 service worker (side-panel behaviour only)
        ├── App.tsx            ← agent loop, provider adapters, history/digests, chat state
        ├── agent/
        │   ├── prompt.ts      ← SYSTEM_PROMPT
        │   └── tools.ts       ← TOOL_CONFIG + implementations (7 graph-backed tools)
        ├── components/
        │   ├── ChatUI/        ← message list + input
        │   ├── Navigation/    ← left rail: tabs + chat list
        │   ├── Settings/      ← provider/key/model/threshold form; exports AppSettings; connected-Canvas row
        │   ├── Connect/       ← first-run screen: inspect the current tab → "Grant access to <host>" → session check
        │   └── GraphExplorer/ ← knowledge-graph browser, sync + index buttons
        ├── settings.ts        ← DEFAULT_SETTINGS + normalizeSettings (merges old persisted settings), resolveBaseUrl
        ├── canvas/
        │   ├── http.ts        ← configureCanvas/canvasHost/canvasBase, canvasGet, fetchAllPages, CanvasHttpError
        │   ├── profiles.ts    ← deployment profiles (quercus, generic): name, internal hosts, origins, prompt intro
        │   ├── connection.ts  ← origin permission check/request, session verification, activeTab host
        │   ├── identity.ts    ← who is signed in (/users/self), memory registry (<host>/<userId> → db + chats key), forget
        │   ├── freshness.ts   ← ensureCurrent: TTL / probe / debounce / unavailable policy, sync_state
        │   ├── collections.ts ← registry: fetch + probe + shape + upsert for all 10 collections
        │   ├── links.ts       ← ingestHtml: HTML body → text with link markers + content_links rows
        │   └── sync.ts        ← JIT document indexing (files, pages, assignment descriptions)
        ├── db/
        │   ├── pglite.ts      ← singleton DB init + Web Lock
        │   ├── schema.ts      ← DDL + idempotent migrations
        │   ├── graph.ts       ← graph queries, upsert/prune, overview text
        │   └── rag.ts         ← chunk storage, hybrid search, document cache state
        ├── embeddings/
        │   └── embeddingClient.ts ← Gemini / OpenAI embedding calls
        ├── utils/
        │   ├── textExtractor.ts   ← PDF/PPTX/HTML → structured pages, chunking
        │   ├── canvasLinks.ts     ← parse Canvas hrefs, HTML → text with [file 123]-style markers
        │   └── markdown.ts        ← marked + DOMPurify for assistant replies
        └── types/
            └── canvas.ts      ← Canvas API entity types, graph stats, retrieved chunk
```

## Data flow

```
 user ──► ChatUI ──► App.tsx agent loop
                       ├─ buildApiHistory (system prompt · digests · turns; course roster on latest user turn)
                       ├─ callLLM ─────────────────────────────────────►  Gemini / OpenAI
                       ├─ parseFunctionCalls
                       └─ agent/tools.ts  toolFunctions[name](args, settings)
                              │
                              ├─ ensureCollection(kind) ── canvas/freshness.ts
                              │        └─ probe / sync ── canvas/collections.ts ──►  Canvas API (session cookies)
                              │                                │  shape + upsert (one transaction)
                              ├─ db/graph.ts reads ◄───────────┴──────►  PGlite (IndexedDB)
                              └─ db/rag.ts search / read ◄── canvas/sync.ts indexing ──►  Canvas API (documents)

 GraphExplorer ──► same ensureCollection / indexing / db functions
```

Two clients share the same data layer: the **agent** (via tools) and the **Graph Explorer UI** (via direct function calls). Both go through `src/canvas/collections.ts` (`ensureCollection`) for anything that may need a Canvas fetch, and `src/db/*` for reads; neither talks to PGlite SQL directly from the component layer.

## Persistence map

| Data | Where | Format |
|---|---|---|
| Chats (display messages, model-facing history with capped tool turns, context digests) | `localStorage[<slot.chatsKey>]` — `canvas-buddy-chats` for the first identity seen, `canvas-buddy-chats:<host>/<userId>` after | JSON array of `Chat` |
| Memory registry (identity → database name, chats key, since) and last identity per host | `localStorage['canvas-buddy-memories']`, `localStorage['canvas-buddy-identity']` | JSON |
| Settings (provider, key, model, embedding model, threshold, freshness TTLs, `canvasHost`) | `localStorage['canvas-buddy-settings']` | JSON `AppSettings` |
| Knowledge graph + vectors | IndexedDB via PGlite (`idb://<slot.dbName>`: `canvas-buddy-db` for the first identity, `canvas-buddy-<host>-<userId>` after) | Postgres tables, see `04-knowledge-graph.md` |

The API key is stored in plain localStorage; the settings page states it "never leaves the browser", which is true — it is only sent to the chosen LLM provider.
