# 01 — Overview

## What it is

An AI study assistant for Canvas LMS, packaged as a Chrome/Edge extension that opens in the **side panel** (in Firefox, the sidebar). The user chats with an agent that can read their courses, assignments, planner, announcements, inbox, and course documents, and can search inside PDFs/slides/pages with citations.

Design constraints that shape everything:

1. **No backend.** All compute, storage, and API calls happen in the extension page. The user brings their own LLM API key. Other services are reached only through remote MCP servers the user connects (`09-connections.md`).
2. **Canvas access rides on the browser session.** No Canvas API token is stored; requests go out with `credentials: 'include'` and succeed because the user is logged into their Canvas in the same browser profile. Known instances (`knownHosts` in `canvas/profiles.ts`, currently `q.utoronto.ca`) are granted in the manifest and connect silently at startup; any other Canvas is connected once through the Connect screen, which requests its origin. A deployment profile (Quercus or generic) names it in the prompt.
3. **Token economy matters.** Canvas payloads are large and the user pays per token, so the system mirrors structure locally, hands the model compact shaped rows, and never makes it decide between cached and live data.

## Design philosophy

The constraints above led to a small set of principles that explain most of the code. When a change is hard to fit, it is usually fighting one of these.

- **Maximal caching, engine-owned freshness.** Everything the agent reads comes from the local graph (PGlite in IndexedDB). Collection data is fetched only by the freshness engine (`ensureCollection`): per-collection TTLs, cheap change probes where Canvas offers one, per-course "unavailable" tracking, in-flight de-duplication. Document text is fetched only by the just-in-time loaders, when a search or read targets the document. The model never sees a cache/live choice and the prompt contains no staleness language; the only cache-related tool parameter is `refresh`, reserved for "the user says something changed". Data that is fetched is kept: text is stored eagerly, old chunk vectors are kept as a cache for re-indexing, and prune is the only thing that deletes.
- **Lazy by default.** Nothing is fetched or computed until something needs it: courses are listed when asked, a course's modules when it is explored, a document's text when it is first read or searched, assignment descriptions on first access, discussion replies when a thread is opened. Embeddings are the strictest case — no sync path may call the embedding API; a document is embedded only when a semantic search is about to target it. Being lazy is what keeps first use fast and the user's API bill proportional to what they actually ask.
- **A minimal, graph-backed toolset.** Eight Canvas tools, each a thin read over the local graph with one shape of output, rather than one tool per Canvas endpoint. The tool descriptions and the system prompt are a single contract; capability is added by widening a tool's `kind` or adding a collection, not by adding tools. Tools return JSON and never throw, so the model can recover from `{ error }`. Anything beyond Canvas comes from the student's MCP connections, whose tools are declared after the built-ins.
- **Discovery through links, not listings.** Canvas hides Files and Pages listings from students at UofT but serves every item by id, so the graph is built from what links to what: module items, the course home page, and links inside every HTML body (`content_links`). Link markers (`[file 123]`, `[page slug]`) are part of document text so the model can hop.
- **Shape at the boundary, store thin mirrors.** Canvas payloads are reduced to the fields the app reads before they enter the database; types are deliberately thin. Ids are strings everywhere. Sync is upsert + prune inside one transaction, only ever with a complete list.
- **Cacheable prompt prefix.** The system prompt and tool schemas stay the same between turns; anything per-turn (the course roster, digests) rides on messages, and connection tools loaded mid-chat are appended at the end, so provider prompt caching keeps working.
- **Compact context.** Tool results are capped when persisted, conversations are digested past a threshold, and shaped rows omit anything the model does not need (no HTML bodies in overviews).
- **Memory is engine-managed.** The user never syncs, refreshes or indexes by hand; the Memory sheet only shows what the agent has remembered and lets the user forget parts of it (a document's text, a collection, a course, the whole graph). Anything forgotten comes back the next time a tool needs it. Chats are not memory: only "Delete this account's data" (Settings) removes them.
- **Everything is local and per-identity.** One database and chat list per `<host>/<userId>`; settings are global. No server, no telemetry, the API key never leaves the browser except to the chosen provider.

## Runtime environment

| Piece | Choice | Notes |
|---|---|---|
| Extension format | Manifest V3, one manifest for Chrome and Firefox | `extension/manifest.json`, with `{{chrome}}.` / `{{firefox}}.` keys per build. See Chrome and Firefox below. |
| Surface | Side panel in Chrome, sidebar in Firefox; both load `index.html` | One panel per browser window. The background (`src/background.ts`) does nothing except make the toolbar action open it. |
| Permissions | `sidePanel` (Chrome build only), `activeTab`, `scripting`, `storage`, `identity`, `declarativeNetRequestWithHostAccess`; `host_permissions: https://*.utoronto.ca/*` (the known instances); `optional_host_permissions: https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` (the last two for local model servers) | Known instances need no prompt. Any other Canvas origin is requested at runtime from the Connect screen (`chrome.permissions.request`, a user gesture) and re-checked on every start. `activeTab` lets the panel read the host of the tab the icon was clicked on and, with `scripting`, run a one-line Canvas signature check in that page before asking for its origin. Chats, settings and the graph use localStorage and IndexedDB; `storage` is for connections (`chrome.storage.local`, which holds their tokens), `identity` for their OAuth sign-in window, and `declarativeNetRequestWithHostAccess` for one rule that removes the extension's `Origin` header on requests to connection hosts. Connection origins are requested from a click like Canvas's (`09-connections.md`). |
| CSP | `script-src 'self' 'wasm-unsafe-eval'` | Required for PGlite's WASM. Inline scripts are blocked. |
| UI | React 19, TypeScript, Tailwind v4 (`@tailwindcss/postcss`, typography via `@plugin`), `motion` for transitions, `@fontsource-variable/{inter,fraunces}` bundled locally, `lucide-react` icons, `marked` for Markdown, `katex` for math | See `07-ui.md`. |
| Database | `@electric-sql/pglite` + `@electric-sql/pglite-pgvector`, one database per Canvas identity (`idb://<dbName>` from `canvas/identity.ts`) | Postgres compiled to WASM. See `04-knowledge-graph.md`. |
| Document parsing | `pdfjs-dist` (worker bundled via `?url` import), `jszip` for PPTX and DOCX | See `05-rag.md`. |
| Build | Vite 8 + `vite-plugin-web-extension` | `npm run build` → `extension/dist` (Chrome/Edge, load unpacked); `npm run build:firefox` → `extension/dist-firefox` (Firefox, temporary add-on). A small custom plugin strips a `__vite-browser-external` chunk that Vite emits for Node shims. `optimizeDeps.exclude` keeps PGlite out of pre-bundling. |
| TypeScript | Project references: `tsconfig.app.json` (browser, `types: ["vite/client", "chrome"]`), `tsconfig.node.json` (Vite config), `tsconfig.test.json` (`test/`, adds Node types) | Strict, `noUnusedLocals`, `verbatimModuleSyntax`. `npm run lint` (ESLint: typescript-eslint, react-hooks, react-refresh) is clean. |
| Tests | Vitest + happy-dom (jsdom for the Markdown renderer) | See Tests below. |

## Chrome and Firefox

One source tree and one `manifest.json` build for both browsers. `npm run build` targets Chrome (and Edge) into `extension/dist`; `npm run build:firefox` runs `vite build --mode firefox`, which sets `vite-plugin-web-extension`'s `browser` option to `firefox` and writes `extension/dist-firefox`. In the manifest, a key prefixed `{{chrome}}.` or `{{firefox}}.` is kept (without the prefix) only in that build; unprefixed keys go to both. Everything else — the React app, PGlite, the agent loop, tools, connections, tests — is shared and calls the `chrome.*` namespace, which Firefox also provides with promise-returning APIs — but not every enum object Chrome hangs off it (`declarativeNetRequest.RuleActionType` and `HeaderOperation` are missing), so code writes such values as string literals. The `chrome.*` test stub has only what both provide, with Firefox's shape where they differ (a page URL host that is not the id).

| | Chrome build (`dist`) | Firefox build (`dist-firefox`) |
|---|---|---|
| Panel | `side_panel.default_path` | `sidebar_action.default_panel` (`open_at_install: false`) |
| Background | `background.service_worker` (module) | `background.scripts` (module); Firefox has no extension service workers |
| Opening the panel | `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` | `sidebarAction.toggle()` from `action.onClicked` — Firefox opens a sidebar only inside a user action |
| `sidePanel` permission | yes | omitted (unknown to Firefox) |
| Add-on id | assigned by Chrome | `browser_specific_settings.gecko.id` (`canvasbuddy@canvasbuddy.extension`); `storage`, `identity` and the OAuth redirect need a fixed id |
| Minimum version | — | `strict_min_version` 128: `optional_host_permissions` and `scripting.executeScript` with `world: 'MAIN'` |
| Extension page origin | `chrome-extension://<id>` | `moz-extension://<per-install UUID>` — not the add-on id (see the Origin rule, `09-connections.md`) |
| OAuth redirect (`identity.getRedirectURL`) | `https://<id>.chromiumapp.org/oauth` | `https://<hash>.extensions.allizom.org/oauth` |
| Host permissions | manifest ones granted at install; optional ones can be revoked | the user can withdraw any of them, the known instances included, from the add-on's Permissions tab |
| Install for development | `chrome://extensions` → Developer mode → Load unpacked → `dist` | `about:debugging` → This Firefox → Load Temporary Add-on → `dist-firefox/manifest.json` (removed when Firefox closes) |

Code that needs an API only one browser has feature-checks it (`background.ts`); nothing else branches on the browser. There is no automated run in Firefox. `tmp/firefox-harness/` (git-ignored) loads `dist-firefox` into a headless Firefox over WebDriver BiDi and reports the `Origin` the app's own MCP requests carry; the OAuth window and permission prompts still need trying by hand.

## Directory layout

```
canvasbuddy/
├── README.md
├── reference/                 ← this folder
└── extension/
    ├── manifest.json
    ├── index.html             ← panel document (Chrome side panel / Firefox sidebar)
    ├── vite.config.ts
    ├── vitest.config.ts       ← tests: happy-dom, setup, no network
    ├── test/                  ← Vitest suites mirroring src/; helpers/ (fake Canvas, LLM, MCP, db, embeddings), fixtures/
    ├── public/                ← logo.png, logo128.png, favicon.svg
    └── src/
        ├── main.tsx           ← React root
        ├── index.css          ← Tailwind + typography plugin, root sizing, KaTeX overflow, streaming caret
        ├── background.ts      ← MV3 background (action opens the side panel / Firefox sidebar)
        ├── App.tsx            ← state owner: connection, settings, chats, the chat on screen; runs the agent through a RunHost; builds the AppModel
        ├── chats.ts           ← Chat / ChatSnapshot, new chat, save a snapshot into a chat (title), read/write localStorage
        ├── providers/
        │   ├── index.ts       ← callModel, embedTexts: the only entry points
        │   ├── registry.ts    ← PROVIDERS (service → adapter, default base URL, key, embeddings), endpointFor, host access
        │   ├── models.ts      ← model catalogue: thinking support by family, known 768-d embedding models
        │   ├── gemini.ts, openaiResponses.ts, openaiChat.ts, anthropic.ts ← one adapter per wire protocol
        │   ├── http.ts        ← postJson, rate-limit retry, API errors, 768-d check
        │   └── types.ts       ← ChatRequest / ChatResult / ToolSpec / Usage / ReplayData / ProviderAdapter
        ├── agent/
        │   ├── run.ts         ← runAgent: the tool-calling loop (bubble, steps, steering, approval, errors) over a RunHost
        │   ├── digest.ts      ← contextSize, digest calls, digestToThreshold
        │   ├── history.ts     ← conversation types, history building/budgeting, tool-step helpers
        │   ├── prompt.ts      ← buildSystemPrompt
        │   └── tools.ts       ← TOOL_CONFIG + implementations (8 graph-backed tools)
        ├── ui/
        │   ├── model.ts       ← AppModel: the one type the UI is written against (+ FRESHNESS_FIELDS)
        │   ├── useMemoryExplorer.ts ← reads the graph into MemoryModel; forget actions
        │   ├── useConnectFlow.ts    ← tab inspection → "Grant access to <host>" → session check, as ConnectModel
        │   ├── useConnections.ts    ← connection records → ConnectionsModel; permission requests from clicks
        │   ├── useProviderAccess.ts ← host permission for a local / custom model provider, as ProviderAccessModel
        │   ├── Shell.tsx      ← header, notice, main area, sheets
        │   ├── Chat.tsx · Memory.tsx · Settings.tsx · Connections.tsx · Connect.tsx · primitives.tsx
        │   ├── theme.css      ← palette/type tokens on .app
        │   └── format.ts      ← timeAgo, formatDue, syncPill, formatTokens, …
        ├── connections/
        │   ├── store.ts       ← ConnectionRecord[] in chrome.storage.local
        │   ├── mcp.ts         ← MCP client over Streamable HTTP: initialize, tools/list, tools/call
        │   ├── oauth.ts       ← MCP authorization: discovery, dynamic registration, PKCE via chrome.identity, refresh
        │   ├── manage.ts      ← add / re-list / sign in / remove
        │   ├── tools.ts       ← connection tools as the model sees them; eager/lazy loading, find_connection_tools, loaded set; results; approval rule
        │   ├── search.ts      ← BM25 + synonyms over connection tools, for find_connection_tools
        │   ├── originRule.ts  ← DNR rule: no Origin header on requests to connection hosts
        │   └── catalog.ts     ← suggested connections
        ├── commands.ts        ← composer commands (/compact, /new, /usage, /export, /tools, /help): registry, dispatch, chat → Markdown
        ├── settings.ts        ← AppSettings (keys per provider; chat and embedding provider + model), DEFAULT_SETTINGS, normalizeSettings (maps the old flat shape)
        ├── canvas/
        │   ├── http.ts        ← configureCanvas/canvasHost/canvasBase, canvasGet, fetchAllPages, CanvasHttpError
        │   ├── profiles.ts    ← deployment profiles (quercus, generic): name, internal hosts, origins, prompt intro
        │   ├── connection.ts  ← origin permission check/request, session verification, activeTab host
        │   ├── identity.ts    ← who is signed in (/users/self), memory registry (<host>/<userId> → db + chats key), forget
        │   ├── freshness.ts   ← ensureCurrent: TTL / probe / debounce / unavailable policy, sync_state
        │   ├── collections.ts ← registry: fetch + probe + shape + upsert for all 13 collections
        │   ├── links.ts       ← ingestHtml: HTML body → text with link markers + content_links rows
        │   └── sync.ts        ← JIT document indexing (files, pages, assignment descriptions, syllabus)
        ├── db/
        │   ├── pglite.ts      ← singleton DB init + Web Lock
        │   ├── schema.ts      ← DDL (idempotent; no migrations)
        │   ├── graph.ts       ← graph queries, upsert/prune, overview text
        │   ├── rag.ts         ← chunk storage, hybrid search, document cache state
        │   └── rows.ts        ← the row types the read functions return (as PGlite hands them back)
        ├── embeddings/
        │   └── embeddingClient.ts ← batchEmbed / getEmbedding / resolveEmbeddingModel over embedTexts
        ├── utils/
        │   ├── textExtractor.ts   ← PDF/PPTX/DOCX/text → structured pages, chunking; HTML → text
        │   ├── canvasLinks.ts     ← parse Canvas hrefs, HTML → text with [file 123]-style markers
        │   ├── markdown.ts        ← marked + DOMPurify for assistant replies
        │   ├── sse.ts             ← server-sent-event reader shared by the model streams and MCP
        │   └── tokens.ts          ← estimateTokenCount (~4 chars/token)
        └── types/
            └── canvas.ts      ← Canvas API entity types, graph stats, retrieved chunk
```

## Tests

`npm test` (Vitest) runs `extension/test/**`, which mirrors `src/`. Nothing reaches a network, an account or IndexedDB:

- **Database**: an in-memory PGlite with the production schema and HNSW settings, injected through `__setTestDb` (`test/helpers/db.ts`); tables are truncated between tests.
- **Canvas**: a fake behind a stubbed `fetch` (`test/helpers/canvas.ts`) with routes keyed by API path (optionally with query), Canvas-style `Link` pagination, 403/404/HTML-login replies, and a record of every request; fixtures in `test/fixtures/canvas.ts` are hand-written (course 1 hides Files/Pages like the UofT courses).
- **Models**: SSE builders for every provider's stream and `captureFetch`, which records each request an adapter makes (`test/helpers/llm.ts`); embeddings are mocked with deterministic, distinct 768-d vectors that count calls (`test/helpers/embeddings.ts`), so the lazy-embedding rule is asserted, not assumed.
- **MCP**: a fake Streamable HTTP server plus OAuth authorization server (`test/helpers/mcp.ts`); `chrome.*` is an in-memory stub (`test/setup.ts`).
- **Environment**: happy-dom (DOMParser for the extractors and link parser; PGlite runs under it) with iframe/script/CSS loading off; the Markdown renderer's file uses jsdom because DOMPurify does not sanitize under happy-dom. pdf.js is mocked (real PDF parsing is out of scope); React components and `App.tsx` are not tested (the loop in `agent/run.ts` is, through a fake `RunHost`).

## Data flow

```
 user ──► ui/Chat ──► App.tsx agent loop
                       ├─ buildApiHistory (system prompt · digests · turns; course roster on latest user turn)
                       ├─ providers/ callModel ── adapter ────────────►  Gemini / OpenAI / Anthropic / compatible
                       ├─ connections/tools.ts  runConnectionTool ──────────────────►  remote MCP servers
                       └─ agent/tools.ts  toolFunctions[name](args, settings)
                              │
                              ├─ ensureCollection(kind) ── canvas/freshness.ts
                              │        └─ probe / sync ── canvas/collections.ts ──►  Canvas API (session cookies)
                              │                                │  shape + upsert (one transaction)
                              ├─ db/graph.ts reads ◄───────────┴──────►  PGlite (IndexedDB)
                              └─ db/rag.ts search / read ◄── canvas/sync.ts indexing ──►  Canvas API (documents)

 ui/useMemoryExplorer ──► db/graph.ts, db/rag.ts, sync_state reads only  (+ the forget functions)
```

Only the **agent** (via tools) brings data in; Canvas is contacted through `src/canvas/collections.ts` (`ensureCollection`) and documents are indexed through `src/canvas/sync.ts`. The **UI** reads the same `src/db/*` functions to show what is remembered and can only shrink it (forget a collection, a document's text, or everything); it never syncs or indexes. Nothing outside `src/db/*` and `canvas/freshness.ts` talks SQL.

## Persistence map

| Data | Where | Format |
|---|---|---|
| Chats (display messages with steps, model-facing history with capped tool turns, context digests, loaded connection tools) | `localStorage[<slot.chatsKey>]` = `canvas-buddy-chats:<host>/<userId>` | JSON array of `Chat` |
| Memory registry (identity → database name, chats key, since) and last identity per host | `localStorage['canvas-buddy-memories']`, `localStorage['canvas-buddy-identity']` | JSON |
| Settings (key and base URL per provider, chat and embedding provider + model, threshold, reasoning, tool rounds before asking, loaded-tool caps, freshness TTLs, `canvasHost`) | `localStorage['canvas-buddy-settings']` | JSON `AppSettings` |
| Connections (servers, OAuth tokens, tool lists, always-allowed tools) | `chrome.storage.local['canvas-buddy-connections']` (per browser profile) | JSON `ConnectionRecord[]`, see `09-connections.md` |
| Knowledge graph + vectors | IndexedDB via PGlite (`idb://<slot.dbName>` = `canvas-buddy-<host>-<userId>`) | Postgres tables, see `04-knowledge-graph.md` |

The API key is stored in plain localStorage; Settings says it is "stored locally and never shared", which holds — it is only sent to the chosen LLM provider.
