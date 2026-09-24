import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { count, openTestDb, resetTestDb } from '../helpers/db';
import { announcement, discussion, quiz, submission } from '../helpers/rows';
import {
  exploreGraph,
  forgetCollectionRows,
  forgetCourseRows,
  getDocumentContext,
  listCourseFiles,
  listCoursePages,
  replaceCourseTabs,
  setCourseSyllabus,
  setFrontPage,
  storeContentLinks,
  upsertAndPruneAnnouncements,
  upsertAndPruneAssignments,
  upsertAndPruneDiscussions,
  upsertAndPruneModuleItems,
  upsertAndPruneModules,
  upsertAndPrunePages,
  upsertAndPruneQuizzes,
  upsertAndPruneSubmissions,
  upsertCourses,
} from '../../src/db/graph';
import { upsertAndPruneKnownFiles } from '../../src/db/rag';
import type { ContentLink } from '../../src/types/canvas';

let db: PGlite;

const link = (to_type: ContentLink['to_type'], to_ref: string, position: number, over: Partial<ContentLink> = {}): ContentLink => ({
  to_type,
  to_ref,
  label: `${to_type} ${to_ref}`,
  position,
  ...over,
});

/** A document row (what indexing creates) for prune tests. */
const addDoc = (fileId: string, sourceType: string, courseId = '1', totalChunks = 1) =>
  db.query(`INSERT INTO files (file_id, course_id, filename, version, total_chunks, source_type) VALUES ($1, $2, $1, 'v1', $3, $4)`, [
    fileId,
    courseId,
    totalChunks,
    sourceType,
  ]);

beforeAll(async () => {
  db = await openTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  await upsertCourses([
    { id: 1, name: 'Algorithms', course_code: 'CSC263', term: { name: 'Fall 2026' }, default_view: 'wiki' },
    { id: 2, name: 'Biology', course_code: 'BIO120', default_view: 'modules' },
  ]);
});

describe('modules and items', () => {
  beforeEach(async () => {
    await upsertAndPruneModules('1', [
      { id: 10, name: 'Week 1', position: 1 },
      { id: 11, name: 'Week 2', position: 2, prerequisite_module_ids: [10] },
    ]);
    await upsertAndPruneModuleItems('10', [
      { id: 100, module_id: 10, title: 'Lecture 1.pdf', type: 'File', content_id: 500, position: 1 },
      { id: 101, module_id: 10, title: 'Intro', type: 'Page', page_url: 'intro', position: 2 },
      { id: 102, module_id: 10, title: 'Zoom', type: 'ExternalUrl', external_url: 'https://zoom.us/j/1', position: 3 },
    ]);
  });

  it('stores content refs by item type and the edges they imply', async () => {
    const items = (await db.query<{ item_id: string; content_ref: string }>('SELECT item_id, content_ref FROM module_items ORDER BY item_id')).rows;
    expect(items.map((i) => i.content_ref)).toEqual(['500', 'intro', 'https://zoom.us/j/1']);
    expect(await count(db, 'graph_edges', "relation = 'prerequisite' AND from_id = '10' AND to_id = '11'")).toBe(1);
    expect(await count(db, 'graph_edges', "from_type = 'module_item' AND to_type = 'file' AND to_id = '500'")).toBe(1);
  });

  it('pruning a module drops its items and every edge that pointed at them', async () => {
    const { pruned } = await upsertAndPruneModules('1', [{ id: 11, name: 'Week 2', position: 2 }]);
    expect(pruned).toBe(1);
    expect(await count(db, 'module_items')).toBe(0);
    expect(await count(db, 'graph_edges')).toBe(0);
  });

  it('pruning items keeps the ones still listed', async () => {
    await upsertAndPruneModuleItems('10', [{ id: 101, module_id: 10, title: 'Intro', type: 'Page', page_url: 'intro' }]);
    expect(await count(db, 'module_items')).toBe(1);
    expect(await count(db, 'graph_edges', "from_type = 'module_item'")).toBe(0);
  });

  it('never prunes another course', async () => {
    await upsertAndPruneModules('2', []);
    expect(await count(db, 'modules')).toBe(2);
  });
});

describe('assignments', () => {
  it('prunes a removed assignment with its description document and the links found in it', async () => {
    await upsertAndPruneAssignments('1', [
      { id: 31, course_id: 1, name: 'A1' },
      { id: 32, course_id: 1, name: 'A2' },
    ]);
    await addDoc('assignment:31', 'assignment');
    await storeContentLinks('1', 'assignment', '31', [link('external', 'https://a.test', 0)]);
    const { pruned } = await upsertAndPruneAssignments('1', [{ id: 32, course_id: 1, name: 'A2' }]);
    expect(pruned).toBe(1);
    expect(await count(db, 'files', "file_id = 'assignment:31'")).toBe(0);
    expect(await count(db, 'content_links', "from_type = 'assignment'")).toBe(0);
  });

  it('keeps a stored description while updated_at is unchanged and drops it when it moves', async () => {
    await upsertAndPruneAssignments('1', [{ id: 31, course_id: 1, name: 'A1', description: 'Do it [file 5]', updated_at: 'T1' }]);
    await upsertAndPruneAssignments('1', [{ id: 31, course_id: 1, name: 'A1 renamed', updated_at: 'T1' }]);
    let row = (await db.query<any>("SELECT name, description, description_version FROM assignments WHERE assignment_id = '31'")).rows[0];
    expect(row).toEqual({ name: 'A1 renamed', description: 'Do it [file 5]', description_version: 'T1' });

    await upsertAndPruneAssignments('1', [{ id: 31, course_id: 1, name: 'A1', updated_at: 'T2' }]);
    row = (await db.query<any>("SELECT description, description_version FROM assignments WHERE assignment_id = '31'")).rows[0];
    expect(row).toEqual({ description: null, description_version: null });
  });
});

describe('pages, announcements, discussions, quizzes, submissions', () => {
  it('pages: prune drops the page document and its links', async () => {
    await upsertAndPrunePages('1', [
      { url: 'intro', title: 'Intro' },
      { url: 'week-1', title: 'Week 1' },
    ]);
    await addDoc('page:1:intro', 'page');
    await storeContentLinks('1', 'page', 'intro', [link('file', '900', 0)]);
    await upsertAndPrunePages('1', [{ url: 'week-1', title: 'Week 1' }]);
    expect(await count(db, 'pages', "page_url = 'intro'")).toBe(0);
    expect(await count(db, 'files', "file_id = 'page:1:intro'")).toBe(0);
    expect(await count(db, 'content_links', "from_type = 'page'")).toBe(0);
  });

  it('announcements: prune drops their links', async () => {
    await upsertAndPruneAnnouncements('1', [announcement('70'), announcement('71')]);
    await storeContentLinks('1', 'announcement', '70', [link('file', '901', 0)]);
    await upsertAndPruneAnnouncements('1', [announcement('71')]);
    expect(await count(db, 'announcements')).toBe(1);
    expect(await count(db, 'content_links')).toBe(0);
  });

  it('discussions: prune drops the thread document and links', async () => {
    await upsertAndPruneDiscussions('1', [discussion('80'), discussion('81')]);
    await addDoc('discussion:80', 'discussion');
    await storeContentLinks('1', 'discussion', '80', [link('page', 'rules', 0)]);
    await storeContentLinks('1', 'discussion_replies', '80', [link('page', 'faq', 0)]);
    await upsertAndPruneDiscussions('1', [discussion('81')]);
    expect(await count(db, 'files', "file_id = 'discussion:80'")).toBe(0);
    expect(await count(db, 'content_links')).toBe(0);
  });

  it('quizzes and submissions: prune to the listed set', async () => {
    await upsertAndPruneQuizzes('1', [quiz('90'), quiz('91')]);
    await storeContentLinks('1', 'quiz', '90', [link('file', '902', 0)]);
    await upsertAndPruneQuizzes('1', [quiz('91')]);
    expect(await count(db, 'quizzes')).toBe(1);
    expect(await count(db, 'content_links')).toBe(0);

    await upsertAndPruneAssignments('1', [{ id: 31, course_id: 1, name: 'A1' }, { id: 32, course_id: 1, name: 'A2' }]);
    await upsertAndPruneSubmissions('1', [submission('31'), submission('32')]);
    await upsertAndPruneSubmissions('1', [submission('32', { score: 9 })]);
    expect((await db.query<any>('SELECT assignment_id, score FROM submissions')).rows).toEqual([{ assignment_id: '32', score: 9 }]);
  });
});

describe('files: the Files-area prune', () => {
  it('keeps a file still named by a link and drops the rest', async () => {
    await upsertAndPruneKnownFiles('1', [
      { id: 500, filename: 'a.pdf', modified_at: 'M1' },
      { id: 501, filename: 'b.pdf', modified_at: 'M1' },
      { id: 502, filename: 'c.pdf', modified_at: 'M1' },
    ]);
    await storeContentLinks('1', 'page', 'intro', [link('file', '501', 0)]);
    const { pruned } = await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'a.pdf', modified_at: 'M1' }]);
    expect(pruned).toBe(1);
    expect((await db.query<any>('SELECT file_id FROM files ORDER BY file_id')).rows.map((r) => r.file_id)).toEqual(['500', '501']);
  });

  it('a new upstream version resets total_chunks (old chunks stay as a vector cache)', async () => {
    await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'a.pdf', modified_at: 'M1' }]);
    await db.query("UPDATE files SET total_chunks = 3 WHERE file_id = '500'");
    await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'a.pdf', modified_at: 'M1' }]);
    expect((await db.query<any>("SELECT total_chunks FROM files WHERE file_id = '500'")).rows[0].total_chunks).toBe(3);
    await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'a.pdf', modified_at: 'M2' }]);
    expect((await db.query<any>("SELECT total_chunks FROM files WHERE file_id = '500'")).rows[0].total_chunks).toBe(0);
  });
});

describe('storeContentLinks', () => {
  it('registers link targets as known (unindexed) files and pages', async () => {
    await storeContentLinks('1', 'page', 'intro', [
      link('file', '700', 0, { label: 'Syllabus', title: 'syllabus-2026.pdf' }),
      link('page', 'week-2', 1, { label: 'Week 2' }),
      link('external', 'https://zoom.us/j/1', 2),
    ]);
    expect((await db.query<any>("SELECT filename, display_name, total_chunks FROM files WHERE file_id = '700'")).rows[0]).toEqual({
      filename: 'syllabus-2026.pdf',
      display_name: 'Syllabus',
      total_chunks: 0,
    });
    expect((await db.query<any>("SELECT title FROM pages WHERE page_url = 'week-2'")).rows[0].title).toBe('Week 2');
    expect(await count(db, 'content_links', "from_id = 'intro'")).toBe(3);
  });

  it('never overwrites an existing row', async () => {
    await upsertAndPruneKnownFiles('1', [{ id: 700, filename: 'real.pdf', display_name: 'Real', modified_at: 'M1' }]);
    await db.query("UPDATE files SET total_chunks = 4 WHERE file_id = '700'");
    await upsertAndPrunePages('1', [{ url: 'week-2', title: 'Week Two (real)' }]);
    await storeContentLinks('1', 'page', 'intro', [link('file', '700', 0, { label: 'click here' }), link('page', 'week-2', 1, { label: 'W2' })]);
    expect((await db.query<any>("SELECT filename, total_chunks FROM files WHERE file_id = '700'")).rows[0]).toEqual({ filename: 'real.pdf', total_chunks: 4 });
    expect((await db.query<any>("SELECT title FROM pages WHERE page_url = 'week-2'")).rows[0].title).toBe('Week Two (real)');
  });

  it('records a link into another course without adopting its target', async () => {
    await storeContentLinks('1', 'page', 'intro', [link('file', '800', 0, { course_id: '2' })]);
    expect(await count(db, 'content_links')).toBe(1);
    expect(await count(db, 'files')).toBe(0);
  });

  it('replaces the previous links of the same body', async () => {
    await storeContentLinks('1', 'page', 'intro', [link('file', '1', 0), link('file', '2', 1)]);
    await storeContentLinks('1', 'page', 'intro', [link('file', '3', 0)]);
    expect((await db.query<any>('SELECT to_ref FROM content_links')).rows).toEqual([{ to_ref: '3' }]);
  });
});

describe('front page', () => {
  it('moves the flag and a later pages listing keeps it', async () => {
    await setFrontPage('1', { url: 'intro', title: 'Intro' });
    await setFrontPage('1', { url: 'home', title: 'Home' });
    await upsertAndPrunePages('1', [
      { url: 'intro', title: 'Intro' },
      { url: 'home', title: 'Home' },
    ]);
    const rows = (await db.query<any>('SELECT page_url, front_page FROM pages ORDER BY page_url')).rows;
    expect(rows).toEqual([
      { page_url: 'home', front_page: true },
      { page_url: 'intro', front_page: false },
    ]);
  });

  it('null clears the flag', async () => {
    await setFrontPage('1', { url: 'intro', title: 'Intro' });
    await setFrontPage('1', null);
    expect(await count(db, 'pages', 'front_page')).toBe(0);
  });
});

describe('deleting and forgetting', () => {
  beforeEach(async () => {
    await upsertAndPruneModules('1', [{ id: 10, name: 'Week 1' }]);
    await upsertAndPruneModuleItems('10', [{ id: 100, module_id: 10, title: 'L1', type: 'File', content_id: 500 }]);
    await upsertAndPruneAssignments('1', [{ id: 31, course_id: 1, name: 'A1' }]);
    await setFrontPage('1', { url: 'intro', title: 'Intro' });
    await upsertAndPruneKnownFiles('1', [
      { id: 500, filename: 'a.pdf', modified_at: 'M1' },
      { id: 501, filename: 'b.pdf', modified_at: 'M1' },
    ]);
    await storeContentLinks('1', 'page', 'intro', [link('file', '501', 0)]);
    await replaceCourseTabs('1', [{ id: 'home', label: 'Home' }]);
  });

  it('DELETE FROM courses cascades to everything under the course; documents lose their course', async () => {
    await db.query("DELETE FROM courses WHERE course_id = '1'");
    for (const table of ['modules', 'module_items', 'assignments', 'pages', 'content_links', 'course_tabs']) {
      expect(await count(db, table), table).toBe(0);
    }
    expect(await count(db, 'files', 'course_id IS NULL')).toBe(2);
  });

  it('forgetCourseRows removes the course, its documents and orphaned edges', async () => {
    await forgetCourseRows('1');
    expect(await count(db, 'courses')).toBe(1);
    expect(await count(db, 'files')).toBe(0);
    expect(await count(db, 'graph_edges')).toBe(0);
  });

  it('forgetting files keeps link-registered rows but drops their text', async () => {
    await db.query("INSERT INTO file_chunks (chunk_id, file_id, chunk_index, content) VALUES ('c1', '501', 0, 'text'), ('c2', '500', 0, 'text')");
    await db.query("UPDATE files SET total_chunks = 1 WHERE file_id IN ('500', '501')");
    await forgetCollectionRows('files', '1');
    expect((await db.query<any>('SELECT file_id, total_chunks FROM files')).rows).toEqual([{ file_id: '501', total_chunks: 0 }]);
    expect(await count(db, 'file_chunks')).toBe(0);
  });

  it('forgetting home clears the flag and the front page links, not the page', async () => {
    await forgetCollectionRows('home', '1');
    expect(await count(db, 'pages', "page_url = 'intro' AND NOT front_page")).toBe(1);
    expect(await count(db, 'content_links')).toBe(0);
  });

  it('forgetting modules prunes their edges', async () => {
    await forgetCollectionRows('modules', '1');
    expect(await count(db, 'module_items')).toBe(0);
    expect(await count(db, 'graph_edges')).toBe(0);
  });

  it('refuses a kind that is not a course collection', async () => {
    await expect(forgetCollectionRows('planner' as any, '1')).rejects.toThrow(/not a course collection/);
  });
});

describe('getDocumentContext', () => {
  it('takes the module from the document course and item type', async () => {
    await upsertAndPruneModules('1', [{ id: 10, name: 'Week 1', position: 1 }]);
    await upsertAndPruneModuleItems('10', [
      { id: 100, module_id: 10, title: 'Intro', type: 'Page', page_url: 'intro' },
      { id: 101, module_id: 10, title: 'A5', type: 'Assignment', content_id: 505 },
    ]);
    await upsertAndPruneModules('2', [{ id: 20, name: 'Cells', position: 1 }]);
    await upsertAndPruneModuleItems('20', [{ id: 200, module_id: 20, title: 'Intro', type: 'Page', page_url: 'intro' }]);

    expect(await getDocumentContext('2', 'intro', 'Page')).toEqual({ course: 'BIO120', module: 'Cells' });
    // File 505 is not assignment 505
    expect(await getDocumentContext('1', '505', 'File')).toEqual({ course: 'CSC263', module: null });
    expect(await getDocumentContext('1', '505', 'Assignment')).toEqual({ course: 'CSC263', module: 'Week 1' });
    expect(await getDocumentContext('1', '1', null)).toEqual({ course: 'CSC263', module: null });
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await setFrontPage('1', { url: 'intro', title: 'Intro' });
    await upsertAndPruneModules('1', [{ id: 10, name: 'Week 3', position: 1 }]);
    await upsertAndPruneModuleItems('10', [
      { id: 100, module_id: 10, title: 'Lecture 3.pdf', type: 'File', content_id: 800 },
      { id: 101, module_id: 10, title: 'Lab notes', type: 'Page', page_url: 'lab' },
      { id: 102, module_id: 10, title: 'Slides.pdf', type: 'File', content_id: 500 },
    ]);
    await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'slides.pdf', display_name: 'Slides.pdf', modified_at: 'M1' }]);
    await db.query("UPDATE files SET total_chunks = 2 WHERE file_id = '500'");
    await storeContentLinks('1', 'page', 'intro', [link('file', '500', 0, { label: 'Slides' }), link('file', '600', 1, { label: 'Syllabus', title: 'syllabus.pdf' })]);
    await setCourseSyllabus('1', 'The syllabus [file 600]', 'v1');
    await storeContentLinks('1', 'syllabus', '1', [link('file', '600', 0)]);
    await replaceCourseTabs('1', [
      { id: 'home', label: 'Home', position: 1 },
      { id: 'context_external_tool_5', label: 'Piazza', type: 'external', html_url: 'https://piazza.test/c', position: 2 },
      { id: 'grades', label: 'Grades', hidden: true, position: 3 },
    ]);
  });

  it('courses: home view, nav bar (hidden tabs omitted), syllabus flag', async () => {
    const [algo, bio] = await exploreGraph({ entity_type: 'courses' });
    expect(algo).toMatchObject({
      course_id: '1',
      home_view: 'front page "Intro" (page intro)',
      nav: 'Home · Piazza — https://piazza.test/c',
      has_syllabus: true,
    });
    expect(bio).toMatchObject({ course_id: '2', home_view: 'modules', nav: null, has_syllabus: false });
  });

  it('module items: indexed comes from total_chunks through the doc-id join', async () => {
    const items = await exploreGraph({ entity_type: 'module_items', course_id: '1' });
    expect(Object.fromEntries(items.map((i: any) => [i.title, i.indexed]))).toEqual({
      'Lecture 3.pdf': false,
      'Lab notes': false,
      'Slides.pdf': true,
    });
  });

  it('listCourseFiles: the union of the Files area, module items and links, with linked_from', async () => {
    const files = await listCourseFiles('1');
    const byId = Object.fromEntries(files.map((f: any) => [f.file_id, f]));
    expect(Object.keys(byId).sort()).toEqual(['500', '600', '800']);
    expect(byId['500']).toMatchObject({ name: 'Slides.pdf', indexed: true });
    expect(byId['500'].linked_from.split('; ').sort()).toEqual(['home page', 'module: Week 3']);
    expect(byId['600'].linked_from.split('; ').sort()).toEqual(['home page', 'syllabus']);
    expect(byId['800']).toMatchObject({ name: 'Lecture 3.pdf', linked_from: 'module: Week 3', indexed: false });
    expect(files[0].file_id).toBe('500'); // indexed first
  });

  it('listCourseFiles: search matches name or where it is linked from', async () => {
    expect((await listCourseFiles('1', 'syllabus')).map((f: any) => f.file_id)).toEqual(['600']);
    expect((await listCourseFiles('1', 'week 3')).map((f: any) => f.file_id).sort()).toEqual(['500', '800']);
  });

  it('listCoursePages: front page first, module-only pages included', async () => {
    const pages = await listCoursePages('1');
    expect(pages.map((p: any) => [p.page_url, p.front_page])).toEqual([
      ['intro', true],
      ['lab', false],
    ]);
    expect(pages[1].linked_from).toBe('module: Week 3');
  });
});
