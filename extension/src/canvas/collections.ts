import {
  clearSyncState,
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
  pruneCourses,
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
  upsertAndPruneDiscussions,
  getDiscussionRow,
  setDiscussionRepliesSynced,
  upsertAndPruneQuizzes,
  setCourseSyllabus,
} from '../db/graph';
import { ingestHtml } from './links';
import {
  docIdFor,
  upsertAndPruneKnownFiles,
  upsertDocumentChunksIncremental,
  chunksToEmbed,
  setChunkEmbeddings,
} from '../db/rag';
import { batchEmbed, resolveEmbeddingModel } from '../embeddings/embeddingClient';
import { htmlToTextWithLinks } from '../utils/canvasLinks';
import type { AppSettings } from '../settings';
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
  CanvasDiscussionTopic,
  CanvasDiscussionView,
  CanvasDiscussionEntry,
  ShapedDiscussion,
  CanvasQuiz,
  ContentLink,
  ShapedQuiz,
} from '../types/canvas';
import { htmlToText } from '../utils/textExtractor';

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
 *   discussions   newest recent-activity topic id:last_reply_at — unverified
 *   syllabus      the body itself is the probe (one course fetch), fingerprinted by length+hash
 *   courses, assignments, submissions, planner, quizzes — no narrow query exists; TTL only
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
    // The roster is the complete list of active courses: one that left it (dropped, term over) goes
    // with everything remembered under it, and its sync stamps, so it is not in the next roster
    const pruned = await withTransaction(async (tx) => {
      await upsertCourses(valid, tx);
      for (const [courseId, list] of tabs) await replaceCourseTabs(courseId, list, tx);
      const gone = await pruneCourses(valid.map((c) => String(c.id)), tx);
      for (const courseId of gone) await clearSyncState(`course:${courseId}`, tx);
      return gone;
    });
    return { summary: `${valid.length} active courses${pruned.length ? `, ${pruned.length} pruned` : ''}` };
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
    const r = await withTransaction(async (tx) => {
      // The fallback listing carries descriptions: store them as text with their links recorded, like every other body
      for (const a of list) {
        if (typeof a.description === 'string') a.description = (await ingestHtml(courseId, 'assignment', String(a.id), a.description, tx)).text;
      }
      return upsertAndPruneAssignments(courseId, list, tx);
    });
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
    text: clip((await ingestHtml(courseId, 'announcement', String(a.id), a.message, tx)).text, ANNOUNCEMENT_TEXT_MAX) || '',
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

/**
 * Live, shaped, not stored — for get_planner requests outside the cached window. The bounds go as
 * full timestamps (Canvas takes ISO 8601): a date alone would be the UTC day, not the student's.
 */
export async function fetchPlannerRange(start: Date, end: Date): Promise<ShapedPlannerItem[]> {
  const q = `start_date=${encodeURIComponent(start.toISOString())}&end_date=${encodeURIComponent(end.toISOString())}`;
  const list = await fetchAllPages<CanvasPlannerItem>(`/planner/items?${q}&per_page=100`, 'planner items');
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
 * Embeds the entries of one thread document (inbox conversation, discussion topic) that have no
 * vector yet. Called only when a semantic search is about to target the thread — no sync embeds.
 * Returns how many entries were embedded.
 */
async function embedThreadIfNeeded(docId: string, header: string, settings: AppSettings): Promise<number> {
  const model = resolveEmbeddingModel(settings);
  const missing = await chunksToEmbed(docId, model);
  if (missing.length === 0) return 0;
  const vectors = await batchEmbed(missing.map((m) => `${header}\n${m.content}`), settings, 'document');
  await setChunkEmbeddings(docId, missing.map((m, i) => ({ chunkId: m.chunk_id, embedding: vectors[i] })), model);
  return missing.length;
}

export async function embedConversationIfNeeded(conversationId: string, settings: AppSettings): Promise<number> {
  const subject = await getConversationSubject(conversationId);
  return embedThreadIfNeeded(docIdFor('conversation', conversationId), `Inbox · ${subject}`, settings);
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
      // Canvas marks an unread conversation read when it is fetched unless told not to
      const thread = await canvasGet<CanvasConversation>(`/conversations/${id}?auto_mark_as_read=false`, `conversation ${id}`);
      const messages = shapeMessages(thread);
      const subject = conv?.subject || thread.subject || `Conversation ${id}`;
      const docId = docIdFor('conversation', id);
      // Messages, thread stamp and document commit together: a stamped thread is never missing its chunks
      await withTransaction(async (tx) => {
        await upsertMessages(id, messages, conv?.last_message_at ?? null, tx);
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
        }, tx);
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
      return (await ingestHtml(courseId, 'page', page.url, page.body, tx)).links.length;
    });
    return {
      fingerprint: page ? page.updated_at || 'unknown' : 'none',
      summary: page ? `front page "${page.title}", ${links} links` : 'no front page',
    };
  },
};

// ---------------------------------------------------------------------------
// discussions — topic list with a recent-activity probe; the reply tree of a topic is fetched
// only when something reads it (ensureDiscussionThread), into the 'discussion:<id>' document
// ---------------------------------------------------------------------------

const DISCUSSION_MESSAGE_MAX = 4000;
const DISCUSSION_ENTRY_MAX = 4000;

async function shapeDiscussion(courseId: string, t: CanvasDiscussionTopic, tx: Queryable): Promise<ShapedDiscussion> {
  return {
    discussion_id: String(t.id),
    title: t.title || '(untitled)',
    author: t.author?.display_name || t.user_name || null,
    posted_at: t.posted_at ?? null,
    last_reply_at: t.last_reply_at ?? null,
    reply_count: t.discussion_subentry_count ?? 0,
    message: clip((await ingestHtml(courseId, 'discussion', String(t.id), t.message, tx)).text, DISCUSSION_MESSAGE_MAX) || '',
    html_url: t.html_url || null,
    pinned: Boolean(t.pinned),
    locked: Boolean(t.locked),
    assignment_id: t.assignment_id != null ? String(t.assignment_id) : null,
  };
}

const discussions: CollectionSpec = {
  kind: 'discussions',
  probe: async (ctx, state) => {
    const courseId = requireCourse(ctx, 'discussions');
    const rows = await canvasGet<CanvasDiscussionTopic[]>(
      `/courses/${courseId}/discussion_topics?order_by=recent_activity&per_page=1`, `discussions probe for course ${courseId}`);
    const marker = rows[0] ? `${rows[0].id}:${rows[0].last_reply_at}:${rows[0].posted_at}` : 'empty';
    return marker === state.fingerprint ? { kind: 'unchanged' } : { kind: 'changed' };
  },
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'discussions');
    // Newest 100 by activity; older topics are pruned (the prune only sees what was fetched)
    const list = await fetchAllPages<CanvasDiscussionTopic>(
      `/courses/${courseId}/discussion_topics?order_by=recent_activity&per_page=50`, `discussions for course ${courseId}`, 2);
    const r = await withTransaction(async (tx) => {
      const rows: ShapedDiscussion[] = [];
      for (const t of list) rows.push(await shapeDiscussion(courseId, t, tx));
      return upsertAndPruneDiscussions(courseId, rows, tx);
    });
    const marker = list[0] ? `${list[0].id}:${list[0].last_reply_at}:${list[0].posted_at}` : 'empty';
    return { fingerprint: marker, summary: `${r.upserted} discussion topics, ${r.pruned} pruned` };
  },
};

type ThreadEntry = { id: string; author: string; parentAuthor: string | null; createdAt: string; text: string };

/**
 * The reply tree flattened in reading order, each entry knowing whom it answers. Entry HTML is
 * converted like every other body: text with link markers, and the links collected into `links`.
 */
function flattenEntries(
  entries: CanvasDiscussionEntry[],
  ctx: { courseId: string; names: Map<string, string>; out: ThreadEntry[]; links: ContentLink[] },
  parentAuthor: string | null = null
): void {
  for (const e of entries) {
    if (e.deleted) continue;
    const author = e.user_id != null ? ctx.names.get(String(e.user_id)) || 'Unknown' : 'Unknown';
    const { text: raw, links } = htmlToTextWithLinks(e.message || '', ctx.courseId);
    const text = raw.trim();
    ctx.links.push(...links);
    if (text) ctx.out.push({ id: String(e.id), author, parentAuthor, createdAt: e.created_at || '', text: clip(text, DISCUSSION_ENTRY_MAX)! });
    if (e.replies?.length) flattenEntries(e.replies, ctx, author);
  }
}

/**
 * Brings the 'discussion:<id>' document up to date with the topic's replies: fetched only when
 * last_reply_at moved since the entries were stored. Text only — no embedding here. Returns a
 * note for the model, or null when nothing was fetched.
 */
export async function ensureDiscussionThread(courseId: string, discussionId: string): Promise<string | null> {
  const topic = await getDiscussionRow(discussionId);
  if (!topic) throw new Error(`Discussion ${discussionId} is not in course ${courseId}'s discussions. Call get_discussions first.`);
  const version = topic.last_reply_at ? new Date(topic.last_reply_at).toISOString() : 'no-replies';
  if (topic.replies_synced_for === version) return null;

  const view = await canvasGet<CanvasDiscussionView>(
    `/courses/${courseId}/discussion_topics/${discussionId}/view`, `replies of discussion ${discussionId}`);
  const names = new Map((view.participants || []).map((p) => [String(p.id), p.display_name || 'Unknown']));
  const entries: ThreadEntry[] = [];
  const found: ContentLink[] = [];
  flattenEntries(Array.isArray(view.view) ? view.view : [], { courseId: String(courseId), names, out: entries, links: found });
  // The replies' links, once each, recorded under the thread so what they point at becomes listable
  const seen = new Set<string>();
  const replyLinks: ContentLink[] = [];
  for (const l of found) {
    const key = `${l.to_type}:${l.to_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    replyLinks.push({ ...l, position: replyLinks.length });
  }

  const docId = docIdFor('discussion', discussionId);
  const topicDate = (topic.posted_at ? new Date(topic.posted_at).toISOString() : '').slice(0, 10);
  const chunks = [
    {
      chunkId: `${docId}:topic`,
      chunkIndex: 0,
      content: `[topic] ${topic.author || 'Unknown'} (${topicDate}): ${topic.title}\n${topic.message || ''}`.trim(),
      embedding: null,
    },
    ...entries.map((e, i) => ({
      chunkId: `${docId}:entry:${e.id}`,
      chunkIndex: i + 1,
      content: `${e.author} (${e.createdAt.slice(0, 10)})${e.parentAuthor ? ` replying to ${e.parentAuthor}` : ''}: ${e.text}`,
      embedding: null,
    })),
  ];
  await withTransaction(async (tx) => {
    await upsertDocumentChunksIncremental({
      docId,
      sourceType: 'discussion',
      courseId: String(courseId),
      title: `Discussion: ${topic.title}`,
      version,
      embeddingModel: null,
      htmlUrl: topic.html_url,
      chunks,
      pruneMissing: true,
    }, tx);
    await storeContentLinks(String(courseId), 'discussion_replies', discussionId, replyLinks, tx);
    await setDiscussionRepliesSynced(discussionId, version, tx);
  });
  return `Read ${entries.length} replies of "${topic.title}".`;
}

export async function embedDiscussionIfNeeded(discussionId: string, settings: AppSettings): Promise<number> {
  const topic = await getDiscussionRow(discussionId);
  return embedThreadIfNeeded(docIdFor('discussion', discussionId), `Discussion · ${topic?.title || discussionId}`, settings);
}

// ---------------------------------------------------------------------------
// quizzes — the Quizzes tab; TTL only (403/404 when the course hides it)
// ---------------------------------------------------------------------------

const QUIZ_DESCRIPTION_MAX = 2000;

async function shapeQuiz(courseId: string, z: CanvasQuiz, tx: Queryable): Promise<ShapedQuiz> {
  return {
    quiz_id: String(z.id),
    title: z.title || '(untitled)',
    quiz_type: z.quiz_type || null,
    time_limit: z.time_limit ?? null,
    allowed_attempts: z.allowed_attempts ?? null,
    question_count: z.question_count ?? null,
    points_possible: z.points_possible != null ? Number(z.points_possible) : null,
    due_at: z.due_at ?? null,
    unlock_at: z.unlock_at ?? null,
    lock_at: z.lock_at ?? null,
    published: z.published ?? true,
    description: clip((await ingestHtml(courseId, 'quiz', String(z.id), z.description, tx)).text, QUIZ_DESCRIPTION_MAX),
    assignment_id: z.assignment_id != null ? String(z.assignment_id) : null,
    html_url: z.html_url || null,
    lock_explanation: z.locked_for_user ? clip(z.lock_explanation ? htmlToText(z.lock_explanation) : 'locked', 300) : null,
  };
}

const quizzes: CollectionSpec = {
  kind: 'quizzes',
  sync: async (ctx) => {
    const courseId = requireCourse(ctx, 'quizzes');
    const list = await fetchAllPages<CanvasQuiz>(`/courses/${courseId}/quizzes?per_page=100`, `quizzes for course ${courseId}`);
    const r = await withTransaction(async (tx) => {
      const rows: ShapedQuiz[] = [];
      for (const z of list) rows.push(await shapeQuiz(courseId, z, tx));
      return upsertAndPruneQuizzes(courseId, rows, tx);
    });
    return { summary: `${r.upserted} quizzes, ${r.pruned} pruned` };
  },
};

// ---------------------------------------------------------------------------
// syllabus — the Syllabus tab body. Canvas gives it no timestamp, so the probe fetches the body
// (one course object) and fingerprints it; the fetch is handed to the sync when it changed.
// ---------------------------------------------------------------------------

function syllabusFingerprint(body: string | null | undefined): string {
  if (!body) return 'none';
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (h * 31 + body.charCodeAt(i)) | 0;
  return `${body.length}:${(h >>> 0).toString(16)}`;
}

async function fetchSyllabusBody(courseId: string): Promise<string | null> {
  const course = await canvasGet<{ syllabus_body?: string | null }>(
    `/courses/${courseId}?include[]=syllabus_body`, `syllabus of course ${courseId}`);
  const body = course.syllabus_body?.trim();
  return body ? body : null;
}

const syllabus: CollectionSpec = {
  kind: 'syllabus',
  probe: async (ctx, state) => {
    const courseId = requireCourse(ctx, 'syllabus');
    const body = await fetchSyllabusBody(courseId);
    return syllabusFingerprint(body) === state.fingerprint ? { kind: 'unchanged' } : { kind: 'changed', data: body };
  },
  sync: async (ctx, info) => {
    const courseId = requireCourse(ctx, 'syllabus');
    const body = info.probeData !== undefined ? (info.probeData as string | null) : await fetchSyllabusBody(courseId);
    const fingerprint = syllabusFingerprint(body);
    const links = await withTransaction(async (tx) => {
      if (!body) {
        await setCourseSyllabus(courseId, null, null, tx);
        return 0;
      }
      // Stored as text with link markers; the fingerprint is over the HTML so an unchanged body is recognised
      const { text, links } = await ingestHtml(courseId, 'syllabus', courseId, body, tx);
      await setCourseSyllabus(courseId, text, fingerprint, tx);
      return links.length;
    });
    return { fingerprint, summary: body ? `syllabus (${body.length} chars, ${links} links)` : 'no syllabus' };
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
  discussions,
  quizzes,
  syllabus,
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
