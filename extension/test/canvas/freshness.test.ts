import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { count, openTestDb, resetTestDb } from '../helpers/db';
import {
  describeEnsure,
  ensureCurrent,
  forgetCollection,
  getSyncState,
  type CollectionSpec,
  type ProbeResult,
  type ScopeContext,
  type SyncInfo,
  type SyncState,
} from '../../src/canvas/freshness';
import { CanvasHttpError } from '../../src/canvas/http';
import { upsertCourses } from '../../src/db/graph';
import { normalizeSettings } from '../../src/settings';

let db: PGlite;
const MIN = 60_000;
// modules: TTL 1 day; probe debounce 3 min; unavailable retry 1 day (DEFAULT_FRESHNESS)
const settings = normalizeSettings({ providers: { google: { apiKey: 'test' } } });
const ctx = { courseId: '1' };
const T0 = new Date('2026-09-23T12:00:00Z').getTime();

function fakeSpec(probe: ProbeResult | (() => Promise<ProbeResult>) = { kind: 'unchanged' }) {
  const spec = {
    kind: 'modules' as const,
    probe: vi.fn(async (_ctx: ScopeContext, _state: SyncState): Promise<ProbeResult> => (typeof probe === 'function' ? probe() : probe)),
    sync: vi.fn(async (_ctx: ScopeContext, _info: SyncInfo) => ({ fingerprint: 'fp-1', summary: '2 modules' })),
  };
  return spec satisfies CollectionSpec;
}

const at = (ms: number) => vi.setSystemTime(T0 + ms);

beforeAll(async () => {
  db = await openTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  await upsertCourses([{ id: 1, name: 'Algorithms' }]);
  // Only Date is faked: PGlite runs its own timers
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
});

describe('ensureCurrent', () => {
  it('never synced → sync, stamping synced_at and the fingerprint', async () => {
    const spec = fakeSpec();
    const r = await ensureCurrent(spec, ctx, { settings });
    expect(r).toMatchObject({ status: 'synced', syncedNow: true, ageMinutes: 0, summary: '2 modules', scope: 'course:1:modules' });
    expect(spec.probe).not.toHaveBeenCalled();
    const state = await getSyncState('course:1:modules');
    expect(state).toMatchObject({ fingerprint: 'fp-1', status: 'ok', error: null });
    expect(state?.syncedAt?.getTime()).toBe(T0);
  });

  it('within the probe debounce → fresh without probing', async () => {
    const spec = fakeSpec();
    await ensureCurrent(spec, ctx, { settings });
    at(2 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'fresh', syncedNow: false });
    expect(spec.probe).not.toHaveBeenCalled();
    expect(spec.sync).toHaveBeenCalledOnce();
  });

  it('within TTL, probe unchanged → fresh; the probe is stamped', async () => {
    const spec = fakeSpec({ kind: 'unchanged' });
    await ensureCurrent(spec, ctx, { settings });
    at(10 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'fresh', syncedNow: false });
    expect(spec.probe).toHaveBeenCalledOnce();
    expect(spec.sync).toHaveBeenCalledOnce();
    expect((await getSyncState('course:1:modules'))?.probedAt?.getTime()).toBe(T0 + 10 * MIN);
  });

  it('probe changed → sync receives the probe data', async () => {
    const spec = fakeSpec({ kind: 'changed', data: { changedModules: ['10'] } });
    await ensureCurrent(spec, ctx, { settings });
    at(10 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'synced' });
    expect(spec.sync).toHaveBeenCalledTimes(2);
    expect(spec.sync.mock.calls[1][1]).toMatchObject({ probeData: { changedModules: ['10'] } });
    expect(spec.sync.mock.calls[1][1].state).toMatchObject({ fingerprint: 'fp-1' });
  });

  it('past the TTL → sync regardless of the probe', async () => {
    const spec = fakeSpec({ kind: 'unchanged' });
    await ensureCurrent(spec, ctx, { settings });
    at(25 * 60 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'synced' });
    expect(spec.probe).not.toHaveBeenCalled();
  });

  it('refresh bypasses debounce, probe and TTL', async () => {
    const spec = fakeSpec({ kind: 'unchanged' });
    await ensureCurrent(spec, ctx, { settings });
    at(1 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings, refresh: true })).toMatchObject({ status: 'synced' });
    expect(spec.probe).not.toHaveBeenCalled();
    expect(spec.sync).toHaveBeenCalledTimes(2);
  });

  it('a 403 marks the collection unavailable, skipped until unavailableRetry, then retried', async () => {
    const spec = fakeSpec();
    spec.sync.mockRejectedValueOnce(new CanvasHttpError(403, 'Forbidden', 'modules'));
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'unavailable', syncedNow: false });
    expect((await getSyncState('course:1:modules'))?.status).toBe('unavailable');

    at(60 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'unavailable' });
    expect(spec.sync).toHaveBeenCalledOnce();

    at(25 * 60 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'synced' });
    expect((await getSyncState('course:1:modules'))?.status).toBe('ok');
  });

  it('a transient probe failure serves the cached copy and records the error', async () => {
    const spec = fakeSpec(async () => {
      throw new Error('network down');
    });
    await ensureCurrent(spec, ctx, { settings });
    at(10 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'fresh', error: 'network down' });
    expect(spec.sync).toHaveBeenCalledOnce();
    expect((await getSyncState('course:1:modules'))?.status).toBe('ok');
  });

  it('a probe that answers again clears the error of the one that failed', async () => {
    let fail = true;
    const spec = fakeSpec(async () => {
      if (fail) throw new Error('network down');
      return { kind: 'unchanged' };
    });
    await ensureCurrent(spec, ctx, { settings });
    at(10 * MIN);
    await ensureCurrent(spec, ctx, { settings });
    expect((await getSyncState('course:1:modules'))?.error).toBe('network down');
    fail = false;
    at(20 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'fresh', syncedNow: false });
    expect((await getSyncState('course:1:modules'))?.error).toBeNull();
  });

  it('a probe 404 marks the collection unavailable', async () => {
    const spec = fakeSpec(async () => {
      throw new CanvasHttpError(404, 'Not Found', 'modules');
    });
    await ensureCurrent(spec, ctx, { settings });
    at(10 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'unavailable' });
  });

  it('a failing sync reports error and keeps the previous stamp', async () => {
    const spec = fakeSpec();
    await ensureCurrent(spec, ctx, { settings });
    spec.sync.mockRejectedValueOnce(new Error('Canvas 500'));
    at(25 * 60 * MIN);
    const r = await ensureCurrent(spec, ctx, { settings });
    expect(r).toMatchObject({ status: 'error', error: 'Canvas 500' });
    expect((await getSyncState('course:1:modules'))?.syncedAt?.getTime()).toBe(T0);
  });

  it('concurrent calls for one scope share one sync', async () => {
    const spec = fakeSpec();
    const [a, b] = await Promise.all([ensureCurrent(spec, ctx, { settings }), ensureCurrent(spec, ctx, { settings })]);
    expect(a).toBe(b);
    expect(spec.sync).toHaveBeenCalledOnce();
  });

  it('course collections need a course id', async () => {
    await expect(ensureCurrent(fakeSpec(), {}, { settings })).rejects.toThrow(/course_id is required/);
  });

  it('honours per-collection minutes from settings', async () => {
    const spec = fakeSpec({ kind: 'unchanged' });
    const short = normalizeSettings({ freshness: { modules: 5, probeDebounce: 0 } });
    await ensureCurrent(spec, ctx, { settings: short });
    at(6 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings: short })).toMatchObject({ status: 'synced' });
  });
});

describe('forgetCollection', () => {
  it('clears the stamp so the next call syncs again', async () => {
    const spec = fakeSpec();
    await ensureCurrent(spec, ctx, { settings });
    await forgetCollection('modules', '1');
    expect(await getSyncState('course:1:modules')).toBeNull();
    at(1 * MIN);
    expect(await ensureCurrent(spec, ctx, { settings })).toMatchObject({ status: 'synced' });
  });

  it('forgetting pages also drops the home stamp', async () => {
    await db.query("INSERT INTO sync_state (scope, synced_at) VALUES ('course:1:pages', now()), ('course:1:home', now()), ('course:1:modules', now())");
    await forgetCollection('pages', '1');
    expect((await db.query<any>('SELECT scope FROM sync_state')).rows).toEqual([{ scope: 'course:1:modules' }]);
    expect(await count(db, 'sync_state')).toBe(1);
  });
});

describe('describeEnsure', () => {
  const base = { kind: 'modules' as const, scope: 'course:1:modules', syncedNow: false, ageMinutes: 42 };
  it.each([
    [{ ...base, status: 'synced' as const, summary: '3 modules' }, 'modules re-synced from Canvas just now (3 modules).'],
    [{ ...base, status: 'unavailable' as const }, 'modules are not available in this course (Canvas hides them from students).'],
    [{ ...base, status: 'error' as const, error: 'timeout' }, 'Could not refresh modules (timeout); showing cached data from 42 min ago.'],
    [{ ...base, status: 'fresh' as const }, null],
  ])('%o', (result, text) => {
    expect(describeEnsure(result)).toBe(text);
  });
});
