import type { AppSettings } from '../components/Settings/Settings';
import type { CanvasAssignment, CanvasFile, CanvasPage } from '../types/canvas';
import { setAssignmentDescription } from '../db/graph';
import {
  docIdFor,
  getDocumentCacheState,
  storeChunksWithEmbeddings,
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
import { CanvasHttpError, canvasGet } from './http';

/**
 * Just-in-time document indexing (files, wiki pages, assignment descriptions).
 * Collection syncs live in ./collections.ts; inbox threads are indexed there as part of the sync.
 */

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
 * File metadata, trying the course-scoped endpoint first (the URL Canvas itself attaches to
 * module items) and the global one second. A 403 here is a Canvas permission decision about
 * this specific file, so the error says what usually causes it.
 */
export async function fetchFileMetadata(fileId: string, courseId?: string | null): Promise<CanvasFile & { url?: string; locked_for_user?: boolean; lock_explanation?: string }> {
  const paths = courseId ? [`/courses/${courseId}/files/${fileId}`, `/files/${fileId}`] : [`/files/${fileId}`];
  let last: unknown = null;
  for (const path of paths) {
    try {
      return await canvasGet(path, `file ${fileId}`);
    } catch (e) {
      last = e;
      if (!(e instanceof CanvasHttpError) || (e.status !== 403 && e.status !== 404)) throw e;
    }
  }
  if (last instanceof CanvasHttpError && last.status === 403) {
    throw new Error(
      `Canvas denied access to file ${fileId} (403). This usually means the file is in a locked module ` +
        `(prerequisites or unlock date), in a locked/hidden folder, or unpublished. Tell the user which file and why.`
    );
  }
  throw last;
}

/**
 * Resolves metadata for a document and a lazy loader for its text, per source type.
 * Metadata is fetched eagerly so the cache check can happen before any download.
 */
async function loadDocumentSource(target: IndexTarget): Promise<DocumentSource> {
  const { sourceType, sourceId, courseId } = target;

  if (sourceType === 'file') {
    const meta = await fetchFileMetadata(sourceId, courseId);
    const filename: string = meta.filename || meta.display_name || `file_${sourceId}`;

    return {
      docId: docIdFor('file', sourceId),
      title: filename,
      displayName: meta.display_name || filename,
      version: meta.modified_at || meta.updated_at || String(meta.size || '1'),
      htmlUrl: meta.url || null,
      loadPages: async () => {
        let downloadUrl: string | undefined = meta.url;
        try {
          const urlData = await canvasGet<{ public_url?: string }>(`/files/${sourceId}/public_url`, `download URL for file ${sourceId}`);
          if (urlData.public_url) downloadUrl = urlData.public_url;
        } catch {
          // fall back to the metadata url
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
    const page = await canvasGet<CanvasPage>(
      `/courses/${courseId}/pages/${encodeURIComponent(sourceId)}`,
      `page "${sourceId}" in course ${courseId}`
    );
    return {
      docId: docIdFor('page', sourceId, courseId),
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
    const a = await fetchAssignmentWithDescription(courseId, sourceId);
    return {
      docId: docIdFor('assignment', sourceId),
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

  if (sourceType === 'conversation') {
    throw new Error('Inbox threads are indexed automatically when the inbox is synced; call get_inbox first.');
  }

  throw new Error(`Unsupported source type: ${sourceType}`);
}

/**
 * Fetches one assignment (the only listing that carries `description`) and caches the
 * description in the graph so get_assignment / indexing do not fetch it twice.
 */
export async function fetchAssignmentWithDescription(courseId: string, assignmentId: string): Promise<CanvasAssignment> {
  const a = await canvasGet<CanvasAssignment>(`/courses/${courseId}/assignments/${assignmentId}`, `assignment ${assignmentId}`);
  await setAssignmentDescription(String(assignmentId), a.description ?? null, a.updated_at ?? null);
  return a;
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
