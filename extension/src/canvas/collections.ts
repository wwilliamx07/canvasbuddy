import {
  ensureCurrent,
  type CollectionKind,
  type CollectionSpec,
  type EnsureOptions,
  type EnsureResult,
  type ProbeResult,
  type ScopeContext,
  type SyncState,
} from './freshness';
import { canvasGet, fetchAllPages, CanvasHttpError } from './http';
import { withTransaction, type Queryable } from '../db/pglite';
import {
  upsertCourses,
  upsertAndPruneModules,
  upsertAndPruneModuleItems,
  upsertAndPruneAssignments,
  upsertAndPrunePages,
  upsertAndPruneSubmissions,
  upsertAndPruneAnnouncements,
  replacePlannerItems,
  upsertAndPruneConversations,
  upsertMessages,
  getConversationSubject,
  replaceCourseTabs,
  setFrontPage,
  storeContentLinks,
} from '../db/graph';
import { ingestHtml } from './links';
import {
  docIdFor,
  upsertAndPruneKnownFiles,
  upsertDocumentChunksIncremental,
  getChunksMissingEmbedding,
  setChunkEmbeddings,
} from '../db/rag';
import { batchEmbed, resolveEmbeddingModel } from '../embeddings/embeddingClient';
import { htmlToTextWithLinks } from '../utils/canvasLinks';
import type { AppSettings } from '../components/Settings/Settings';
import type {
  CanvasCourse,
  CanvasTab,
  CanvasModule,
  CanvasModuleItem,
  CanvasAssignment,
  CanvasFile,
  CanvasPage,
  ShapedSubmission,
  ShapedAnnouncement,
  ShapedPlannerItem,
  ShapedConversation,
  ShapedMessage,
} from '../types/canvas';

/**
 * Registry of every collection the freshness engine keeps current. Each entry declares how to
 * sync it, and — where Canvas offers a narrow query — how to probe for upstream changes while the
 * cached copy is within its TTL. Everything stored is shaped here; nothing raw reaches the model.
 *
 * Probe status (verified against q.utoronto.ca, 2026-09-17):
 *   modules       module list without items → per-module fingerprint → partial re-sync      ✓
 *   announcements newest posted_at                                                          ✓
 *   inbox         newest last_message_at → per-conversation thread fetch                    ✓
 *   files, pages  newest updated_at via sort=updated_at — unverified (403/404 on all probed
 *                 courses); feature-detected, falls back to TTL
 *   home          front page updated_at (the probe fetch doubles as the sync's input)          ✓
 *   courses, assignments, submissions, planner — no narrow query exists; TTL only
 */

function requireCourse(ctx: ScopeContext, kind: string): string {
  if (!ctx.courseId) throw new Error(`course_id is required to sync ${kind}`);
  return ctx.courseId;
}

const clip = (s: string | null | undefined, n: number): string | null => {
  if (!s) return null;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// ---------------------------------------------------------------------------
// courses
// ---------------------------------------------------------------------------

const courses: CollectionSpec = {
  kind: 'courses',
  sync: async () => {
    const data = await fetchAllPages<CanvasCourse>(
      `/courses?per_page=100&enrollment_state=active&include[]=term`,
      'courses'
    );
    const valid = data.filter((c) => c && c.id && c.name);
    // The nav bar tells the model what each course offers (incl. external tools such as Piazza
    // or lecture-capture) and is one small request per course at the courses TTL.
    const tabs = new Map<string, CanvasTab[]>();
    for (const c of valid) {
      try {
        tabs.set(String(c.id), await canvasGet<CanvasTab[]>(`/courses/${c.id}/tabs`, `tabs for course ${c.id}`));
      } catch (e) {
        if (!(e instanceof CanvasHttpError)) throw e;
      }
    }
    await withTransaction(async (tx) => {
      await upsertCourses(valid, tx);
      for (const [courseId, list] of tabs) await replaceCourseTabs(courseId, list, tx);
    });
    return { summary: `${valid.length} active courses` };
  },
};

// ---------------------------------------------------------------------------
// modules (+ items) — fingerprint probe with partial re-sync
// ---------------------------------------------------------------------------

type ModuleFingerprints = Record<string, string>;

function moduleFingerprint(m: CanvasModule): string {
  return [m.name, m.position ?? 0, m.items_count ?? '', (m.prerequisite_module_ids || []).join(',')].join('|');
}

function fingerprintMap(modules: CanvasModule[]): ModuleFingerprints {
  const out: ModuleFingerprints = {};
  for (const m of modules) out[String(m.id)] = moduleFingerprint(m);
  return out;
}

function parseFingerprints(state: SyncState | null): ModuleFingerprints | null {
  if (!state?.fingerprint) return null;
  try {
    return JSON.parse(state.fingerprint) as ModuleFingerprints;
  } catch {
    return null;
  }
}

/** Ids whose fingerprint is new or different; removed modules are handled by the prune. */
function changedModuleIds(prev: ModuleFingerprints | null, next: ModuleFingerprints): string[] {
  if (!prev) return Object.keys(next);
  return Object.keys(next).filter((id) => prev[id] !== next[id]);
}

const modules: CollectionSpec = {
  kind: 'modules',
  probe: async (ctx, state) => {
    const courseId = requireCourse(ctx, 'modules');
    // ~350 bytes for a course; the items are what cost, and this tells us which modules need them
    const light = await fetchAllPages<CanvasModule>(`/courses/${courseId}/modules?per_page=100`, `modules for course ${courseId}`);
    const next = fingerprintMap(light);
    const prev = parseFingerprints(state);
    const removed = prev ? Object.keys(prev).some((id) => !(id in next)) : false;
    const changed = changedModuleIds(prev, next);
    if (!removed && changed.length === 0) return { kind: 'unchanged' };
    return { kind: 'changed', data: { modules: light, changed } };
  },
  sync: async (ctx, info) => {
    const courseId = requireCourse(ctx, 'modules');
    const partial = info.probeData as { modules: CanvasModule[]; changed: string[] } | undefined;

    if (partial) {
      // Partial: module list is already in hand; fetch items only for changed modules.
      const itemsByModule = new Map<string, CanvasModuleItem[]>();
      for (const id of partial.changed) {
        itemsByModule.set(id, await fetchAllPages<CanvasModuleItem>(
          `/courses/${courseId}/modules/${id}/items?per_page=100`, `items for module ${id}`));
      }
      const result = await withTransaction(async (tx) => {
        const r = await upsertAndPruneModules(courseId, partial.modules, tx);
        let items = 0;
        for (const [id, list] of itemsByModule) items += (await upsertAndPruneModuleItems(id, list, tx)).upserted;
        return { ...r, items };
      });
      return {
        fingerprint: JSON.stringify(fingerprintMap(partial.modules)),
        summary: `${partial.changed.length} of ${partial.modules.length} modules changed (${result.items} items), ${result.pruned} pruned`,
      };
    }

    // Full: modules with inline items. Canvas omits `items` for large modules → per-module fallback.
    const full = await fetchAllPages<CanvasModule>(
      `/courses/${courseId}/modules?per_page=100&include[]=items`, `modules for course ${courseId}`);
    const itemsByModule = new Map<string, CanvasModuleItem[]>();
    for (const m of full) {
      itemsByModule.set(String(m.id), Array.isArray(m.items)
        ? m.items
        : await fetchAllPages<CanvasModuleItem>(`/courses/${courseId}/modules/${m.id}/items?per_page=100`, `items for module ${m.id}`));
    }
    const result = await withTransaction(async (tx) => {
      const r = await upsertAndPruneModules(courseId, full, tx);
      let items = 0;
      for (const [id, list] of itemsByModule) items += (await upsertAndPruneModuleItems(id, list, tx)).upserted;
      return { ...r, items };
    });
    return {
      fingerprint: JSON.stringify(fingerprintMap(full)),
      summary: `${result.upserted} modules, ${result.items} items, ${result.pruned} pruned`,
    };
  },
};

// ---------------------------------------------------------------------------
// assignments — compact listing via assignment_groups (no description/rubric); TTL only
// ---------------------------------------------------------------------------

interface CanvasAssignmentGroup {
  id: number | string;
  name: string;
  assignments?: CanvasAssignment[];
}

const assignments: CollectionSpec = {
  kind: 'assignments',
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'assignments');
    let list: CanvasAssignment[];
    try {
      const groups = await fetchAllPages<CanvasAssignmentGroup>(
        `/courses/${courseId}/assignment_groups?include[]=assignments&exclude_response_fields[]=description&exclude_response_fields[]=rubric&per_page=50`,
        `assignment groups for course ${courseId}`
      );
      list = groups.flatMap((g) => (g.assignments || []).map((a) => ({ ...a, group_name: g.name })));
      // Strip anything a Canvas version might still include
      for (const a of list) delete a.description;
    } catch (e) {
      if (!(e instanceof CanvasHttpError)) throw e;
      // Some courses restrict assignment groups; the plain listing is the fallback (larger payload)
      list = await fetchAllPages<CanvasAssignment>(`/courses/${courseId}/assignments?per_page=100`, `assignments for course ${courseId}`);
    }
    const r = await withTransaction((tx) => upsertAndPruneAssignments(courseId, list, tx));
    return { summary: `${r.upserted} assignments, ${r.pruned} pruned` };
  },
};

// ---------------------------------------------------------------------------
// files / pages — newest-updated_at probe (feature-detected), otherwise TTL
// ---------------------------------------------------------------------------

async function newestUpdatedAtProbe(path: string, label: string, state: SyncState): Promise<ProbeResult> {
  const rows = await canvasGet<unknown>(path, label);
  if (!Array.isArray(rows)) return { kind: 'unsupported' };
  const newest = rows[0] as { updated_at?: string } | undefined;
  const marker = newest?.updated_at ?? 'empty';
  return marker === state.fingerprint ? { kind: 'unchanged' } : { kind: 'changed' };
}

const files: CollectionSpec = {
  kind: 'files',
  probe: (ctx, state) => {
    const courseId = requireCourse(ctx, 'files');
    return newestUpdatedAtProbe(`/courses/${courseId}/files?sort=updated_at&order=desc&per_page=1`, `files probe for course ${courseId}`, state);
  },
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'files');
    const list = await fetchAllPages<CanvasFile>(
      `/courses/${courseId}/files?per_page=100&sort=updated_at&order=desc`, `files for course ${courseId}`);
    const r = await withTransaction((tx) => upsertAndPruneKnownFiles(courseId, list, tx));
    return { fingerprint: list[0]?.updated_at ?? 'empty', summary: `${r.upserted} files, ${r.pruned} pruned` };
  },
};

const pages: CollectionSpec = {
  kind: 'pages',
  probe: (ctx, state) => {
    const courseId = requireCourse(ctx, 'pages');
    return newestUpdatedAtProbe(`/courses/${courseId}/pages?sort=updated_at&order=desc&per_page=1&published=true`, `pages probe for course ${courseId}`, state);
  },
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'pages');
    const list = await fetchAllPages<CanvasPage>(
      `/courses/${courseId}/pages?per_page=100&published=true&sort=updated_at&order=desc`, `pages for course ${courseId}`);
    const r = await withTransaction((tx) => upsertAndPrunePages(courseId, list, tx));
    return { fingerprint: list[0]?.updated_at ?? 'empty', summary: `${r.upserted} pages, ${r.pruned} pruned` };
  },
};

// ---------------------------------------------------------------------------
// submissions — the student's own, per course; TTL only
// ---------------------------------------------------------------------------

interface CanvasSubmission {
  assignment_id: number | string;
  workflow_state?: string;
  submitted_at?: string | null;
  graded_at?: string | null;
  score?: number | null;
  grade?: string | null;
  late?: boolean;
  missing?: boolean;
  excused?: boolean | null;
}

function shapeSubmission(s: CanvasSubmission): ShapedSubmission {
  return {
    assignment_id: String(s.assignment_id),
    workflow_state: s.workflow_state ?? null,
    submitted_at: s.submitted_at ?? null,
    graded_at: s.graded_at ?? null,
    score: s.score != null ? Number(s.score) : null,
    grade: s.grade ?? null,
    late: Boolean(s.late),
    missing: Boolean(s.missing),
    excused: Boolean(s.excused),
  };
}

const submissions: CollectionSpec = {
  kind: 'submissions',
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'submissions');
    const list = await fetchAllPages<CanvasSubmission>(
      `/courses/${courseId}/students/submissions?student_ids[]=self&per_page=100`, `submissions for course ${courseId}`);
    const rows = list.map(shapeSubmission);
    const r = await withTransaction((tx) => upsertAndPruneSubmissions(courseId, rows, tx));
    return { summary: `${r.upserted} submissions` };
  },
};

// ---------------------------------------------------------------------------
// announcements — newest posted_at probe
// ---------------------------------------------------------------------------

interface CanvasAnnouncement {
  id: number | string;
  title?: string;
  message?: string;
  posted_at?: string | null;
  html_url?: string;
  author?: { display_name?: string };
  user_name?: string;
}

const ANNOUNCEMENT_TEXT_MAX = 4000;

async function shapeAnnouncement(courseId: string, a: CanvasAnnouncement, tx: Queryable): Promise<ShapedAnnouncement> {
  return {
    announcement_id: String(a.id),
    title: a.title || '(untitled)',
    posted_at: a.posted_at ?? null,
    author: a.author?.display_name || a.user_name || null,
    text: clip(await ingestHtml(courseId, 'announcement', String(a.id), a.message, tx), ANNOUNCEMENT_TEXT_MAX) || '',
    html_url: a.html_url || null,
  };
}

const announcements: CollectionSpec = {
  kind: 'announcements',
  probe: async (ctx, state) => {
    const courseId = requireCourse(ctx, 'announcements');
    const rows = await canvasGet<CanvasAnnouncement[]>(
      `/courses/${courseId}/discussion_topics?only_announcements=true&per_page=1`, `announcements probe for course ${courseId}`);
    const marker = rows[0] ? `${rows[0].id}:${rows[0].posted_at}` : 'empty';
    return marker === state.fingerprint ? { kind: 'unchanged' } : { kind: 'changed' };
  },
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'announcements');
    // Newest 100 is plenty; older ones are pruned (the prune only sees what was fetched)
    const list = await fetchAllPages<CanvasAnnouncement>(
      `/courses/${courseId}/discussion_topics?only_announcements=true&per_page=50`, `announcements for course ${courseId}`, 2);
    const r = await withTransaction(async (tx) => {
      const rows: ShapedAnnouncement[] = [];
      for (const a of list) rows.push(await shapeAnnouncement(courseId, a, tx));
      return upsertAndPruneAnnouncements(courseId, rows, tx);
    });
    const marker = list[0] ? `${list[0].id}:${list[0].posted_at}` : 'empty';
    return { fingerprint: marker, summary: `${r.upserted} announcements` };
  },
};

// ---------------------------------------------------------------------------
// planner — rolling window, replaced wholesale; TTL only
// ---------------------------------------------------------------------------

export const PLANNER_WINDOW = { pastDays: 7, futureDays: 28 };

export function plannerWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now.getTime() - PLANNER_WINDOW.pastDays * 864e5);
  const end = new Date(now.getTime() + PLANNER_WINDOW.futureDays * 864e5);
  return { start, end };
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

interface CanvasPlannerItem {
  plannable_type: string;
  plannable_id?: number | string;
  course_id?: number | string | null;
  context_name?: string;
  plannable_date?: string | null;
  html_url?: string;
  new_activity?: boolean;
  plannable?: { title?: string; points_possible?: number | null; due_at?: string | null; todo_date?: string | null };
  submissions?: false | { submitted?: boolean; late?: boolean; missing?: boolean; graded?: boolean };
}

export function shapePlannerItem(p: CanvasPlannerItem): ShapedPlannerItem {
  const sub = p.submissions && typeof p.submissions === 'object' ? p.submissions : null;
  const id = p.plannable_id != null ? String(p.plannable_id) : null;
  return {
    item_key: `${p.plannable_type}:${id ?? Math.random().toString(36).slice(2)}`,
    plannable_type: p.plannable_type,
    plannable_id: id,
    course_id: p.course_id != null ? String(p.course_id) : null,
    context_name: p.context_name ?? null,
    title: p.plannable?.title || '(untitled)',
    date: p.plannable_date || p.plannable?.due_at || p.plannable?.todo_date || null,
    points: p.plannable?.points_possible != null ? Number(p.plannable.points_possible) : null,
    submitted: sub ? Boolean(sub.submitted) : null,
    late: sub ? Boolean(sub.late) : null,
    missing: sub ? Boolean(sub.missing) : null,
    graded: sub ? Boolean(sub.graded) : null,
    new_activity: Boolean(p.new_activity),
    html_url: p.html_url || null,
  };
}

/** Live, shaped, not stored — for get_planner requests outside the cached window. */
export async function fetchPlannerRange(start: Date, end: Date): Promise<ShapedPlannerItem[]> {
  const list = await fetchAllPages<CanvasPlannerItem>(
    `/planner/items?start_date=${isoDate(start)}&end_date=${isoDate(end)}&per_page=100`, 'planner items');
  return list.map(shapePlannerItem);
}

const planner: CollectionSpec = {
  kind: 'planner',
  sync: async () => {
    const { start, end } = plannerWindow();
    const rows = await fetchPlannerRange(start, end);
    const n = await withTransaction((tx) => replacePlannerItems(rows, tx));
    return { fingerprint: `${start.toISOString()}|${end.toISOString()}`, summary: `${n} planner items` };
  },
};

// ---------------------------------------------------------------------------
// inbox — newest last_message_at probe; threads fetched per changed conversation. Messages are stored
// as text only (keyword-searchable); a thread is embedded lazily, the first time a semantic search
// targets it (embedConversationIfNeeded), never at sync time.
// ---------------------------------------------------------------------------

interface CanvasConversation {
  id: number | string;
  subject?: string;
  workflow_state?: string;
  last_message?: string;
  last_message_at?: string | null;
  message_count?: number;
  starred?: boolean;
  participants?: Array<{ id: number | string; name?: string }>;
  context_name?: string;
  context_code?: string;
  messages?: Array<{
    id: number | string;
    created_at?: string;
    body?: string;
    author_id?: number | string;
  }>;
}

const INBOX_LIST_PAGES = 2; // newest 200 conversations
const INBOX_THREAD_FETCH_CAP = 30; // per sync

function shapeConversation(c: CanvasConversation): ShapedConversation {
  const courseMatch = c.context_code?.match(/^course_(\d+)$/);
  return {
    conversation_id: String(c.id),
    subject: c.subject || null,
    context_name: c.context_name || null,
    course_id: courseMatch ? courseMatch[1] : null,
    participants: (c.participants || []).map((p) => ({ id: String(p.id), name: p.name || '' })),
    last_message: clip(c.last_message, 500),
    last_message_at: c.last_message_at ?? null,
    workflow_state: c.workflow_state ?? null,
    message_count: c.message_count ?? null,
    starred: Boolean(c.starred),
  };
}

function shapeMessages(thread: CanvasConversation): ShapedMessage[] {
  const names = new Map((thread.participants || []).map((p) => [String(p.id), p.name || '']));
  return (thread.messages || [])
    .filter((m) => m.body && m.body.trim())
    .map((m) => ({
      message_id: String(m.id),
      author_id: m.author_id != null ? String(m.author_id) : null,
      author_name: m.author_id != null ? names.get(String(m.author_id)) || null : null,
      created_at: m.created_at ?? null,
      body: m.body!.trim(),
    }));
}

/**
 * Embeds the messages of one thread that have no vector yet. Called only when a semantic search is
 * about to target this thread — the inbox sync never embeds. Returns how many messages were embedded.
 */
export async function embedConversationIfNeeded(conversationId: string, settings: AppSettings): Promise<number> {
  const docId = docIdFor('conversation', conversationId);
  const missing = await getChunksMissingEmbedding(docId);
  if (missing.length === 0) return 0;
  const subject = await getConversationSubject(conversationId);
  const model = resolveEmbeddingModel(settings);
  const vectors = await batchEmbed(missing.map((m) => `Inbox · ${subject}\n${m.content}`), settings, 'document');
  await setChunkEmbeddings(docId, missing.map((m, i) => ({ chunkId: m.chunk_id, embedding: vectors[i] })), model);
  return missing.length;
}

const inbox: CollectionSpec = {
  kind: 'inbox',
  probe: async (_ctx, state) => {
    const rows = await canvasGet<CanvasConversation[]>(`/conversations?per_page=1`, 'inbox probe');
    const marker = rows[0] ? `${rows[0].id}:${rows[0].last_message_at}` : 'empty';
    return marker === state.fingerprint ? { kind: 'unchanged' } : { kind: 'changed' };
  },
  sync: async () => {
    const list = await fetchAllPages<CanvasConversation>(`/conversations?per_page=100`, 'inbox', INBOX_LIST_PAGES);
    const shaped = list.map(shapeConversation);
    const { upserted, pruned, staleThreads } = await withTransaction((tx) => upsertAndPruneConversations(shaped, tx));

    // Threads: only conversations whose last_message_at moved since their messages were stored.
    // Text only — no embedding API calls here.
    let threads = 0;
    const byId = new Map(shaped.map((c) => [c.conversation_id, c]));
    for (const id of staleThreads.slice(0, INBOX_THREAD_FETCH_CAP)) {
      const conv = byId.get(id);
      const thread = await canvasGet<CanvasConversation>(`/conversations/${id}`, `conversation ${id}`);
      const messages = shapeMessages(thread);
      await withTransaction((tx) => upsertMessages(id, messages, conv?.last_message_at ?? null, tx));
      const subject = conv?.subject || thread.subject || `Conversation ${id}`;
      const docId = docIdFor('conversation', id);
      await upsertDocumentChunksIncremental({
        docId,
        sourceType: 'conversation',
        courseId: conv?.course_id ?? null,
        title: `Inbox: ${subject}`,
        version: conv?.last_message_at ?? '1',
        embeddingModel: null,
        chunks: messages.map((m, i) => ({
          chunkId: `${docId}:msg:${m.message_id}`,
          chunkIndex: i,
          content: `${m.author_name || 'Unknown'} (${(m.created_at || '').slice(0, 10)}): ${m.body}`,
          embedding: null,
        })),
      });
      threads++;
    }

    const marker = list[0] ? `${list[0].id}:${list[0].last_message_at}` : 'empty';
    return {
      fingerprint: marker,
      summary: `${upserted} conversations (${pruned} pruned), ${threads} threads updated`,
    };
  },
};

// ---------------------------------------------------------------------------
// home — the course front page and the files/pages it links to
// ---------------------------------------------------------------------------

/** The front page, or null when the course has none (404). Other errors propagate. */
async function fetchFrontPage(courseId: string): Promise<CanvasPage | null> {
  try {
    return await canvasGet<CanvasPage>(`/courses/${courseId}/front_page`, `front page of course ${courseId}`);
  } catch (e) {
    if (e instanceof CanvasHttpError && e.status === 404) return null;
    throw e;
  }
}

const home: CollectionSpec = {
  kind: 'home',
  // The front page is small; the probe fetch is reused as the sync input when it changed.
  probe: async (ctx, state) => {
    const courseId = requireCourse(ctx, 'home');
    const page = await fetchFrontPage(courseId);
    const marker = page ? page.updated_at || 'unknown' : 'none';
    return marker === state.fingerprint ? { kind: 'unchanged' } : { kind: 'changed', data: page };
  },
  sync: async (ctx, info) => {
    const courseId = requireCourse(ctx, 'home');
    const page = info.probeData !== undefined ? (info.probeData as CanvasPage | null) : await fetchFrontPage(courseId);
    const links = await withTransaction(async (tx) => {
      await setFrontPage(courseId, page, tx);
      if (!page?.url) return 0;
      const { links } = htmlToTextWithLinks(page.body || '', courseId);
      await storeContentLinks(courseId, 'page', page.url, links, tx);
      return links.length;
    });
    return {
      fingerprint: page ? page.updated_at || 'unknown' : 'none',
      summary: page ? `front page "${page.title}", ${links} links` : 'no front page',
    };
  },
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const COLLECTIONS: Record<CollectionKind, CollectionSpec> = {
  courses,
  modules,
  assignments,
  files,
  pages,
  submissions,
  announcements,
  planner,
  inbox,
  home,
};

/** Bring one collection up to date according to the freshness policy. */
export function ensureCollection(kind: CollectionKind, ctx: ScopeContext, opts: EnsureOptions): Promise<EnsureResult> {
  return ensureCurrent(COLLECTIONS[kind], ctx, opts);
}

/**
 * Bring several collections up to date in sequence (PGlite is single-connection and Canvas
 * throttles bursts). One unavailable or failing collection never aborts the others.
 */
export async function ensureCollections(
  kinds: CollectionKind[],
  ctx: ScopeContext,
  opts: EnsureOptions
): Promise<EnsureResult[]> {
  const results: EnsureResult[] = [];
  for (const kind of kinds) results.push(await ensureCollection(kind, ctx, opts));
  return results;
}
