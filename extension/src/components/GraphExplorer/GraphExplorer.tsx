import React, { useState, useEffect } from 'react';
import {
  Brain,
  RefreshCw,
  FileText,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Calendar,
  Layers,
  BookOpen,
  Search,
  ExternalLink,
  Sparkles,
  Database,
  X,
} from 'lucide-react';
import type { AppSettings } from '../Settings/Settings';
import type { CanvasCourse, GraphStats } from '../../types/canvas';
import { exploreGraph, getGraphStatistics } from '../../db/graph';
import { getFilesList, getFileChunks, docIdFor } from '../../db/rag';
import { indexDocumentJustInTime, type IndexTarget } from '../../canvas/sync';
import { ensureCollection, ensureCollections } from '../../canvas/collections';
import type { EnsureResult } from '../../canvas/freshness';

/** "Updated modules, assignments · unavailable: files, pages · failed: …" */
function summarizeEnsure(results: EnsureResult[]): string {
  const by = (status: EnsureResult['status']) => results.filter((r) => r.status === status).map((r) => r.kind);
  const parts: string[] = [];
  const synced = by('synced');
  const fresh = by('fresh');
  const unavailable = by('unavailable');
  const errors = results.filter((r) => r.status === 'error');
  if (synced.length) parts.push(`Updated ${synced.join(', ')}`);
  if (fresh.length) parts.push(`already current: ${fresh.join(', ')}`);
  if (unavailable.length) parts.push(`not available in this course: ${unavailable.join(', ')}`);
  if (errors.length) parts.push(`failed: ${errors.map((r) => `${r.kind} (${r.error})`).join('; ')}`);
  return parts.join(' · ') || 'Nothing to do.';
}

/**
 * Which local document (row in `files`) a selected node corresponds to, and how to index it.
 * Returns null for nodes that have no indexable content (modules, quizzes, external links...).
 */
function indexTargetFor(node: any, courseId: string | null): { docId: string; target: IndexTarget } | null {
  if (!node) return null;
  if (node.node_type === 'assignment' || node.assignment_id) {
    const id = String(node.assignment_id);
    return { docId: docIdFor('assignment', id), target: { sourceType: 'assignment', sourceId: id, courseId } };
  }
  if (node.node_type === 'page' || node.page_url) {
    const slug = String(node.page_url);
    return { docId: docIdFor('page', slug, courseId), target: { sourceType: 'page', sourceId: slug, courseId } };
  }
  if (node.item_type === 'File' && node.content_ref) {
    const id = String(node.content_ref);
    return { docId: docIdFor('file', id), target: { sourceType: 'file', sourceId: id, courseId } };
  }
  if (node.item_type === 'Page' && node.content_ref) {
    const slug = String(node.content_ref);
    return { docId: docIdFor('page', slug, courseId), target: { sourceType: 'page', sourceId: slug, courseId } };
  }
  if (node.node_type === 'file' || node.file_id) {
    const id = String(node.file_id);
    return { docId: docIdFor('file', id), target: { sourceType: 'file', sourceId: id, courseId } };
  }
  return null;
}

interface GraphExplorerProps {
  settings: AppSettings;
  /** "<name> · <host>" of the identity whose memory this is. */
  memoryLabel?: string;
}

export const GraphExplorer: React.FC<GraphExplorerProps> = ({ settings, memoryLabel }) => {
  const [stats, setStats] = useState<GraphStats>({
    courseCount: 0,
    moduleCount: 0,
    itemCount: 0,
    assignmentCount: 0,
    fileCount: 0,
    chunkCount: 0,
  });
  const [courses, setCourses] = useState<CanvasCourse[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [hierarchyData, setHierarchyData] = useState<any>(null);
  const [trackedFiles, setTrackedFiles] = useState<any[]>([]);
  const [coursePages, setCoursePages] = useState<any[]>([]);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [nodeChunks, setNodeChunks] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [collapsedModules, setCollapsedModules] = useState<Record<string, boolean>>({});
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);
  const [isIndexingFile, setIsIndexingFile] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load initial statistics and courses
  const loadData = async () => {
    try {
      const [s, c, f] = await Promise.all([
        getGraphStatistics(),
        exploreGraph({ entity_type: 'courses' }),
        getFilesList(),
      ]);
      setStats(s);
      setCourses(c);
      setTrackedFiles(f);
      setLoadError(null);

      if (c.length > 0 && !selectedCourseId) {
        setSelectedCourseId(String(c[0].course_id));
      }
    } catch (err) {
      console.error('Error loading graph data:', err);
      setLoadError((err as Error).message || String(err));
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // When selected course changes, load hierarchy
  useEffect(() => {
    if (!selectedCourseId) return;

    const loadCourseTree = async () => {
      try {
        const [data, pages] = await Promise.all([
          exploreGraph({ entity_type: 'full_hierarchy', course_id: selectedCourseId }),
          exploreGraph({ entity_type: 'pages', course_id: selectedCourseId, limit: 200 }),
        ]);
        setHierarchyData(data);
        setCoursePages(pages);
      } catch (err) {
        console.error('Error loading course tree:', err);
      }
    };

    loadCourseTree();
  }, [selectedCourseId]);

  // When selected node is a file, load its chunks if available
  useEffect(() => {
    if (!selectedNode) {
      setNodeChunks([]);
      return;
    }

    const doc = indexTargetFor(selectedNode, selectedCourseId);
    if (doc) {
      getFileChunks(doc.docId).then(setNodeChunks).catch(console.error);
    } else {
      setNodeChunks([]);
    }
  }, [selectedNode, selectedCourseId]);

  // Manual Sync All Courses (forces a refresh regardless of TTL)
  const handleSyncAllCourses = async () => {
    setIsSyncing(true);
    setSyncStatusMsg('Fetching active courses from Canvas...');
    try {
      const res = await ensureCollection('courses', {}, { settings, refresh: true });
      setSyncStatusMsg(summarizeEnsure([res]));
      await loadData();
    } catch (err: any) {
      setSyncStatusMsg(`Error: ${err.message}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatusMsg(null), 4000);
    }
  };

  // Manual refresh of every collection of the selected course. Collections the course hides
  // (403/404) are reported, not fatal.
  const handleSyncCurrentCourse = async () => {
    if (!selectedCourseId) return;
    setIsSyncing(true);
    setSyncStatusMsg('Refreshing modules, assignments, files, pages and home page...');
    try {
      const results = await ensureCollections(
        ['modules', 'assignments', 'files', 'pages', 'home'],
        { courseId: selectedCourseId },
        { settings, refresh: true }
      );
      setSyncStatusMsg(summarizeEnsure(results));
      await loadData();
      const [updated, pages] = await Promise.all([
        exploreGraph({ entity_type: 'full_hierarchy', course_id: selectedCourseId }),
        exploreGraph({ entity_type: 'pages', course_id: selectedCourseId, limit: 200 }),
      ]);
      setHierarchyData(updated);
      setCoursePages(pages);
    } catch (err: any) {
      setSyncStatusMsg(`Sync error: ${err.message}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatusMsg(null), 4000);
    }
  };

  // Manual trigger to index a document (file, page, or assignment description) for search
  const handleIndexDocument = async (doc: { docId: string; target: IndexTarget }) => {
    setIsIndexingFile(true);
    try {
      const res = await indexDocumentJustInTime(doc.target, settings);
      setSyncStatusMsg(
        res.status === 'cached'
          ? `${res.title} was already indexed (${res.chunksCount} chunks).`
          : `Indexed ${res.chunksCount} chunks for ${res.title}${
              res.chunksEmbedded < res.chunksCount ? ` (${res.chunksEmbedded} embedded, ${res.chunksCount - res.chunksEmbedded} unchanged)` : ''
            }.`
      );
      const [updatedFiles, updatedStats, chunks] = await Promise.all([
        getFilesList(),
        getGraphStatistics(),
        getFileChunks(doc.docId),
      ]);
      setTrackedFiles(updatedFiles);
      setStats(updatedStats);
      setNodeChunks(chunks);
    } catch (err: any) {
      setSyncStatusMsg(`Indexing error: ${err.message}`);
    } finally {
      setIsIndexingFile(false);
      setTimeout(() => setSyncStatusMsg(null), 4000);
    }
  };

  const toggleModule = (modId: string) => {
    setCollapsedModules((prev) => ({ ...prev, [modId]: !prev[modId] }));
  };

  // Group tree nodes by modules
  const modulesList: any[] = [];
  const itemsByModule: Record<string, any[]> = {};

  if (hierarchyData?.treeNodes) {
    for (const node of hierarchyData.treeNodes) {
      if (node.node_type === 'module') {
        modulesList.push(node);
        if (!itemsByModule[node.node_id]) {
          itemsByModule[node.node_id] = [];
        }
      } else if (node.node_type === 'module_item') {
        if (!itemsByModule[node.parent_module_id]) {
          itemsByModule[node.parent_module_id] = [];
        }
        itemsByModule[node.parent_module_id].push(node);
      }
    }
  }

  // Check if a document is already indexed for search
  const isDocIndexed = (docId?: string | null) => {
    if (!docId) return false;
    return trackedFiles.some((f) => String(f.file_id) === String(docId) && Number(f.total_chunks) > 0);
  };
  const isFileIndexed = (contentRef?: string) => isDocIndexed(contentRef);

  // Files known for this course that are not placed in any module
  const moduleFileIds = new Set<string>();
  for (const items of Object.values(itemsByModule)) {
    for (const it of items) if (it.item_type === 'File' && it.content_ref) moduleFileIds.add(String(it.content_ref));
  }
  const looseFiles = trackedFiles.filter(
    (f) => f.source_type === 'file' && String(f.course_id) === String(selectedCourseId) && !moduleFileIds.has(String(f.file_id))
  );
  const selectedDoc = indexTargetFor(selectedNode, selectedCourseId);

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-900 text-slate-100 overflow-hidden">
      {/* Top Header & Stats Bar */}
      <div className="px-5 py-3 border-b border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 bg-blue-600/20 text-blue-400 rounded-lg flex-shrink-0">
            <Brain size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-white flex items-center gap-2 min-w-0">
              <span className="truncate">Memory</span>
              <span className="hidden md:inline text-xs px-2 py-0.5 rounded-full bg-blue-900/50 text-blue-300 font-normal whitespace-nowrap">
                PGlite WASM
              </span>
            </h1>
            <p className="hidden md:block text-xs text-slate-400">
              {memoryLabel ? `Memory for ${memoryLabel}, kept current on demand` : 'What CanvasBuddy remembers about your courses, kept current on demand'}
            </p>
          </div>
        </div>

        {/* Global Action & Status */}
        <div className="flex items-center gap-2">
          {syncStatusMsg && (
            <span className="text-xs text-blue-400 bg-blue-950 px-2.5 py-1 rounded border border-blue-800 animate-fade-in">
              {syncStatusMsg}
            </span>
          )}
          <button
            onClick={handleSyncAllCourses}
            disabled={isSyncing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md border border-slate-700 transition-colors disabled:opacity-50"
            title="Fetch all active courses from Canvas"
          >
            <RefreshCw size={13} className={isSyncing ? 'animate-spin' : ''} />
            Sync Courses
          </button>
        </div>
      </div>

      {/* Stats Counter Ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-x-3 gap-y-1 px-5 py-2 bg-slate-900/60 border-b border-slate-800 text-xs flex-shrink-0">
        <div className="flex items-center gap-1.5 text-slate-300 whitespace-nowrap min-w-0">
          <BookOpen size={13} className="text-blue-400" />
          <span>Courses:</span>
          <span className="font-semibold text-white">{stats.courseCount}</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-300 whitespace-nowrap min-w-0">
          <Layers size={13} className="text-cyan-400" />
          <span>Modules:</span>
          <span className="font-semibold text-white">{stats.moduleCount}</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-300 whitespace-nowrap min-w-0">
          <FileText size={13} className="text-amber-400" />
          <span>Items:</span>
          <span className="font-semibold text-white">{stats.itemCount}</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-300 whitespace-nowrap min-w-0">
          <Calendar size={13} className="text-purple-400" />
          <span>Assignments:</span>
          <span className="font-semibold text-white">{stats.assignmentCount}</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-300 whitespace-nowrap min-w-0">
          <Database size={13} className="text-emerald-400" />
          <span>Files:</span>
          <span className="font-semibold text-white">{stats.fileCount}</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-300 whitespace-nowrap min-w-0">
          <Sparkles size={13} className="text-rose-400" />
          <span>Chunks:</span>
          <span className="font-semibold text-white">{stats.chunkCount}</span>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Center: Graph Tree View */}
        <div className="flex-1 overflow-y-auto p-4 bg-slate-900/50 space-y-4 min-w-0">
          {/* Course selector & filter (compact so the explorer fits a side panel) */}
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={selectedCourseId || ''}
              onChange={(e) => setSelectedCourseId(e.target.value || null)}
              className="flex-1 min-w-0 bg-slate-950 text-xs text-slate-200 px-2.5 py-2 rounded border border-slate-700 focus:outline-none focus:border-blue-500"
            >
              {courses.length === 0 && <option value="">No courses synced yet</option>}
              {courses.map((c) => {
                const id = String(c.course_id || c.id);
                return (
                  <option key={id} value={id}>
                    {c.course_code ? `${c.course_code} — ${c.name}` : c.name}
                  </option>
                );
              })}
            </select>
            <div className="relative sm:w-44">
              <Search size={12} className="absolute left-2.5 top-2.5 text-slate-500" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Filter modules..."
                className="w-full bg-slate-950 text-xs text-slate-200 pl-7 pr-2 py-2 rounded border border-slate-700 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {selectedCourseId && hierarchyData && (
            <div className="flex items-center justify-between bg-slate-800/80 p-3 rounded-lg border border-slate-700">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  {hierarchyData.course?.name || 'Selected Course'}
                </h2>
                <p className="text-xs text-slate-400">
                  {modulesList.length} modules â€¢ {hierarchyData.assignments?.length || 0} assignments
                </p>
              </div>
              <button
                onClick={handleSyncCurrentCourse}
                disabled={isSyncing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded font-medium transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
                Refresh Course
              </button>
            </div>
          )}

          {loadError && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-900 bg-red-950/40 text-xs text-red-200">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{loadError}</span>
            </div>
          )}

          {/* Modules and Items Hierarchy */}
          {courses.length === 0 ? (
            <div className="text-center p-8 bg-slate-950/30 rounded-lg border border-slate-800 border-dashed">
              <BookOpen size={32} className="mx-auto text-slate-600 mb-2" />
              <p className="text-sm font-medium text-slate-400">Nothing remembered yet — ask about a course in Chat, or Sync Courses</p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                Click "Sync Courses" above to pull your active courses from Canvas.
              </p>
            </div>
          ) : modulesList.length === 0 ? (
            <div className="text-center p-8 bg-slate-950/30 rounded-lg border border-slate-800 border-dashed">
              <Layers size={32} className="mx-auto text-slate-600 mb-2" />
              <p className="text-sm font-medium text-slate-400">No modules remembered for this course</p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                The agent will fetch this automatically on demand, or click "Refresh Course" to pull module structure now.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {modulesList
                .filter((m) => !searchTerm || m.label.toLowerCase().includes(searchTerm.toLowerCase()))
                .map((m) => {
                  const isCollapsed = collapsedModules[m.node_id];
                  const items = itemsByModule[m.node_id] || [];
                  const isSelected = selectedNode?.node_id === m.node_id;

                  return (
                    <div
                      key={m.node_id}
                      className="bg-slate-950/60 rounded-lg border border-slate-800 overflow-hidden transition-all"
                    >
                      {/* Module Header */}
                      <div
                        onClick={() => setSelectedNode(m)}
                        className={`flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-slate-800/60 transition-colors ${
                          isSelected ? 'bg-slate-800 border-l-4 border-l-blue-500' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleModule(m.node_id);
                            }}
                            className="text-slate-400 hover:text-white"
                          >
                            {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                          </button>
                          <Layers size={14} className="text-cyan-400 flex-shrink-0" />
                          <span className="text-xs font-semibold text-slate-200 truncate">
                            {m.label}
                          </span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                          {items.length} items
                        </span>
                      </div>

                      {/* Module Items List */}
                      {!isCollapsed && items.length > 0 && (
                        <div className="pl-6 pr-3 py-1 space-y-1 bg-slate-900/30 border-t border-slate-800/80">
                          {items.map((item) => {
                            const isItemSel = selectedNode?.node_id === item.node_id;
                            const isIndexed = isFileIndexed(item.content_ref);

                            return (
                              <div
                                key={item.node_id}
                                onClick={() => setSelectedNode(item)}
                                className={`flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                                  isItemSel
                                    ? 'bg-blue-600/30 text-white font-medium border border-blue-500/50'
                                    : 'text-slate-300 hover:bg-slate-800/60'
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold tracking-wider ${
                                      item.item_type === 'File'
                                        ? 'bg-blue-900/60 text-blue-300 border border-blue-800'
                                        : item.item_type === 'Assignment'
                                        ? 'bg-purple-900/60 text-purple-300 border border-purple-800'
                                        : 'bg-slate-800 text-slate-400'
                                    }`}
                                  >
                                    {item.item_type}
                                  </span>
                                  <span className="truncate">{item.label}</span>
                                </div>

                                {item.item_type === 'File' && (
                                  <span
                                    className={`text-[10px] flex items-center gap-1 ${
                                      isIndexed ? 'text-emerald-400' : 'text-slate-500'
                                    }`}
                                  >
                                    <span
                                      className={`w-1.5 h-1.5 rounded-full ${
                                        isIndexed ? 'bg-emerald-400' : 'bg-slate-600'
                                      }`}
                                    />
                                    {isIndexed ? 'Indexed' : 'Unindexed'}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}

          {/* Assignments Section */}
          {hierarchyData?.assignments && hierarchyData.assignments.length > 0 && (
            <div className="bg-slate-950/60 rounded-lg border border-slate-800 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-purple-400">
                <Calendar size={14} />
                <span>Course Assignments ({hierarchyData.assignments.length})</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {hierarchyData.assignments.map((a: any) => (
                  <div
                    key={a.assignment_id}
                    onClick={() => setSelectedNode({ ...a, node_type: 'assignment' })}
                    className={`p-2.5 rounded bg-slate-900 border text-xs cursor-pointer transition-colors ${
                      selectedNode?.assignment_id === a.assignment_id
                        ? 'border-purple-500 bg-purple-950/30'
                        : 'border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <p className="font-medium text-slate-200 truncate">{a.name}</p>
                    <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                      <Calendar size={10} />
                      {a.due_at ? new Date(a.due_at).toLocaleDateString() : 'No due date'}
                      {a.points_possible != null && (
                        <span className="ml-auto font-semibold text-slate-300">
                          {a.points_possible} pts
                        </span>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files not in any module */}
          {looseFiles.length > 0 && (
            <div className="bg-slate-950/60 rounded-lg border border-slate-800 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                <Database size={14} />
                <span>Other Course Files ({looseFiles.length})</span>
              </div>
              <div className="space-y-1">
                {looseFiles
                  .filter((f) => !searchTerm || String(f.display_name || f.filename).toLowerCase().includes(searchTerm.toLowerCase()))
                  .map((f: any) => (
                  <div
                    key={f.file_id}
                    onClick={() => setSelectedNode({ ...f, node_type: 'file', label: f.display_name || f.filename })}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                      selectedNode?.file_id === f.file_id
                        ? 'bg-blue-600/30 text-white font-medium border border-blue-500/50'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="truncate">{f.display_name || f.filename}</span>
                    <span className={`text-[10px] flex items-center gap-1 ${Number(f.total_chunks) > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${Number(f.total_chunks) > 0 ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                      {Number(f.total_chunks) > 0 ? 'Indexed' : 'Unindexed'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Wiki pages */}
          {coursePages.length > 0 && (
            <div className="bg-slate-950/60 rounded-lg border border-slate-800 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
                <FileText size={14} />
                <span>Pages ({coursePages.length})</span>
              </div>
              <div className="space-y-1">
                {coursePages
                  .filter((p) => !searchTerm || String(p.title).toLowerCase().includes(searchTerm.toLowerCase()))
                  .map((p: any) => (
                  <div
                    key={p.page_url}
                    onClick={() => setSelectedNode({ ...p, node_type: 'page', label: p.title })}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                      selectedNode?.page_url === p.page_url
                        ? 'bg-blue-600/30 text-white font-medium border border-blue-500/50'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="truncate">{p.title}</span>
                    <span className={`text-[10px] flex items-center gap-1 ${p.indexed ? 'text-emerald-400' : 'text-slate-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${p.indexed ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                      {p.indexed ? 'Indexed' : 'Unindexed'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Side: Node Inspector Drawer (overlays the tree so it fits a narrow side panel) */}
        {selectedNode && (
        <div className="absolute inset-y-0 right-0 w-80 max-w-full border-l border-slate-800 bg-slate-950 flex flex-col shadow-2xl">
          <div className="p-3 border-b border-slate-800 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Node Inspector
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                {selectedNode.node_type || selectedNode.item_type || 'Node'}
              </span>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-slate-400 hover:text-white"
                title="Close inspector"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
                <div>
                  <h3 className="text-sm font-semibold text-white break-words">
                    {selectedNode.label || selectedNode.name || 'Untitled Node'}
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
                    ID: {selectedNode.node_id || selectedNode.assignment_id || selectedNode.item_id || selectedNode.module_id}
                  </p>
                </div>

                {/* Properties */}
                <div className="space-y-2 bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                  {selectedNode.item_type && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Type:</span>
                      <span className="font-medium text-slate-200">{selectedNode.item_type}</span>
                    </div>
                  )}
                  {selectedNode.content_ref && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Content Ref:</span>
                      <span className="font-mono text-slate-300">{selectedNode.content_ref}</span>
                    </div>
                  )}
                  {selectedNode.due_at && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Due At:</span>
                      <span className="text-slate-200 font-medium">
                        {new Date(selectedNode.due_at).toLocaleString()}
                      </span>
                    </div>
                  )}
                  {selectedNode.points_possible != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Points:</span>
                      <span className="text-slate-200 font-medium">{selectedNode.points_possible}</span>
                    </div>
                  )}
                  {selectedNode.html_url && (
                    <div className="pt-1">
                      <a
                        href={selectedNode.html_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <ExternalLink size={12} />
                        View in Canvas
                      </a>
                    </div>
                  )}
                </div>

                {/* Search index section: files, wiki pages, assignment descriptions */}
                {selectedDoc && (
                  <div className="space-y-2 bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <Sparkles size={13} className="text-rose-400" />
                        Search Index
                      </span>
                      {isDocIndexed(selectedDoc.docId) ? (
                        <span className="text-emerald-400 flex items-center gap-1 text-[11px]">
                          <CheckCircle2 size={12} />
                          Indexed ({nodeChunks.length} chunks)
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px] flex items-center gap-1">
                          <AlertCircle size={12} />
                          Not Indexed
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => handleIndexDocument(selectedDoc)}
                      disabled={isIndexingFile}
                      className="w-full mt-2 py-1.5 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <Sparkles size={13} className={isIndexingFile ? 'animate-spin' : ''} />
                      {isIndexingFile
                        ? 'Indexing… keep this panel open'
                        : isDocIndexed(selectedDoc.docId)
                        ? 'Re-Index'
                        : selectedDoc.target.sourceType === 'assignment'
                        ? 'Index Description for Search'
                        : 'Index for Search'}
                    </button>

                    {/* Chunk Previews */}
                    {nodeChunks.length > 0 && (
                      <div className="pt-2 border-t border-slate-800 space-y-1.5 max-h-48 overflow-y-auto">
                        <span className="text-[10px] text-slate-400 uppercase font-semibold">
                          Sample Chunks:
                        </span>
                        {nodeChunks.slice(0, 5).map((c) => (
                          <div
                            key={c.chunk_id}
                            className="p-1.5 bg-slate-950 rounded border border-slate-800/80 text-[10px] text-slate-300"
                          >
                            <div className="flex justify-between text-slate-400 text-[9px] mb-0.5">
                              <span>Chunk #{c.chunk_index}</span>
                              {c.page_number && (
                                <span>
                                  Page/Slide {c.page_end && Number(c.page_end) > Number(c.page_number) ? `${c.page_number}-${c.page_end}` : c.page_number}
                                </span>
                              )}
                            </div>
                            <p className="line-clamp-2 text-slate-300">{c.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

