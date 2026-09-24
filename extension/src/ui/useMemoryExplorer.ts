import { useCallback, useEffect, useRef, useState } from 'react';
import { exploreGraph, getCourseSyllabus, getGraphStatistics, listAnnouncements, listDiscussions, listQuizzes } from '../db/graph';
import { docIdFor, forgetDocument, getFileChunks, getFilesList } from '../db/rag';
import { forgetCollection, forgetCourse, forgetEverything, getSyncState, scopeKey, type CollectionKind } from '../canvas/freshness';
import type {
  AssignmentRow,
  Chunk,
  CollectionStatus,
  CourseMemory,
  CourseSummary,
  FileRow,
  GraphStats,
  MemoryModel,
  MemoryNode,
  ModuleItemNode,
  ModuleItemType,
  ModuleNode,
  PageRow,
} from './model';
import { FRESHNESS_FIELDS } from './model';
import type { CourseListRow } from '../db/rows';

const EMPTY_STATS: GraphStats = { courseCount: 0, moduleCount: 0, itemCount: 0, assignmentCount: 0, fileCount: 0, chunkCount: 0 };

/** The course-scoped collections, in the order the sheet lists them, labelled as in Settings → Freshness. */
const COURSE_COLLECTIONS: Array<{ kind: CollectionKind; label: string }> = (
  ['modules', 'assignments', 'files', 'pages', 'home', 'submissions', 'announcements', 'discussions', 'quizzes', 'syllabus'] as const
).map((kind) => ({ kind, label: FRESHNESS_FIELDS.find((f) => f.key === kind)?.label ?? kind }));

const ITEM_TYPES: ReadonlySet<string> = new Set(['File', 'Page', 'Assignment', 'Discussion', 'Quiz', 'ExternalUrl', 'ExternalTool', 'SubHeader']);

/** The document a node's text lives in (`files.file_id`), or null for nodes without text of their own. */
function docIdForNode(node: MemoryNode | null, courseId: string | null): string | null {
  if (!node) return null;
  switch (node.node_type) {
    case 'assignment':
      return docIdFor('assignment', node.assignment_id);
    case 'page':
      return docIdFor('page', node.page_url, courseId);
    case 'file':
      return docIdFor('file', node.file_id);
    case 'module_item':
      if (!node.content_ref) return null;
      if (node.item_type === 'File') return docIdFor('file', node.content_ref);
      if (node.item_type === 'Page') return docIdFor('page', node.content_ref, courseId);
      if (node.item_type === 'Assignment') return docIdFor('assignment', node.content_ref);
      if (node.item_type === 'Discussion') return docIdFor('discussion', node.content_ref);
      return null;
    default:
      return null;
  }
}

function nodeName(node: MemoryNode): string {
  switch (node.node_type) {
    case 'assignment':
      return node.name;
    case 'page':
      return node.title;
    case 'file':
      return node.display_name;
    default:
      return node.label;
  }
}

function toCourseSummary(row: CourseListRow): CourseSummary {
  return {
    course_id: row.course_id,
    name: row.name,
    course_code: row.course_code,
    term: row.term,
    module_count: row.module_count,
    assignment_count: row.assignment_count,
    indexed_document_count: row.indexed_document_count,
  };
}

function toSubmissionState(state: string | null | undefined): AssignmentRow['submission_state'] {
  if (state === 'graded' || state === 'unsubmitted') return state;
  if (state === 'submitted' || state === 'pending_review') return 'submitted';
  return null;
}

/** The model speaks ISO strings; PGlite hands `TIMESTAMPTZ` back as `Date`. */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function loadCourseMemory(course: CourseSummary): Promise<CourseMemory> {
  const courseId = course.course_id;
  const [hierarchy, assignmentRows, pageRows, fileRows, announcementRows, discussionRows, quizRows, syllabus] = await Promise.all([
    exploreGraph({ entity_type: 'full_hierarchy', course_id: courseId }),
    exploreGraph({ entity_type: 'assignments', course_id: courseId, limit: 200, include_submission: true }),
    exploreGraph({ entity_type: 'pages', course_id: courseId, limit: 200 }),
    getFilesList(courseId),
    listAnnouncements(courseId, 200),
    listDiscussions(courseId, undefined, 200),
    listQuizzes({ courseId, limit: 200 }),
    getCourseSyllabus(courseId),
  ]);

  // `indexed` for every node comes from the documents table, keyed by doc id
  const indexedDocs = new Set(fileRows.filter((f) => f.total_chunks > 0).map((f) => f.file_id));

  const modules: ModuleNode[] = [];
  const byModule = new Map<string, ModuleNode>();
  for (const n of hierarchy.treeNodes) {
    if (n.node_type === 'module') {
      const m: ModuleNode = { node_type: 'module', node_id: n.node_id, label: n.label, items: [] };
      modules.push(m);
      byModule.set(m.node_id, m);
    }
  }
  for (const n of hierarchy.treeNodes) {
    if (n.node_type !== 'module_item') continue;
    const parent = byModule.get(n.parent_module_id);
    if (!parent) continue;
    const item_type = (n.item_type && ITEM_TYPES.has(n.item_type) ? n.item_type : 'ExternalUrl') as ModuleItemType;
    const item: ModuleItemNode = {
      node_type: 'module_item',
      node_id: n.node_id,
      label: n.label,
      item_type,
      content_ref: n.content_ref,
      html_url: n.html_url,
      indexed: false,
    };
    const docId = docIdForNode(item, courseId);
    item.indexed = docId != null && indexedDocs.has(docId);
    parent.items.push(item);
  }

  const assignments: AssignmentRow[] = assignmentRows.map((a) => ({
    node_type: 'assignment',
    assignment_id: a.assignment_id,
    name: a.name,
    due_at: iso(a.due_at),
    points_possible: a.points_possible,
    html_url: a.html_url,
    submission_state: toSubmissionState(a.submission_state),
    score: a.score ?? null,
    indexed: a.description_indexed,
  }));

  const pages: PageRow[] = pageRows.map((p) => ({
    node_type: 'page',
    page_url: p.page_url,
    title: p.title,
    front_page: p.front_page,
    html_url: p.html_url,
    indexed: p.indexed,
  }));

  const moduleFileIds = new Set<string>();
  for (const m of modules) for (const it of m.items) if (it.item_type === 'File' && it.content_ref) moduleFileIds.add(it.content_ref);
  const courseFiles = fileRows.filter((f) => f.source_type === 'file');
  const looseFiles: FileRow[] = courseFiles
    .filter((f) => !moduleFileIds.has(f.file_id))
    .map((f) => ({
      node_type: 'file',
      file_id: f.file_id,
      display_name: f.display_name || f.filename || f.file_id,
      content_type: f.content_type,
      size: f.size,
      total_chunks: f.total_chunks,
      html_url: f.html_url,
      indexed: f.total_chunks > 0,
    }));

  const counts: Partial<Record<CollectionKind, number | null>> = {
    modules: modules.length,
    assignments: assignments.length,
    files: courseFiles.length,
    pages: pages.length,
    home: null,
    submissions: assignmentRows.filter((a) => a.submission_state != null).length,
    announcements: announcementRows.length,
    discussions: discussionRows.length,
    quizzes: quizRows.length,
    syllabus: null,
  };
  const collections: CollectionStatus[] = await Promise.all(
    COURSE_COLLECTIONS.map(async ({ kind, label }) => {
      const state = await getSyncState(scopeKey(kind, { courseId }));
      const status: CollectionStatus['status'] = !state ? 'never' : state.status === 'unavailable' ? 'unavailable' : state.error ? 'error' : 'ok';
      return { kind, label, count: counts[kind] ?? null, status, syncedAt: state?.syncedAt ?? null, ...(state?.error ? { error: state.error } : {}) };
    })
  );

  return {
    course,
    collections,
    modules,
    assignments,
    pages,
    looseFiles,
    announcements: announcementRows.map((a) => ({
      announcement_id: a.announcement_id,
      title: a.title,
      posted_at: iso(a.posted_at),
      author: a.author,
    })),
    discussions: discussionRows.map((d) => ({
      discussion_id: d.discussion_id,
      title: d.title,
      reply_count: d.reply_count ?? 0,
      last_reply_at: iso(d.last_reply_at),
      replies_read: d.replies_read,
    })),
    quizzes: quizRows.map((z) => ({
      quiz_id: z.quiz_id,
      title: z.title,
      due_at: iso(z.due_at),
      points_possible: z.points_possible,
      question_count: z.question_count,
    })),
    hasSyllabus: syllabus != null,
  };
}

/**
 * The Memory sheet's data: a read-only view of the graph plus the two ways the user may shrink
 * it (forget a collection, forget a document's text). Nothing here syncs or indexes — the engine
 * does that when the agent needs something. `reload()` re-reads everything; `App` calls it after
 * each agent turn so the sheet shows what the turn brought in. Loads only while `enabled`, since
 * the database is not configured before a connection.
 */
export function useMemoryExplorer(enabled: boolean): MemoryModel & { reload: () => void } {
  const [stats, setStats] = useState<GraphStats>(EMPTY_STATS);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [course, setCourse] = useState<CourseMemory | null>(null);
  const [loadingCourse, setLoadingCourse] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
  const [nodeChunks, setNodeChunks] = useState<Chunk[]>([]);
  const [isForgetting, setIsForgetting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadedCourseId = useRef<string | null>(null);
  const coursesRef = useRef<CourseSummary[]>([]);
  coursesRef.current = courses;

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const showStatus = (message: string) => {
    setStatusMessage(message);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatusMessage(null), 4000);
  };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.all([getGraphStatistics(), exploreGraph({ entity_type: 'courses', limit: 200 })])
      .then(([s, c]) => {
        if (cancelled) return;
        setStats(s);
        setCourses(c.map(toCourseSummary));
      })
      .catch((e) => {
        console.error('Memory overview failed to load:', e);
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, version]);

  useEffect(() => {
    if (!enabled || !selectedCourseId) {
      setCourse(null);
      return;
    }
    const summary = coursesRef.current.find((c) => c.course_id === selectedCourseId);
    if (!summary) return;
    let cancelled = false;
    // A spinner only when moving to another course; a reload of the same course keeps its content up
    setLoadingCourse(loadedCourseId.current !== selectedCourseId);
    setLoadError(null);
    loadCourseMemory(summary)
      .then((next) => {
        if (cancelled) return;
        loadedCourseId.current = selectedCourseId;
        setCourse(next);
      })
      .catch((e) => {
        console.error('Course memory failed to load:', e);
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingCourse(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, selectedCourseId, version]);

  const selectedDocId = docIdForNode(selectedNode, selectedCourseId);
  useEffect(() => {
    if (!enabled || !selectedDocId) {
      setNodeChunks([]);
      return;
    }
    let cancelled = false;
    getFileChunks(selectedDocId)
      .then((rows) => {
        if (cancelled) return;
        setNodeChunks(
          rows.map((r) => ({
            chunk_id: r.chunk_id,
            chunk_index: r.chunk_index,
            page_number: r.page_number,
            page_end: r.page_end,
            page_kind: r.page_kind || 'page',
            content: r.content,
          }))
        );
      })
      .catch((e) => console.error('Chunks failed to load:', e));
    return () => {
      cancelled = true;
    };
  }, [enabled, selectedDocId, version]);

  const selectCourse = (id: string | null) => {
    setSelectedCourseId(id);
    setSelectedNode(null);
  };

  const forgetCollectionAction = async (kind: CollectionKind) => {
    if (!course) return;
    const label = COURSE_COLLECTIONS.find((c) => c.kind === kind)?.label ?? kind;
    if (!window.confirm(`Forget the ${label.toLowerCase()} remembered for ${course.course.course_code ?? course.course.name}? They are fetched again when next needed.`)) return;
    setIsForgetting(true);
    try {
      await forgetCollection(kind, course.course.course_id);
      setSelectedNode(null);
      showStatus(`Forgot ${label.toLowerCase()}.`);
      reload();
    } catch (e) {
      showStatus(`Could not forget: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsForgetting(false);
    }
  };

  const forgetSelected = async () => {
    if (!selectedNode || !selectedDocId) return;
    const name = nodeName(selectedNode);
    if (!window.confirm(`Forget the text remembered for "${name}"? It is read again when next needed.`)) return;
    setIsForgetting(true);
    try {
      await forgetDocument(selectedDocId);
      showStatus(`Forgot the text of ${name}.`);
      reload();
    } catch (e) {
      showStatus(`Could not forget: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsForgetting(false);
    }
  };

  const forgetCourseAction = async () => {
    if (!course) return;
    const label = course.course.course_code ?? course.course.name;
    if (!window.confirm(`Forget everything remembered about ${label}? It is fetched again as you ask about it.`)) return;
    setIsForgetting(true);
    try {
      await forgetCourse(course.course.course_id);
      setSelectedCourseId(null);
      setSelectedNode(null);
      showStatus(`Forgot ${label}.`);
      reload();
    } catch (e) {
      showStatus(`Could not forget: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsForgetting(false);
    }
  };

  const forgetEverythingAction = async () => {
    if (!window.confirm('Forget everything remembered about your courses? Chats are kept; courses and documents are fetched again as you ask about them.')) return;
    setIsForgetting(true);
    try {
      await forgetEverything();
      setSelectedCourseId(null);
      setSelectedNode(null);
      showStatus('Forgot everything.');
      reload();
    } catch (e) {
      showStatus(`Could not forget: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsForgetting(false);
    }
  };

  return {
    stats,
    courses,
    selectedCourseId,
    selectCourse,
    course,
    loadingCourse,
    loadError,
    selectedNode,
    selectNode: setSelectedNode,
    selectedIsIndexable: selectedDocId != null,
    nodeChunks,
    forgetCollection: (kind) => void forgetCollectionAction(kind),
    forgetSelected: () => void forgetSelected(),
    forgetCourse: () => void forgetCourseAction(),
    forgetEverything: () => void forgetEverythingAction(),
    isForgetting,
    statusMessage,
    reload,
  };
}
