/**
 * The Canvas deployment this session talks to. Set once at startup / Connect from
 * `settings.canvasHost` after the origin permission is confirmed; nothing else may hardcode a host.
 */
let configuredHost: string | null = null;

export function configureCanvas(host: string): void {
  configuredHost = host;
}

/** The connected Canvas host ("q.utoronto.ca"), or throws when the panel is not connected yet. */
export function canvasHost(): string {
  if (!configuredHost) throw new Error('Not connected to Canvas. Open your Canvas site and connect from the CanvasBuddy panel first.');
  return configuredHost;
}

export function canvasBase(): string {
  return `https://${canvasHost()}/api/v1`;
}

/**
 * Canvas returned a non-2xx status. `status` lets callers distinguish "this course hides
 * this collection" (403/404, permanent) from transient failures.
 */
export class CanvasHttpError extends Error {
  status: number;
  constructor(status: number, statusText: string, label: string) {
    super(`Canvas ${status} ${statusText} while fetching ${label}`);
    this.name = 'CanvasHttpError';
    this.status = status;
  }
}

export function isUnavailableError(e: unknown): boolean {
  return e instanceof CanvasHttpError && (e.status === 403 || e.status === 404);
}

let sessionListener: (() => void) | null = null;

/** Called (once per request) when Canvas answers with a sign-in page instead of JSON. */
export function onSessionLost(listener: (() => void) | null): void {
  sessionListener = listener;
}

/**
 * A signed-out session gets a 200 HTML login page, not an error status. Detecting it here keeps
 * every sync from failing on a JSON parse and lets the app re-check who is signed in (the user
 * may have switched accounts, which must not be mixed into this identity's memory).
 */
function assertJson(response: Response, label: string): void {
  if (/application\/json/i.test(response.headers.get('content-type') || '')) return;
  sessionListener?.();
  throw new Error(`Canvas returned a sign-in page instead of ${label}; sign in to ${canvasHost()} and try again`);
}

/** GET with the browser's Canvas session; throws CanvasHttpError on non-OK. */
export async function canvasGet<T = unknown>(path: string, label: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${canvasBase()}${path}`;
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new CanvasHttpError(response.status, response.statusText, label);
  assertJson(response, label);
  return (await response.json()) as T;
}

/**
 * Fetches every page of a paginated Canvas list endpoint by following the
 * `Link: <...>; rel="next"` header. Sync prunes anything not in the result set,
 * so returning a partial list would delete real data — any failure throws. `maxPages` bounds
 * collections where only the newest N matter (announcements, inbox); the caller accepts that
 * anything beyond is pruned.
 */
export async function fetchAllPages<T>(path: string, label: string, maxPages = 100): Promise<T[]> {
  const all: T[] = [];
  let next: string | null = path.startsWith('http') ? path : `${canvasBase()}${path}`;
  let guard = 0;

  while (next && guard++ < maxPages) {
    const response: Response = await fetch(next, { credentials: 'include' });
    if (!response.ok) throw new CanvasHttpError(response.status, response.statusText, label);
    assertJson(response, label);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error(`Unexpected ${label} response format from Canvas`);
    all.push(...(page as T[]));
    next = parseNextLink(response.headers.get('Link'));
  }

  return all;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
