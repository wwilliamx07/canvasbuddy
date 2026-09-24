import { getDB, q, withTransaction, type Queryable } from '../db/pglite';
import { clearGraphRows, forgetCollectionRows, forgetCourseRows } from '../db/graph';
import { isUnavailableError } from './http';
import type { AppSettings } from '../settings';

/**
 * Freshness engine. Every tool reads the local graph; before it does, `ensureCurrent` decides
 * whether the collection it needs is missing, stale, or unchanged, and syncs only when needed.
 * The model never sees this — freshness is code policy, not model discretion.
 */

export type CollectionKind =
  | 'courses'
  | 'modules'
  | 'assignments'
  | 'files'
  | 'pages'
  | 'submissions'
  | 'announcements'
  | 'planner'
  | 'inbox'
  | 'home'
  | 'discussions'
  | 'quizzes'
  | 'syllabus';

/** All values in minutes. Editable in Settings; merged over DEFAULT_FRESHNESS. */
export interface FreshnessSettings {
  courses: number;
  modules: number;
  assignments: number;
  files: number;
  pages: number;
  submissions: number;
  announcements: number;
  planner: number;
  inbox: number;
  /** The course front page and the files/pages it links to. */
  home: number;
  /** Discussion topics (replies are fetched when a thread is read). */
  discussions: number;
  quizzes: number;
  /** The Syllabus tab body. */
  syllabus: number;
  /** Skip re-probing a scope that was checked this recently (one tool loop touches a scope many times). */
  probeDebounce: number;
  /** How long to remember that a course hides a collection (403/404) before trying again. */
  unavailableRetry: number;
}

const H = 60;
const D = 24 * H;
export const DEFAULT_FRESHNESS: FreshnessSettings = {
  courses: 7 * D,
  modules: 1 * D,
  assignments: 12 * H,
  files: 1 * D,
  pages: 1 * D,
  submissions: 20,
  announcements: 30,
  planner: 15,
  inbox: 15,
  home: 1 * D,
  discussions: 30,
  quizzes: 12 * H,
  syllabus: 1 * D,
  probeDebounce: 3,
  unavailableRetry: 1 * D,
};

export function resolveFreshness(settings: Pick<AppSettings, 'freshness'>): FreshnessSettings {
  return { ...DEFAULT_FRESHNESS, ...(settings.freshness || {}) };
}

export interface ScopeContext {
  courseId?: string;
}

/** 'courses' | 'planner' | 'inbox' | 'course:<id>:<collection>' */
export function scopeKey(kind: CollectionKind, ctx: ScopeContext): string {
  if (kind === 'courses' || kind === 'planner' || kind === 'inbox') return kind;
  if (!ctx.courseId) throw new Error(`course_id is required for ${kind}`);
  return `course:${ctx.courseId}:${kind}`;
}

export interface SyncState {
  scope: string;
  syncedAt: Date | null;
  probedAt: Date | null;
  fingerprint: string | null;
  status: 'ok' | 'unavailable';
  error: string | null;
}

export type ProbeResult =
  | { kind: 'unchanged' }
  | { kind: 'changed'; data?: unknown }
  | { kind: 'unsupported' };

export interface SyncOutcome {
  /** Opaque value the next probe compares against (e.g. a module-list fingerprint). */
  fingerprint?: string | null;
  /** Human-readable, surfaced in tool notes ("modules re-synced from Canvas just now (3 modules, …)"). */
  summary?: string;
}

export interface SyncInfo {
  state: SyncState | null;
  /** Whatever the probe returned in { kind: 'changed', data } — lets a sync be partial. */
  probeData?: unknown;
  settings: AppSettings;
}

export interface CollectionSpec {
  kind: CollectionKind;
  /**
   * Cheap upstream change check, consulted only while the scope is within its TTL.
   * Omit (or return 'unsupported') for collections Canvas gives no narrow query for.
   */
  probe?: (ctx: ScopeContext, state: SyncState) => Promise<ProbeResult>;
  /** Full (or, given probe data, partial) sync into the graph. Must throw on failure. */
  sync: (ctx: ScopeContext, info: SyncInfo) => Promise<SyncOutcome | void>;
}

export type EnsureStatus = 'fresh' | 'synced' | 'unavailable' | 'error';

export interface EnsureResult {
  kind: CollectionKind;
  scope: string;
  status: EnsureStatus;
  syncedNow: boolean;
  ageMinutes: number | null;
  summary?: string;
  error?: string;
}

export interface EnsureOptions {
  settings: AppSettings;
  /** The user said something changed: bypass debounce, probe and TTL and sync now. */
  refresh?: boolean;
}

// ---------------------------------------------------------------------------
// sync_state persistence
// ---------------------------------------------------------------------------

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

interface SyncStateRow {
  scope: string;
  synced_at: string | Date | null;
  probed_at: string | Date | null;
  fingerprint: string | null;
  status: string;
  error: string | null;
}

export async function getSyncState(scope: string): Promise<SyncState | null> {
  const db = await getDB();
  const res = await db.query<SyncStateRow>('SELECT * FROM sync_state WHERE scope = $1', [scope]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    scope: r.scope,
    syncedAt: toDate(r.synced_at),
    probedAt: toDate(r.probed_at),
    fingerprint: r.fingerprint ?? null,
    status: r.status === 'unavailable' ? 'unavailable' : 'ok',
    error: r.error ?? null,
  };
}

async function setSyncState(
  scope: string,
  patch: Partial<Omit<SyncState, 'scope'>>
): Promise<void> {
  const db = await getDB();
  await db.query(
    `INSERT INTO sync_state (scope, synced_at, probed_at, fingerprint, status, error)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'ok'), $6)
     ON CONFLICT (scope) DO UPDATE SET
       synced_at   = COALESCE(EXCLUDED.synced_at, sync_state.synced_at),
       probed_at   = COALESCE(EXCLUDED.probed_at, sync_state.probed_at),
       fingerprint = CASE WHEN $7::boolean THEN EXCLUDED.fingerprint ELSE sync_state.fingerprint END,
       status      = COALESCE($5, sync_state.status),
       error       = CASE WHEN $8::boolean THEN EXCLUDED.error ELSE sync_state.error END`,
    [
      scope,
      patch.syncedAt ?? null,
      patch.probedAt ?? null,
      patch.fingerprint ?? null,
      patch.status ?? null,
      patch.error ?? null,
      'fingerprint' in patch,
      'error' in patch,
    ]
  );
}

/** Forget a scope and everything under it (`course:<id>` takes all of that course's collections). */
export async function clearSyncState(scopePrefix: string, tx?: Queryable): Promise<void> {
  const db = await q(tx);
  await db.query('DELETE FROM sync_state WHERE scope = $1 OR scope LIKE $2', [scopePrefix, `${scopePrefix}:%`]);
}

/**
 * Forgets one course collection: its rows go in one transaction, then its sync stamp, so the next
 * `ensureCollection` for it starts from nothing. The only way the UI changes the graph besides
 * forgetting the whole memory.
 */
export async function forgetCollection(kind: CollectionKind, courseId: string): Promise<void> {
  const scope = scopeKey(kind, { courseId });
  await withTransaction(async (tx) => {
    await forgetCollectionRows(kind, courseId, tx);
    // Forgetting the pages removes the front page row too; the home stamp would otherwise say it is current
    const scopes = kind === 'pages' ? [scope, scopeKey('home', { courseId })] : [scope];
    await tx.query('DELETE FROM sync_state WHERE scope = ANY($1::text[])', [scopes]);
  });
}

/**
 * Forgets one course: its rows, its documents and its sync stamps. The roster stamp goes too, so
 * the course reappears on the next turn (the courses TTL is a week) rather than staying hidden.
 */
export async function forgetCourse(courseId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await forgetCourseRows(courseId, tx);
    await tx.query("DELETE FROM sync_state WHERE scope = 'courses' OR scope LIKE $1", [`course:${courseId}:%`]);
  });
}

/** Forgets the whole graph (every course, document, planner, inbox) and every sync stamp. Chats are kept. */
export async function forgetEverything(): Promise<void> {
  await withTransaction(async (tx) => {
    await clearGraphRows(tx);
    await tx.query('DELETE FROM sync_state');
  });
}

// ---------------------------------------------------------------------------
// ensureCurrent
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<EnsureResult>>();

/**
 * Decision procedure (see reference/04-knowledge-graph.md → Freshness):
 *   refresh            → sync
 *   unavailable        → skip until unavailableRetry elapses
 *   probed recently    → fresh (debounce)
 *   never synced / past TTL → full sync (also the backstop for deletions probes can't see)
 *   within TTL         → probe: changed → sync (with probe data); otherwise fresh
 */
export async function ensureCurrent(
  spec: CollectionSpec,
  ctx: ScopeContext,
  opts: EnsureOptions
): Promise<EnsureResult> {
  const scope = scopeKey(spec.kind, ctx);
  const existing = inFlight.get(scope);
  if (existing) return existing;

  const run = (async (): Promise<EnsureResult> => {
    const fr = resolveFreshness(opts.settings);
    const ttlMs = fr[spec.kind] * 60_000;
    const now = Date.now();
    const state = await getSyncState(scope);
    const ageMs = state?.syncedAt ? now - state.syncedAt.getTime() : null;
    const ageMinutes = ageMs == null ? null : ageMs / 60_000;
    const base = { kind: spec.kind, scope, ageMinutes };

    if (!opts.refresh) {
      if (state?.status === 'unavailable') {
        const sinceProbe = state.probedAt ? now - state.probedAt.getTime() : Infinity;
        if (sinceProbe < fr.unavailableRetry * 60_000) {
          return { ...base, status: 'unavailable', syncedNow: false, error: state.error ?? undefined };
        }
      } else if (state?.syncedAt && state.probedAt && now - state.probedAt.getTime() < fr.probeDebounce * 60_000) {
        return { ...base, status: 'fresh', syncedNow: false };
      }
    }

    let probeData: unknown;
    let mustSync = opts.refresh || ageMs == null || ageMs >= ttlMs || state?.status === 'unavailable';

    if (!mustSync && spec.probe && state) {
      try {
        const r = await spec.probe(ctx, state);
        if (r.kind === 'changed') {
          mustSync = true;
          probeData = r.data;
        }
      } catch (e) {
        if (isUnavailableError(e)) {
          await setSyncState(scope, { probedAt: new Date(now), status: 'unavailable', error: (e as Error).message });
          return { ...base, status: 'unavailable', syncedNow: false, error: (e as Error).message };
        }
        // Probe failed transiently: keep serving the cached copy, try again after the debounce.
        await setSyncState(scope, { probedAt: new Date(now), error: (e as Error).message });
        return { ...base, status: 'fresh', syncedNow: false, error: (e as Error).message };
      }
    }

    if (!mustSync) {
      // A probe that answered clears an error left by an earlier failed probe or sync: Canvas is
      // reachable and the stored copy is current, so nothing should say "failed" any more
      await setSyncState(scope, { probedAt: new Date(now), ...(spec.probe && state ? { error: null } : {}) });
      return { ...base, status: 'fresh', syncedNow: false };
    }

    try {
      const outcome = (await spec.sync(ctx, { state, probeData, settings: opts.settings })) || {};
      const done = new Date();
      await setSyncState(scope, {
        syncedAt: done,
        probedAt: done,
        status: 'ok',
        error: null,
        ...(outcome.fingerprint !== undefined ? { fingerprint: outcome.fingerprint } : {}),
      });
      return { ...base, ageMinutes: 0, status: 'synced', syncedNow: true, summary: outcome.summary };
    } catch (e) {
      const message = (e as Error).message || String(e);
      if (isUnavailableError(e)) {
        await setSyncState(scope, { probedAt: new Date(), status: 'unavailable', error: message });
        return { ...base, status: 'unavailable', syncedNow: false, error: message };
      }
      await setSyncState(scope, { probedAt: new Date(), error: message });
      return { ...base, status: 'error', syncedNow: false, error: message };
    }
  })().finally(() => inFlight.delete(scope));

  inFlight.set(scope, run);
  return run;
}

/** Short human label for tool results / UI ("synced just now", "unavailable in this course"). */
export function describeEnsure(r: EnsureResult): string | null {
  switch (r.status) {
    case 'synced':
      return `${r.kind} re-synced from Canvas just now${r.summary ? ` (${r.summary})` : ''}.`;
    case 'unavailable':
      return `${r.kind} are not available in this course (Canvas hides them from students).`;
    case 'error':
      return `Could not refresh ${r.kind} (${r.error}); showing cached data${r.ageMinutes != null ? ` from ${Math.round(r.ageMinutes)} min ago` : ''}.`;
    default:
      return null;
  }
}
