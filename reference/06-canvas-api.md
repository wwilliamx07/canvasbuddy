# 06 — Canvas API integration

Sources: `src/canvas/http.ts` (`CANVAS_BASE`, `canvasGet`, `fetchAllPages`, `CanvasHttpError`), `src/canvas/collections.ts` (collection fetches), `src/canvas/sync.ts` (document fetches), entity types in `src/types/canvas.ts`.

## Authentication model

There is no Canvas API token. Every request is made from the extension page with `fetch(url, { credentials: 'include' })`, and the browser attaches the user's Quercus session cookies because `manifest.json` grants `host_permissions` for `https://*.utoronto.ca/*`. Consequences:

- The user must be logged in to Quercus in the same browser profile; otherwise Canvas returns a login redirect/HTML, which the code does not currently detect (`response.json()` fails or a non-array is returned).
- The base URL `https://q.utoronto.ca/api/v1` is `CANVAS_BASE` in `canvas/http.ts` — the only place it appears. Supporting another institution means changing it and the manifest host permission.
- File downloads go through `/files/:id/public_url` to obtain a signed URL, then a plain `fetch` (no credentials) to that URL.

## Pagination

Canvas list endpoints page at `per_page` (max 100) and advertise the next page in a `Link` header. `fetchAllPages(path, label)` in `canvas/http.ts`:

- follows `rel="next"` until absent (guard of 100 pages);
- throws `CanvasHttpError` (with `.status`) on any non-OK page, or a plain `Error` on a non-array body; 403/404 are treated by the freshness engine as "this course hides this collection";
- is used by **every sync**, because sync prunes rows not present in the result — a partial list would delete real data.

Newest-N collections (announcements, inbox) pass `maxPages` and accept that older rows are pruned. The tools never call Canvas list endpoints directly.

## Endpoints in use

| Purpose | Method + path | Used by |
|---|---|---|
| Active courses with term | `GET /courses?enrollment_state=active&include[]=term` | `courses` sync |
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
| Single page with body | `GET /courses/:c/pages/:slug` | page indexing |
| Announcements (list / probe) | `GET /courses/:c/discussion_topics?only_announcements=true[&per_page=1]` | `announcements` sync / probe |
| Planner | `GET /planner/items?start_date&end_date` | `planner` sync (rolling window) and `get_planner` for ranges outside it (live, not stored) |
| Inbox list (list / probe) | `GET /conversations[?per_page=1]` | `inbox` sync / probe |
| Inbox thread | `GET /conversations/:id` | `inbox` sync, for conversations whose `last_message_at` moved |

Verified against q.utoronto.ca on 2026-09-17: ETag/`If-None-Match` is **not** honoured (200, never 304); `exclude_response_fields` works; all three probed courses return 403 for `/files` and 404 for `/pages`.

## Response handling conventions

- Every Canvas request goes through `canvasGet` / `fetchAllPages`, which throw `CanvasHttpError` (with `.status`) on non-OK. The freshness engine treats 403/404 as "this course hides this collection" and marks the scope unavailable.
- Responses are shaped in `canvas/collections.ts` before storage (`Shaped*` types in `types/canvas.ts`); the model never sees a raw Canvas object.
- A login redirect (HTML with status 200) surfaces as a JSON parse error / "Unexpected … response format"; it is not yet detected specifically.

## Entity types (`types/canvas.ts`)

Thin interfaces for the fields the code reads: `CanvasCourse`, `CanvasModule` (incl. `prerequisite_module_ids`, optional inline `items`), `CanvasModuleItem` (`type`, `content_id`, `page_url`), `CanvasAssignment`, `CanvasPage` (`url` is the slug; `body` only on single-page fetch), `CanvasFile` (`modified_at`/`updated_at` used as version). Ids are typed `number | string` because Canvas returns numbers and the graph stores strings.

Module item `type` values seen: `File`, `Page`, `Assignment`, `Quiz`, `Discussion`, `SubHeader`, `ExternalUrl`, `ExternalTool`. Only `File` and `Page` are indexable through module items; assignments are indexed via the assignments collection.

## Rate limiting

Canvas throttles bursts. The code keeps Canvas calls sequential (tools execute one at a time; the Graph Explorer's "Refresh Course" runs the four collection syncs in series). There is no retry/backoff.
