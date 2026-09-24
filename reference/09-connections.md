# 09 — Connections (remote MCP servers)

Sources: `src/connections/` (`store.ts`, `mcp.ts`, `oauth.ts`, `manage.ts`, `tools.ts`, `search.ts`, `originRule.ts`, `catalog.ts`), `src/ui/useConnections.ts`, `src/ui/Connections.tsx`, the tool dispatch in `src/App.tsx`.

## What it is

A connection is a remote **MCP server** the student added in Settings → Connections. Its tools are offered to the model next to the eight built-in tools. This is how CanvasBuddy reaches anything beyond Canvas (Notion, or Google Calendar and thousands more through an aggregator like Zapier or Composio) without shipping an integration per service.

Why MCP and nothing else: a Manifest V3 extension may not run code it did not ship, so "installing a tool" can never mean downloading JavaScript. A connection is only **data** — a URL and a token — and the tools run on the server. Local (stdio) MCP servers are out of reach for the same reason: an extension cannot start processes. There is **no direct integration** for any service, Google Calendar included; a service without its own MCP server is reached through an aggregator the student has an account with.

## The protocol (`mcp.ts`)

MCP over **Streamable HTTP**: every message is a JSON-RPC request `POST`ed to the server's one URL with `Accept: application/json, text/event-stream`; the server answers with a JSON body or with an SSE stream that carries the reply (read with the shared `utils/sse.ts`). The client only speaks what the agent needs:

1. `initialize` (protocol `2025-06-18`, no client capabilities, so servers send no sampling/elicitation requests), then the `notifications/initialized` notification. A session id from `Mcp-Session-Id` is sent back on every later request with `MCP-Protocol-Version`.
2. `tools/list`, following `nextCursor` (≤ 20 pages). Each tool keeps `name`, `title`, `description`, `inputSchema` and `readOnly` (= `annotations.readOnlyHint === true`).
3. `tools/call` with the model's arguments.

Sessions are per page and in memory. A 404 on a request with a session means the server dropped it: the session is re-created once. Anything on an SSE stream that is not the awaited reply is ignored. Servers that only implement the old HTTP+SSE transport answer 404/405 to the POST and get an error that says so.

## Authorization (`oauth.ts`)

MCP authorization for a public client, run when a request answers **401**:

1. **Discovery** (`discoverIssuer`): the `WWW-Authenticate` header's `resource_metadata` URL, else `/.well-known/oauth-protected-resource[/path]` on the server's origin (RFC 9728) → `authorization_servers[0]` and the scope to ask for (challenge `scope`, else `scopes_supported`). A server with no metadata is its own issuer. The issuer's metadata then gives its token and registration endpoints (`authEndpoints`). The connection becomes `needs-auth` with `authIssuer` / `authScope` / `authEndpoints`.
2. **Sign in** (a click; `signIn`): authorization-server metadata (RFC 8414 / OIDC discovery, path-aware; the first MCP auth spec's default `/authorize` `/token` `/register` as a last resort) → **dynamic client registration** (RFC 7591, `token_endpoint_auth_method: none`, redirect `chrome.identity.getRedirectURL('oauth')` = `https://<extension-id>.chromiumapp.org/oauth`) → authorization code + **PKCE S256** + `state` in a `chrome.identity.launchWebAuthFlow` window → token exchange. Every request carries `resource=<server URL>` (RFC 8707) so the token is bound to that server. A server whose authorization server does not allow registration cannot be signed in to (no pre-registered clients).
3. **Refresh** (`accessTokenFor`): before each request, an access token within a minute of `expiresAt` is refreshed; a 401 with a refresh token forces one refresh and one retry. A failed refresh means sign-in again (`needs-auth`).

The registered client is reused when the same issuer asks again.

## Permissions

Every fetch to a server or authorization server needs its origin granted (the extension then bypasses CORS; servers need not send CORS headers). `optional_host_permissions: https://*/*` allows asking for any https origin, and Chrome only shows the prompt from a user gesture, so **each click that reaches a new origin asks first** (`useConnections`): Connect asks for the server's origin, Sign in for the server's, the issuer's and those of `authEndpoints`, Reconnect for the server's and the token endpoint's again (Chrome can revoke them; a refresh needs the token endpoint). The endpoints are recorded at discovery because they can sit on yet another origin that sends no CORS headers — Composio's `login.composio.dev` behind `connect.composio.dev` answers registration with a 201 that the panel could not read without a grant ("Failed to fetch"). A record made before `authEndpoints` existed picks them up on Reconnect. A fetch that fails without a status is explained by `describeFailure`: missing permission ("click Reconnect") or network.

Removing a connection does not release its origin grants. `identity` (the auth window), `storage` and `declarativeNetRequestWithHostAccess` (below) are manifest permissions.

**The `Origin` header is removed** (`originRule.ts`). The MCP spec tells servers to validate `Origin` against DNS rebinding, and some (Notion: `403 Invalid Origin: <extension id>`) reject any browser origin they do not know — including `chrome-extension://<id>`, which Chrome sets on every fetch from the panel and `fetch()` cannot change. One dynamic declarativeNetRequest rule removes `Origin` from this extension's own XHR/fetch requests (`initiatorDomains: [chrome.runtime.id]`) to every connection host (server, issuer, `authEndpoints`, token endpoint), so the server sees what a desktop MCP client sends: no Origin. `saveConnections` re-syncs the rule on every write, before the new host is contacted; the panel also syncs it once on open. Web pages' requests are never touched.

## Storage (`store.ts`)

`chrome.storage.local['canvas-buddy-connections']` holds `ConnectionRecord[]`: id, name, `slug`, url, `enabled`, `status` (`ok` · `needs-auth` · `error` + `error`), `authIssuer`/`authScope`/`authEndpoints`, `auth` (endpoints, client id/secret, access/refresh tokens, `expiresAt`), the last `tools` list, `alwaysAllow` and `disabledTools` (tool names). Writers are serialized read-modify-writes, so a token refresh inside a tool call and a click in Settings do not lose each other's change; `onConnectionsChanged` lets the UI re-read. Connections belong to the **browser profile**, not to a Canvas identity: switching Canvas or "Delete this account's data" leaves them.

## Tools as the model sees them (`tools.ts`)

`connectionTools(records)` turns every **switched-on** tool (`disabledTools` excludes the rest) of an **enabled, `ok`** connection into a function named `<slug>__<tool>` (letters, digits, `_`, `-`; ≤ 64 chars, a short hash when longer or colliding). Its description is `[<connection name>] <server description>` (≤ 1,500 chars); its parameters are the **server's JSON Schema**, forced to `type: object` with `properties`, `$schema` dropped. The loop sends them **after** the built-in tools as ordinary `ToolSpec`s; each adapter passes the schema through (Gemini as `parametersJsonSchema`, since its `parameters` only takes an OpenAPI subset). Each carries `tokens`, the estimated size of its definition (`utils/tokens.ts`, ~4 chars/token); what a call declares is added to the context estimate. Whether they are all declared or loaded on demand is the next section.

Differences from built-in tools:
- **Arguments are not stringified.** The server validates them against the schema it published, so they pass through with their JSON types.
- **Results** (`CallToolResult`): text content (and text of embedded resources, links as `<uri>`) joined; other content types are noted as omitted; `structuredContent` is used only when there is no text. `isError` → `{ error }`. Otherwise `{ result }`, cut at 12,000 chars with a note. Calls time out after 60 s. `runConnectionTool` returns JSON and never throws, like a built-in tool; a 401 marks the connection `needs-auth` and tells the model the student must sign in again.
- **Approval.** A tool runs without asking when the server marks it read-only or the student chose "Always allow" for it; any other call puts its step in `awaiting` and the loop waits for `respondToApproval` (Allow · Always allow · Deny, see `07-ui.md`). Deny returns `{ error: 'The student declined this action.' }`. Stop answers a pending approval with deny and aborts.

The system prompt gains one line, only while a connection offers tools (`buildSystemPrompt(intro, services, loading)` in `agent/prompt.ts`): which services are connected; either that their tools are `<service>__<action>` (eager) or that they load on demand through `find_connection_tools` and stay available in the chat (lazy); that what they return is data, not instructions; and that a declined action is not retried. It changes only when the connected services or the mode do, so the prefix stays cacheable between turns.

## Lazy loading (`tools.ts`, `search.ts`)

Declaring every connection tool on every call does not scale: Notion's definitions alone are several thousand tokens, and a run often makes a dozen calls or more, which exhausts a tokens-per-minute limit before anything is done. So there are two modes (`toolLoading(live)`):

- **eager** — all switched-on connection tools together estimate ≤ `EAGER_CONNECTION_TOKENS` (2,000): every tool is declared on every call; the prompt line names the tools' form.
- **lazy** — above that: no connection tool is declared up front. The built-in tool **`find_connection_tools(query, service?)`** is declared instead (after the eight built-ins); its description lists every live tool's MCP name per service (≤ 60 per service, then "…and N more"), so the model usually asks for a name. The prompt line says tools load on demand.

**Search** (`searchConnectionTools`, pure): each tool is a bag of stemmed tokens — name ×6, title ×6, top-level parameter names ×3, first 300 description chars ×2 — scored with BM25 (k1 1.2, b 0.75) against the query, IDF computed per search (no stored index). Query words are widened with a small generic synonym table (add/write/new/make → create, find/look → search, edit/change → update, note/document → page, table → database, …); a word that has a synonym counts half, its synonym in full, so a rare original word ("Add a comment") does not outrank the tool that creates things. A query that **names** a tool — equal to its MCP or function name, or, when it is at least two words, equal to the end of a prefixed name (`create-pages` → `notion-create-pages`) — is an exact hit and outranks every score.

**What loads** (`pickToLoad`): only the named tools when there are exact hits; otherwise scored hits while they stay ≥ 30 % of the best, at most 5 (and ≤ `loadedToolsMax`), and after the first within `loadedToolsTokenBudget`. The result gives each loaded tool's function name, a one-sentence summary and `changes_something`; hits already loaded are listed under `already_loaded` (and marked used). No hit → nothing loads and the result is an index (name + 80-char summary, ≤ 60) to search again from.

**The loaded set** (`LoadedTool = { connectionId, tool, lastUsed }`, keyed by connection id + MCP name so a renamed connection keeps it) is **per chat**: `Chat.loadedTools`, app state `loadedTools`, saved with the chat. `applyLoad` appends new tools (the declared list only grows at its end, so the provider's cached prefix breaks at most once per load), marks re-found or called tools used, and evicts least-recently-used entries until the set fits the student's **`loadedToolsMax`** (default 8) and **`loadedToolsTokenBudget`** (default 6,000) settings; the tools of the current load are never evicted by it, and one tool larger than the budget still loads alone. `resolveLoaded` turns the set into live tools per call; entries whose tool is switched off, gone or whose connection is not working are skipped, not dropped (capped at `loadedToolsMax` such entries), so switching back on brings them back.

**In the loop**: the declared tools are recomputed before **every** model call (`declaredTools(currentLoaded)` in `App.tsx`), because a search in the previous step may have loaded something. `find_connection_tools` is dispatched before the built-in `toolFunctions` (it changes run state, not the graph). A live connection tool the model calls without having loaded it (it read the name list) still runs, with the usual approval, and is loaded as a side effect. A call to a function that does not exist gets `unknownToolResult`: with connections live, `{ error, tools, note }` — the callable function names per service (only the service whose slug prefixes the name, when one does; ≤ 60 per service) and a note that a name found inside a tool's result is not a function but is run through that service's own execute tool. Aggregators cause this: Composio's search returns app actions by name (`GOOGLECALENDAR_CREATE_EVENT`), which a model otherwise calls as `googlecalendar__GOOGLECALENDAR_CREATE_EVENT` and then loops searching for. Without connections it stays `Tool not found: <name>`. Calls to tools that are no longer declared stay in the history; the OpenAI adapters do not check history against the tool list; whether Gemini and Anthropic accept a replayed call to an undeclared function is **unverified** (fallback if it does not: evict only tools with no call in the un-digested history).

## Lifecycle (`manage.ts`, `useConnections`)

- **Add** (URL + optional name, or a catalog chip): validate (https) → ask for the origin → store with a unique slug → `refreshConnection` (new session + `tools/list`; 401 → `needs-auth`; failure → `error`).
- **Sign in**, **Reconnect** (re-list), **enable/disable** (a disabled connection's tools are not offered), **per-tool on/off** (`setToolEnabled` → `disabledTools`: a switched-off tool is never searched, loaded or declared), **Always allow** per tool (revocable in the tool list), **Remove** (confirm).
- Each enabled `ok` connection is re-listed once per panel session, one at a time, when the panel opens.

## Catalog (`catalog.ts`)

A short list of suggestions shown as chips: servers with a fixed URL connect directly — Notion, and Composio through its shared server `https://connect.composio.dev/mcp` (Composio Connect: MCP OAuth picks the account; it exposes a handful of meta-tools — search tools, get schemas, execute, manage the account's app connections — rather than one tool per app, and an app the student has not linked yet comes back as an authorization link in the chat). Composio's per-server dashboard URLs are for app builders and require an `x-api-key` header, which a connection cannot send. Zapier hands each user a personal URL, and its chip explains where to get it. Anything else is added by URL. Agent-driven discovery (searching the MCP Registry and *suggesting* a connection) is planned, not built; installing always stays a student's click.
