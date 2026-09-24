import { vi } from 'vitest';
import { configureCanvas } from '../../src/canvas/http';

/**
 * A fake Canvas behind a stubbed global `fetch`. Routes are keyed by the path under `/api/v1`
 * (`/courses/1/modules`), optionally with its query (`/courses/1/files?sort=updated_at&per_page=1`);
 * a key with a query wins over the bare path. Anything else (file downloads) is keyed by full URL.
 * A route is plain JSON (200) or a `reply(...)`; array bodies are paginated when the request has
 * `per_page`, with a `Link: rel="next"` header like Canvas. Every request is recorded in `calls`.
 */

export const HOST = 'canvas.test';
export const API = `https://${HOST}/api/v1`;

export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export const reply = {
  json: (body: unknown, status = 200) => new Reply(status, body),
  status: (status: number, body: unknown = { errors: [{ message: 'fake error' }] }) => new Reply(status, body),
  /** The sign-in page a lost session gets: 200, text/html. */
  loginPage: () => new Reply(200, '<html><body>Log in</body></html>', { 'content-type': 'text/html' }),
  bytes: (body: string | Uint8Array, contentType = 'application/octet-stream') => new Reply(200, body, { 'content-type': contentType }),
};

export type Route = unknown | Reply | ((url: URL, init?: RequestInit) => unknown | Reply);

export interface FakeCanvas {
  /** Keys of every request, in order: `/courses/1/files?sort=updated_at&per_page=1`. */
  calls: string[];
  routes: Record<string, Route>;
  set(key: string, route: Route): void;
  /** Requests to a route key, with or without query. */
  callsTo(pathPrefix: string): string[];
}

/** Route key of a request, decoded (`include[]=items`, however the URL happened to encode it). */
function keyOf(url: URL | string): string {
  const full = decodeURIComponent(url.toString());
  return full.startsWith(API) ? full.slice(API.length) : full;
}

const withoutPageParam = (key: string) => key.replace(/([?&])page=\d+(&|$)/, (_m, lead: string, tail: string) => (tail ? lead : '')).replace(/[?&]$/, '');

function toResponse(value: unknown, url: URL): Response {
  const r = value instanceof Reply ? value : new Reply(200, value);
  let body = r.body;
  const headers = new Headers({ 'content-type': 'application/json', ...r.headers });

  const perPage = Number(url.searchParams.get('per_page'));
  if (Array.isArray(body) && perPage > 0) {
    const page = Number(url.searchParams.get('page') || '1');
    const slice = body.slice((page - 1) * perPage, page * perPage);
    if (page * perPage < body.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      headers.set('Link', `<${next}>; rel="next", <${url}>; rel="current"`);
    }
    body = slice;
  }

  const payload =
    typeof body === 'string' || body instanceof Uint8Array ? body : body === undefined ? '' : JSON.stringify(body);
  return new Response(payload as BodyInit, { status: r.status, headers });
}

/**
 * Installs the fake and points `canvas/http.ts` at it. `fallback` answers anything that is not a
 * Canvas route (an LLM or MCP request in the same test); without it such a request fails the test.
 */
export function stubCanvas(routes: Record<string, Route> = {}, fallback?: (url: URL, init?: RequestInit) => Response | Promise<Response>): FakeCanvas {
  configureCanvas(HOST);
  const fake: FakeCanvas = {
    calls: [],
    routes: { ...routes },
    set(key, route) {
      fake.routes[key] = route;
    },
    callsTo(pathPrefix) {
      return fake.calls.filter((c) => c === pathPrefix || c.startsWith(`${pathPrefix}?`));
    },
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.hostname !== HOST) {
        if (fallback) return fallback(url, init);
        throw new Error(`Unexpected request outside the fake Canvas: ${url}`);
      }
      const key = keyOf(url);
      fake.calls.push(key);
      // Pagination params are the fake's own business; routes are keyed without them
      const candidates = [withoutPageParam(key), key.split('?')[0]];
      const routes = new Map(Object.entries(fake.routes).map(([k, v]) => [keyOf(k.startsWith('http') ? k : `${API}${k}`), v]));
      for (const candidate of candidates) {
        if (routes.has(candidate)) {
          const route = routes.get(candidate);
          const value = typeof route === 'function' ? await (route as (u: URL, i?: RequestInit) => unknown)(url, init) : route;
          return toResponse(value, url);
        }
      }
      return toResponse(reply.status(404, { errors: [{ message: `no fake route for ${key}` }] }), url);
    })
  );
  return fake;
}
