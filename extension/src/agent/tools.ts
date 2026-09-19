import type { AppSettings } from '../components/Settings/Settings';
import {
  ensureCollection,
  ensureCollections,
  fetchPlannerRange,
  plannerWindow,
  embedConversationIfNeeded,
  ensureDiscussionThread,
  embedDiscussionIfNeeded,
} from '../canvas/collections';
import { describeEnsure, type EnsureResult } from '../canvas/freshness';
import { indexDocumentJustInTime, fetchAssignmentWithDescription } from '../canvas/sync';
import {
  exploreGraph,
  listCourseFiles,
  listCoursePages,
  getAssignmentRow,
  listAnnouncements,
  listPlannerItems,
  listConversations,
  getConversationMessages,
  listDiscussions,
  listQuizzes,
  getCourseSyllabus,
  type AssignmentBucket,
  type QuizBucket,
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
import { ingestHtml } from '../canvas/links';
import type { ShapedPlannerItem } from '../types/canvas';

/**
 * The model's tools. All eight read the local graph; before reading, each brings the collections
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
      'List a course\'s structure or a specific kind of content. kind="courses" also tells what each course\'s Home shows, its nav bar (incl. external tools) and whether it has a syllabus; "items" finds files/pages/quizzes/discussions inside modules; "files"/"pages" list every file/page the course is known to have — the Files/Pages areas when visible plus everything linked from modules, the home page, announcements, assignment descriptions, discussions and the syllabus (linked_from says where) — with the syllabus and home page listed first under "pages"; "assignments" gives names, due dates, points and optionally your submission status; "quizzes" gives quiz details the assignment list lacks: time limit, allowed attempts, question count, availability window, and optionally your submission. Always pass search when the user named something; keep limit small.',
    parameters: {
      type: 'OBJECT',
      properties: {
        kind: { type: 'STRING', description: 'What to list', enum: ['courses', 'modules', 'items', 'assignments', 'quizzes', 'files', 'pages'] },
        course_id: { type: 'STRING', description: 'Course id (from the course list). Required for everything except kind="courses".' },
        search: { type: 'STRING', description: 'Case-insensitive substring on the name/title (e.g. "lecture 4", "week 3", "midterm"). Use whenever the user mentioned a name, topic, week or number.' },
        module_id: { type: 'STRING', description: 'kind="items" only: restrict to one module.' },
        bucket: { type: 'STRING', description: 'kind="assignments"/"quizzes": due-date filter. Default "upcoming" for assignments, "all" for quizzes.', enum: ['upcoming', 'past', 'undated', 'all'] },
        include_submission: { type: 'BOOLEAN', description: 'kind="assignments"/"quizzes": include your submission status, score and grade per row.' },
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
      'Semantic + keyword search over course documents (PDF/PPTX files, wiki pages, assignment descriptions, the syllabus), discussion threads and inbox messages; returns the best excerpts with document name and page/slide for citation. To search inside one specific document, pass document_type + document_id (from list_content / get_discussions / get_inbox); it is indexed automatically if needed. Without them, previously indexed documents are searched semantically and all stored inbox messages and discussion replies by keyword.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Specific question or key phrase. Include distinctive terms (theorem names, question numbers, concepts).' },
        course_id: { type: 'STRING', description: 'Restrict to one course. Pass whenever the course is known.' },
        document_type: { type: 'STRING', description: 'With document_id: which kind of document', enum: ['file', 'page', 'assignment', 'syllabus', 'discussion', 'conversation'] },
        document_id: { type: 'STRING', description: 'The content_ref of a File/Page item, a file id, a page slug, an assignment id, a discussion id, a conversation id, or the course id for the syllabus.' },
        limit: { type: 'INTEGER', description: 'Max excerpts (default 5, max 15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_document',
    description:
      'Read the text of a document, a discussion thread (topic + all replies) or an inbox thread directly, optionally a page/slide range like "3-5". Indexes the document first if needed. Use when the user wants the actual content of specific pages, a whole short page, the syllabus, or a full thread — not for finding where something is (use search_documents).',
    parameters: {
      type: 'OBJECT',
      properties: {
        document_type: { type: 'STRING', description: 'Kind of document', enum: ['file', 'page', 'assignment', 'syllabus', 'discussion', 'conversation'] },
        document_id: { type: 'STRING', description: 'File id / content_ref, page slug, assignment id, discussion id, conversation id, or the course id for the syllabus' },
        course_id: { type: 'STRING', description: 'Course id (required for pages, assignments, discussions and the syllabus; recommended for files)' },
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
    name: 'get_discussions',
    description:
      'Discussion topics of a course (the forum: Q&A, weekly threads, graded discussions), most recent activity first, with the topic text and reply count. search matches titles and topic text. To read the replies of a topic use read_document(document_type="discussion"); to find what was said about something across replies use search_documents(document_type="discussion", document_id=…).',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'Course id' },
        search: { type: 'STRING', description: 'Keywords to find in topic titles or text' },
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

/** The topic list current and this topic's replies stored as text — no vectors (reading needs none). */
async function ensureDiscussionRead(
  id: string,
  courseId: string | undefined,
  settings: AppSettings
): Promise<{ docId: string; title: string; note?: string }> {
  if (!courseId) throw new Error('course_id is required for a discussion');
  const r = await ensureCollection('discussions', { courseId }, { settings });
  if (r.status === 'unavailable') throw new Error(`Discussions are not available in course ${courseId}.`);
  const fetched = await ensureDiscussionThread(courseId, id);
  const note = [describeEnsure(r), fetched].filter(Boolean).join(' ');
  return { docId: docIdFor('discussion', id), title: `Discussion ${id}`, note: note || undefined };
}

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
    // Lazy: this thread is about to be searched semantically, so embed it now (new messages only)
    const embedded = await embedConversationIfNeeded(id, settings);
    const notes = [describeEnsure(r), embedded ? `Embedded ${embedded} messages of this thread.` : null].filter(Boolean);
    return { docId, title: `Inbox thread ${id}`, note: notes.join(' ') || undefined };
  }
  if (type === 'discussion') {
    // Lazy: this thread is about to be searched semantically, so embed it now (new entries only)
    const thread = await ensureDiscussionRead(id, courseId, settings);
    const embedded = await embedDiscussionIfNeeded(id, settings);
    const note = [thread.note, embedded ? `Embedded ${embedded} entries of this thread.` : null].filter(Boolean).join(' ');
    return { ...thread, note: note || undefined };
  }
  if (type === 'syllabus') {
    const course = courseId || id;
    const r = await ensureCollection('syllabus', { courseId: course }, { settings });
    if (r.status === 'unavailable') throw new Error(`The syllabus of course ${course} is not available.`);
    if (!(await getCourseSyllabus(course))) throw new Error(`Course ${course} has no syllabus on its Syllabus tab; look for one under list_content(kind="files"/"pages").`);
    const res = await indexDocumentJustInTime({ sourceType: 'syllabus', sourceId: course, courseId: course }, settings);
    const note = [describeEnsure(r), res.status === 'indexed' ? `Indexed the syllabus (${res.chunksCount} chunks).` : null].filter(Boolean).join(' ');
    return { docId: res.docId, title: res.title, note: note || undefined };
  }
  const res = await indexDocumentJustInTime({ sourceType: type, sourceId: id, courseId }, settings);
  return {
    docId: res.docId,
    title: res.title,
    note:
      res.status === 'indexed'
        ? `Indexed "${res.title}" (${res.chunksCount} chunks${res.chunksEmbedded < res.chunksCount ? `, ${res.chunksCount - res.chunksEmbedded} unchanged` : ''}).`
        : undefined,
  };
}

/** Quiz row for the model: minutes and attempts spelled out, description clipped. */
function shapeQuizRow(z: any) {
  return {
    id: z.quiz_id,
    title: z.title,
    type: z.quiz_type,
    due_at: z.due_at,
    available_from: z.unlock_at,
    available_until: z.lock_at,
    time_limit_minutes: z.time_limit,
    allowed_attempts: z.allowed_attempts === -1 ? 'unlimited' : z.allowed_attempts,
    questions: z.question_count,
    points_possible: z.points_possible,
    published: z.published ? undefined : false,
    locked: z.lock_explanation || undefined,
    description: z.description && z.description.length > 600 ? z.description.slice(0, 600) + '…' : z.description || undefined,
    url: z.html_url,
    ...(z.submission_state !== undefined
      ? { submission: z.submission_state ? { state: z.submission_state, submitted_at: z.submitted_at, score: z.score, grade: z.grade, late: z.late, missing: z.missing, excused: z.excused } : null }
      : {}),
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
        if (rows.length === 0) {
          notes.push(
            args.search
              ? `No ${kind} match "${args.search}"; try a shorter search, or kind="files"/"pages", which also cover what the course home page links to.`
              : 'This course has no module content; use kind="files"/"pages" — they include what the course home page links to.'
          );
        }
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

      if (kind === 'quizzes') {
        const includeSubmission = bool(args.include_submission);
        const results = await ensureCollections(includeSubmission ? ['quizzes', 'submissions'] : ['quizzes'], { courseId }, { settings, refresh });
        if (results[0].status === 'unavailable') return withNotes({ data: [] }, notesFrom(results));
        const rows = await listQuizzes({
          courseId,
          search: args.search,
          bucket: (args.bucket as QuizBucket) || 'all',
          includeSubmission,
          limit,
        });
        const notes = notesFrom(results);
        if (rows.length === 0 && args.search) notes.push(`No quizzes match "${args.search}"; try a shorter search or kind="items".`);
        return withNotes({ data: rows.map(shapeQuizRow) }, notes);
      }

      if (kind === 'files' || kind === 'pages') {
        // The area listing (when the course shows it) plus everything discovered through modules
        // and links on the home page / pages / assignments / announcements / discussions / syllabus.
        const results = await ensureCollections([kind, 'modules', 'home', ...(kind === 'pages' ? ['syllabus' as const] : [])], { courseId }, { settings, refresh });
        let rows = kind === 'files'
          ? await listCourseFiles(courseId, args.search, limit)
          : await listCoursePages(courseId, args.search, limit);
        if (kind === 'pages' && (!args.search || /syllabus/i.test(args.search)) && (await getCourseSyllabus(courseId))) {
          // The Syllabus tab is a document like a page; it has no slug, so it is addressed by course id
          rows = [{ title: 'Syllabus (Syllabus tab)', document_type: 'syllabus', document_id: courseId, linked_from: 'course nav' }, ...rows];
        }
        const notes = notesFrom(results);
        if (results[0].status === 'unavailable') {
          notes.push(`The ${kind} area of this course is hidden from students; these are the ${kind} reachable through modules and links (linked_from).`);
        }
        if (rows.length === 0 && args.search) notes.push(`No ${kind} match "${args.search}"; try a shorter search.`);
        return withNotes({ data: rows }, notes);
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

      const text = await ingestHtml(courseId, 'assignment', assignmentId, row.description);
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
            document_id: r.source_type === 'file' ? r.file_id : r.file_id.replace(/^(page:[^:]+:|assignment:|conversation:|discussion:|syllabus:)/, ''),
            page_or_slide: r.page_number == null ? null : r.page_end != null && r.page_end > r.page_number ? `${r.page_number}-${r.page_end}` : r.page_number,
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

      if (type === 'discussion') {
        const doc = await ensureDiscussionRead(id, args.course_id, settings);
        const entries = await getFileChunks(doc.docId);
        const text = entries.map((c) => c.content).join('\n\n');
        const notes = doc.note ? [doc.note] : [];
        if (text.length > READ_MAX_CHARS) notes.push(`Thread capped at ~${READ_MAX_CHARS} characters; use search_documents(document_type="discussion", document_id="${id}") for specific replies.`);
        return withNotes({ document: doc.title, entries: entries.length, text: text.slice(0, READ_MAX_CHARS) }, notes);
      }

      const doc = await ensureDocumentIndexed(type, id, args.course_id, settings);
      const range = parsePageRange(args.pages);
      const pageCount = await getDocumentPageCount(doc.docId);
      const chunks = await getFileChunks(doc.docId, range || undefined);

      let text = '';
      let truncated = false;
      let lastPage: number | null = null;
      for (const c of chunks) {
        const pageEnd = c.page_end != null ? Number(c.page_end) : null;
        const label = pageEnd != null && pageEnd > Number(c.page_number) ? `pages ${c.page_number}-${pageEnd}` : `page ${c.page_number}`;
        const piece = (c.page_number != null && c.page_number !== lastPage ? `\n[${label}]\n` : '\n') + c.content;
        if (text.length + piece.length > READ_MAX_CHARS) {
          truncated = true;
          break;
        }
        text += piece;
        lastPage = pageEnd ?? c.page_number ?? lastPage;
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

  get_discussions: async (args, settings) => {
    try {
      if (!args.course_id) return fail('course_id is required');
      const r = await ensureCollection('discussions', { courseId: args.course_id }, { settings, refresh: bool(args.refresh) });
      if (r.status === 'unavailable') return withNotes({ data: [] }, notesFrom([r]));
      const rows = await listDiscussions(args.course_id, args.search, int(args.limit, 10, 50));
      const notes = notesFrom([r]);
      if (rows.length === 0 && args.search) notes.push(`No topics match "${args.search}"; try a shorter search.`);
      return withNotes(
        {
          data: rows.map((d) => ({
            id: d.discussion_id,
            title: d.title,
            author: d.author,
            posted_at: d.posted_at,
            last_reply_at: d.last_reply_at,
            replies: d.reply_count,
            pinned: d.pinned || undefined,
            locked: d.locked || undefined,
            graded: d.assignment_id ? true : undefined,
            text: d.message && d.message.length > 400 ? d.message.slice(0, 400) + '…' : d.message,
            url: d.html_url,
          })),
        },
        notes
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
