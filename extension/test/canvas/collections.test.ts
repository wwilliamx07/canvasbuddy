import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

vi.mock('../../src/embeddings/embeddingClient', () => import('../helpers/embeddings'));

import { count, openTestDb, resetTestDb } from '../helpers/db';
import { embedCalls, resetEmbedCalls } from '../helpers/embeddings';
import { reply, stubCanvas, type FakeCanvas } from '../helpers/canvas';
import { canvasRoutes, CONVERSATIONS, COURSES, MODULES_1, PLANNER, SYLLABUS_1 } from '../fixtures/canvas';
import { ensureCollection, ensureDiscussionThread } from '../../src/canvas/collections';
import { getSyncState } from '../../src/canvas/freshness';
import { exploreGraph, getCourseSyllabus, listCourseFiles } from '../../src/db/graph';
import { normalizeSettings } from '../../src/settings';

let db: PGlite;
let canvas: FakeCanvas;
const settings = normalizeSettings({ providers: { google: { apiKey: 'test-key' } } });
const T0 = new Date('2026-09-23T12:00:00Z').getTime();
const MIN = 60_000;
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const ensure = (kind: Parameters<typeof ensureCollection>[0], courseId?: string, refresh = false) =>
  ensureCollection(kind, courseId ? { courseId } : {}, { settings, refresh });

beforeAll(async () => {
  db = await openTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  resetEmbedCalls();
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  canvas = stubCanvas(canvasRoutes());
  await ensure('courses');
  canvas.calls.length = 0;
});

describe('courses', () => {
  it('stores courses with their Home view and visible nav tabs; a course without tabs is fine', async () => {
    const rows = await exploreGraph({ entity_type: 'courses' });
    expect(rows.map((r: any) => [r.course_id, r.home_view])).toEqual([
      ['1', 'front page'],
      ['2', 'modules'],
    ]);
    expect(rows[0].nav).toBe('Home · Modules · Piazza — https://canvas.test/courses/1/external_tools/9');
    expect(rows[1].nav).toBeNull();
  });

  it('prunes a course that left the active list, with what is remembered under it and its sync stamps', async () => {
    await ensure('modules', '2');
    expect(await getSyncState('course:2:modules')).not.toBeNull();
    canvas.set('/courses', COURSES.filter((c) => c.id !== 2));
    const r = await ensure('courses', undefined, true);
    expect(r.summary).toBe('1 active courses, 1 pruned');
    expect((await exploreGraph({ entity_type: 'courses' })).map((c: any) => c.course_id)).toEqual(['1']);
    expect(await count(db, 'modules', "course_id = '2'")).toBe(0);
    expect(await getSyncState('course:2:modules')).toBeNull();
  });
});

describe('modules', () => {
  it('full sync stores modules and items, falling back to the items endpoint when inline items are missing', async () => {
    const r = await ensure('modules', '1');
    expect(r).toMatchObject({ status: 'synced', summary: '2 modules, 3 items, 0 pruned' });
    expect(canvas.callsTo('/courses/1/modules/11/items')).toHaveLength(1);
    expect(canvas.callsTo('/courses/1/modules/10/items')).toHaveLength(0);
    expect(await count(db, 'module_items')).toBe(3);
  });

  it('a probe-driven partial sync re-fetches only the changed module’s items', async () => {
    await ensure('modules', '1');
    canvas.calls.length = 0;
    const week2 = { ...MODULES_1[1], items_count: 2 };
    canvas.set('/courses/1/modules', [MODULES_1[0], week2]);
    canvas.set('/courses/1/modules/11/items', [
      { id: 110, module_id: 11, title: 'A1', type: 'Assignment', content_id: 31 },
      { id: 111, module_id: 11, title: 'Lecture 2.pdf', type: 'File', content_id: 506 },
    ]);
    at(10 * MIN);
    const r = await ensure('modules', '1');
    expect(r.summary).toBe('1 of 2 modules changed (2 items), 0 pruned');
    expect(canvas.calls).toEqual(['/courses/1/modules?per_page=100', '/courses/1/modules/11/items?per_page=100']);
    expect(await count(db, 'module_items')).toBe(4);
  });

  it('an unchanged probe fetches nothing else', async () => {
    await ensure('modules', '1');
    canvas.calls.length = 0;
    at(10 * MIN);
    expect(await ensure('modules', '1')).toMatchObject({ status: 'fresh' });
    expect(canvas.calls).toEqual(['/courses/1/modules?per_page=100']);
  });
});

describe('assignments', () => {
  it('the compact listing stores no description and records the group', async () => {
    await ensure('assignments', '1');
    const rows = (await db.query<any>('SELECT assignment_id, group_name, description FROM assignments ORDER BY assignment_id')).rows;
    expect(rows).toEqual([
      { assignment_id: '31', group_name: 'Homework', description: null },
      { assignment_id: '32', group_name: 'Exams', description: null },
    ]);
  });

  it('the fallback listing stores descriptions as text and records their links', async () => {
    canvas.set('/courses/1/assignment_groups', reply.status(403));
    await ensure('assignments', '1');
    const row = (await db.query<any>("SELECT description FROM assignments WHERE assignment_id = '31'")).rows[0];
    expect(row.description).toBe('See the starter code [file 501].');
    expect(await count(db, 'content_links', "from_type = 'assignment' AND to_ref = '501'")).toBe(1);
    expect(await count(db, 'files', "file_id = '501' AND total_chunks = 0")).toBe(1);
  });
});

describe('files and pages', () => {
  it('a hidden Files area is unavailable, not an error', async () => {
    expect(await ensure('files', '1')).toMatchObject({ status: 'unavailable' });
    expect((await getSyncState('course:1:files'))?.status).toBe('unavailable');
    expect(await ensure('pages', '1')).toMatchObject({ status: 'unavailable' });
  });

  it('a visible Files area is probed with the newest file only', async () => {
    const files = [
      { id: 500, filename: 'lecture1.pdf', updated_at: 'U2' },
      { id: 501, filename: 'starter.zip', updated_at: 'U1' },
    ];
    canvas.set('/courses/1/files', (url: URL) => (url.searchParams.get('per_page') === '1' ? files.slice(0, 1) : files));
    await ensure('files', '1');
    expect(await count(db, 'files')).toBe(2);
    canvas.calls.length = 0;
    at(10 * MIN);
    expect(await ensure('files', '1')).toMatchObject({ status: 'fresh' });
    expect(canvas.calls).toEqual(['/courses/1/files?sort=updated_at&order=desc&per_page=1']);
  });
});

describe('home', () => {
  it('ingests the front page: flag, links, and the targets they register', async () => {
    const r = await ensure('home', '1');
    expect(r.summary).toBe('front page "Welcome", 3 links');
    expect((await db.query<any>('SELECT page_url, front_page FROM pages ORDER BY page_url')).rows).toEqual([
      { page_url: 'home', front_page: true },
      { page_url: 'week-1', front_page: false },
    ]);
    expect((await db.query<any>("SELECT filename, display_name FROM files WHERE file_id = '502'")).rows[0]).toEqual({
      filename: 'syllabus-2026.pdf',
      display_name: 'Syllabus',
    });
    expect(await count(db, 'content_links', "from_id = 'home'")).toBe(3);
  });

  it('a course without a front page (404) is not unavailable', async () => {
    expect(await ensure('home', '2')).toMatchObject({ status: 'synced', summary: 'no front page' });
  });
});

describe('syllabus', () => {
  it('stores the body as text with links; an unchanged fingerprint does not re-sync; a change does', async () => {
    await ensure('syllabus', '1');
    expect((await getCourseSyllabus('1'))?.body).toBe('Grading\nSee the policy [file 504].');
    expect(await count(db, 'content_links', "from_type = 'syllabus' AND to_ref = '504'")).toBe(1);

    at(10 * MIN);
    expect(await ensure('syllabus', '1')).toMatchObject({ status: 'fresh' });

    canvas.set('/courses/1', { ...SYLLABUS_1, syllabus_body: '<p>New policy: <a href="/courses/1/files/507">here</a></p>' });
    at(20 * MIN);
    expect(await ensure('syllabus', '1')).toMatchObject({ status: 'synced' });
    expect((await getCourseSyllabus('1'))?.body).toBe('New policy: here [file 507]');
    expect(await count(db, 'content_links', "from_type = 'syllabus' AND to_ref = '504'")).toBe(0);
  });
});

describe('announcements and quizzes', () => {
  it('announcement bodies are text and their links make files listable', async () => {
    await ensure('announcements', '1');
    expect((await db.query<any>('SELECT text FROM announcements')).rows[0].text).toBe('Slides: lecture2.pdf [file 505]');
    expect(await count(db, 'files', "file_id = '505'")).toBe(1);
  });

  it('quizzes keep their rules and a lock explanation as text', async () => {
    await ensure('quizzes', '1');
    const row = (await db.query<any>('SELECT allowed_attempts, description, lock_explanation FROM quizzes')).rows[0];
    expect(row).toEqual({ allowed_attempts: -1, description: 'Covers week 1 [page week-1].', lock_explanation: 'Available Oct 1' });
  });
});

describe('discussions', () => {
  it('stores topics; reading a thread stores one chunk per entry, keyed by entry id, without embedding', async () => {
    await ensure('discussions', '1');
    expect((await db.query<any>('SELECT message FROM discussions')).rows[0].message).toBe('Ask here. Read the rules [file 503] first.');

    expect(await ensureDiscussionThread('1', '80')).toBe('Read 2 replies of "Questions about A1".');
    const chunks = (await db.query<any>("SELECT chunk_id, content FROM file_chunks WHERE file_id = 'discussion:80' ORDER BY chunk_index")).rows;
    expect(chunks.map((c) => c.chunk_id)).toEqual(['discussion:80:topic', 'discussion:80:entry:1', 'discussion:80:entry:2']);
    expect(chunks[2].content).toBe('Ben (2026-09-03) replying to Ada: By the test suite. See the rubric [file 560].');
    // A file linked only from a reply becomes a known file of the course, and says where it was linked
    const files = await listCourseFiles('1', 'rubric');
    expect(files).toMatchObject([{ file_id: '560', linked_from: 'replies to discussion: Questions about A1' }]);
    expect(embedCalls.texts).toBe(0);

    canvas.calls.length = 0;
    expect(await ensureDiscussionThread('1', '80')).toBeNull();
    expect(canvas.calls).toEqual([]);
  });

  it('a thread of an unknown topic is refused with a hint', async () => {
    await expect(ensureDiscussionThread('1', '999')).rejects.toThrow(/Call get_discussions first/);
  });
});

describe('inbox', () => {
  it('stores threads as text, fetches a thread again only when last_message_at moved, and never embeds', async () => {
    await ensure('inbox');
    // Fetching a thread must not mark it read in Canvas
    expect(canvas.callsTo('/conversations/900')).toEqual(['/conversations/900?auto_mark_as_read=false']);
    const chunks = (await db.query<any>("SELECT content FROM file_chunks WHERE file_id = 'conversation:900' ORDER BY chunk_index")).rows;
    expect(chunks.map((c) => c.content)).toEqual(['Prof (2026-09-06): Granted.', 'Ada (2026-09-05): Could I have two more days for A1?']);

    await ensure('inbox', undefined, true);
    expect(canvas.callsTo('/conversations/900')).toHaveLength(1);

    canvas.set('/conversations', [{ ...CONVERSATIONS[0], last_message_at: '2026-09-07T00:00:00Z' }]);
    await ensure('inbox', undefined, true);
    expect(canvas.callsTo('/conversations/900')).toHaveLength(2);
    expect(embedCalls.texts).toBe(0);
  });
});

describe('planner and submissions', () => {
  it('the planner window is replaced wholesale', async () => {
    await ensure('planner');
    expect(await count(db, 'planner_items')).toBe(1);
    canvas.set('/planner/items', [{ ...PLANNER[0], plannable_id: 99, plannable: { title: 'Quiz 1' } }]);
    await ensure('planner', undefined, true);
    expect((await db.query<any>('SELECT title FROM planner_items')).rows).toEqual([{ title: 'Quiz 1' }]);
  });

  it('submissions are shaped', async () => {
    await ensure('submissions', '1');
    expect((await db.query<any>('SELECT workflow_state, score, late FROM submissions')).rows).toEqual([
      { workflow_state: 'graded', score: 9, late: false },
    ]);
  });
});

describe('pagination', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, title: `Q${i}` }));

  it('follows Link headers across pages', async () => {
    canvas.set('/courses/1/quizzes', many);
    await ensure('quizzes', '1');
    expect(await count(db, 'quizzes')).toBe(150);
    expect(canvas.callsTo('/courses/1/quizzes')).toHaveLength(2);
  });

  it('a failed second page stores nothing (a partial list would prune real rows)', async () => {
    await ensure('quizzes', '1');
    canvas.set('/courses/1/quizzes', (url: URL) => (url.searchParams.get('page') === '2' ? reply.status(500) : many));
    const r = await ensure('quizzes', '1', true);
    expect(r.status).toBe('error');
    expect((await db.query<any>('SELECT quiz_id FROM quizzes')).rows).toEqual([{ quiz_id: '60' }]);
  });
});
