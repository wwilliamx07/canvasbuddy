# 06 — Canvas API integration

Sources: `src/canvas/http.ts` (`configureCanvas` / `canvasBase`, `canvasGet`, `fetchAllPages`, `CanvasHttpError`), `src/canvas/connection.ts` + `src/canvas/profiles.ts` (connecting), `src/canvas/collections.ts` (collection fetches), `src/canvas/sync.ts` (document fetches), entity types in `src/types/canvas.ts`.

## Authentication model

There is no Canvas API token. Every request is made from the extension page with `fetch(url, { credentials: 'include' })`, and the browser attaches the user's Canvas session cookies because the extension holds an origin permission for that host. The manifest grants the **known instances** up front (`host_permissions: https://*.utoronto.ca/*`, mirrored by `knownHosts` in `canvas/profiles.ts`) and declares `optional_host_permissions: ["https://*/*"]` for everything else (plus `http://localhost/*` and `http://127.0.0.1/*`, which only local model servers use). At startup with no remembered host, `findConnectableHost` tries the active tab's host and then the known instances, taking the first that already has permission and a live session — so a Quercus user never sees a prompt. Otherwise the Connect screen (`ui/useConnectFlow.ts`, `canvas/connection.ts`) takes the host from the **current tab** — there is nothing to type. `inspectActiveTab` reads the tab's host and runs `looksLikeCanvasPage` in the page's main world (`chrome.scripting.executeScript`, allowed by the `activeTab` grant an action click gives): Canvas LMS exposes a global `ENV` with `current_user_id` / `DOMAIN_ROOT_ACCOUNT_ID` / `ACCOUNT_ID` on every page and wraps the app in `#application.ic-app` (login pages carry `.ic-Login`). A page that fails the check gets no permission request. "Grant access to <host>" then requests the profile's origins (`https://<host>/*` for an unknown Canvas) as the first thing in the click, verifies the session with `GET /api/v1/users/self` (a login page is HTML with 200 — the content type is checked; a 404 or non-JSON error means "not Canvas" and the just-granted permission is released), and stores the host in `settings.canvasHost`. When the page cannot be inspected (the panel was open while the user switched tabs, so no `activeTab` grant), the API check after the request is the only signature test. Consequences:

- The user must be logged in to their Canvas in the same browser profile; otherwise Canvas returns a login page as HTML with status 200. `canvasGet` / `fetchAllPages` check the content type (`assertJson`), throw a "sign-in page instead of …" error, and fire the `onSessionLost` listener, which `App` uses to re-resolve the identity (signed out → banner; another account → "Reload to switch memory").
- The host lives in `canvas/http.ts` module state (`configureCanvas(host)` at startup / Connect; `canvasHost()` / `canvasBase()` for readers) — nothing else may hardcode a host. Which hostnames count as *inside* the Canvas for link parsing is the profile's `isInternalHost`.
- Chrome can revoke optional permissions, so `hasOriginPermission` runs on every start and the Connect screen returns when it is missing. A known instance's permission cannot be released, so "Switch Canvas" only stops auto-connecting for the session and shows the Connect screen.
- Adding a known instance = its origin pattern in `manifest.json` `host_permissions` **and** the host in a profile's `knownHosts`; the two must agree.
- File downloads go through `/files/:id/public_url` to obtain a signed URL and fetch it plainly; if that host is outside the granted origins the browser refuses, and the file's own `url` on the Canvas host is fetched with credentials instead. A deployment whose downloads still fail needs its CDN origin added to its profile's `origins`.

## Pagination

Canvas list endpoints page at `per_page` (max 100) and advertise the next page in a `Link` header. `fetchAllPages(path, label)` in `canvas/http.ts`:

- follows `rel="next"` until absent (guard of 100 pages);
- throws `CanvasHttpError` (with `.status`) on any non-OK page, or a plain `Error` on a non-array body; 403/404 are treated by the freshness engine as "this course hides this collection";
- is used by **every sync**, because sync prunes rows not present in the result — a partial list would delete real data.

Newest-N collections (announcements, inbox) pass `maxPages` and accept that older rows are pruned. Apart from `get_planner` for a range outside the cached window (fetched live through `fetchPlannerRange`, not stored), the tools never call Canvas list endpoints directly.

## Endpoints in use

| Purpose | Method + path | Used by |
|---|---|---|
| Active courses with term (+ `default_view`) | `GET /courses?enrollment_state=active&include[]=term` | `courses` sync |
| Course navigation | `GET /courses/:c/tabs` | `courses` sync (one per course; students receive visible tabs only) |
| Front page with body | `GET /courses/:c/front_page` | `home` probe + sync; page loader fallback. 404 = the course has no front page |
| Module list (probe) | `GET /courses/:c/modules` | `modules` probe (fingerprint) |
| Modules with inline items | `GET /courses/:c/modules?include[]=items` | `modules` full sync |
| Items of one module | `GET /courses/:c/modules/:m/items` | `modules` partial sync; fallback when Canvas omits inline items |
| Compact assignments | `GET /courses/:c/assignment_groups?include[]=assignments&exclude_response_fields[]=description&exclude_response_fields[]=rubric` | `assignments` sync (falls back to `GET /courses/:c/assignments`) |
| Single assignment (with description) | `GET /courses/:c/assignments/:a` | `fetchAssignmentWithDescription` (get_assignment, assignment indexing) |
| Own submissions | `GET /courses/:c/students/submissions?student_ids[]=self` | `submissions` sync |
| Course files (list / probe) | `GET /courses/:c/files?sort=updated_at&order=desc[&per_page=1]` | `files` sync / probe — 403 when the course hides Files |
| File metadata | `GET /courses/:c/files/:f`, then `GET /files/:f` | `fetchFileMetadata` (indexing, read_document) |
| Signed download URL | `GET /files/:f/public_url` | file indexing |
| Published pages (list / probe) | `GET /courses/:c/pages?published=true&sort=updated_at&order=desc[&per_page=1]` | `pages` sync / probe — 404 when the course hides Pages |
| Single page with body | `GET /courses/:c/pages/:slug` | page indexing (works even when the Pages listing is 404) |
| Announcements (list / probe) | `GET /courses/:c/discussion_topics?only_announcements=true[&per_page=1]` | `announcements` sync / probe |
| Discussion topics (list / probe) | `GET /courses/:c/discussion_topics?order_by=recent_activity[&per_page=1]` | `discussions` sync / probe (announcements are excluded without `only_announcements`) |
| Discussion replies | `GET /courses/:c/discussion_topics/:id/view` | `ensureDiscussionThread`, when the topic's `last_reply_at` moved; the whole tree in one response (`participants`, nested `view[].replies`), deleted entries skipped |
| Quizzes | `GET /courses/:c/quizzes` | `quizzes` sync (time limit, attempts, question count, availability, `assignment_id`) |
| Syllabus | `GET /courses/:c?include[]=syllabus_body` | `syllabus` probe + sync (the body is fingerprinted; there is no timestamp) |
| Planner | `GET /planner/items?start_date&end_date` | `planner` sync (rolling window) and `get_planner` for ranges outside it (live, not stored) |
| Inbox list (list / probe) | `GET /conversations[?per_page=1]` | `inbox` sync / probe |
| Inbox thread | `GET /conversations/:id?auto_mark_as_read=false` | `inbox` sync, for conversations whose `last_message_at` moved. Without the flag Canvas marks an unread conversation read when it is fetched |

Verified against q.utoronto.ca on 2026-09-17: ETag/`If-None-Match` is **not** honoured (200, never 304); `exclude_response_fields` works; all three probed courses return 403 for `/files` and 404 for `/pages`.

Verified 2026-09-18 on a course whose Home is a front page (`default_view: wiki`): `/front_page` and `/pages/:slug` return 200 with the body although the Pages listing is 404 and the Files listing, `/folders/root` and folder listings are all 403; a file linked from the front page is readable by id through both `/courses/:c/files/:id` and `/files/:id`, and `/files/:id/public_url` works. Hidden tabs are simply absent from `/tabs` for students. So **hidden areas restrict listing, not access**: discovery has to come from links.

## Response handling conventions

- Responses are shaped in `canvas/collections.ts` before storage (`Shaped*` types in `types/canvas.ts`); the model never sees a raw Canvas object.
- A login redirect (HTML with status 200) is detected by content type in `canvas/http.ts` and reported as a sign-in problem, not a parse error.

## Entity types (`types/canvas.ts`)

Thin interfaces for the fields the code reads: `CanvasCourse` (incl. `default_view`), `CanvasTab`, `CanvasModule` (incl. `prerequisite_module_ids`, optional inline `items`), `CanvasModuleItem` (`type`, `content_id`, `page_url`, `external_url`), `CanvasAssignment`, `CanvasPage` (`url` is the slug; `body` only on single fetches), `CanvasFile` (`modified_at`/`updated_at` used as version), `CanvasDiscussionTopic` / `CanvasDiscussionView` / `CanvasDiscussionEntry`, `CanvasQuiz`; plus the `Shaped*` rows collections store and `ContentLink`. Ids are typed `number | string` because Canvas returns numbers and the graph stores strings. A few response types used by one collection only (announcements, conversations, submissions, planner items) are declared in `collections.ts`.

Module item `type` values seen: `File`, `Page`, `Assignment`, `Quiz`, `Discussion`, `SubHeader`, `ExternalUrl`, `ExternalTool`. `File`, `Page`, `Assignment` (its description) and `Discussion` (its thread) items point at documents the tools can read and search; `ExternalUrl` / `ExternalTool` carry their destination in `external_url`, stored as `content_ref`.

## Rate limiting

Canvas throttles bursts. The code keeps Canvas calls sequential (tools execute one at a time; `ensureCollections` runs in series; the courses sync fetches each course's tabs in series). Canvas requests have no retry/backoff (model calls do: `02-agent-loop.md` → Rate limits).
