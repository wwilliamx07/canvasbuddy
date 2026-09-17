import type { AppSettings } from '../components/Settings/Settings';
import { ensureCollection, ensureCollections, fetchPlannerRange, plannerWindow } from '../canvas/collections';
import { describeEnsure, type EnsureResult } from '../canvas/freshness';
import { indexDocumentJustInTime, fetchAssignmentWithDescription } from '../canvas/sync';
import {
  exploreGraph,
  getAssignmentRow,
  listAnnouncements,
  listPlannerItems,
  listConversations,
  getConversationMessages,
  type AssignmentBucket,
} from '../db/graph';
import {
  docIdFor,
  getDocumentCacheState,
  getFileChunks,
  getDocumentPageCount,
  searchChunksHybrid,
  type DocumentSourceType,
} from '../db/rag';
import { getEmbedding } from '../embeddings/embeddingClient';
import { htmlToText } from '../utils/textExtractor';
import type { ShapedPlannerItem } from '../types/canvas';

/**
 * The model's tools. All seven read the local graph; before reading, each brings the collections
 * it needs up to date through the freshness engine. The model never decides between live and
 * cached data — `refresh` exists only to relay "the user says something changed".
 */

export interface ToolParameter {
  type: 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN';
  description: string;
  enum?: string[];
}

export interface ToolConfig {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export type ToolArgs = Record<string, string>;
export type ToolFn = (args: ToolArgs, settings: AppSettings) => Promise<string>;

const REFRESH_PARAM: ToolParameter = {
  type: 'BOOLEAN',
  description: 'Set true ONLY when the user says something changed or asks to re-check Canvas. Otherwise omit; the data is kept current automatically.',
};

export const TOOL_CONFIG: ToolConfig[] = [
  {
    name: 'list_content',
    description:
      'List a course\'s structure or a specific kind of content. kind="items" finds files/pages/quizzes inside modules (the way to locate a lecture or document); "assignments" gives names, due dates, points and optionally your submission status; "files"/"pages" list the course Files/Pages areas. Always pass search when the user named something; keep limit small.',
    parameters: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', description: 'What to list', enum: ['courses', 'modules', 'items', 'assignments', 'files', 'pages'] },
        course_id: { type: 'STRING', description: 'Course id (from the course list). Required for everything except kind="courses".' },
        search: { type: 'STRING', description: 'Case-insensitive substring on the name/title (e.g. "lecture 4", "week 3", "midterm"). Use whenever the user mentioned a name, topic, week or number.' },
        module_id: { type: 'STRING', description: 'kind="items" only: restrict to one module.' },
        bucket: { type: 'STRING', description: 'kind="assignments" only: due-date filter. Default "upcoming".', enum: ['upcoming', 'past', 'undated', 'all'] },
        include_submission: { type: 'BOOLEAN', description: 'kind="assignments" only: include your submission status, score and grade per assignment.' },
        limit: { type: 'INTEGER', description: 'Max rows (default 25, max 100).' },
        refresh: REFRESH_PARAM,
      },
      required: ['kind'],
    },
  },
  {
    name: 'get_assignment',
    description: 'Full details of one assignment: description text, due date, points, submission types, and your submission status/score/grade. Use after list_content identified the assignment.',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'Course id' },
        assignment_id: { type: 'STRING', description: 'Assignment id' },
        refresh: REFRESH_PARAM,
      },
      required: ['course_id', 'assignment_id'],
    },
  },
  {
    name: 'search_documents',
    description:
      'Semantic + keyword search over course documents (PDF/PPTX files, wiki pages, assignment descriptions) and inbox messages; returns the best excerpts with document name and page/slide for citation. To search inside one specific document, pass document_type + document_id (from list_content); it is indexed automatically if needed. Without them, only documents that were previously indexed are searched.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Specific question or key phrase. Include distinctive terms (theorem names, question numbers, concepts).' },
        course_id: { type: 'STRING', description: 'Restrict to one course. Pass whenever the course is known.' },
        document_type: { type: 'STRING', description: 'With document_id: which kind of document', enum: ['file', 'page', 'assignment', 'conversation'] },
        document_id: { type: 'STRING', description: 'The content_ref of a File/Page item, a file id, a page slug, an assignment id, or a conversation id.' },
        limit: { type: 'INTEGER', description: 'Max excerpts (default 5, max 15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_document',
    description:
      'Read the text of a document (or an inbox thread) directly, optionally a page/slide range like "3-5". Indexes the document first if needed. Use when the user wants the actual content of specific pages, a whole short page, or a full message thread — not for finding where something is (use search_documents).',
    parameters: {
      type: 'OBJECT',
      properties: {
        document_type: { type: 'STRING', description: 'Kind of document', enum: ['file', 'page', 'assignment', 'conversation'] },
        document_id: { type: 'STRING', description: 'File id / content_ref, page slug, assignment id, or conversation id' },
        course_id: { type: 'STRING', description: 'Course id (required for pages and assignments; recommended for files)' },
        pages: { type: 'STRING', description: 'Page/slide range, e.g. "3" or "3-5". Omit for the beginning of the document.' },
      },
      required: ['document_type', 'document_id'],
    },
  },
  {
    name: 'get_announcements',
    description: 'Recent announcements for a course, newest first, with the message text.',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'Course id' },
        limit: { type: 'INTEGER', description: 'Default 10, max 50' },
        refresh: REFRESH_PARAM,
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_planner',
    description:
      'The student\'s planner across ALL courses: assignments, quizzes, events and to-dos with due dates and submission state. Best tool for "what do I have this week / what is due / what am I missing". Defaults to the next 7 days.',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'ISO date (YYYY-MM-DD). Default today.' },
        end_date: { type: 'STRING', description: 'ISO date (YYYY-MM-DD). Default start + 7 days.' },
        refresh: REFRESH_PARAM,
      },
    },
  },
  {
    name: 'get_inbox',
    description:
      'Canvas inbox conversations (messages with instructors, TAs, classmates), newest first, with a snippet of the last message. search finds conversations whose subject or any message matches. Use read_document(document_type="conversation") to read a full thread.',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: { type: 'STRING', description: 'Default "all"', enum: ['all', 'unread', 'starred'] },
        search: { type: 'STRING', description: 'Keywords to find in subjects or message bodies' },
        limit: { type: 'INTEGER', description: 'Default 10, max 50' },
        refresh: REFRESH_PARAM,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ok = (payload: unknown) => JSON.stringify(payload);
const fail = (message: string) => JSON.stringify({ error: message });
const bool = (v: string | undefined) => v === 'true' || v === '1';
const int = (v: string | undefined, fallback: number, max: number) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(1, n), max) : fallback;
};

/** Notes worth telling the model: a sync just happened, the course hides a collection, or a refresh failed. */
function notesFrom(results: EnsureResult[]): string[] {
  return results.map(describeEnsure).filter((n): n is string => Boolean(n));
}

function withNotes(payload: Record<string, unknown>, notes: string[]) {
  return ok(notes.length ? { ...payload, notes } : payload);
}

function parsePageRange(spec: string | undefined): { from: number; to: number } | null {
  if (!spec) return null;
  const m = spec.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to = m[2] ? parseInt(m[2], 10) : from;
  return from <= to ? { from, to } : { from: to, to: from };
}

const READ_MAX_CHARS = 12000;

async function ensureDocumentIndexed(
  type: DocumentSourceType,
  id: string,
  courseId: string | undefined,
  settings: AppSettings
): Promise<{ docId: string; title: string; note?: string }> {
  if (type === 'conversation') {
    const r = await ensureCollection('inbox', {}, { settings });
    const docId = docIdFor('conversation', id);
    const state = await getDocumentCacheState(docId);
    if (!state) throw new Error(`Conversation ${id} is not in the inbox cache. Call get_inbox first.`);
    return { docId, title: `Inbox thread ${id}`, note: describeEnsure(r) || undefined };
  }
  const res = await indexDocumentJustInTime({ sourceType: type, sourceId: id, courseId }, settings);
  return {
    docId: res.docId,
    title: res.title,
    note: res.status === 'indexed' ? `Indexed "${res.title}" (${res.chunksCount} chunks).` : undefined,
  };
}

// ---------------------------------------------------------------------------
// implementations
// ---------------------------------------------------------------------------

export const toolFunctions: Record<string, ToolFn> = {
  list_content: async (args, settings) => {
    try {
      const kind = args.kind;
      const refresh = bool(args.refresh);
      const limit = int(args.limit, 25, 100);
      const courseId = args.course_id;

      if (kind === 'courses') {
        const r = await ensureCollection('courses', {}, { settings, refresh });
        const rows = await exploreGraph({ entity_type: 'courses', search_term: args.search, limit });
        return withNotes({ data: rows }, notesFrom([r]));
      }
      if (!courseId) return fail(`course_id is required for kind="${kind}"`);

      if (kind === 'modules' || kind === 'items') {
        const r = await ensureCollection('modules', { courseId }, { settings, refresh });
        if (r.status === 'unavailable') return withNotes({ data: [] }, notesFrom([r]));
        const rows = await exploreGraph({
          entity_type: kind === 'modules' ? 'modules' : 'module_items',
          course_id: courseId,
          module_id: args.module_id,
          search_term: args.search,
          limit,
        });
        const notes = notesFrom([r]);
        if (rows.length === 0 && args.search) notes.push(`No ${kind} match "${args.search}"; try a shorter search.`);
        return withNotes({ data: rows }, notes);
      }

      if (kind === 'assignments') {
        const includeSubmission = bool(args.include_submission);
        const results = await ensureCollections(
          includeSubmission ? ['assignments', 'submissions'] : ['assignments'],
          { courseId },
          { settings, refresh }
        );
        const rows = await exploreGraph({
          entity_type: 'assignments',
          course_id: courseId,
          search_term: args.search,
          bucket: (args.bucket as AssignmentBucket) || 'upcoming',
          include_submission: includeSubmission,
          limit,
        });
        const notes = notesFrom(results);
        if (rows.length === 0 && (!args.bucket || args.bucket === 'upcoming')) {
          notes.push('No upcoming assignments matched; pass bucket="past" or "all" for earlier ones.');
        }
        return withNotes({ data: rows }, notes);
      }

      if (kind === 'files' || kind === 'pages') {
        const r = await ensureCollection(kind, { courseId }, { settings, refresh });
        if (r.status === 'unavailable') {
          // The course hides its Files/Pages area; what is linked from modules is still reachable.
          const itemType = kind === 'files' ? 'File' : 'Page';
          await ensureCollection('modules', { courseId }, { settings });
          const items = await exploreGraph({ entity_type: 'module_items', course_id: courseId, search_term: args.search, limit: 100 });
          const rows = items.filter((i: { item_type: string }) => i.item_type === itemType).slice(0, limit);
          return withNotes({ data: rows }, [
            `The ${kind} area of this course is hidden from students, so these are the ${kind} linked from modules instead (use content_ref as the document_id).`,
          ]);
        }
        const rows = await exploreGraph({ entity_type: kind, course_id: courseId, search_term: args.search, limit });
        return withNotes({ data: rows }, notesFrom([r]));
      }

      return fail(`Unknown kind "${kind}"`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },

  get_assignment: async (args, settings) => {
    try {
      const { course_id: courseId, assignment_id: assignmentId } = args;
      if (!courseId || !assignmentId) return fail('course_id and assignment_id are required');
      const results = await ensureCollections(['assignments', 'submissions'], { courseId }, { settings, refresh: bool(args.refresh) });

      let row = await getAssignmentRow(assignmentId);
      if (!row) return fail(`Assignment ${assignmentId} not found in course ${courseId}. Use list_content(kind="assignments", search=...) to find the right id.`);

      // Description is fetched lazily and cached while the assignment's updated_at is unchanged
      if (row.description == null || row.description_version !== row.updated_at) {
        await fetchAssignmentWithDescription(courseId, assignmentId);
        row = await getAssignmentRow(assignmentId);
      }

      const text = htmlToText(row.description || '');
      return withNotes(
        {
          assignment: {
            id: row.assignment_id,
            name: row.name,
            due_at: row.due_at,
            points_possible: row.points_possible,
            submission_types: row.submission_types,
            group: row.group_name,
            url: row.html_url,
            description: text.length > 3000 ? text.slice(0, 3000) + '… [truncated; use read_document(document_type="assignment") for the rest]' : text || null,
            submission: row.submission_state
              ? {
                  state: row.submission_state,
                  submitted_at: row.submitted_at,
                  score: row.score,
                  grade: row.grade,
                  late: row.late,
                  missing: row.missing,
                  excused: row.excused,
                }
              : null,
          },
        },
        notesFrom(results)
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },

  search_documents: async (args, settings) => {
    try {
      if (!args.query) return fail('query is required');
      const limit = int(args.limit, 5, 15);
      const notes: string[] = [];
      let docId: string | null = null;

      if (args.document_id) {
        const type = (args.document_type as DocumentSourceType) || 'file';
        const doc = await ensureDocumentIndexed(type, args.document_id, args.course_id, settings);
        docId = doc.docId;
        if (doc.note) notes.push(doc.note);
      }

      const queryVector = await getEmbedding(args.query, settings, 'query');
      const results = await searchChunksHybrid(args.query, queryVector, args.course_id, limit, docId);
      if (results.length === 0) {
        notes.push(
          docId
            ? 'No matching excerpts in that document; try different key terms.'
            : 'No matching excerpts among indexed documents. Locate the document with list_content(kind="items", search=...) and pass its document_type/document_id here.'
        );
        return withNotes({ results: [] }, notes);
      }
      return withNotes(
        {
          results: results.map((r) => ({
            document: r.filename,
            document_type: r.source_type,
            document_id: r.source_type === 'file' ? r.file_id : r.file_id.replace(/^(page:[^:]+:|assignment:|conversation:)/, ''),
            page_or_slide: r.page_number ?? null,
            module: r.module_name || null,
            excerpt: r.content,
          })),
        },
        notes
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },

  read_document: async (args, settings) => {
    try {
      const type = args.document_type as DocumentSourceType;
      const id = args.document_id;
      if (!type || !id) return fail('document_type and document_id are required');

      if (type === 'conversation') {
        const r = await ensureCollection('inbox', {}, { settings });
        const messages = await getConversationMessages(id);
        if (messages.length === 0) return withNotes({ error: `No stored messages for conversation ${id}. Call get_inbox first.` }, notesFrom([r]));
        return withNotes({ conversation_id: id, messages }, notesFrom([r]));
      }

      const doc = await ensureDocumentIndexed(type, id, args.course_id, settings);
      const range = parsePageRange(args.pages);
      const pageCount = await getDocumentPageCount(doc.docId);
      const chunks = await getFileChunks(doc.docId, range || undefined);

      let text = '';
      let truncated = false;
      let lastPage: number | null = null;
      for (const c of chunks) {
        const piece = (c.page_number != null && c.page_number !== lastPage ? `\n[page ${c.page_number}]\n` : '\n') + c.content;
        if (text.length + piece.length > READ_MAX_CHARS) {
          truncated = true;
          break;
        }
        text += piece;
        lastPage = c.page_number ?? lastPage;
      }

      const notes = doc.note ? [doc.note] : [];
      if (truncated) notes.push(`Output capped at ~${READ_MAX_CHARS} characters (stopped after page ${lastPage}). Request a narrower pages range for the rest.`);
      if (range && chunks.length === 0) notes.push(`No text on pages ${range.from}-${range.to}${pageCount ? ` (document has ${pageCount} pages/slides)` : ''}.`);
      return withNotes({ document: doc.title, pages_total: pageCount, pages_returned: range ? `${range.from}-${range.to}` : 'from start', text: text.trim() }, notes);
    } catch (e) {
      return fail((e as Error).message);
    }
  },

  get_announcements: async (args, settings) => {
    try {
      if (!args.course_id) return fail('course_id is required');
      const r = await ensureCollection('announcements', { courseId: args.course_id }, { settings, refresh: bool(args.refresh) });
      if (r.status === 'unavailable') return withNotes({ data: [] }, notesFrom([r]));
      const rows = await listAnnouncements(args.course_id, int(args.limit, 10, 50));
      return withNotes(
        {
          data: rows.map((a) => ({
            id: a.announcement_id,
            title: a.title,
            posted_at: a.posted_at,
            author: a.author,
            text: a.text && a.text.length > 600 ? a.text.slice(0, 600) + '…' : a.text,
            url: a.html_url,
          })),
        },
        notesFrom([r])
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },

  get_planner: async (args, settings) => {
    try {
      const today = new Date();
      const start = args.start_date ? new Date(args.start_date) : new Date(today.toISOString().slice(0, 10));
      const end = args.end_date ? new Date(args.end_date) : new Date(start.getTime() + 7 * 864e5);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return fail('start_date/end_date must be ISO dates (YYYY-MM-DD)');
      end.setHours(23, 59, 59, 999);

      const window = plannerWindow();
      const insideWindow = start >= window.start && end <= window.end;
      if (!insideWindow) {
        // Outside the cached rolling window: fetch live for exactly this range, do not store
        const rows = await fetchPlannerRange(start, end);
        return ok({ range: { start: start.toISOString(), end: end.toISOString() }, data: rows.map(shapePlannerOut) });
      }
      const r = await ensureCollection('planner', {}, { settings, refresh: bool(args.refresh) });
      const rows = await listPlannerItems(start, end);
      return withNotes({ range: { start: start.toISOString(), end: end.toISOString() }, data: rows.map(shapePlannerOut) }, notesFrom([r]));
    } catch (e) {
      return fail((e as Error).message);
    }
  },

  get_inbox: async (args, settings) => {
    try {
      const r = await ensureCollection('inbox', {}, { settings, refresh: bool(args.refresh) });
      const rows = await listConversations({
        scope: (args.scope as 'all' | 'unread' | 'starred') || 'all',
        search: args.search,
        limit: int(args.limit, 10, 50),
      });
      return withNotes(
        {
          data: rows.map((c) => ({
            conversation_id: c.conversation_id,
            subject: c.subject,
            course: c.context_name,
            participants: safeParticipants(c.participants),
            last_message: c.last_message && c.last_message.length > 300 ? c.last_message.slice(0, 300) + '…' : c.last_message,
            last_message_at: c.last_message_at,
            unread: c.workflow_state === 'unread',
            message_count: c.message_count,
            ...(c.matching_message ? { matching_message: c.matching_message } : {}),
          })),
        },
        notesFrom([r])
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

function shapePlannerOut(p: Partial<ShapedPlannerItem>) {
  return {
    type: p.plannable_type,
    id: p.plannable_id,
    course_id: p.course_id,
    course: p.context_name,
    title: p.title,
    date: p.date,
    points: p.points,
    submitted: p.submitted,
    late: p.late,
    missing: p.missing,
    graded: p.graded,
    url: p.html_url,
  };
}

function safeParticipants(raw: unknown): string[] {
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.map((p: { name?: string }) => p.name).filter((n): n is string => Boolean(n)) : [];
  } catch {
    return [];
  }
}
