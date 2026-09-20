# 01 — Overview

## What it is

An AI study assistant for Canvas LMS, packaged as a Chrome/Edge extension that opens in the **side panel**. The user chats with an agent that can read their courses, assignments, planner, announcements, inbox, and course documents, and can search inside PDFs/slides/pages with citations.

Design constraints that shape everything:

1. **No backend.** All compute, storage, and API calls happen in the extension page. The user brings their own LLM API key.
2. **Canvas access rides on the browser session.** No Canvas API token is stored; requests go out with `credentials: 'include'` and succeed because the user is logged into their Canvas in the same browser profile. Known instances (`knownHosts` in `canvas/profiles.ts`, currently `q.utoronto.ca`) are granted in the manifest and connect silently at startup; any other Canvas is connected once through the Connect screen, which requests its origin. A deployment profile (Quercus or generic) names it in the prompt.
3. **Token economy matters.** Canvas payloads are large and the user pays per token, so the system mirrors structure locally, hands the model compact shaped rows, and never makes it decide between cached and live data.

## Design philosophy

The constraints above led to a small set of principles that explain most of the code. When a change is hard to fit, it is usually fighting one of these.

- **Maximal caching, engine-owned freshness.** Everything the agent reads comes from the local graph (PGlite in IndexedDB). Canvas is only contacted by the freshness engine (`ensureCollection`): per-collection TTLs, cheap change probes where Canvas offers one, per-course "unavailable" tracking, in-flight de-duplication. The model never sees a cache/live choice and the prompt contains no staleness language; the only cache-related tool parameter is `refresh`, reserved for "the user says something changed". Data that is fetched is kept: text is stored eagerly, old chunk vectors are kept as a cache for re-indexing, and prune is the only thing that deletes.
- **Lazy by default.** Nothing is fetched or computed until something needs it: courses are listed when asked, a course's modules when it is explored, a document's text when it is first read or searched, assignment descriptions on first access, discussion replies when a thread is opened. Embeddings are the strictest case — no sync path may call the embedding API; a document is embedded only when a semantic search is about to target it. Being lazy is what keeps first use fast and the user's API bill proportional to what they actually ask.
- **A minimal, graph-backed toolset.** Eight tools, each a thin read over the local graph with one shape of output, rather than one tool per Canvas endpoint. The tool descriptions and the system prompt are a single contract; capability is added by widening a tool's `kind` or adding a collection, not by adding tools. Tools return JSON and never throw, so the model can recover from `{ error }`.
- **Discovery through links, not listings.** Canvas hides Files and Pages listings from students at UofT but serves every item by id, so the graph is built from what links to what: module items, the course home page, and links inside every HTML body (`content_links`). Link markers (`[file 123]`, `[page slug]`) are part of document text so the model can hop.
- **Shape at the boundary, store thin mirrors.** Canvas payloads are reduced to the fields the app reads before they enter the database; types are deliberately thin. Ids are strings everywhere. Sync is upsert + prune inside one transaction, only ever with a complete list.
- **Cacheable prompt prefix.** The system prompt and tool schemas are fixed for a session; anything per-turn (the course roster, digests) rides on messages, so provider prompt caching keeps working.
- **Compact context.** Tool results are capped when persisted, conversations are digested past a threshold, and shaped rows omit anything the model does not need (no HTML bodies in overviews).
- **Everything is local and per-identity.** One database and chat list per `<host>/<userId>`; settings are global. No server, no telemetry, the API key never leaves the browser except to the chosen provider.

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
        │   └── tools.ts       ← TOOL_CONFIG + implementations (8 graph-backed tools)
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
