import type { AppSettings } from '../components/Settings/Settings';
import type {
  CanvasCourse,
  CanvasModule,
  CanvasModuleItem,
  CanvasAssignment,
  CanvasFile,
  CanvasPage,
} from '../types/canvas';
import {
  upsertCourses,
  upsertAndPruneModules,
  upsertAndPruneModuleItems,
  upsertAndPruneAssignments,
  upsertAndPrunePages,
  markCollectionSynced,
  getCollectionAgeHours,
  type SyncCollection,
} from '../db/graph';
import {
  getDocumentCacheState,
  storeChunksWithEmbeddings,
  upsertAndPruneKnownFiles,
  type DocumentSourceType,
} from '../db/rag';
import { getDB } from '../db/pglite';
import { batchEmbed, resolveEmbeddingModel } from '../embeddings/embeddingClient';
import {
  extractStructuredFromFile,
  chunkStructuredDocument,
  htmlToText,
  type StructuredPage,
} from '../utils/textExtractor';

const CANVAS_BASE = 'https://q.utoronto.ca/api/v1';

/**
 * Fetches every page of a paginated Canvas list endpoint by following the
 * `Link: <...>; rel="next"` header. The sync functions prune anything not in the
 * result set, so returning a partial list would delete real data.
 */
async function fetchAllPages<T>(url: string, label: string): Promise<T[]> {
  const all: T[] = [];
  let next: string | null = url;
  let guard = 0;

  while (next && guard++ < 100) {
    const response: Response = await fetch(next, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${label} from Canvas: ${response.status} ${response.statusText}`);
    }
    const page: unknown = await response.json();
    if (!Array.isArray(page)) {
      throw new Error(`Unexpected ${label} response format from Canvas`);
    }
    all.push(...(page as T[]));
    next = parseNextLink(response.headers.get('Link'));
  }

  return all;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Sync active courses from Canvas into local PGlite graph
 */
export async function syncCourses(): Promise<{ count: number; courses: CanvasCourse[] }> {
  const data = await fetchAllPages<CanvasCourse>(
    `${CANVAS_BASE}/courses?per_page=100&enrollment_state=active&include[]=term`,
    'courses'
  );
  const validCourses = data.filter((c) => c && c.id && c.name);

  const count = await upsertCourses(validCourses);
  return { count, courses: validCourses };
}

/**
 * Sync modules and their module items for a specific course, pruning deleted items
 */
export async function syncCourseModules(
  courseId: string
): Promise<{ modulesUpserted: number; modulesPruned: number; itemsUpserted: number }> {
  const modules = await fetchAllPages<CanvasModule>(
    `${CANVAS_BASE}/courses/${courseId}/modules?per_page=100&include[]=items`,
    `modules for course ${courseId}`
  );

  // 1. Upsert and prune modules
  const moduleResult = await upsertAndPruneModules(courseId, modules);

  // 2. Upsert and prune items for each module. Canvas omits inline `items` for
  //    large modules, so fall back to the items endpoint in that case.
  let totalItemsUpserted = 0;
  for (const m of modules) {
    const itemResult = Array.isArray(m.items)
      ? await upsertAndPruneModuleItems(String(m.id), m.items)
      : await syncModuleItems(courseId, String(m.id));
    totalItemsUpserted += itemResult.upserted;
  }

  await markCollectionSynced(courseId, 'modules');

  return {
    modulesUpserted: moduleResult.upserted,
    modulesPruned: moduleResult.pruned,
    itemsUpserted: totalItemsUpserted,
  };
}

/**
 * Sync items for a specific module
 */
export async function syncModuleItems(
  courseId: string,
  moduleId: string
): Promise<{ upserted: number; pruned: number }> {
  const items = await fetchAllPages<CanvasModuleItem>(
    `${CANVAS_BASE}/courses/${courseId}/modules/${moduleId}/items?per_page=100`,
    `items for module ${moduleId}`
  );

  return upsertAndPruneModuleItems(moduleId, items);
}

/**
 * Sync assignments for a course, pruning deleted assignments
 */
export async function syncCourseAssignments(
  courseId: string
): Promise<{ upserted: number; pruned: number }> {
  const assignments = await fetchAllPages<CanvasAssignment>(
    `${CANVAS_BASE}/courses/${courseId}/assignments?per_page=100`,
    `assignments for course ${courseId}`
  );

  const result = await upsertAndPruneAssignments(courseId, assignments);
  await markCollectionSynced(courseId, 'assignments');
  return result;
}

/**
 * Sync the course's Files list (metadata only, nothing is downloaded). Makes files that are
 * not placed in any module discoverable and indexable.
 */
export async function syncCourseFiles(courseId: string): Promise<{ upserted: number; pruned: number }> {
  const files = await fetchAllPages<CanvasFile>(
    `${CANVAS_BASE}/courses/${courseId}/files?per_page=100&sort=updated_at&order=desc`,
    `files for course ${courseId}`
  );

  const result = await upsertAndPruneKnownFiles(courseId, files);
  await markCollectionSynced(courseId, 'files');
  return result;
}

/**
 * Sync the course's wiki pages (titles only; bodies are fetched when a page is indexed).
 */
export async function syncCoursePages(courseId: string): Promise<{ upserted: number; pruned: number }> {
  const pages = await fetchAllPages<CanvasPage>(
    `${CANVAS_BASE}/courses/${courseId}/pages?per_page=100&published=true`,
    `pages for course ${courseId}`
  );

  const result = await upsertAndPrunePages(courseId, pages);
  await markCollectionSynced(courseId, 'pages');
  return result;
}

/**
 * Deterministic staleness rule: re-sync a collection if it has never been synced for this
 * course or is older than `maxAgeHours`. Used for time-sensitive data (due dates) so freshness
 * does not depend on the model noticing a timestamp.
 */
export async function ensureFresh(
  courseId: string,
  collection: SyncCollection,
  maxAgeHours: number
): Promise<{ refreshed: boolean; ageHours: number | null }> {
  const ageHours = await getCollectionAgeHours(courseId, collection);
  if (ageHours != null && ageHours < maxAgeHours) {
    return { refreshed: false, ageHours };
  }

  switch (collection) {
    case 'modules':
      await syncCourseModules(courseId);
      break;
    case 'assignments':
      await syncCourseAssignments(courseId);
      break;
    case 'files':
      await syncCourseFiles(courseId);
      break;
    case 'pages':
      await syncCoursePages(courseId);
      break;
  }
  return { refreshed: true, ageHours };
}

export interface IndexTarget {
  sourceType: DocumentSourceType;
  /** Canvas file id, page slug, or assignment id depending on sourceType */
  sourceId: string;
  courseId?: string | null;
}

export interface IndexResult {
  status: 'cached' | 'indexed';
  docId: string;
  sourceType: DocumentSourceType;
  title: string;
  chunksCount: number;
  htmlUrl?: string | null;
}

/**
 * Just-in-time extraction and vector indexing of a Canvas document (file, wiki page, or
 * assignment description). Cache is keyed on the upstream version AND the embedding model.
 */
export async function indexDocumentJustInTime(target: IndexTarget, settings: AppSettings): Promise<IndexResult> {
  const embeddingModel = resolveEmbeddingModel(settings);
  const source = await loadDocumentSource(target);

  // Cache check: same upstream version and same embedding model means nothing to do
  const cached = await getDocumentCacheState(source.docId);
  if (cached && cached.version === source.version && cached.totalChunks > 0 && cached.embeddingModel === embeddingModel) {
    return {
      status: 'cached',
      docId: source.docId,
      sourceType: target.sourceType,
      title: source.title,
      chunksCount: cached.totalChunks,
      htmlUrl: source.htmlUrl,
    };
  }

  const pages = await source.loadPages();
  if (pages.length === 0) {
    throw new Error(`No text could be extracted from ${source.title}`);
  }

  const rawChunks = chunkStructuredDocument(pages, 400, 50);
  if (rawChunks.length === 0) {
    throw new Error(`Chunking yielded 0 chunks for ${source.title}`);
  }

  // Prepend a context header to what gets embedded (not to what is stored/displayed):
  // slide fragments like "- O(n log n)" mean little without the course and document they belong to.
  const header = await buildChunkHeader(source.docId, target, source.title);
  const pageLabel = target.sourceType === 'file' && source.title.toLowerCase().endsWith('.pptx') ? 'slide' : 'page';
  const embeddedTexts = rawChunks.map((c) =>
    `${header}${c.pageNumber != null ? ` · ${pageLabel} ${c.pageNumber}` : ''}\n${c.content}`
  );

  const embeddings = await batchEmbed(embeddedTexts, settings, 'document');

  await storeChunksWithEmbeddings({
    docId: source.docId,
    sourceType: target.sourceType,
    courseId: target.courseId ? String(target.courseId) : source.courseId ?? null,
    filename: source.title,
    displayName: source.displayName || source.title,
    version: source.version,
    embeddingModel,
    htmlUrl: source.htmlUrl,
    chunks: rawChunks.map((c, idx) => ({
      chunkIndex: c.chunkIndex,
      pageNumber: c.pageNumber,
      content: c.content,
      tokenCount: c.tokenCount,
      embedding: embeddings[idx],
    })),
  });

  return {
    status: 'indexed',
    docId: source.docId,
    sourceType: target.sourceType,
    title: source.title,
    chunksCount: rawChunks.length,
    htmlUrl: source.htmlUrl,
  };
}

/** Backward-compatible wrapper for Canvas files */
export async function indexFileJustInTime(
  fileId: string,
  courseId: string | undefined | null,
  settings: AppSettings
): Promise<{ status: 'cached' | 'indexed'; filename: string; chunksCount: number }> {
  const res = await indexDocumentJustInTime({ sourceType: 'file', sourceId: fileId, courseId }, settings);
  return { status: res.status, filename: res.title, chunksCount: res.chunksCount };
}

interface DocumentSource {
  docId: string;
  title: string;
  displayName?: string | null;
  version: string;
  htmlUrl?: string | null;
  courseId?: string | null;
  loadPages: () => Promise<StructuredPage[]>;
}

/**
 * Resolves metadata for a document and a lazy loader for its text, per source type.
 * Metadata is fetched eagerly so the cache check can happen before any download.
 */
async function loadDocumentSource(target: IndexTarget): Promise<DocumentSource> {
  const { sourceType, sourceId, courseId } = target;

  if (sourceType === 'file') {
    const metaRes = await fetch(`${CANVAS_BASE}/files/${sourceId}`, { credentials: 'include' });
    if (!metaRes.ok) {
      throw new Error(`Failed to get file metadata for ${sourceId}: ${metaRes.status} ${metaRes.statusText}`);
    }
    const meta = await metaRes.json();
    const filename: string = meta.filename || meta.display_name || `file_${sourceId}`;

    return {
      docId: String(sourceId),
      title: filename,
      displayName: meta.display_name || filename,
      version: meta.modified_at || meta.updated_at || String(meta.size || '1'),
      htmlUrl: meta.url || null,
      loadPages: async () => {
        let downloadUrl: string = meta.url;
        const urlRes = await fetch(`${CANVAS_BASE}/files/${sourceId}/public_url`, { credentials: 'include' });
        if (urlRes.ok) {
          const urlData = await urlRes.json();
          if (urlData.public_url) downloadUrl = urlData.public_url;
        }
        if (!downloadUrl) {
          throw new Error(`Unable to obtain download URL for file ${sourceId}`);
        }
        const fileDownload = await fetch(downloadUrl);
        if (!fileDownload.ok) {
          throw new Error(`Failed to download ${filename} (${fileDownload.status})`);
        }
        return extractStructuredFromFile(await fileDownload.arrayBuffer(), filename);
      },
    };
  }

  if (sourceType === 'page') {
    if (!courseId) throw new Error('course_id is required to index a page');
    const res = await fetch(`${CANVAS_BASE}/courses/${courseId}/pages/${encodeURIComponent(sourceId)}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch page "${sourceId}" in course ${courseId}: ${res.status} ${res.statusText}`);
    }
    const page: CanvasPage = await res.json();
    return {
      docId: `page:${courseId}:${sourceId}`,
      title: page.title || sourceId,
      version: page.updated_at || '1',
      htmlUrl: page.html_url || null,
      courseId: String(courseId),
      loadPages: async () => {
        const text = htmlToText(page.body || '');
        return text ? [{ pageNumber: 1, text }] : [];
      },
    };
  }

  if (sourceType === 'assignment') {
    if (!courseId) throw new Error('course_id is required to index an assignment description');
    const res = await fetch(`${CANVAS_BASE}/courses/${courseId}/assignments/${sourceId}`, { credentials: 'include' });
    if (!res.ok) {
      throw new Error(`Failed to fetch assignment ${sourceId}: ${res.status} ${res.statusText}`);
    }
    const a: CanvasAssignment = await res.json();
    return {
      docId: `assignment:${sourceId}`,
      title: a.name ? `${a.name} (assignment description)` : `Assignment ${sourceId}`,
      version: a.updated_at || '1',
      htmlUrl: a.html_url || null,
      courseId: String(courseId),
      loadPages: async () => {
        const text = htmlToText(a.description || '');
        return text ? [{ pageNumber: 1, text }] : [];
      },
    };
  }

  throw new Error(`Unsupported source type: ${sourceType}`);
}

/**
 * "CSC236 · Week 3 · Lecture 5 slides" — the context that a bare chunk lacks.
 */
async function buildChunkHeader(docId: string, target: IndexTarget, title: string): Promise<string> {
  const db = await getDB();
  const parts: string[] = [];

  if (target.courseId) {
    const c = await db.query<{ name: string; course_code: string | null }>(
      'SELECT name, course_code FROM courses WHERE course_id = $1',
      [String(target.courseId)]
    );
    if (c.rows[0]) parts.push(c.rows[0].course_code || c.rows[0].name);
  }

  const m = await db.query<{ name: string }>(
    `SELECT m.name FROM module_items mi JOIN modules m ON m.module_id = mi.module_id
     WHERE mi.content_ref = $1 ORDER BY m.position ASC LIMIT 1`,
    [target.sourceType === 'file' ? docId : target.sourceId]
  );
  if (m.rows[0]) parts.push(m.rows[0].name);

  parts.push(title);
  return parts.join(' · ');
}
