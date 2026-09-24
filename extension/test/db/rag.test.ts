import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { count, openTestDb, resetTestDb } from '../helpers/db';
import { fakeVector } from '../helpers/embeddings';
import { discussion } from '../helpers/rows';
import {
  exploreGraph,
  listCoursePages,
  upsertAndPruneAssignments,
  upsertAndPruneDiscussions,
  upsertAndPruneModuleItems,
  upsertAndPruneModules,
  upsertAndPrunePages,
  upsertCourses,
} from '../../src/db/graph';
import {
  chunksToEmbed,
  docIdFor,
  forgetDocument,
  getDocumentCacheState,
  getFileChunks,
  getStoredEmbeddingsByHash,
  searchChunksHybrid,
  setChunkEmbeddings,
  storeChunksWithEmbeddings,
  upsertAndPruneKnownFiles,
  upsertDocumentChunksIncremental,
} from '../../src/db/rag';

let db: PGlite;

/** Stores a document the way indexing does: one chunk per text, distinct vectors. */
function store(docId: string, texts: string[], over: Partial<Parameters<typeof storeChunksWithEmbeddings>[0]> = {}) {
  return storeChunksWithEmbeddings({
    docId,
    sourceType: 'file',
    courseId: '1',
    filename: `${docId}.pdf`,
    version: 'v1',
    embeddingModel: 'google/fake-embedding',
    pageKind: 'page',
    chunks: texts.map((content, i) => ({ chunkIndex: i, pageNumber: i + 1, content, contentHash: `h-${content}`, embedding: fakeVector(content) })),
    ...over,
  });
}

beforeAll(async () => {
  db = await openTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  await upsertCourses([
    { id: 1, name: 'Algorithms' },
    { id: 2, name: 'Biology' },
  ]);
});

describe('document ids and the hand-written joins', () => {
  it.each([
    ['file', '500', '1', '500'],
    ['page', 'week-1', '1', 'page:1:week-1'],
    ['assignment', '31', null, 'assignment:31'],
    ['conversation', '9', null, 'conversation:9'],
    ['discussion', '80', null, 'discussion:80'],
    ['syllabus', '1', null, 'syllabus:1'],
  ] as const)('%s %s → %s', (type, id, course, docId) => {
    expect(docIdFor(type, id, course)).toBe(docId);
  });

  it('page, assignment and discussion documents light up `indexed` in the graph reads', async () => {
    await upsertAndPrunePages('1', [{ url: 'week-1', title: 'Week 1' }]);
    await upsertAndPruneAssignments('1', [{ id: 31, course_id: 1, name: 'A1' }]);
    await upsertAndPruneDiscussions('1', [discussion('80')]);
    await upsertAndPruneModules('1', [{ id: 10, name: 'M' }]);
    await upsertAndPruneModuleItems('10', [
      { id: 100, module_id: 10, title: 'Week 1', type: 'Page', page_url: 'week-1' },
      { id: 101, module_id: 10, title: 'A1', type: 'Assignment', content_id: 31 },
      { id: 102, module_id: 10, title: 'Topic', type: 'Discussion', content_id: 80 },
    ]);

    await store(docIdFor('page', 'week-1', '1'), ['page text'], { sourceType: 'page' });
    await store(docIdFor('assignment', '31'), ['assignment text'], { sourceType: 'assignment' });
    await store(docIdFor('discussion', '80'), ['reply text'], { sourceType: 'discussion' });

    expect((await exploreGraph({ entity_type: 'pages', course_id: '1' }))[0].indexed).toBe(true);
    expect((await listCoursePages('1'))[0].indexed).toBe(true);
    expect((await exploreGraph({ entity_type: 'assignments', course_id: '1' }))[0].description_indexed).toBe(true);
    const items = await exploreGraph({ entity_type: 'module_items', course_id: '1' });
    expect(items.every((i: any) => i.indexed)).toBe(true);
  });
});

describe('storing chunks', () => {
  it('sets total_chunks, page_kind, the model and the full-text vector', async () => {
    await store('500', ['alpha', 'beta'], { pageKind: 'slide' });
    expect(await getDocumentCacheState('500')).toEqual({ version: 'v1', totalChunks: 2, embeddingModel: 'google/fake-embedding' });
    expect((await db.query<any>("SELECT page_kind FROM files WHERE file_id = '500'")).rows[0].page_kind).toBe('slide');
    expect(await count(db, 'file_chunks', 'content_tsv IS NOT NULL AND embedding IS NOT NULL')).toBe(2);
  });

  it('a re-index replaces the chunks', async () => {
    await store('500', ['alpha', 'beta', 'gamma']);
    await store('500', ['delta']);
    expect((await getFileChunks('500')).map((c) => c.content)).toEqual(['delta']);
  });

  it('a failed re-index leaves the previous version whole (no "cached" document with chunks missing)', async () => {
    await store('500', ['alpha', 'beta']);
    const broken = store('500', ['gamma', 'delta'], { version: 'v2' }).then(() => null);
    // A second write whose last chunk cannot be stored (wrong vector size) must roll everything back
    const failing = storeChunksWithEmbeddings({
      docId: '500', sourceType: 'file', courseId: '1', filename: '500.pdf', version: 'v3', embeddingModel: 'google/fake-embedding', pageKind: 'page',
      chunks: [
        { chunkIndex: 0, pageNumber: 1, content: 'epsilon', embedding: fakeVector('epsilon') },
        { chunkIndex: 1, pageNumber: 2, content: 'zeta', embedding: [1, 2, 3] },
      ],
    });
    await broken;
    await expect(failing).rejects.toThrow();
    expect(await getDocumentCacheState('500')).toMatchObject({ version: 'v2', totalChunks: 2 });
    expect((await getFileChunks('500')).map((c) => c.content)).toEqual(['gamma', 'delta']);
  });

  it('keeps vectors by content hash for reuse', async () => {
    await store('500', ['alpha', 'beta']);
    const byHash = await getStoredEmbeddingsByHash('500');
    expect([...byHash.keys()].sort()).toEqual(['h-alpha', 'h-beta']);
    expect(byHash.get('h-alpha')).toMatch(/^\[/);
  });
});

describe('total_chunks = 0 hides kept chunks', () => {
  it('a new upstream version makes the old chunks invisible to reads and search, but keeps them', async () => {
    await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'a.pdf', modified_at: 'M1' }]);
    await store('500', ['the pumping lemma for regular languages'], { version: 'M1' });
    expect(await getFileChunks('500')).toHaveLength(1);

    await upsertAndPruneKnownFiles('1', [{ id: 500, filename: 'a.pdf', modified_at: 'M2' }]);
    expect(await getFileChunks('500')).toHaveLength(0);
    expect(await searchChunksHybrid('pumping lemma', fakeVector('the pumping lemma for regular languages'))).toHaveLength(0);
    expect(await count(db, 'file_chunks')).toBe(1); // the vector cache
  });

  it('forgetDocument drops the text and keeps the row as known', async () => {
    await store('500', ['alpha']);
    await forgetDocument('500');
    expect(await count(db, 'file_chunks')).toBe(0);
    expect((await getDocumentCacheState('500'))?.totalChunks).toBe(0);
  });
});

describe('incremental documents (threads)', () => {
  const thread = (chunks: Array<{ id: string; content: string; embed: boolean }>, pruneMissing = false) =>
    upsertDocumentChunksIncremental({
      docId: 'discussion:80',
      sourceType: 'discussion',
      courseId: '1',
      title: 'Topic',
      version: 'v1',
      embeddingModel: null,
      chunks: chunks.map((c, i) => ({ chunkId: c.id, chunkIndex: i, content: c.content, embedding: c.embed ? fakeVector(c.content) : null })),
      pruneMissing,
    });

  const vectors = async () =>
    Object.fromEntries(
      (await db.query<any>("SELECT chunk_id, embedding IS NOT NULL AS has FROM file_chunks WHERE file_id = 'discussion:80'")).rows.map((r) => [r.chunk_id, r.has])
    );

  it('keeps the vector of an unchanged entry, drops that of an edited one, prunes on request', async () => {
    const first = await thread([
      { id: 'e1', content: 'first reply', embed: true },
      { id: 'e2', content: 'second reply', embed: true },
    ]);
    expect(first.inserted).toBe(2);

    const second = await thread([
      { id: 'e1', content: 'first reply', embed: false },
      { id: 'e2', content: 'second reply (edited)', embed: false },
      { id: 'e3', content: 'third reply', embed: false },
    ]);
    expect(second.inserted).toBe(1);
    expect(await vectors()).toEqual({ e1: true, e2: false, e3: false });

    await thread([{ id: 'e1', content: 'first reply', embed: false }], true);
    expect(Object.keys(await vectors())).toEqual(['e1']);
    expect((await getDocumentCacheState('discussion:80'))?.totalChunks).toBe(1);
  });

  it('embeds only what lacks a vector, and everything again after a model change', async () => {
    await thread([
      { id: 'e1', content: 'first reply', embed: false },
      { id: 'e2', content: 'second reply', embed: false },
    ]);
    const missing = await chunksToEmbed('discussion:80', 'm1');
    expect(missing.map((c) => c.chunk_id)).toEqual(['e1', 'e2']);
    await setChunkEmbeddings('discussion:80', missing.map((c) => ({ chunkId: c.chunk_id, embedding: fakeVector(c.content) })), 'm1');
    expect(await chunksToEmbed('discussion:80', 'm1')).toEqual([]);

    // Vectors of m1 must not stay next to vectors of m2 under the m2 label
    expect((await chunksToEmbed('discussion:80', 'm2')).map((c) => c.chunk_id)).toEqual(['e1', 'e2']);
    expect(await vectors()).toEqual({ e1: false, e2: false });
  });

  it('a conversation about a course outside the graph gets no course', async () => {
    await upsertDocumentChunksIncremental({
      docId: 'conversation:9',
      sourceType: 'conversation',
      courseId: '999',
      title: 'Hi',
      version: 'v1',
      embeddingModel: null,
      chunks: [{ chunkId: 'm1', chunkIndex: 0, content: 'hello', embedding: null }],
    });
    expect((await db.query<any>("SELECT course_id FROM files WHERE file_id = 'conversation:9'")).rows[0].course_id).toBeNull();
  });
});

describe('getFileChunks page ranges', () => {
  it('returns chunks whose page range overlaps the request', async () => {
    await storeChunksWithEmbeddings({
      docId: '500',
      sourceType: 'file',
      courseId: '1',
      filename: 'deck.pptx',
      version: 'v1',
      embeddingModel: 'm',
      pageKind: 'slide',
      chunks: [
        { chunkIndex: 0, pageNumber: 1, pageEnd: 1, content: 'one', embedding: fakeVector('one') },
        { chunkIndex: 1, pageNumber: 2, pageEnd: 4, content: 'two-four', embedding: fakeVector('two-four') },
        { chunkIndex: 2, pageNumber: 5, pageEnd: 5, content: 'five', embedding: fakeVector('five') },
      ],
    });
    expect((await getFileChunks('500', { from: 3, to: 5 })).map((c) => c.content)).toEqual(['two-four', 'five']);
    expect((await getFileChunks('500', { from: 1, to: 1 })).map((c) => c.content)).toEqual(['one']);
  });
});

describe('searchChunksHybrid', () => {
  const textA = (i: number) => `algorithms lecture filler chunk ${i}`;
  const textB = (i: number) => `biology lecture filler chunk ${i}`;

  beforeEach(async () => {
    // ~300 distinct vectors across two courses: identical vectors would degenerate the HNSW graph
    const a = Array.from({ length: 150 }, (_, i) => textA(i));
    a[42] = 'the mitochondria is the powerhouse of the cell';
    await store('doc-a', a);
    await store('doc-b', Array.from({ length: 150 }, (_, i) => textB(i)), { courseId: '2' });
    // A keyword-only chunk: stored without a vector (no API key at the time)
    await upsertDocumentChunksIncremental({
      docId: 'conversation:9',
      sourceType: 'conversation',
      courseId: '1',
      title: 'Inbox',
      version: 'v1',
      embeddingModel: null,
      chunks: [{ chunkId: 'm1', chunkIndex: 0, content: 'photosynthesis happens in chloroplasts', embedding: null }],
    });
  });

  it('finds a chunk by vector alone', async () => {
    const hits = await searchChunksHybrid('zzzz qqqq', fakeVector(textA(7)), { limit: 5 });
    expect(hits[0].content).toBe(textA(7));
    expect(hits[0].similarity).toBeGreaterThan(0.99);
  });

  it('finds a chunk that has no vector by keyword', async () => {
    const hits = await searchChunksHybrid('photosynthesis', fakeVector('unrelated query'), { limit: 5 });
    expect(hits.map((h) => h.content)).toContain('photosynthesis happens in chloroplasts');
  });

  it('ranks a chunk found by both halves first (reciprocal rank fusion)', async () => {
    const hits = await searchChunksHybrid('mitochondria powerhouse', fakeVector('the mitochondria is the powerhouse of the cell'), { limit: 5 });
    expect(hits[0].content).toBe('the mitochondria is the powerhouse of the cell');
    expect(hits[0].file_id).toBe('doc-a');
  });

  it('a course filter still fills the limit', async () => {
    const hits = await searchChunksHybrid('lecture', fakeVector('something'), { courseId: '2', limit: 10 });
    expect(hits).toHaveLength(10);
    expect(new Set(hits.map((h) => h.course_id))).toEqual(new Set(['2']));
  });

  it('a document filter still fills the limit', async () => {
    const hits = await searchChunksHybrid('zzzz', fakeVector(textB(3)), { limit: 8, docId: 'doc-b' });
    expect(hits).toHaveLength(8);
    expect(hits.every((h) => h.file_id === 'doc-b')).toBe(true);
    expect(hits[0].content).toBe(textB(3));
  });

  it('a document filter wins over the course filter', async () => {
    // conversation:9 belongs to course 1; a search scoped to it must not be emptied by course 2
    const hits = await searchChunksHybrid('photosynthesis', fakeVector('x'), { courseId: '2', docId: 'conversation:9' });
    expect(hits.map((h) => h.file_id)).toEqual(['conversation:9']);
  });

  it('returns citation fields', async () => {
    const [hit] = await searchChunksHybrid('zzzz', fakeVector(textA(0)), { courseId: '1', limit: 1 });
    expect(hit).toMatchObject({ file_id: 'doc-a', course_id: '1', course_name: 'Algorithms', page_number: 1, page_end: 1, page_kind: 'page', source_type: 'file' });
  });

  it('the vector half ranks only vectors from the embedding model of the query', async () => {
    const same = await searchChunksHybrid('zzzz qqqq', fakeVector(textA(7)), { limit: 5, embeddingModel: 'google/fake-embedding' });
    expect(same[0].content).toBe(textA(7));
    // After a model change, a document not re-indexed yet must not be ranked in the new space
    expect(await searchChunksHybrid('zzzz qqqq', fakeVector(textA(7)), { limit: 5, embeddingModel: 'openai/other' })).toHaveLength(0);
    // …but it still takes part in the keyword half
    const keyword = await searchChunksHybrid('mitochondria', fakeVector('x'), { limit: 5, embeddingModel: 'openai/other' });
    expect(keyword.map((h) => h.content)).toContain('the mitochondria is the powerhouse of the cell');
  });
});
