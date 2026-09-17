import { getDB } from './pglite';
import type {
  CanvasCourse,
  CanvasModule,
  CanvasModuleItem,
  CanvasAssignment,
  CanvasPage,
  GraphStats,
} from '../types/canvas';

export type SyncCollection = 'modules' | 'assignments' | 'files' | 'pages';

const AGE_SQL = (col: string) =>
  `ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ${col})) / 3600.0, 1) AS synced_age_hours`;

function clampLimit(limit: number | undefined, fallback = 25): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), 200);
}

/**
 * Explore local graph nodes with optional filters.
 * Rows are compact (ids, names, dates, a synced_age_hours signal) and capped by `limit`
 * so the agent gets what it asked for instead of a dump of the whole course.
 */
export async function exploreGraph(options: {
  entity_type: 'courses' | 'modules' | 'module_items' | 'assignments' | 'files' | 'pages' | 'full_hierarchy';
  course_id?: string;
  module_id?: string;
  search_term?: string;
  limit?: number;
  include_items?: boolean;
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
    const sql = `
      SELECT c.course_id, c.name, c.course_code, c.term,
        ${AGE_SQL('c.synced_at')},
        ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.modules_synced_at)) / 3600.0, 1)     AS modules_synced_age_hours,
        ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.assignments_synced_at)) / 3600.0, 1) AS assignments_synced_age_hours,
        ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.files_synced_at)) / 3600.0, 1)       AS files_synced_age_hours,
        ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.pages_synced_at)) / 3600.0, 1)       AS pages_synced_age_hours,
        (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.course_id)     AS module_count,
        (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.course_id) AS assignment_count,
        (SELECT COUNT(*) FROM files f WHERE f.course_id = c.course_id AND f.total_chunks > 0) AS indexed_document_count
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
      SELECT m.module_id, m.course_id, m.name, m.position, ${AGE_SQL('m.synced_at')},
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
    const sql = `
      SELECT mi.item_id, mi.module_id, m.name AS module_name, m.course_id, mi.item_type, mi.title,
        mi.position, mi.content_ref, mi.html_url, ${AGE_SQL('mi.synced_at')},
        COALESCE(f.total_chunks, 0) > 0 AS indexed
      FROM module_items mi
      JOIN modules m ON m.module_id = mi.module_id
      LEFT JOIN files f ON mi.item_type = 'File' AND f.file_id = mi.content_ref
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY m.position ASC, mi.position ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'assignments') {
    if (course_id) conditions.push(`a.course_id = ${add(String(course_id))}`);
    if (search_term) conditions.push(`a.name ILIKE ${add(`%${search_term}%`)}`);
    const sql = `
      SELECT a.assignment_id, a.course_id, a.name, a.due_at, a.points_possible, a.html_url,
        ${AGE_SQL('a.synced_at')},
        (a.description IS NOT NULL AND length(a.description) > 0) AS has_description,
        COALESCE(f.total_chunks, 0) > 0 AS description_indexed
      FROM assignments a
      LEFT JOIN files f ON f.file_id = 'assignment:' || a.assignment_id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY a.due_at ASC NULLS LAST, a.name ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'files') {
    if (course_id) conditions.push(`f.course_id = ${add(String(course_id))}`);
    if (search_term) {
      const p = add(`%${search_term}%`);
      conditions.push(`(f.filename ILIKE ${p} OR f.display_name ILIKE ${p})`);
    }
    const sql = `
      SELECT f.file_id, f.course_id, f.source_type, f.filename, f.display_name, f.content_type, f.size,
        f.html_url, f.total_chunks > 0 AS indexed, f.total_chunks, f.embedding_model,
        ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - f.extracted_at)) / 3600.0, 1) AS indexed_age_hours
      FROM files f
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY f.total_chunks DESC, f.filename ASC
      LIMIT ${add(limit)}`;
    return (await db.query(sql, params)).rows;
  }

  if (entity_type === 'pages') {
    if (course_id) conditions.push(`p.course_id = ${add(String(course_id))}`);
    if (search_term) conditions.push(`p.title ILIKE ${add(`%${search_term}%`)}`);
    const sql = `
      SELECT p.page_url, p.course_id, p.title, p.updated_at, p.html_url, ${AGE_SQL('p.synced_at')},
        COALESCE(f.total_chunks, 0) > 0 AS indexed
      FROM pages p
      LEFT JOIN files f ON f.file_id = 'page:' || p.course_id || ':' || p.page_url
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY p.title ASC
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

/**
 * Traverses course modules, module items, and assignments using a recursive CTE
 */
export async function getCourseHierarchy(courseId: string, includeItems: boolean = true): Promise<any> {
  const db = await getDB();

  // 1. Get course metadata
  const courseRes = await db.query('SELECT * FROM courses WHERE course_id = $1', [courseId]);
  const course = courseRes.rows[0] || null;

  // 2. Query module and item tree via CTE
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

  // 3. Get course assignments
  const assignRes = await db.query(
    'SELECT * FROM assignments WHERE course_id = $1 ORDER BY due_at ASC NULLS LAST',
    [courseId]
  );

  // 4. Get prerequisite edges
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

/**
 * Removes graph_edges whose module / module_item endpoint no longer exists.
 * graph_edges has no foreign keys, so pruning (and the ON DELETE CASCADE from
 * modules -> module_items) would otherwise leave ghost edges behind.
 */
async function pruneOrphanEdges(): Promise<void> {
  const db = await getDB();
  await db.query(`
    DELETE FROM graph_edges
    WHERE (from_type = 'module' AND from_id NOT IN (SELECT module_id FROM modules))
       OR (to_type   = 'module' AND to_id   NOT IN (SELECT module_id FROM modules))
       OR (from_type = 'module_item' AND from_id NOT IN (SELECT item_id FROM module_items))
       OR (to_type   = 'module_item' AND to_id   NOT IN (SELECT item_id FROM module_items))
  `);
}

/**
 * Upserts courses and returns count
 */
export async function upsertCourses(courses: CanvasCourse[]): Promise<number> {
  if (!courses || courses.length === 0) return 0;
  const db = await getDB();

  for (const c of courses) {
    await db.query(
      `INSERT INTO courses (course_id, name, course_code, term, synced_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (course_id) DO UPDATE SET
         name = EXCLUDED.name,
         course_code = EXCLUDED.course_code,
         term = EXCLUDED.term,
         synced_at = CURRENT_TIMESTAMP`,
      [String(c.id), c.name, c.course_code || null, c.term?.name || null]
    );
  }

  return courses.length;
}

/**
 * Upserts modules for a course, prunes removed modules, and stores prerequisite edges
 */
export async function upsertAndPruneModules(
  courseId: string,
  modules: CanvasModule[]
): Promise<{ upserted: number; pruned: number }> {
  const db = await getDB();
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

  // Prune modules that no longer exist in Canvas
  let prunedCount = 0;
  if (validIds.length > 0) {
    const placeholders = validIds.map((_, i) => `$${i + 2}`).join(',');
    const pruneRes = await db.query(
      `DELETE FROM modules WHERE course_id = $1 AND module_id NOT IN (${placeholders}) RETURNING module_id`,
      [String(courseId), ...validIds]
    );
    prunedCount = pruneRes.rows.length;
  } else {
    const pruneRes = await db.query(
      'DELETE FROM modules WHERE course_id = $1 RETURNING module_id',
      [String(courseId)]
    );
    prunedCount = pruneRes.rows.length;
  }

  await pruneOrphanEdges();
  return { upserted: modules.length, pruned: prunedCount };
}

/**
 * Upserts module items, prunes removed items, and links file references
 */
export async function upsertAndPruneModuleItems(
  moduleId: string,
  items: CanvasModuleItem[]
): Promise<{ upserted: number; pruned: number }> {
  const db = await getDB();
  const validIds: string[] = [];

  for (const item of items) {
    const itemId = String(item.id);
    validIds.push(itemId);
    // Files/Assignments/Quizzes carry a numeric content_id; wiki pages are addressed by slug.
    const contentRef = item.type === 'Page' && item.page_url
      ? String(item.page_url)
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

    // Link file content ref in graph_edges
    if (item.type === 'File' && contentRef) {
      await db.query(
        `INSERT INTO graph_edges (from_type, from_id, to_type, to_id, relation)
         VALUES ('module_item', $1, 'file', $2, 'references')
         ON CONFLICT DO NOTHING`,
        [itemId, contentRef]
      );
    }
  }

  // Prune deleted items
  let prunedCount = 0;
  if (validIds.length > 0) {
    const placeholders = validIds.map((_, i) => `$${i + 2}`).join(',');
    const pruneRes = await db.query(
      `DELETE FROM module_items WHERE module_id = $1 AND item_id NOT IN (${placeholders}) RETURNING item_id`,
      [String(moduleId), ...validIds]
    );
    prunedCount = pruneRes.rows.length;
  } else {
    const pruneRes = await db.query(
      'DELETE FROM module_items WHERE module_id = $1 RETURNING item_id',
      [String(moduleId)]
    );
    prunedCount = pruneRes.rows.length;
  }

  await pruneOrphanEdges();
  return { upserted: items.length, pruned: prunedCount };
}

/**
 * Upserts assignments for a course and prunes removed ones
 */
export async function upsertAndPruneAssignments(
  courseId: string,
  assignments: CanvasAssignment[]
): Promise<{ upserted: number; pruned: number }> {
  const db = await getDB();
  const validIds: string[] = [];

  for (const a of assignments) {
    const assignId = String(a.id);
    validIds.push(assignId);

    await db.query(
      `INSERT INTO assignments (assignment_id, course_id, name, due_at, points_possible, html_url, description, updated_at, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (assignment_id) DO UPDATE SET
         name = EXCLUDED.name,
         due_at = EXCLUDED.due_at,
         points_possible = EXCLUDED.points_possible,
         html_url = EXCLUDED.html_url,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at,
         synced_at = CURRENT_TIMESTAMP`,
      [
        assignId,
        String(courseId),
        a.name,
        a.due_at || null,
        a.points_possible != null ? Number(a.points_possible) : null,
        a.html_url || null,
        a.description || null,
        a.updated_at || null,
      ]
    );
  }

  // Prune deleted assignments
  let prunedCount = 0;
  if (validIds.length > 0) {
    const placeholders = validIds.map((_, i) => `$${i + 2}`).join(',');
    const pruneRes = await db.query(
      `DELETE FROM assignments WHERE course_id = $1 AND assignment_id NOT IN (${placeholders}) RETURNING assignment_id`,
      [String(courseId), ...validIds]
    );
    prunedCount = pruneRes.rows.length;
  } else {
    const pruneRes = await db.query(
      'DELETE FROM assignments WHERE course_id = $1 RETURNING assignment_id',
      [String(courseId)]
    );
    prunedCount = pruneRes.rows.length;
  }

  return { upserted: assignments.length, pruned: prunedCount };
}

/**
 * Upserts wiki pages for a course and prunes removed ones
 */
export async function upsertAndPrunePages(
  courseId: string,
  pages: CanvasPage[]
): Promise<{ upserted: number; pruned: number }> {
  const db = await getDB();
  const validUrls: string[] = [];

  for (const p of pages) {
    if (!p.url) continue;
    validUrls.push(p.url);
    await db.query(
      `INSERT INTO pages (page_url, course_id, title, updated_at, html_url, synced_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (course_id, page_url) DO UPDATE SET
         title = EXCLUDED.title,
         updated_at = EXCLUDED.updated_at,
         html_url = EXCLUDED.html_url,
         synced_at = CURRENT_TIMESTAMP`,
      [p.url, String(courseId), p.title || p.url, p.updated_at || null, p.html_url || null]
    );
  }

  let pruned = 0;
  if (validUrls.length > 0) {
    const placeholders = validUrls.map((_, i) => `$${i + 2}`).join(',');
    const res = await db.query(
      `DELETE FROM pages WHERE course_id = $1 AND page_url NOT IN (${placeholders}) RETURNING page_url`,
      [String(courseId), ...validUrls]
    );
    pruned = res.rows.length;
  } else {
    const res = await db.query('DELETE FROM pages WHERE course_id = $1 RETURNING page_url', [String(courseId)]);
    pruned = res.rows.length;
  }

  return { upserted: validUrls.length, pruned };
}

/**
 * Records that a collection of a course was fully synced, so staleness can be judged
 * even when the collection is empty.
 */
export async function markCollectionSynced(courseId: string, collection: SyncCollection): Promise<void> {
  const db = await getDB();
  const column = `${collection}_synced_at`;
  await db.query(`UPDATE courses SET ${column} = CURRENT_TIMESTAMP WHERE course_id = $1`, [String(courseId)]);
}

/**
 * Hours since a collection was last synced for a course; null if never (or course unknown).
 */
export async function getCollectionAgeHours(courseId: string, collection: SyncCollection): Promise<number | null> {
  const db = await getDB();
  const column = `${collection}_synced_at`;
  const res = await db.query<{ age: number | string | null }>(
    `SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ${column})) / 3600.0 AS age FROM courses WHERE course_id = $1`,
    [String(courseId)]
  );
  if (res.rows.length === 0 || res.rows[0].age == null) return null;
  return Number(res.rows[0].age);
}

/**
 * One-paragraph summary of what the local graph holds, injected into the system prompt so the
 * model knows what is cached without spending a tool call to find out.
 */
export async function getGraphOverviewText(): Promise<string> {
  const db = await getDB();
  const res = await db.query<any>(`
    SELECT c.course_id, c.name, c.course_code,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.modules_synced_at)) / 3600.0     AS modules_age,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.assignments_synced_at)) / 3600.0 AS assignments_age,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.files_synced_at)) / 3600.0       AS files_age,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.pages_synced_at)) / 3600.0       AS pages_age,
      (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.course_id)     AS module_count,
      (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.course_id) AS assignment_count,
      (SELECT COUNT(*) FROM files f WHERE f.course_id = c.course_id AND f.total_chunks > 0) AS indexed_count,
      (SELECT COUNT(*) FROM files f WHERE f.course_id = c.course_id) AS known_doc_count
    FROM courses c
    ORDER BY c.name ASC
    LIMIT 40`);

  if (res.rows.length === 0) {
    return 'The local graph is EMPTY: no courses have been synced yet. Call sync_canvas_node with target "courses" first.';
  }

  const fmtAge = (h: number | string | null) => {
    if (h == null) return 'never';
    const hours = Number(h);
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
    if (hours < 48) return `${Math.round(hours)}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  };

  const lines = res.rows.map((r: any) =>
    `- ${r.course_code || r.name} (id ${r.course_id}): ` +
    `${r.module_count} modules (synced ${fmtAge(r.modules_age)}), ` +
    `${r.assignment_count} assignments (synced ${fmtAge(r.assignments_age)}), ` +
    `${r.known_doc_count} known documents / ${r.indexed_count} indexed for search ` +
    `(files list synced ${fmtAge(r.files_age)}, pages synced ${fmtAge(r.pages_age)})`
  );

  return `Local graph contents right now (${res.rows.length} courses):\n${lines.join('\n')}`;
}

/**
 * Returns summary counts for the Graph Explorer dashboard
 */
export async function getGraphStatistics(): Promise<GraphStats> {
  const db = await getDB();

  const [courses, modules, items, assignments, files, chunks] = await Promise.all([
    db.query('SELECT COUNT(*) as count FROM courses'),
    db.query('SELECT COUNT(*) as count FROM modules'),
    db.query('SELECT COUNT(*) as count FROM module_items'),
    db.query('SELECT COUNT(*) as count FROM assignments'),
    db.query('SELECT COUNT(*) as count FROM files'),
    db.query('SELECT COUNT(*) as count FROM file_chunks'),
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

