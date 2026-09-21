import { getDB, q, type Queryable } from './pglite';
import type { CollectionKind } from '../canvas/freshness';
import type {
  CanvasCourse,
  CanvasModule,
  CanvasModuleItem,
  CanvasAssignment,
  CanvasPage,
  CanvasTab,
  ContentLink,
  GraphStats,
  ShapedSubmission,
  ShapedAnnouncement,
  ShapedPlannerItem,
  ShapedConversation,
  ShapedMessage,
  ShapedDiscussion,
  ShapedQuiz,
} from '../types/canvas';

function clampLimit(limit: number | undefined, fallback = 25): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), 200);
}

/** 'unavailable' when the course hides the collection from students, else NULL (`c` = courses alias). */
const SCOPE_STATUS_SQL = (collection: string) =>
  `(SELECT NULLIF(s.status, 'ok') FROM sync_state s WHERE s.scope = 'course:' || c.course_id || ':${collection}')`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AssignmentBucket = 'upcoming' | 'past' | 'undated' | 'all';

/**
 * Explore local graph nodes with optional filters. Rows are compact and capped by `limit`.
 * Used by the tools (via list_content) and the Graph Explorer.
 */
export async function exploreGraph(options: {
  entity_type: 'courses' | 'modules' | 'module_items' | 'assignments' | 'files' | 'pages' | 'full_hierarchy';
  course_id?: string;
  module_id?: string;
  search_term?: string;
  limit?: number;
  include_items?: boolean;
  bucket?: AssignmentBucket;
  include_submission?: boolean;
}): Promise<any> {
  const db = await getDB();
  const { entity_type, course_id, module_id, search_term } = options;
  const limit = clampLimit(options.limit);

  const params: any[] = [];
  const conditions: string[] = [];
  const add = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (entity_type === 'courses') {
    if (search_term) {
      const p = add(`%${search_term}%`);
      conditions.push(`(name ILIKE ${p} OR course_code ILIKE ${p})`);
    }
    // home_view: what the "Home" nav item shows; nav: the nav bar, with launch URLs for external tools
    const sql = `
      SELECT c.course_id, c.name, c.course_code, c.term,
        CASE WHEN c.default_view = 'wiki'
             THEN 'front page' || COALESCE((SELECT ' "' || p.title || '" (page ' || p.page_url || ')' FROM pages p WHERE p.course_id = c.course_id AND p.front_page LIMIT 1), '')
             ELSE c.default_view END AS home_view,
        (SELECT string_agg(CASE WHEN t.type = 'external' THEN t.label || ' — ' || COALESCE(t.html_url, '') ELSE t.label END, ' · ' ORDER BY t.position)
           FROM course_tabs t WHERE t.course_id = c.course_id) AS nav,
        (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.course_id)     AS module_count,
        (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.course_id) AS assignment_count,
        (SELECT COUNT(*) FROM files f WHERE f.course_id = c.course_id AND f.total_chunks > 0) AS indexed_document_count,
        ${SCOPE_STATUS_SQL('files')} AS files_status,
        ${SCOPE_STATUS_SQL('pages')} AS pages_status,
        (c.syllabus_body IS NOT NULL AND length(c.syllabus_body) > 0) AS has_syllabus
      FROM courses c
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY c.name ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'modules') {
    if (course_id) conditions.push(`m.course_id = ${add(String(course_id))}`);
    if (search_term) conditions.push(`m.name ILIKE ${add(`%${search_term}%`)}`);
    const sql = `
      SELECT m.module_id, m.course_id, m.name, m.position,
        (SELECT COUNT(*) FROM module_items mi WHERE mi.module_id = m.module_id) AS item_count
      FROM modules m
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY m.position ASC, m.name ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'module_items') {
    if (module_id) conditions.push(`mi.module_id = ${add(String(module_id))}`);
    if (course_id) conditions.push(`m.course_id = ${add(String(course_id))}`);
    if (search_term) conditions.push(`mi.title ILIKE ${add(`%${search_term}%`)}`);
    // `indexed` covers File items (doc id = file id), Page items (page:<course>:<slug>), Assignment
    // descriptions and Discussion threads (discussion:<id>, present once its replies were read)
    const sql = `
      SELECT mi.item_id, mi.module_id, m.name AS module_name, m.course_id, mi.item_type, mi.title,
        mi.position, mi.content_ref, mi.html_url,
        COALESCE(f.total_chunks, 0) > 0 AS indexed
      FROM module_items mi
      JOIN modules m ON m.module_id = mi.module_id
      LEFT JOIN files f ON f.file_id = CASE
        WHEN mi.item_type = 'File' THEN mi.content_ref
        WHEN mi.item_type = 'Page' THEN 'page:' || m.course_id || ':' || mi.content_ref
        WHEN mi.item_type = 'Assignment' THEN 'assignment:' || mi.content_ref
        WHEN mi.item_type = 'Discussion' THEN 'discussion:' || mi.content_ref
        ELSE NULL END
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY m.position ASC, mi.position ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'assignments') {
    if (course_id) conditions.push(`a.course_id = ${add(String(course_id))}`);
    if (search_term) conditions.push(`a.name ILIKE ${add(`%${search_term}%`)}`);
    const bucket = options.bucket || 'all';
    if (bucket === 'upcoming') conditions.push(`a.due_at >= CURRENT_TIMESTAMP`);
    if (bucket === 'past') conditions.push(`a.due_at < CURRENT_TIMESTAMP`);
    if (bucket === 'undated') conditions.push(`a.due_at IS NULL`);
    const submissionCols = options.include_submission
      ? `, s.workflow_state AS submission_state, s.submitted_at, s.score, s.grade, s.late, s.missing, s.excused`
      : '';
    const submissionJoin = options.include_submission ? `LEFT JOIN submissions s ON s.assignment_id = a.assignment_id` : '';
    const sql = `
      SELECT a.assignment_id, a.course_id, a.name, a.due_at, a.points_possible, a.submission_types, a.group_name, a.html_url,
        (a.description IS NOT NULL AND length(a.description) > 0) AS has_description,
        COALESCE(f.total_chunks, 0) > 0 AS description_indexed
        ${submissionCols}
      FROM assignments a
      LEFT JOIN files f ON f.file_id = 'assignment:' || a.assignment_id
      ${submissionJoin}
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY ${bucket === 'past' ? 'a.due_at DESC' : 'a.due_at ASC NULLS LAST'}, a.name ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'files') {
    if (course_id) conditions.push(`f.course_id = ${add(String(course_id))}`);
    conditions.push(`f.source_type = 'file'`);
    if (search_term) {
      const p = add(`%${search_term}%`);
      conditions.push(`(f.filename ILIKE ${p} OR f.display_name ILIKE ${p})`);
    }
    const sql = `
      SELECT f.file_id, f.course_id, f.filename, f.display_name, f.content_type, f.size,
        f.html_url, f.total_chunks > 0 AS indexed
      FROM files f
      WHERE ${conditions.join(' AND ')}
      ORDER BY f.total_chunks DESC, f.filename ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'pages') {
    if (course_id) conditions.push(`p.course_id = ${add(String(course_id))}`);
    if (search_term) conditions.push(`p.title ILIKE ${add(`%${search_term}%`)}`);
    const sql = `
      SELECT p.page_url, p.course_id, p.title, p.updated_at, p.html_url, p.front_page,
        COALESCE(f.total_chunks, 0) > 0 AS indexed
      FROM pages p
      LEFT JOIN files f ON f.file_id = 'page:' || p.course_id || ':' || p.page_url
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY p.front_page DESC, p.title ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'full_hierarchy') {
    if (!course_id) {
      throw new Error('course_id is required for full_hierarchy exploration');
    }
    return getCourseHierarchy(String(course_id), options.include_items ?? true);
  }

  return [];
}

/** Where a piece of content is reachable from, as one string: "home page; module: Week 1; announcement: …". */
const LINKED_FROM_SQL = `
  SELECT s.to_ref, string_agg(DISTINCT s.src, '; ') AS linked_from FROM (
    SELECT mi.content_ref AS to_ref, 'module: ' || m.name AS src
    FROM module_items mi JOIN modules m ON m.module_id = mi.module_id
    WHERE m.course_id = $1 AND mi.item_type = $2
    UNION ALL
    SELECT cl.to_ref,
      CASE
        WHEN cl.from_type = 'page' AND p.front_page THEN 'home page'
        WHEN cl.from_type = 'page' THEN 'page: ' || COALESCE(p.title, cl.from_id)
        WHEN cl.from_type = 'assignment' THEN 'assignment: ' || COALESCE(a.name, cl.from_id)
        WHEN cl.from_type = 'announcement' THEN 'announcement: ' || COALESCE(an.title, cl.from_id)
        WHEN cl.from_type = 'discussion' THEN 'discussion: ' || COALESCE(d.title, cl.from_id)
        WHEN cl.from_type = 'quiz' THEN 'quiz: ' || COALESCE(qz.title, cl.from_id)
        WHEN cl.from_type = 'syllabus' THEN 'syllabus'
        ELSE cl.from_type
      END
    FROM content_links cl
    LEFT JOIN pages p ON cl.from_type = 'page' AND p.course_id = cl.course_id AND p.page_url = cl.from_id
    LEFT JOIN assignments a ON cl.from_type = 'assignment' AND a.assignment_id = cl.from_id
    LEFT JOIN announcements an ON cl.from_type = 'announcement' AND an.announcement_id = cl.from_id
    LEFT JOIN discussions d ON cl.from_type = 'discussion' AND d.discussion_id = cl.from_id
    LEFT JOIN quizzes qz ON cl.from_type = 'quiz' AND qz.quiz_id = cl.from_id
    WHERE cl.course_id = $1 AND cl.to_type = $3
  ) s GROUP BY s.to_ref`;

/**
 * Every file the course is known to have, however it was discovered: the Files area (when
 * visible), module items, and links on the home page / pages / assignments / announcements.
 */
export async function listCourseFiles(courseId: string, search?: string, limit?: number): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    `WITH linked AS (${LINKED_FROM_SQL}),
     known AS (
       SELECT f.file_id, COALESCE(f.display_name, f.filename) AS name, NULLIF(f.filename, COALESCE(f.display_name, f.filename)) AS filename,
         f.content_type, f.size, f.html_url, f.total_chunks > 0 AS indexed
       FROM files f WHERE f.course_id = $1 AND f.source_type = 'file'
       UNION
       SELECT mi.content_ref, mi.title, NULL, NULL, NULL, mi.html_url, FALSE
       FROM module_items mi JOIN modules m ON m.module_id = mi.module_id
       WHERE m.course_id = $1 AND mi.item_type = 'File' AND mi.content_ref IS NOT NULL
         AND mi.content_ref NOT IN (SELECT file_id FROM files WHERE course_id = $1)
     )
     SELECT k.file_id, k.name, k.filename, k.content_type, k.size, k.html_url, k.indexed, l.linked_from
     FROM known k LEFT JOIN linked l ON l.to_ref = k.file_id
     WHERE ($4::text IS NULL OR k.name ILIKE $4 OR k.filename ILIKE $4 OR l.linked_from ILIKE $4)
     ORDER BY k.indexed DESC, k.name ASC
     LIMIT $5`,
    [String(courseId), 'File', 'file', search ? `%${search}%` : null, clampLimit(limit)]
  );
  return res.rows;
}

/** Every page the course is known to have (Pages area when visible, module items, links); the front page first. */
export async function listCoursePages(courseId: string, search?: string, limit?: number): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    `WITH linked AS (${LINKED_FROM_SQL}),
     known AS (
       SELECT p.page_url, p.title, p.updated_at, p.html_url, p.front_page,
         COALESCE(f.total_chunks, 0) > 0 AS indexed
       FROM pages p
       LEFT JOIN files f ON f.file_id = 'page:' || p.course_id || ':' || p.page_url
       WHERE p.course_id = $1
       UNION
       SELECT mi.content_ref, mi.title, NULL, mi.html_url, FALSE, FALSE
       FROM module_items mi JOIN modules m ON m.module_id = mi.module_id
       WHERE m.course_id = $1 AND mi.item_type = 'Page' AND mi.content_ref IS NOT NULL
         AND mi.content_ref NOT IN (SELECT page_url FROM pages WHERE course_id = $1)
     )
     SELECT k.page_url, k.title, k.updated_at, k.html_url, k.front_page, k.indexed, l.linked_from
     FROM known k LEFT JOIN linked l ON l.to_ref = k.page_url
     WHERE ($4::text IS NULL OR k.title ILIKE $4 OR l.linked_from ILIKE $4)
     ORDER BY k.front_page DESC, k.title ASC
     LIMIT $5`,
    [String(courseId), 'Page', 'page', search ? `%${search}%` : null, clampLimit(limit)]
  );
  return res.rows;
}

/**
 * Replaces the links recorded for one HTML body and registers what they point at, so a file or
 * page that is only reachable through a link becomes listable and indexable. Registration never
 * overwrites a row that exists already (an indexed file keeps its real name and chunks).
 */
export async function storeContentLinks(
  courseId: string,
  fromType: 'page' | 'assignment' | 'announcement' | 'discussion' | 'quiz' | 'syllabus',
  fromId: string,
  links: ContentLink[],
  tx?: Queryable
): Promise<void> {
  const db = await q(tx);
  const course = String(courseId);
  await db.query('DELETE FROM content_links WHERE course_id = $1 AND from_type = $2 AND from_id = $3', [course, fromType, String(fromId)]);
  for (const l of links) {
    await db.query(
      `INSERT INTO content_links (course_id, from_type, from_id, to_type, to_ref, label, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [course, fromType, String(fromId), l.to_type, l.to_ref, l.label, l.position]
    );
    // Only content of this course is registered; a link into another course is recorded, not adopted
    if (l.course_id && l.course_id !== course) continue;
    if (l.to_type === 'file') {
      // Canvas puts the real filename in the anchor's title; the anchor text is what the student sees
      const filename = l.title && /\.\w{2,5}$/.test(l.title) ? l.title : null;
      await db.query(
        `INSERT INTO files (file_id, course_id, filename, display_name, version, total_chunks, source_type)
         VALUES ($1, $2, $3, $4, '', 0, 'file') ON CONFLICT (file_id) DO NOTHING`,
        [l.to_ref, course, filename || l.label || `file ${l.to_ref}`, l.label || filename || `file ${l.to_ref}`]
      );
    } else if (l.to_type === 'page') {
      await db.query(
        `INSERT INTO pages (page_url, course_id, title) VALUES ($1, $2, $3) ON CONFLICT (course_id, page_url) DO NOTHING`,
        [l.to_ref, course, l.label || l.to_ref]
      );
    }
  }
}

/** Sets which page is the course front page (clearing the flag elsewhere); upserts the page row. */
export async function setFrontPage(courseId: string, page: CanvasPage | null, tx?: Queryable): Promise<void> {
  const db = await q(tx);
  await db.query('UPDATE pages SET front_page = FALSE WHERE course_id = $1 AND front_page', [String(courseId)]);
  if (!page?.url) return;
  await db.query(
    `INSERT INTO pages (page_url, course_id, title, updated_at, html_url, front_page, synced_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP)
     ON CONFLICT (course_id, page_url) DO UPDATE SET
       title = EXCLUDED.title, updated_at = EXCLUDED.updated_at, html_url = COALESCE(EXCLUDED.html_url, pages.html_url),
       front_page = TRUE, synced_at = CURRENT_TIMESTAMP`,
    [page.url, String(courseId), page.title || page.url, page.updated_at || null, page.html_url || null]
  );
}

/** Replaces a course's navigation bar. */
export async function replaceCourseTabs(courseId: string, tabs: CanvasTab[], tx?: Queryable): Promise<number> {
  const db = await q(tx);
  await db.query('DELETE FROM course_tabs WHERE course_id = $1', [String(courseId)]);
  let n = 0;
  for (const t of tabs) {
    if (!t.id || t.hidden) continue;
    await db.query(
      `INSERT INTO course_tabs (course_id, tab_id, label, type, html_url, position)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (course_id, tab_id) DO NOTHING`,
      [String(courseId), String(t.id), t.label || t.id, t.type || 'internal', t.full_url || t.html_url || null, t.position ?? n]
    );
    n++;
  }
  return n;
}

/**
 * Modules + items (flat, depth-tagged) and assignments for the Graph Explorer's tree view.
 */
export async function getCourseHierarchy(courseId: string, includeItems: boolean = true): Promise<any> {
  const db = await getDB();

  const courseRes = await db.query('SELECT course_id, name, course_code, term FROM courses WHERE course_id = $1', [courseId]);
  const course = courseRes.rows[0] || null;

  const treeQuery = `
    WITH RECURSIVE tree AS (
      SELECT
        m.module_id AS node_id,
        'module' AS node_type,
        m.name AS label,
        m.position AS pos,
        m.module_id AS parent_module_id,
        NULL::text AS item_type,
        NULL::text AS content_ref,
        NULL::text AS html_url,
        0 AS depth
      FROM modules m
      WHERE m.course_id = $1

      UNION ALL

      SELECT
        mi.item_id AS node_id,
        'module_item' AS node_type,
        mi.title AS label,
        mi.position AS pos,
        mi.module_id AS parent_module_id,
        mi.item_type,
        mi.content_ref,
        mi.html_url,
        tree.depth + 1 AS depth
      FROM module_items mi
      JOIN tree ON mi.module_id = tree.node_id AND tree.node_type = 'module'
      WHERE $2::boolean
    )
    SELECT * FROM tree ORDER BY parent_module_id, depth, pos;
  `;

  const treeRes = await db.query(treeQuery, [courseId, includeItems]);

  // Projected: the description HTML is never part of an overview
  const assignRes = await db.query(
    `SELECT assignment_id, course_id, name, due_at, points_possible, html_url, group_name
     FROM assignments WHERE course_id = $1 ORDER BY due_at ASC NULLS LAST`,
    [courseId]
  );

  const edgesRes = await db.query(
    `SELECT ge.* FROM graph_edges ge
     JOIN modules m ON m.module_id = ge.to_id AND ge.to_type = 'module'
     WHERE m.course_id = $1`,
    [courseId]
  );

  return {
    course,
    treeNodes: treeRes.rows,
    assignments: assignRes.rows,
    prerequisites: edgesRes.rows,
  };
}

export async function getAssignmentRow(assignmentId: string): Promise<any | null> {
  const db = await getDB();
  const res = await db.query(
    `SELECT a.*, s.workflow_state AS submission_state, s.submitted_at, s.graded_at, s.score, s.grade, s.late, s.missing, s.excused,
       COALESCE(f.total_chunks, 0) > 0 AS description_indexed
     FROM assignments a
     LEFT JOIN submissions s ON s.assignment_id = a.assignment_id
     LEFT JOIN files f ON f.file_id = 'assignment:' || a.assignment_id
     WHERE a.assignment_id = $1`,
    [String(assignmentId)]
  );
  return res.rows[0] || null;
}

export async function listAnnouncements(courseId: string, limit: number): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    `SELECT announcement_id, title, posted_at, author, text, html_url
     FROM announcements WHERE course_id = $1 ORDER BY posted_at DESC NULLS LAST LIMIT $2`,
    [String(courseId), clampLimit(limit, 10)]
  );
  return res.rows;
}

export async function listDiscussions(courseId: string, search: string | undefined, limit: number): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    `SELECT d.discussion_id, d.title, d.author, d.posted_at, d.last_reply_at, d.reply_count, d.message, d.html_url,
       d.pinned, d.locked, d.assignment_id, COALESCE(f.total_chunks, 0) > 0 AS replies_read
     FROM discussions d
     LEFT JOIN files f ON f.file_id = 'discussion:' || d.discussion_id
     WHERE d.course_id = $1 AND ($2::text IS NULL OR d.title ILIKE $2 OR d.message ILIKE $2)
     ORDER BY d.pinned DESC, COALESCE(d.last_reply_at, d.posted_at) DESC NULLS LAST
     LIMIT $3`,
    [String(courseId), search ? `%${search}%` : null, clampLimit(limit, 10)]
  );
  return res.rows;
}

export async function getDiscussionRow(discussionId: string): Promise<any | null> {
  const db = await getDB();
  const res = await db.query('SELECT * FROM discussions WHERE discussion_id = $1', [String(discussionId)]);
  return res.rows[0] || null;
}

/** Records which last_reply_at the stored reply entries correspond to. */
export async function setDiscussionRepliesSynced(discussionId: string, version: string | null): Promise<void> {
  const db = await getDB();
  await db.query('UPDATE discussions SET replies_synced_for = $2 WHERE discussion_id = $1', [String(discussionId), version]);
}

export type QuizBucket = 'upcoming' | 'past' | 'undated' | 'all';

export async function listQuizzes(options: {
  courseId: string;
  search?: string;
  bucket?: QuizBucket;
  includeSubmission?: boolean;
  limit?: number;
}): Promise<any[]> {
  const db = await getDB();
  const conditions = ['qz.course_id = $1', '($2::text IS NULL OR qz.title ILIKE $2)'];
  const bucket = options.bucket || 'all';
  if (bucket === 'upcoming') conditions.push('qz.due_at >= CURRENT_TIMESTAMP');
  if (bucket === 'past') conditions.push('qz.due_at < CURRENT_TIMESTAMP');
  if (bucket === 'undated') conditions.push('qz.due_at IS NULL');
  const submissionCols = options.includeSubmission
    ? ', s.workflow_state AS submission_state, s.submitted_at, s.score, s.grade, s.late, s.missing, s.excused'
    : '';
  const submissionJoin = options.includeSubmission ? 'LEFT JOIN submissions s ON s.assignment_id = qz.assignment_id' : '';
  const res = await db.query(
    `SELECT qz.quiz_id, qz.title, qz.quiz_type, qz.time_limit, qz.allowed_attempts, qz.question_count, qz.points_possible,
       qz.due_at, qz.unlock_at, qz.lock_at, qz.published, qz.description, qz.assignment_id, qz.html_url, qz.lock_explanation
       ${submissionCols}
     FROM quizzes qz ${submissionJoin}
     WHERE ${conditions.join(' AND ')}
     ORDER BY qz.due_at ASC NULLS LAST, qz.title ASC
     LIMIT $3`,
    [String(options.courseId), options.search ? `%${options.search}%` : null, clampLimit(options.limit)]
  );
  return res.rows;
}

/** The Syllabus tab body (raw HTML) and its fingerprint, or null when the course has none. */
export async function getCourseSyllabus(courseId: string): Promise<{ body: string; version: string } | null> {
  const db = await getDB();
  const res = await db.query<{ syllabus_body: string | null; syllabus_version: string | null }>(
    'SELECT syllabus_body, syllabus_version FROM courses WHERE course_id = $1',
    [String(courseId)]
  );
  const row = res.rows[0];
  if (!row?.syllabus_body) return null;
  return { body: row.syllabus_body, version: row.syllabus_version || '1' };
}

export async function listPlannerItems(start: Date, end: Date): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    `SELECT plannable_type, plannable_id, course_id, context_name, title, date, points,
       submitted, late, missing, graded, new_activity, html_url
     FROM planner_items WHERE date >= $1 AND date <= $2 ORDER BY date ASC`,
    [start, end]
  );
  return res.rows;
}

export async function listConversations(options: {
  scope?: 'all' | 'unread' | 'starred';
  search?: string;
  limit?: number;
}): Promise<any[]> {
  const db = await getDB();
  const params: any[] = [];
  const add = (v: any) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  if (options.scope === 'unread') conditions.push(`c.workflow_state = 'unread'`);
  if (options.scope === 'starred') conditions.push(`c.starred = TRUE`);

  // Search matches subject/last message directly, or any stored message body (FTS with ILIKE fallback)
  let matchCols = '';
  if (options.search) {
    const like = add(`%${options.search}%`);
    const tsq = add(options.search);
    conditions.push(`(c.subject ILIKE ${like} OR c.last_message ILIKE ${like} OR EXISTS (
        SELECT 1 FROM messages mm WHERE mm.conversation_id = c.conversation_id
          AND (mm.body_tsv @@ websearch_to_tsquery('english', ${tsq}) OR mm.body ILIKE ${like})))`);
    matchCols = `, (
        SELECT mm.author_name || ' (' || to_char(mm.created_at, 'YYYY-MM-DD') || '): ' || left(mm.body, 300)
        FROM messages mm WHERE mm.conversation_id = c.conversation_id
          AND (mm.body_tsv @@ websearch_to_tsquery('english', ${tsq}) OR mm.body ILIKE ${like})
        ORDER BY mm.created_at DESC LIMIT 1) AS matching_message`;
  }

  const sql = `
    SELECT c.conversation_id, c.subject, c.context_name, c.participants, c.last_message, c.last_message_at,
      c.workflow_state, c.message_count, c.starred ${matchCols}
    FROM conversations c
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT ${add(clampLimit(options.limit, 10))}`;
  return (await db.query(sql, params)).rows;
}

export async function getConversationSubject(conversationId: string): Promise<string> {
  const db = await getDB();
  const res = await db.query<{ subject: string | null }>('SELECT subject FROM conversations WHERE conversation_id = $1', [String(conversationId)]);
  return res.rows[0]?.subject || `Conversation ${conversationId}`;
}

export async function getConversationMessages(conversationId: string): Promise<any[]> {
  const db = await getDB();
  const res = await db.query(
    `SELECT message_id, author_name, created_at, body FROM messages
     WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [String(conversationId)]
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Writes (all accept an optional transaction)
// ---------------------------------------------------------------------------

/**
 * Removes graph_edges whose module / module_item endpoint no longer exists.
 * graph_edges has no foreign keys, so pruning (and the ON DELETE CASCADE from
 * modules -> module_items) would otherwise leave ghost edges behind.
 */
export async function pruneOrphanEdges(tx?: Queryable): Promise<void> {
  const db = await q(tx);
  await db.query(`
    DELETE FROM graph_edges
    WHERE (from_type = 'module' AND from_id NOT IN (SELECT module_id FROM modules))
       OR (to_type   = 'module' AND to_id   NOT IN (SELECT module_id FROM modules))
       OR (from_type = 'module_item' AND from_id NOT IN (SELECT item_id FROM module_items))
       OR (to_type   = 'module_item' AND to_id   NOT IN (SELECT item_id FROM module_items))
  `);
}

async function pruneNotIn(
  db: Queryable,
  table: string,
  idColumn: string,
  scopeSql: string,
  scopeParams: any[],
  keepIds: string[]
): Promise<number> {
  const base = scopeParams.length;
  if (keepIds.length > 0) {
    const placeholders = keepIds.map((_, i) => `$${base + i + 1}`).join(',');
    const res = await db.query(
      `DELETE FROM ${table} WHERE ${scopeSql} AND ${idColumn} NOT IN (${placeholders}) RETURNING ${idColumn}`,
      [...scopeParams, ...keepIds]
    );
    return res.rows.length;
  }
  const res = await db.query(`DELETE FROM ${table} WHERE ${scopeSql} RETURNING ${idColumn}`, scopeParams);
  return res.rows.length;
}

export async function upsertCourses(courses: CanvasCourse[], tx?: Queryable): Promise<number> {
  if (!courses || courses.length === 0) return 0;
  const db = await q(tx);

  for (const c of courses) {
    await db.query(
      `INSERT INTO courses (course_id, name, course_code, term, default_view, synced_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (course_id) DO UPDATE SET
         name = EXCLUDED.name,
         course_code = EXCLUDED.course_code,
         term = EXCLUDED.term,
         default_view = COALESCE(EXCLUDED.default_view, courses.default_view),
         synced_at = CURRENT_TIMESTAMP`,
      [String(c.id), c.name, c.course_code || null, c.term?.name || null, c.default_view || null]
    );
  }

  return courses.length;
}

/**
 * Upserts modules for a course, prunes removed modules, and stores prerequisite edges.
 * Does not touch items (see upsertAndPruneModuleItems).
 */
export async function upsertAndPruneModules(
  courseId: string,
  modules: CanvasModule[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const validIds: string[] = [];

  for (const m of modules) {
    const moduleId = String(m.id);
    validIds.push(moduleId);

    await db.query(
      `INSERT INTO modules (module_id, course_id, name, position, synced_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (module_id) DO UPDATE SET
         name = EXCLUDED.name,
         position = EXCLUDED.position,
         synced_at = CURRENT_TIMESTAMP`,
      [moduleId, String(courseId), m.name, m.position ?? 0]
    );

    // Replace prerequisite edges so removed prerequisites do not linger
    await db.query(
      `DELETE FROM graph_edges WHERE to_type = 'module' AND to_id = $1 AND relation = 'prerequisite'`,
      [moduleId]
    );
    if (m.prerequisite_module_ids && Array.isArray(m.prerequisite_module_ids)) {
      for (const prereqId of m.prerequisite_module_ids) {
        await db.query(
          `INSERT INTO graph_edges (from_type, from_id, to_type, to_id, relation)
           VALUES ('module', $1, 'module', $2, 'prerequisite')
           ON CONFLICT DO NOTHING`,
          [String(prereqId), moduleId]
        );
      }
    }
  }

  const pruned = await pruneNotIn(db, 'modules', 'module_id', 'course_id = $1', [String(courseId)], validIds);
  await pruneOrphanEdges(db);
  return { upserted: modules.length, pruned };
}

export async function upsertAndPruneModuleItems(
  moduleId: string,
  items: CanvasModuleItem[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const validIds: string[] = [];

  for (const item of items) {
    const itemId = String(item.id);
    validIds.push(itemId);
    // Files/Assignments/Quizzes carry a numeric content_id; wiki pages are addressed by slug;
    // ExternalUrl/ExternalTool point off-Canvas, so content_ref holds their destination URL when Canvas sends one.
    const contentRef = item.type === 'Page' && item.page_url
      ? String(item.page_url)
      : (item.type === 'ExternalUrl' || item.type === 'ExternalTool') && item.external_url
      ? String(item.external_url)
      : item.content_id ? String(item.content_id) : null;

    await db.query(
      `INSERT INTO module_items (item_id, module_id, item_type, title, position, content_ref, html_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (item_id) DO UPDATE SET
         item_type = EXCLUDED.item_type,
         title = EXCLUDED.title,
         position = EXCLUDED.position,
         content_ref = EXCLUDED.content_ref,
         html_url = EXCLUDED.html_url,
         synced_at = CURRENT_TIMESTAMP`,
      [
        itemId,
        String(moduleId),
        item.type || 'Unknown',
        item.title || 'Untitled',
        item.position ?? 0,
        contentRef,
        item.html_url || null,
      ]
    );

    if (item.type === 'File' && contentRef) {
      await db.query(
        `INSERT INTO graph_edges (from_type, from_id, to_type, to_id, relation)
         VALUES ('module_item', $1, 'file', $2, 'references')
         ON CONFLICT DO NOTHING`,
        [itemId, contentRef]
      );
    }
  }

  const pruned = await pruneNotIn(db, 'module_items', 'item_id', 'module_id = $1', [String(moduleId)], validIds);
  await pruneOrphanEdges(db);
  return { upserted: items.length, pruned };
}

/**
 * Upserts assignments from a listing that may lack `description`. A stored description is kept
 * while the upstream `updated_at` is unchanged, otherwise dropped so it is re-fetched on demand.
 */
export async function upsertAndPruneAssignments(
  courseId: string,
  assignments: CanvasAssignment[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const validIds: string[] = [];

  for (const a of assignments) {
    const assignId = String(a.id);
    validIds.push(assignId);
    const hasDescription = typeof a.description === 'string';

    await db.query(
      `INSERT INTO assignments (assignment_id, course_id, name, due_at, points_possible, html_url,
         description, description_version, updated_at, submission_types, group_name, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
       ON CONFLICT (assignment_id) DO UPDATE SET
         name = EXCLUDED.name,
         due_at = EXCLUDED.due_at,
         points_possible = EXCLUDED.points_possible,
         html_url = EXCLUDED.html_url,
         description = CASE
           WHEN $12::boolean THEN EXCLUDED.description
           WHEN assignments.description_version IS NOT DISTINCT FROM EXCLUDED.updated_at THEN assignments.description
           ELSE NULL END,
         description_version = CASE
           WHEN $12::boolean THEN EXCLUDED.updated_at
           WHEN assignments.description_version IS NOT DISTINCT FROM EXCLUDED.updated_at THEN assignments.description_version
           ELSE NULL END,
         updated_at = EXCLUDED.updated_at,
         submission_types = EXCLUDED.submission_types,
         group_name = COALESCE(EXCLUDED.group_name, assignments.group_name),
         synced_at = CURRENT_TIMESTAMP`,
      [
        assignId,
        String(courseId),
        a.name,
        a.due_at || null,
        a.points_possible != null ? Number(a.points_possible) : null,
        a.html_url || null,
        hasDescription ? a.description : null,
        hasDescription ? a.updated_at || null : null,
        a.updated_at || null,
        Array.isArray(a.submission_types) ? a.submission_types.join(',') : null,
        a.group_name || null,
        hasDescription,
      ]
    );
  }

  const pruned = await pruneNotIn(db, 'assignments', 'assignment_id', 'course_id = $1', [String(courseId)], validIds);
  if (pruned > 0) {
    // Indexed description documents of deleted assignments would otherwise keep surfacing in search
    await db.query(
      `DELETE FROM files WHERE source_type = 'assignment' AND course_id = $1
         AND substring(file_id from 12) NOT IN (SELECT assignment_id FROM assignments WHERE course_id = $1)`,
      [String(courseId)]
    );
    await db.query(
      `DELETE FROM content_links WHERE course_id = $1 AND from_type = 'assignment' AND from_id NOT IN (SELECT assignment_id FROM assignments WHERE course_id = $1)`,
      [String(courseId)]
    );
  }
  return { upserted: assignments.length, pruned };
}

/** Stores a freshly fetched description for one assignment. */
export async function setAssignmentDescription(
  assignmentId: string,
  description: string | null,
  updatedAt: string | null
): Promise<void> {
  const db = await getDB();
  await db.query(
    `UPDATE assignments SET description = $2, description_version = $3, updated_at = COALESCE($3, updated_at)
     WHERE assignment_id = $1`,
    [String(assignmentId), description, updatedAt]
  );
}

export async function upsertAndPrunePages(
  courseId: string,
  pages: CanvasPage[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const validUrls: string[] = [];

  for (const p of pages) {
    if (!p.url) continue;
    validUrls.push(p.url);
    await db.query(
      `INSERT INTO pages (page_url, course_id, title, updated_at, html_url, front_page, synced_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), CURRENT_TIMESTAMP)
       ON CONFLICT (course_id, page_url) DO UPDATE SET
         title = EXCLUDED.title,
         updated_at = EXCLUDED.updated_at,
         html_url = EXCLUDED.html_url,
         front_page = COALESCE($6, pages.front_page),
         synced_at = CURRENT_TIMESTAMP`,
      [p.url, String(courseId), p.title || p.url, p.updated_at || null, p.html_url || null, p.front_page ?? null]
    );
  }

  const pruned = await pruneNotIn(db, 'pages', 'page_url', 'course_id = $1', [String(courseId)], validUrls);
  if (pruned > 0) {
    await db.query(
      `DELETE FROM files WHERE source_type = 'page' AND course_id = $1
         AND substring(file_id from length('page:' || $1 || ':') + 1) NOT IN (SELECT page_url FROM pages WHERE course_id = $1)`,
      [String(courseId)]
    );
    await db.query(
      `DELETE FROM content_links WHERE course_id = $1 AND from_type = 'page' AND from_id NOT IN (SELECT page_url FROM pages WHERE course_id = $1)`,
      [String(courseId)]
    );
  }
  return { upserted: validUrls.length, pruned };
}

export async function upsertAndPruneSubmissions(
  courseId: string,
  rows: ShapedSubmission[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const ids: string[] = [];
  for (const s of rows) {
    ids.push(s.assignment_id);
    await db.query(
      `INSERT INTO submissions (assignment_id, course_id, workflow_state, submitted_at, graded_at, score, grade, late, missing, excused, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
       ON CONFLICT (assignment_id) DO UPDATE SET
         course_id = EXCLUDED.course_id, workflow_state = EXCLUDED.workflow_state, submitted_at = EXCLUDED.submitted_at,
         graded_at = EXCLUDED.graded_at, score = EXCLUDED.score, grade = EXCLUDED.grade, late = EXCLUDED.late,
         missing = EXCLUDED.missing, excused = EXCLUDED.excused, synced_at = CURRENT_TIMESTAMP`,
      [s.assignment_id, String(courseId), s.workflow_state, s.submitted_at, s.graded_at, s.score, s.grade, s.late, s.missing, s.excused]
    );
  }
  const pruned = await pruneNotIn(db, 'submissions', 'assignment_id', 'course_id = $1', [String(courseId)], ids);
  return { upserted: rows.length, pruned };
}

export async function upsertAndPruneAnnouncements(
  courseId: string,
  rows: ShapedAnnouncement[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const ids: string[] = [];
  for (const a of rows) {
    ids.push(a.announcement_id);
    await db.query(
      `INSERT INTO announcements (announcement_id, course_id, title, posted_at, author, text, html_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (announcement_id) DO UPDATE SET
         title = EXCLUDED.title, posted_at = EXCLUDED.posted_at, author = EXCLUDED.author,
         text = EXCLUDED.text, html_url = EXCLUDED.html_url, synced_at = CURRENT_TIMESTAMP`,
      [a.announcement_id, String(courseId), a.title, a.posted_at, a.author, a.text, a.html_url]
    );
  }
  const pruned = await pruneNotIn(db, 'announcements', 'announcement_id', 'course_id = $1', [String(courseId)], ids);
  if (pruned > 0) {
    await db.query(
      `DELETE FROM content_links WHERE course_id = $1 AND from_type = 'announcement' AND from_id NOT IN (SELECT announcement_id FROM announcements WHERE course_id = $1)`,
      [String(courseId)]
    );
  }
  return { upserted: rows.length, pruned };
}

export async function upsertAndPruneDiscussions(
  courseId: string,
  rows: ShapedDiscussion[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const ids: string[] = [];
  for (const d of rows) {
    ids.push(d.discussion_id);
    await db.query(
      `INSERT INTO discussions (discussion_id, course_id, title, author, posted_at, last_reply_at, reply_count, message,
         html_url, pinned, locked, assignment_id, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
       ON CONFLICT (discussion_id) DO UPDATE SET
         title = EXCLUDED.title, author = EXCLUDED.author, posted_at = EXCLUDED.posted_at,
         last_reply_at = EXCLUDED.last_reply_at, reply_count = EXCLUDED.reply_count, message = EXCLUDED.message,
         html_url = EXCLUDED.html_url, pinned = EXCLUDED.pinned, locked = EXCLUDED.locked,
         assignment_id = EXCLUDED.assignment_id, synced_at = CURRENT_TIMESTAMP`,
      [d.discussion_id, String(courseId), d.title, d.author, d.posted_at, d.last_reply_at, d.reply_count, d.message,
        d.html_url, d.pinned, d.locked, d.assignment_id]
    );
  }
  const pruned = await pruneNotIn(db, 'discussions', 'discussion_id', 'course_id = $1', [String(courseId)], ids);
  if (pruned > 0) {
    await db.query(
      `DELETE FROM files WHERE source_type = 'discussion' AND course_id = $1
         AND substring(file_id from 12) NOT IN (SELECT discussion_id FROM discussions WHERE course_id = $1)`,
      [String(courseId)]
    );
    await db.query(
      `DELETE FROM content_links WHERE course_id = $1 AND from_type = 'discussion' AND from_id NOT IN (SELECT discussion_id FROM discussions WHERE course_id = $1)`,
      [String(courseId)]
    );
  }
  return { upserted: rows.length, pruned };
}

export async function upsertAndPruneQuizzes(
  courseId: string,
  rows: ShapedQuiz[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number }> {
  const db = await q(tx);
  const ids: string[] = [];
  for (const z of rows) {
    ids.push(z.quiz_id);
    await db.query(
      `INSERT INTO quizzes (quiz_id, course_id, title, quiz_type, time_limit, allowed_attempts, question_count, points_possible,
         due_at, unlock_at, lock_at, published, description, assignment_id, html_url, lock_explanation, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
       ON CONFLICT (quiz_id) DO UPDATE SET
         title = EXCLUDED.title, quiz_type = EXCLUDED.quiz_type, time_limit = EXCLUDED.time_limit,
         allowed_attempts = EXCLUDED.allowed_attempts, question_count = EXCLUDED.question_count,
         points_possible = EXCLUDED.points_possible, due_at = EXCLUDED.due_at, unlock_at = EXCLUDED.unlock_at,
         lock_at = EXCLUDED.lock_at, published = EXCLUDED.published, description = EXCLUDED.description,
         assignment_id = EXCLUDED.assignment_id, html_url = EXCLUDED.html_url, lock_explanation = EXCLUDED.lock_explanation,
         synced_at = CURRENT_TIMESTAMP`,
      [z.quiz_id, String(courseId), z.title, z.quiz_type, z.time_limit, z.allowed_attempts, z.question_count, z.points_possible,
        z.due_at, z.unlock_at, z.lock_at, z.published, z.description, z.assignment_id, z.html_url, z.lock_explanation]
    );
  }
  const pruned = await pruneNotIn(db, 'quizzes', 'quiz_id', 'course_id = $1', [String(courseId)], ids);
  if (pruned > 0) {
    await db.query(
      `DELETE FROM content_links WHERE course_id = $1 AND from_type = 'quiz' AND from_id NOT IN (SELECT quiz_id FROM quizzes WHERE course_id = $1)`,
      [String(courseId)]
    );
  }
  return { upserted: rows.length, pruned };
}

/** Stores the Syllabus tab body; NULL when the course has none. The document is indexed from it on demand. */
export async function setCourseSyllabus(courseId: string, body: string | null, version: string | null, tx?: Queryable): Promise<void> {
  const db = await q(tx);
  await db.query('UPDATE courses SET syllabus_body = $2, syllabus_version = $3 WHERE course_id = $1', [String(courseId), body, version]);
  if (!body) {
    // A removed syllabus must stop surfacing in search
    await db.query(`DELETE FROM files WHERE file_id = 'syllabus:' || $1`, [String(courseId)]);
    await db.query(`DELETE FROM content_links WHERE course_id = $1 AND from_type = 'syllabus'`, [String(courseId)]);
  }
}

/**
 * Drops everything one collection stored for a course, so the engine fetches it afresh the next
 * time it is needed. Mirrors what each collection's prune removes when a row disappears
 * (dependent documents, the links found in their bodies). Files that a link in the course still
 * names keep their registration and lose only their text, as in the Files-area prune.
 */
export async function forgetCollectionRows(kind: CollectionKind, courseId: string, tx?: Queryable): Promise<void> {
  const db = await q(tx);
  const c = String(courseId);
  switch (kind) {
    case 'modules':
      await db.query('DELETE FROM modules WHERE course_id = $1', [c]);
      await pruneOrphanEdges(db);
      return;
    case 'assignments':
      await db.query('DELETE FROM assignments WHERE course_id = $1', [c]);
      await db.query(`DELETE FROM files WHERE course_id = $1 AND source_type = 'assignment'`, [c]);
      await db.query(`DELETE FROM content_links WHERE course_id = $1 AND from_type = 'assignment'`, [c]);
      return;
    case 'files': {
      const linked = `file_id IN (SELECT to_ref FROM content_links WHERE course_id = $1 AND to_type = 'file')`;
      await db.query(`DELETE FROM files WHERE course_id = $1 AND source_type = 'file' AND NOT ${linked}`, [c]);
      await db.query(
        `DELETE FROM file_chunks WHERE file_id IN (SELECT file_id FROM files WHERE course_id = $1 AND source_type = 'file' AND ${linked})`,
        [c]
      );
      await db.query(`UPDATE files SET total_chunks = 0 WHERE course_id = $1 AND source_type = 'file' AND ${linked}`, [c]);
      return;
    }
    case 'pages':
      await db.query('DELETE FROM pages WHERE course_id = $1', [c]);
      await db.query(`DELETE FROM files WHERE course_id = $1 AND source_type = 'page'`, [c]);
      await db.query(`DELETE FROM content_links WHERE course_id = $1 AND from_type = 'page'`, [c]);
      return;
    case 'home':
      // The front page stays a page; what "home" added is the flag and the links found on it
      await db.query(
        `DELETE FROM content_links WHERE course_id = $1 AND from_type = 'page'
           AND from_id IN (SELECT page_url FROM pages WHERE course_id = $1 AND front_page)`,
        [c]
      );
      await db.query('UPDATE pages SET front_page = FALSE WHERE course_id = $1 AND front_page', [c]);
      return;
    case 'submissions':
      await db.query('DELETE FROM submissions WHERE course_id = $1', [c]);
      return;
    case 'announcements':
      await db.query('DELETE FROM announcements WHERE course_id = $1', [c]);
      await db.query(`DELETE FROM content_links WHERE course_id = $1 AND from_type = 'announcement'`, [c]);
      return;
    case 'discussions':
      await db.query('DELETE FROM discussions WHERE course_id = $1', [c]);
      await db.query(`DELETE FROM files WHERE course_id = $1 AND source_type = 'discussion'`, [c]);
      await db.query(`DELETE FROM content_links WHERE course_id = $1 AND from_type = 'discussion'`, [c]);
      return;
    case 'quizzes':
      await db.query('DELETE FROM quizzes WHERE course_id = $1', [c]);
      await db.query(`DELETE FROM content_links WHERE course_id = $1 AND from_type = 'quiz'`, [c]);
      return;
    case 'syllabus':
      await setCourseSyllabus(c, null, null, db);
      return;
    default:
      throw new Error(`${kind} is not a course collection`);
  }
}

/** Drops one course and everything remembered under it (its documents included). */
export async function forgetCourseRows(courseId: string, tx?: Queryable): Promise<void> {
  const db = await q(tx);
  await db.query('DELETE FROM files WHERE course_id = $1', [String(courseId)]); // before the course delete sets course_id null
  await db.query('DELETE FROM courses WHERE course_id = $1', [String(courseId)]);
  await pruneOrphanEdges(db);
}

/**
 * Empties the whole graph — every course and what hangs off it, every document, the planner
 * window, the inbox and the link/edge tables — leaving the schema in place. Chats are not
 * stored here and are untouched.
 */
export async function clearGraphRows(tx?: Queryable): Promise<void> {
  const db = await q(tx);
  await db.query('DELETE FROM courses'); // cascades to modules, items, assignments, submissions, pages, tabs, links, …
  await db.query('DELETE FROM files'); // cascades to file_chunks; course_id was set null by the course delete
  await db.query('DELETE FROM conversations'); // cascades to messages
  await db.query('DELETE FROM planner_items');
  await db.query('DELETE FROM graph_edges');
}

/** The planner window is replaced wholesale on every sync. */
export async function replacePlannerItems(rows: ShapedPlannerItem[], tx?: Queryable): Promise<number> {
  const db = await q(tx);
  await db.query('DELETE FROM planner_items');
  for (const p of rows) {
    await db.query(
      `INSERT INTO planner_items (item_key, plannable_type, plannable_id, course_id, context_name, title, date, points,
         submitted, late, missing, graded, new_activity, html_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
       ON CONFLICT (item_key) DO NOTHING`,
      [p.item_key, p.plannable_type, p.plannable_id, p.course_id, p.context_name, p.title, p.date, p.points,
        p.submitted, p.late, p.missing, p.graded, p.new_activity, p.html_url]
    );
  }
  return rows.length;
}

/**
 * Upserts the conversation list and prunes conversations no longer in it. Returns the ids whose
 * thread needs (re)fetching: new ones, and ones whose last_message_at moved.
 */
export async function upsertAndPruneConversations(
  rows: ShapedConversation[],
  tx?: Queryable
): Promise<{ upserted: number; pruned: number; staleThreads: string[] }> {
  const db = await q(tx);
  const ids: string[] = [];
  const staleThreads: string[] = [];
  for (const c of rows) {
    ids.push(c.conversation_id);
    const res = await db.query<{ stale: boolean }>(
      `INSERT INTO conversations (conversation_id, subject, context_name, course_id, participants, last_message,
         last_message_at, workflow_state, message_count, starred, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
       ON CONFLICT (conversation_id) DO UPDATE SET
         subject = EXCLUDED.subject, context_name = EXCLUDED.context_name, course_id = EXCLUDED.course_id,
         participants = EXCLUDED.participants, last_message = EXCLUDED.last_message,
         last_message_at = EXCLUDED.last_message_at, workflow_state = EXCLUDED.workflow_state,
         message_count = EXCLUDED.message_count, starred = EXCLUDED.starred, synced_at = CURRENT_TIMESTAMP
       RETURNING (thread_synced_for IS DISTINCT FROM $11::text) AS stale`,
      [c.conversation_id, c.subject, c.context_name, c.course_id, JSON.stringify(c.participants), c.last_message,
        c.last_message_at, c.workflow_state, c.message_count, c.starred, c.last_message_at]
    );
    if (res.rows[0]?.stale) staleThreads.push(c.conversation_id);
  }
  const pruned = await pruneNotIn(db, 'conversations', 'conversation_id', 'TRUE', [], ids);
  if (pruned > 0) {
    await db.query(
      `DELETE FROM files WHERE source_type = 'conversation'
         AND substring(file_id from 14) NOT IN (SELECT conversation_id FROM conversations)`
    );
  }
  return { upserted: rows.length, pruned, staleThreads };
}

/** Inserts messages not yet stored; returns the ids that were new. */
export async function upsertMessages(
  conversationId: string,
  rows: ShapedMessage[],
  threadVersion: string | null,
  tx?: Queryable
): Promise<string[]> {
  const db = await q(tx);
  const inserted: string[] = [];
  for (const m of rows) {
    const res = await db.query(
      `INSERT INTO messages (message_id, conversation_id, author_id, author_name, created_at, body, body_tsv)
       VALUES ($1, $2, $3, $4, $5, $6, to_tsvector('english', $6))
       ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
      [m.message_id, String(conversationId), m.author_id, m.author_name, m.created_at, m.body]
    );
    if (res.rows.length) inserted.push(m.message_id);
  }
  await db.query('UPDATE conversations SET thread_synced_for = $2 WHERE conversation_id = $1', [
    String(conversationId),
    threadVersion,
  ]);
  return inserted;
}

// ---------------------------------------------------------------------------
// Overview / stats
// ---------------------------------------------------------------------------

/**
 * Compact course roster for the model: names and ids only. Freshness is the engine's job now,
 * so nothing about sync ages is exposed here.
 */
export async function getGraphOverviewText(): Promise<string> {
  const db = await getDB();
  const res = await db.query<{ course_id: string; name: string; course_code: string | null; term: string | null }>(
    `SELECT course_id, name, course_code, term FROM courses ORDER BY name ASC LIMIT 40`
  );
  if (res.rows.length === 0) {
    return 'No courses are known yet. Call list_content with kind "courses" to load them.';
  }
  const lines = res.rows.map((r) =>
    `- ${r.course_code ? `${r.course_code} — ` : ''}${r.name} (course_id ${r.course_id}${r.term ? `, ${r.term}` : ''})`
  );
  return `The student's courses:\n${lines.join('\n')}`;
}

export async function getGraphStatistics(): Promise<GraphStats> {
  const db = await getDB();

  const [courses, modules, items, assignments, files, chunks] = await Promise.all([
    db.query('SELECT COUNT(*) as count FROM courses'),
    db.query('SELECT COUNT(*) as count FROM modules'),
    db.query('SELECT COUNT(*) as count FROM module_items'),
    db.query('SELECT COUNT(*) as count FROM assignments'),
    db.query('SELECT COUNT(*) as count FROM files'),
    // chunks of an outdated document version are kept only as a vector cache; don't count them
    db.query('SELECT COUNT(*) as count FROM file_chunks fc JOIN files f ON f.file_id = fc.file_id WHERE f.total_chunks > 0'),
  ]);

  const readCount = (row: unknown): number => Number((row as { count?: string | number } | undefined)?.count || 0);

  return {
    courseCount: readCount(courses.rows[0]),
    moduleCount: readCount(modules.rows[0]),
    itemCount: readCount(items.rows[0]),
    assignmentCount: readCount(assignments.rows[0]),
    fileCount: readCount(files.rows[0]),
    chunkCount: readCount(chunks.rows[0]),
  };
}
