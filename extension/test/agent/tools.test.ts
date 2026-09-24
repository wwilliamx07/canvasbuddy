import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

vi.mock('../../src/embeddings/embeddingClient', () => import('../helpers/embeddings'));

import { openTestDb, resetTestDb } from '../helpers/db';
import { embedCalls, resetEmbedCalls } from '../helpers/embeddings';
import { reply, stubCanvas, type FakeCanvas } from '../helpers/canvas';
import { canvasRoutes } from '../fixtures/canvas';
import { toolFunctions, TOOL_CONFIG } from '../../src/agent/tools';
import { normalizeSettings } from '../../src/settings';

let db: PGlite;
let canvas: FakeCanvas;
const settings = normalizeSettings({ providers: { google: { apiKey: 'test-key' } } });

/** Calls a tool the way the loop does (string args) and parses its JSON. */
async function call(name: string, args: Record<string, string> = {}): Promise<any> {
  const raw = await toolFunctions[name](args, settings);
  expect(typeof raw).toBe('string');
  return JSON.parse(raw);
}

// A course file of exactly two sections (1,500 one-word lines, then more); the second holds the phrase searched for
const NOTES = [
  ...Array.from({ length: 1500 }, (_, i) => `note${i}`),
  'The amortized cost of decrease-key in a Fibonacci heap is constant.',
  ...Array.from({ length: 99 }, (_, i) => `tail${i}`),
].join('\n');

beforeAll(async () => {
  db = await openTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  resetEmbedCalls();
  canvas = stubCanvas({
    ...canvasRoutes(),
    '/courses/1/files/510': { id: 510, filename: 'notes.md', display_name: 'Heap notes', url: 'https://canvas.test/files/510/download', modified_at: 'M1' },
    '/files/510/public_url': reply.status(404),
    'https://canvas.test/files/510/download': reply.bytes(NOTES, 'text/markdown'),
  });
  // The roster is always known before course tools run (it rides on every user turn)
  await call('list_content', { kind: 'courses' });
  canvas.calls.length = 0;
});

describe('the tool contract', () => {
  it('every configured tool has an implementation and vice versa', () => {
    expect(TOOL_CONFIG.map((t) => t.name).sort()).toEqual(Object.keys(toolFunctions).sort());
  });

  it('every tool returns JSON and never throws, even when Canvas fails everywhere', async () => {
    // Every other route 404s through the fake; the lists the tools reach first answer 500
    stubCanvas({ '/courses': reply.status(500), '/conversations': reply.status(500), '/planner/items': reply.status(500) });
    const argsFor: Record<string, Record<string, string>> = {
      list_content: { kind: 'files', course_id: '1' },
      get_assignment: { course_id: '1', assignment_id: '31' },
      search_documents: { query: 'heap', document_type: 'file', document_id: '510', course_id: '1' },
      read_document: { document_type: 'page', document_id: 'intro', course_id: '1' },
      get_announcements: { course_id: '1' },
      get_planner: {},
      get_discussions: { course_id: '1' },
      get_inbox: {},
    };
    for (const name of Object.keys(toolFunctions)) {
      const raw = await toolFunctions[name](argsFor[name] ?? {}, settings);
      expect(() => JSON.parse(raw), name).not.toThrow();
    }
  });

  it('reports missing arguments as { error }', async () => {
    expect(await call('list_content', { kind: 'files' })).toEqual({ error: 'course_id is required for kind="files"' });
    expect(await call('list_content', { kind: 'nope', course_id: '1' })).toEqual({ error: 'Unknown kind "nope"' });
    expect((await call('read_document', {})).error).toMatch(/required/);
  });
});

describe('list_content', () => {
  it('courses: home view, nav bar with external tools', async () => {
    const { data } = await call('list_content', { kind: 'courses' });
    expect(data.map((c: any) => c.course_id)).toEqual(['1', '2']);
    expect(data[0].nav).toContain('Piazza — https://canvas.test/courses/1/external_tools/9');
  });

  it('files: the union over a hidden Files area, with where each file is linked from', async () => {
    const { data, notes } = await call('list_content', { kind: 'files', course_id: '1' });
    const byId = Object.fromEntries(data.map((f: any) => [f.file_id, f.linked_from]));
    expect(byId).toMatchObject({
      '500': 'module: Week 1',
      '502': 'home page',
      '503': 'discussion: Questions about A1',
      '504': 'syllabus',
      '505': 'announcement: Slides for today',
    });
    expect(notes.join(' ')).toMatch(/files area of this course is hidden from students/);
  });

  it('pages: the syllabus comes first as a document', async () => {
    const { data } = await call('list_content', { kind: 'pages', course_id: '1' });
    expect(data[0]).toMatchObject({ document_type: 'syllabus', document_id: '1' });
    expect(data.map((p: any) => p.page_url).filter(Boolean)).toEqual(expect.arrayContaining(['home', 'week-1', 'intro']));
  });

  it('assignments: string args are parsed (include_submission "true", limit "1")', async () => {
    const { data } = await call('list_content', { kind: 'assignments', course_id: '1', bucket: 'all', include_submission: 'true', limit: '1' });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ name: 'A1', submission_state: 'graded', group_name: 'Homework' });
  });

  it('refresh forces a sync that would otherwise be skipped', async () => {
    await call('list_content', { kind: 'modules', course_id: '1' });
    const before = canvas.callsTo('/courses/1/modules').length;
    const again = await call('list_content', { kind: 'modules', course_id: '1' });
    expect(canvas.callsTo('/courses/1/modules').length).toBe(before);
    expect(again.notes).toBeUndefined();
    const refreshed = await call('list_content', { kind: 'modules', course_id: '1', refresh: 'true' });
    expect(canvas.callsTo('/courses/1/modules').length).toBeGreaterThan(before);
    expect(refreshed.notes.join(' ')).toMatch(/modules re-synced from Canvas just now/);
  });
});

describe('get_assignment', () => {
  it('fetches the description once as text with link markers, then serves the cache', async () => {
    const first = await call('get_assignment', { course_id: '1', assignment_id: '31' });
    expect(first.assignment).toMatchObject({ name: 'A1', group: 'Homework', description: 'Task\nImplement a heap. Starter: starter.zip [file 501]' });
    expect(first.assignment.submission).toMatchObject({ state: 'graded' });
    // Points and scores reach the model as numbers, not strings (DOUBLE PRECISION columns)
    expect(first.assignment.points_possible).toBe(10);
    expect(first.assignment.submission.score).toBe(9);
    await call('get_assignment', { course_id: '1', assignment_id: '31' });
    expect(canvas.callsTo('/courses/1/assignments/31')).toHaveLength(1);
  });

  it('an unknown id is an actionable error', async () => {
    expect((await call('get_assignment', { course_id: '1', assignment_id: '999' })).error).toMatch(/list_content\(kind="assignments"/);
  });
});

describe('documents', () => {
  it('search_documents indexes a file on demand and cites sections', async () => {
    const out = await call('search_documents', { query: 'amortized cost of decrease-key', document_type: 'file', document_id: '510', course_id: '1' });
    expect(out.notes[0]).toMatch(/^Indexed "notes.md" \(\d+ chunks\)\.$/);
    expect(embedCalls.texts).toBeGreaterThan(0);
    expect(out.results[0]).toMatchObject({ document: 'notes.md', document_type: 'file', document_id: '510', page_or_slide: 2, unit: 'section' });
    expect(out.results[0].excerpt).toContain('decrease-key');
    expect(canvas.callsTo('https://canvas.test/files/510/download')).toHaveLength(1);
  });

  it('a second search reuses the index (no download, no new vectors besides the query)', async () => {
    await call('search_documents', { query: 'heap', document_type: 'file', document_id: '510', course_id: '1' });
    const texts = embedCalls.texts;
    await call('search_documents', { query: 'Fibonacci', document_type: 'file', document_id: '510', course_id: '1' });
    expect(canvas.callsTo('https://canvas.test/files/510/download')).toHaveLength(1);
    expect(embedCalls.texts).toBe(texts + 1);
  });

  it('read_document labels sections and honours a range', async () => {
    const out = await call('read_document', { document_type: 'file', document_id: '510', course_id: '1', pages: '2' });
    expect(out).toMatchObject({ unit: 'section', pages_total: 2, pages_returned: '2-2' });
    expect(out.text.startsWith('[section 2]')).toBe(true);
    expect(out.text).toContain('Fibonacci heap');
    expect(out.text).not.toMatch(/\bnote0\b/);
  });

  it('read_document of a discussion reads the thread without embedding it', async () => {
    const out = await call('read_document', { document_type: 'discussion', document_id: '80', course_id: '1' });
    expect(out.entries).toBe(3);
    expect(out.text).toContain('Ada (2026-09-02): How is A1 graded?');
    expect(embedCalls.texts).toBe(0);
  });

  it('search_documents without a document searches what is indexed, and says how to find more', async () => {
    const out = await call('search_documents', { query: 'anything' });
    expect(out.results).toEqual([]);
    expect(out.notes[0]).toMatch(/Locate the document with list_content/);
  });
});

describe('other tools', () => {
  it('get_announcements, get_discussions, get_inbox and get_planner shape their rows', async () => {
    expect((await call('get_announcements', { course_id: '1' })).data[0]).toMatchObject({ title: 'Slides for today', text: 'Slides: lecture2.pdf [file 505]' });
    expect((await call('get_discussions', { course_id: '1' })).data[0]).toMatchObject({ title: 'Questions about A1', replies: 2 });
    expect((await call('get_inbox', {})).data[0]).toMatchObject({ subject: 'Extension request', course: 'Algorithms', participants: ['Ada', 'Prof'] });
    const planner = await call('get_planner', { start_date: '2026-10-01', end_date: '2026-10-02' });
    expect(planner.data[0]).toMatchObject({ title: 'A1', course_id: '1', date: '2026-10-01T23:59:00.000Z', points: 10 });
    // Dates are the student's local days (not UTC midnights), from the start of the first to the end of the last
    expect(planner.range).toEqual({ start: new Date(2026, 9, 1).toISOString(), end: new Date(2026, 9, 2, 23, 59, 59, 999).toISOString() });
  });
});
