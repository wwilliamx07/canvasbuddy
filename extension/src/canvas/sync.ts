import type { AppSettings } from '../settings';
import type { CanvasAssignment, CanvasFile, CanvasPage } from '../types/canvas';
import { setAssignmentDescription, getCourseSyllabus, getDocumentContext } from '../db/graph';
import {
  docIdFor,
  getDocumentCacheState,
  getStoredEmbeddingsByHash,
  storeChunksWithEmbeddings,
  type DocumentSourceType,
} from '../db/rag';
import { batchEmbed, resolveEmbeddingModel } from '../embeddings/embeddingClient';
import {
  extractStructuredFromFile,
  chunkStructuredDocument,
  pageKindFor,
  type PageKind,
  type StructuredPage,
} from '../utils/textExtractor';
import { CanvasHttpError, canvasGet } from './http';
import { ingestHtml } from './links';

/**
 * Just-in-time document indexing (files, wiki pages, assignment descriptions, the syllabus).
 * Collection syncs live in ./collections.ts; inbox and discussion threads are stored there as text.
 */

export interface IndexTarget {
  sourceType: DocumentSourceType;
  /** Canvas file id, page slug, assignment id, or the course id for the syllabus, depending on sourceType */
  sourceId: string;
  courseId?: string | null;
}

export interface IndexResult {
  status: 'cached' | 'indexed';
  docId: string;
  sourceType: DocumentSourceType;
  title: string;
  chunksCount: number;
  /** Chunks sent to the embedding API this time (the rest reused stored vectors); 0 when cached */
  chunksEmbedded: number;
  htmlUrl?: string | null;
}

/** Human-readable page label for a chunk: "slide 4", "slides 4-7", "section 2". */
export function pageRangeLabel(
  pageNumber: number | null | undefined,
  pageEnd: number | null | undefined,
  unit: PageKind
): string | null {
  if (pageNumber == null) return null;
  const end = pageEnd ?? pageNumber;
  return end > pageNumber ? `${unit}s ${pageNumber}-${end}` : `${unit} ${pageNumber}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Just-in-time extraction and vector indexing of a Canvas document (file, wiki page, assignment
 * description, or the syllabus). Cache is keyed on the upstream version AND the embedding model.
 * On re-index, chunks whose text is unchanged keep their stored vector; only new or modified
 * chunks are sent to the embedding API.
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
      chunksEmbedded: 0,
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

  // Vectors of unchanged chunks are reused only if they came from the same model. The hash
  // covers the stored text, not the context header, so a renamed module does not re-embed.
  const hashes = await Promise.all(rawChunks.map((c) => sha256Hex(c.content)));
  const reusable = cached?.embeddingModel === embeddingModel ? await getStoredEmbeddingsByHash(source.docId) : new Map<string, string>();
  const toEmbed = rawChunks.map((_, i) => i).filter((i) => !reusable.has(hashes[i]));

  // Prepend a context header to what gets embedded (not to what is stored/displayed):
  // slide fragments like "- O(n log n)" mean little without the course and document they belong to.
  const header = await buildChunkHeader(source.docId, target, source.title);
  const embeddedTexts = toEmbed.map((i) => {
    const c = rawChunks[i];
    const label = pageRangeLabel(c.pageNumber, c.pageEnd, source.pageKind);
    return `${header}${label ? ` · ${label}` : ''}\n${c.content}`;
  });

  const fresh = embeddedTexts.length > 0 ? await batchEmbed(embeddedTexts, settings, 'document') : [];
  const freshByIndex = new Map(toEmbed.map((chunkIdx, k) => [chunkIdx, fresh[k]]));

  await storeChunksWithEmbeddings({
    docId: source.docId,
    sourceType: target.sourceType,
    courseId: target.courseId ? String(target.courseId) : source.courseId ?? null,
    filename: source.title,
    displayName: source.displayName || source.title,
    version: source.version,
    embeddingModel,
    htmlUrl: source.htmlUrl,
    pageKind: source.pageKind,
    chunks: rawChunks.map((c, idx) => ({
      chunkIndex: c.chunkIndex,
      pageNumber: c.pageNumber,
      pageEnd: c.pageEnd,
      content: c.content,
      contentHash: hashes[idx],
      tokenCount: c.tokenCount,
      embedding: freshByIndex.get(idx) ?? reusable.get(hashes[idx])!,
    })),
  });

  return {
    status: 'indexed',
    docId: source.docId,
    sourceType: target.sourceType,
    title: source.title,
    chunksCount: rawChunks.length,
    chunksEmbedded: toEmbed.length,
    htmlUrl: source.htmlUrl,
  };
}

/** Metadata of a document to index plus a lazy loader for its text. */
interface DocumentSource {
  docId: string;
  title: string;
  displayName?: string | null;
  version: string;
  htmlUrl?: string | null;
  courseId?: string | null;
  /** What page_number counts in the loaded pages (PDF pages, PPTX slides, sections otherwise) */
  pageKind: PageKind;
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
      pageKind: pageKindFor(filename),
      loadPages: async () => {
        // `public_url` is a signed link that may live on a file CDN outside the origins the
        // extension was granted; if the browser refuses it, the file's own `url` on the Canvas
        // host (session-authenticated) is tried next.
        const candidates: Array<{ url: string; init?: RequestInit }> = [];
        try {
          const urlData = await canvasGet<{ public_url?: string }>(`/files/${sourceId}/public_url`, `download URL for file ${sourceId}`);
          if (urlData.public_url) candidates.push({ url: urlData.public_url });
        } catch {
          // fall through to the metadata url
        }
        if (meta.url) candidates.push({ url: meta.url, init: { credentials: 'include' } });
        if (candidates.length === 0) {
          throw new Error(`Unable to obtain download URL for file ${sourceId}`);
        }
        let lastFailure = '';
        for (const candidate of candidates) {
          try {
            const fileDownload = await fetch(candidate.url, candidate.init);
            if (fileDownload.ok) return extractStructuredFromFile(await fileDownload.arrayBuffer(), filename);
            lastFailure = String(fileDownload.status);
          } catch (e) {
            lastFailure = e instanceof Error ? e.message : 'network error';
          }
        }
        throw new Error(`Failed to download ${filename} (${lastFailure})`);
      },
    };
  }

  if (sourceType === 'page') {
    if (!courseId) throw new Error('course_id is required to index a page');
    const page = await fetchPage(courseId, sourceId);
    // The body is in hand: record its links now so what it points at becomes discoverable
    const { text } = await ingestHtml(courseId, 'page', sourceId, page.body);
    return {
      docId: docIdFor('page', sourceId, courseId),
      title: page.title || sourceId,
      version: page.updated_at || '1',
      htmlUrl: page.html_url || null,
      pageKind: 'page',
      courseId: String(courseId),
      loadPages: async () => (text ? [{ pageNumber: 1, text }] : []),
    };
  }

  if (sourceType === 'assignment') {
    if (!courseId) throw new Error('course_id is required to index an assignment description');
    const { assignment: a, text } = await fetchAssignmentWithDescription(courseId, sourceId);
    return {
      docId: docIdFor('assignment', sourceId),
      title: a.name ? `${a.name} (assignment description)` : `Assignment ${sourceId}`,
      version: a.updated_at || '1',
      htmlUrl: a.html_url || null,
      pageKind: 'page',
      courseId: String(courseId),
      loadPages: async () => (text ? [{ pageNumber: 1, text }] : []),
    };
  }

  if (sourceType === 'syllabus') {
    // The syllabus collection stored the body as text and recorded its links (the tool ensured it before calling here)
    const course = String(courseId || sourceId);
    const syllabus = await getCourseSyllabus(course);
    if (!syllabus) throw new Error(`Course ${course} has no syllabus on its Syllabus tab.`);
    const text = syllabus.body;
    return {
      docId: docIdFor('syllabus', course),
      title: 'Syllabus',
      version: syllabus.version,
      htmlUrl: null,
      pageKind: 'page',
      courseId: course,
      loadPages: async () => (text ? [{ pageNumber: 1, text }] : []),
    };
  }

  if (sourceType === 'conversation') {
    throw new Error('Inbox threads are indexed automatically when the inbox is synced; call get_inbox first.');
  }
  if (sourceType === 'discussion') {
    throw new Error('Discussion threads are read through get_discussions / read_document(document_type="discussion").');
  }

  throw new Error(`Unsupported source type: ${sourceType}`);
}

/**
 * A wiki page with its body. When a course hides its Pages area, Canvas can still refuse a slug
 * fetch for the front page while serving it through /front_page, so that is tried second.
 */
async function fetchPage(courseId: string, slug: string): Promise<CanvasPage> {
  try {
    return await canvasGet<CanvasPage>(`/courses/${courseId}/pages/${encodeURIComponent(slug)}`, `page "${slug}" in course ${courseId}`);
  } catch (e) {
    if (!(e instanceof CanvasHttpError) || (e.status !== 403 && e.status !== 404)) throw e;
    const front = await canvasGet<CanvasPage>(`/courses/${courseId}/front_page`, `front page of course ${courseId}`).catch(() => null);
    if (front?.url === slug) return front;
    throw e;
  }
}

/**
 * Fetches one assignment (the only listing that carries `description`), records its links and
 * caches the description as text in the graph so get_assignment / indexing do not fetch it twice.
 */
export async function fetchAssignmentWithDescription(
  courseId: string,
  assignmentId: string
): Promise<{ assignment: CanvasAssignment; text: string }> {
  const a = await canvasGet<CanvasAssignment>(`/courses/${courseId}/assignments/${assignmentId}`, `assignment ${assignmentId}`);
  const { text } = await ingestHtml(courseId, 'assignment', String(assignmentId), a.description);
  await setAssignmentDescription(String(assignmentId), text, a.updated_at ?? null);
  return { assignment: a, text };
}

/** The module item type that lists a document of each kind (the syllabus is in no module). */
const MODULE_ITEM_TYPE: Partial<Record<DocumentSourceType, 'File' | 'Page' | 'Assignment'>> = { file: 'File', page: 'Page', assignment: 'Assignment' };

/**
 * "CSC236 · Week 3 · Lecture 5 slides" — the context that a bare chunk lacks.
 */
async function buildChunkHeader(docId: string, target: IndexTarget, title: string): Promise<string> {
  const { course, module } = await getDocumentContext(
    target.courseId ?? null,
    target.sourceType === 'file' ? docId : target.sourceId,
    MODULE_ITEM_TYPE[target.sourceType] ?? null
  );
  return [course, module, title].filter(Boolean).join(' · ');
}
