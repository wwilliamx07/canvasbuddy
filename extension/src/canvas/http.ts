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
  if (!configuredHost) throw new Error('Not connected to Canvas. Connect from the Chat tab first.');
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

/** GET with the browser's Canvas session; throws CanvasHttpError on non-OK. */
export async function canvasGet<T = unknown>(path: string, label: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${canvasBase()}${path}`;
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new CanvasHttpError(response.status, response.statusText, label);
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
