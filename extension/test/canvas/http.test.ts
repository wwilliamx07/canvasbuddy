import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasGet, CanvasHttpError, fetchAllPages, isUnavailableError, onSessionLost } from '../../src/canvas/http';
import { reply, stubCanvas } from '../helpers/canvas';

afterEach(() => onSessionLost(null));

describe('fetchAllPages', () => {
  const items = [1, 2, 3, 4, 5].map((id) => ({ id }));

  it('follows Link rel="next" until the list is exhausted', async () => {
    const canvas = stubCanvas({ '/courses': items });
    expect(await fetchAllPages('/courses?per_page=2', 'courses')).toEqual(items);
    expect(canvas.calls).toEqual(['/courses?per_page=2', '/courses?per_page=2&page=2', '/courses?per_page=2&page=3']);
  });

  it('stops at maxPages', async () => {
    stubCanvas({ '/courses': items });
    expect(await fetchAllPages('/courses?per_page=2', 'courses', 2)).toEqual(items.slice(0, 4));
  });

  it('throws on a failed page rather than returning a partial list (sync would prune the rest)', async () => {
    stubCanvas({
      '/courses': (url: URL) => (url.searchParams.get('page') === '2' ? reply.status(500) : items),
    });
    await expect(fetchAllPages('/courses?per_page=2', 'courses')).rejects.toThrow(CanvasHttpError);
  });

  it('rejects a non-array body', async () => {
    stubCanvas({ '/courses': { id: 1 } });
    await expect(fetchAllPages('/courses', 'courses')).rejects.toThrow(/Unexpected courses response/);
  });
});

describe('errors', () => {
  it('CanvasHttpError carries the status; 403/404 count as unavailable', async () => {
    stubCanvas({ '/courses/1/files': reply.status(403) });
    const error = (await canvasGet('/courses/1/files', 'files').catch((e) => e)) as CanvasHttpError;
    expect(error).toBeInstanceOf(CanvasHttpError);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/403.*files/);
    expect(isUnavailableError(error)).toBe(true);
    expect(isUnavailableError(new CanvasHttpError(500, 'Server Error', 'x'))).toBe(false);
  });

  it('a sign-in page (HTML with 200) fires the session-lost listener and throws', async () => {
    stubCanvas({ '/users/self': reply.loginPage() });
    const listener = vi.fn();
    onSessionLost(listener);
    await expect(canvasGet('/users/self', 'your profile')).rejects.toThrow(/sign-in page/);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('host', () => {
  it('canvasHost() throws until configureCanvas has run', async () => {
    vi.resetModules();
    const fresh = await import('../../src/canvas/http');
    expect(() => fresh.canvasHost()).toThrow(/Not connected to Canvas/);
    fresh.configureCanvas('canvas.test');
    expect(fresh.canvasBase()).toBe('https://canvas.test/api/v1');
  });
});
